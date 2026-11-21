use soroban_sdk::{Env, Address, String, Vec};
use crate::storage::{DataKey, VaccinationRecord, IssuerRecord, compute_token_id};
use crate::events;
use crate::ContractError;
use crate::validate_input_length;

/// Normalize a vaccine name for duplicate detection.
///
/// Trims leading/trailing whitespace and lowercases ASCII characters so that
/// formatting variants (e.g. "  Pfizer " vs "pfizer") map to the same key.
fn normalize_vaccine_name(env: &Env, name: &String) -> String {
    let len = name.len();
    let mut buf = [0u8; 64];
    let mut out_len: usize = 0;
    let mut started = false;
    let mut pending_space = false;

    for i in 0..len {
        let b = name.get(i).unwrap();
        let is_space = b == b' ' || b == b'\t' || b == b'\n' || b == b'\r';
        if is_space {
            if started {
                pending_space = true;
            }
            continue;
        }
        if pending_space && out_len < buf.len() {
            buf[out_len] = b' ';
            out_len += 1;
            pending_space = false;
        }
        started = true;
        let lower = if b >= b'A' && b <= b'Z' { b + 32 } else { b };
        if out_len < buf.len() {
            buf[out_len] = lower;
            out_len += 1;
        }
    }

    let mut s = String::new(env);
    for i in 0..out_len {
        s.push_back(buf[i] as char);
    }
    s
}

/// Normalize an administration date to ISO `YYYY-MM-DD` form.
///
/// Accepts `YYYY-MM-DD`, `YYYY/MM/DD`, and `YYYYMMDD` variants and returns a
/// canonical `YYYY-MM-DD` string. Unrecognized formats are returned trimmed.
fn normalize_date(env: &Env, date: &String) -> String {
    let len = date.len();
    let mut digits = [0u8; 8];
    let mut digit_count: usize = 0;
    let mut has_separator = false;

    for i in 0..len {
        let b = date.get(i).unwrap();
        if b >= b'0' && b <= b'9' {
            if digit_count < 8 {
                digits[digit_count] = b;
                digit_count += 1;
            }
        } else if b == b'-' || b == b'/' {
            has_separator = true;
        }
    }

    let mut s = String::new(env);
    if digit_count == 8 && (has_separator || len == 8) {
        for i in 0..4 {
            s.push_back(digits[i] as char);
        }
        s.push_back('-');
        for i in 4..6 {
            s.push_back(digits[i] as char);
        }
        s.push_back('-');
        for i in 6..8 {
            s.push_back(digits[i] as char);
        }
    } else {
        // Fallback: trim surrounding whitespace only.
        let mut started = false;
        let mut end: u32 = 0;
        for i in 0..len {
            let b = date.get(i).unwrap();
            if b != b' ' && b != b'\t' && b != b'\n' && b != b'\r' {
                if !started {
                    started = true;
                }
                end = i + 1;
            }
        }
        if started {
            for i in 0..end {
                let b = date.get(i).unwrap();
                if b != b' ' && b != b'\t' && b != b'\n' && b != b'\r' {
                    s.push_back(b as char);
                }
            }
        }
    }
    s
}

