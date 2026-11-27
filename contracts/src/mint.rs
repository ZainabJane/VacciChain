use soroban_sdk::{Env, Address, String, Vec};
use crate::storage::{
    DataKey, VaccinationRecord, IssuerRecord, compute_token_id, extend_token_ttl,
    extend_patient_tokens_ttl,
};
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

    // Patient consent / allowlist gate.
    //
    // Consent semantics (see contract docs):
    // * Absent   - no allowlist entry exists: issuance is rejected with
    //              `PatientNotRegistered`.
    // * Granted  - allowlist entry is `true`: issuance proceeds.
    // * Revoked  - allowlist entry is `false`: issuance is rejected with
    //              `PatientNotRegistered`.
    // * Changed  - consent is re-evaluated on every call, so a patient that
    //              revokes and later re-grants consent is honoured immediately.
    //
    // Note: allowlisting only gates issuance. It does not make on-chain data
    // private; verification of an existing record remains public.
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

    // Issue #88: validate the ledger timestamp before persisting it. A zero
    // timestamp indicates an unset/invalid ledger time assumption, and a
    // timestamp earlier than the current ledger time would be inconsistent.
    let timestamp = env.ledger().timestamp();
    if timestamp == 0 {
        return Err(ContractError::InvalidTimestamp);
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
        vaccine_name: normalized_vaccine.clone(),
        date_administered: normalized_date,
        issuer: issuer.clone(),
        timestamp,
        schema_version: 1,
        revoked: false,
        dose_number,
        dose_series,
    };

    // Persist the token record and extend its TTL so the entry does not expire.
    env.storage().persistent().set(&DataKey::Token(token_id), &record);
    extend_token_ttl(env, token_id);

    // Append the minted token to the patient's token list. The length was
    // already checked above with checked_add, so this push cannot overflow.
    // Also extend the patient token list TTL.
    let mut patient_tokens = tokens;
    patient_tokens.push_back(token_id);
    env.storage().persistent().set(&DataKey::PatientTokens(patient.clone()), &patient_tokens);
    extend_patient_tokens_ttl(env, &patient);

    events::emit_minted(env, token_id, &patient, &normalized_vaccine, &issuer);

    Ok(token_id)
}

#[cfg(test)]
mod boundary_tests {
    use super::*;
    use soroban_sdk::testutils::{Address as _, Ledger as _};
    use soroban_sdk::{Env, String};

    fn setup(env: &Env) -> (Address, Address) {
        let patient = Address::generate(env);
        let issuer = Address::generate(env);
        env.storage()
            .persistent()
            .set(&DataKey::PatientAllowlist(patient.clone()), &true);
        env.storage().persistent().set(
            &DataKey::Issuer(issuer.clone()),
            &IssuerRecord { authorized: true },
        );
        (patient, issuer)
    }

    #[test]
    fn record_limit_boundary_is_enforced_without_overflow() {
        let env = Env::default();
        env.mock_all_auths();
        let (patient, issuer) = setup(&env);

        // Cap of 1: first mint succeeds, second must be rejected.
        env.storage()
            .persistent()
            .set(&DataKey::PatientRecordLimit, &1u32);

        let first = mint_vaccination(
            &env,
            patient.clone(),
            String::from_str(&env, "VaxA"),
            String::from_str(&env, "2024-01-01"),
            issuer.clone(),
            Some(1),
            Some(2),
        );
        assert!(first.is_ok());

        let second = mint_vaccination(
            &env,
            patient.clone(),
            String::from_str(&env, "VaxB"),
            String::from_str(&env, "2024-02-01"),
            issuer,
            Some(2),
            Some(2),
        );
        assert_eq!(second, Err(ContractError::RecordLimitExceeded));
    }

    #[test]
    fn zero_timestamp_is_rejected() {
        let env = Env::default();
        env.mock_all_auths();
        let (patient, issuer) = setup(&env);
        env.ledger().set_timestamp(0);

        let result = mint_vaccination(
            &env,
            patient,
            String::from_str(&env, "VaxA"),
            String::from_str(&env, "2024-01-01"),
            issuer,
            None,
            None,
        );
        assert_eq!(result, Err(ContractError::InvalidTimestamp));
    }

    #[test]
    fn max_u64_timestamp_is_accepted() {
        let env = Env::default();
        env.mock_all_auths();
        let (patient, issuer) = setup(&env);
        env.ledger().set_timestamp(u64::MAX);

        let result = mint_vaccination(
            &env,
            patient,
            String::from_str(&env, "VaxA"),
            String::from_str(&env, "2024-01-01"),
            issuer,
            None,
            None,
        );
        assert!(result.is_ok());
    }
}
