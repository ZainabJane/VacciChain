use soroban_sdk::{Env, Address, String, Vec};
use crate::storage::{DataKey, VaccinationRecord, IssuerRecord, compute_token_id};
use crate::events;
use crate::ContractError;
use crate::validate_input_length;

/// Maximum number of vaccination records a single patient may hold.
/// Documented bound for the `PatientTokens` collection (see field policy).
pub const MAX_RECORDS_PER_PATIENT: u32 = 50;

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
    // Enforce documented maximum lengths before any storage access so that
    // oversized inputs fail fast without mutating state or emitting events.
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

    // Deterministically derive a token ID from the patient, vaccine, date,
    // issuer, and ledger sequence. This is used for duplicate detection.
    let ledger_sequence = env.ledger().sequence();
    let token_id = compute_token_id(
        env,
        &patient,
        &vaccine_name,
        &date_administered,
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
    // already have a record with the same vaccine name and administration date.
    for i in 0..tokens.len() {
        let tid = tokens.get(i).unwrap();
        let record: VaccinationRecord = env
            .storage()
            .persistent()
            .get(&DataKey::Token(tid))
            .unwrap();
        if record.vaccine_name == vaccine_name && record.date_administered == date_administered {
            return Err(ContractError::DuplicateRecord);
        }
    }

    // Enforce a per-patient record cap to prevent unbounded storage growth.
    // This check occurs before any persistent write; exceeding the cap is a
    // recoverable error rather than a panic so no state is mutated and no
    // events are emitted on the failure path.
    let limit: u32 = env
        .storage()
        .persistent()
        .get(&DataKey::PatientRecordLimit)
        .unwrap_or(MAX_RECORDS_PER_PATIENT);
    if tokens.len() >= limit {
        return Err(ContractError::RecordLimitExceeded);
    }

    // Build the vaccination record and persist it under DataKey::Token(token_id).
    //
    // Field policy (privacy-safe on-chain schema): only the fields below are
    // stored. No patient name, contact data, or unnecessary clinical details
    // are persisted; the patient is referenced solely by wallet address and
    // the vaccine is referenced by a bounded identifier string.
    let record = VaccinationRecord {
        token_id,
        patient: patient.clone(),
        vaccine_name: vaccine_name.clone(),
        date_administered,
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

    events::emit_minted(env, token_id, &patient, &vaccine_name, &issuer);

    Ok(token_id)
}