/// Mint a new vaccination record NFT for a patient.
///
/// This function validates input length, enforces issuer authorization,
/// verifies that the patient has self-registered, detects duplicate records,
/// and stores the minted vaccination record into persistent contract storage.
///
/// # Arguments
/// * `env` - The Soroban environment.
/// * `patient` - The wallet address receiving the vaccination record.
/// * `vaccine_name` - The vaccine identifier string.
/// * `date_administered` - The administration date string.
/// * `issuer` - The issuer wallet address authorized to mint records.
/// * `dose_number` - Optional dose sequence number.
/// * `dose_series` - Optional total doses in the series.
///
/// # Returns
/// * `Ok(u64)` with the minted token ID on success.
/// * `Err(ContractError)` on authorization failure, duplicate detection, or invalid input.
pub fn mint_vaccination(
    env: &Env,
    patient: Address,
    vaccine_name: String,
    date_administered: String,
    issuer: Address,
    dose_number: Option<u32>,
    dose_series: Option<u32>,
) -> Result<u64, ContractError> {
    validate_input_length(&vaccine_name, "vaccine_name")?;
    validate_input_length(&date_administered, "date_administered")?;

    // Require that the issuer has signed the transaction before checking authorization.
    issuer.require_auth();

    // Authorized issuers are stored under DataKey::Issuer(issuer).
    let is_authorized: bool = env
        .storage()
        .persistent()
        .get::<DataKey, IssuerRecord>(&DataKey::Issuer(issuer.clone()))
        .map(|r| r.authorized)
        .unwrap_or(false);
    if !is_authorized {
        return Err(ContractError::Unauthorized);
    }

    // Patient must have self-registered to receive vaccination records.
    let is_registered: bool = env
        .storage()
        .persistent()
        .get::<DataKey, bool>(&DataKey::PatientAllowlist(patient.clone()))
        .unwrap_or(false);
    if !is_registered {
        return Err(ContractError::PatientNotRegistered);
    }

    // Normalize the duplicate-key fields so formatting variants cannot bypass
    // uniqueness. The duplicate key is the tuple:
    //   (patient, normalized vaccine_name, normalized date, dose_number)
    // where `dose_number` distinguishes legitimate repeat doses of the same
    // vaccine on the same date.
    let normalized_vaccine = normalize_vaccine_name(env, &vaccine_name);
    let normalized_date = normalize_date(env, &date_administered);

    // Deterministically derive a token ID from the patient, normalized vaccine,
    // normalized date, issuer, and ledger sequence. This is used for duplicate
    // detection and is checked atomically within this transaction.
    let ledger_sequence = env.ledger().sequence();
    let token_id = compute_token_id(
        env,
        &patient,
        &normalized_vaccine,
        &normalized_date,
        &issuer,
        ledger_sequence,
    );

    // Duplicate detection by exact token ID. If this token already exists,
    // the same vaccination record has already been minted.
    if env.storage().persistent().has(&DataKey::Token(token_id)) {
        return Err(ContractError::DuplicateRecord);
    }

    // Load all tokens already associated with the patient.
    let tokens: Vec<u64> = env
        .storage()
        .persistent()
        .get(&DataKey::PatientTokens(patient.clone()))
        .unwrap_or(Vec::new(env));

    // In addition to token-based duplicate detection, ensure the patient does not
    // already have a record with the same normalized vaccine name, normalized
    // administration date, and dose number. Differing dose numbers are treated
    // as legitimate repeat doses and are allowed.
    for i in 0..tokens.len() {
        let tid = tokens.get(i).unwrap();
        let record: VaccinationRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Token(tid))
            .unwrap();
        let existing_vaccine = normalize_vaccine_name(env, &record.vaccine_name);
        let existing_date = normalize_date(env, &record.date_administered);
        if existing_vaccine == normalized_vaccine
            && existing_date == normalized_date
            && record.dose_number == dose_number
        {
            return Err(ContractError::DuplicateRecord);
        }
    }

    // Enforce a per-patient record cap to prevent unbounded storage growth.
    let limit: u32 = env
        .storage()
        .persistent()
        .get(&DataKey::PatientRecordLimit)
        .unwrap_or(50u32);
    if tokens.len() >= limit {
        panic!("record limit exceeded");
    }

    // Build the vaccination record and persist it under DataKey::Token(token_id).
    // The normalized vaccine name and date are stored so the duplicate key is
    // consistent across API and contract.
    let record = VaccinationRecord {
        token_id,
        patient: patient.clone(),
        vaccine_name: normalized_vaccine.clone(),
        date_administered: normalized_date,
        issuer: issuer.clone(),
        timestamp: env.ledger().timestamp(),
        schema_version: 1,
        revoked: false,
        dose_number,
        dose_series,
    };

    // Persist the token record.
    env.storage().persistent().set(&DataKey::Token(token_id), &record);

    // Append the minted token to the patient's token list.
    let mut patient_tokens = tokens;
    patient_tokens.push_back(token_id);
    env.storage().persistent().set(&DataKey::PatientTokens(patient.clone()), &patient_tokens);

    events::emit_minted(env, token_id, &patient, &normalized_vaccine, &issuer);

    Ok(token_id)
}
