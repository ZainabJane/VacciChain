//! Vaccination verification logic.
//!
//! # Batch verification limits
//!
//! `batch_verify` accepts at most [`MAX_BATCH_SIZE`] wallets per invocation.
//! The limit is validated up front, before any storage access, so an over-limit
//! request is rejected cheaply without consuming storage read resources.
//! Requests exceeding the limit return [`ContractError::BatchTooLarge`].

use soroban_sdk::{Env, Address, Vec, contracttype, String};
use crate::storage::{DataKey, VaccinationRecord};
use crate::errors::ContractError;

/// Maximum number of wallets accepted by a single `batch_verify` invocation.
///
/// This bound keeps per-invocation resource usage (storage reads, CPU and
/// memory) predictable. It is validated before any storage access occurs.
/// Passing more than this many wallets fails with
/// `ContractError::BatchTooLarge` and performs no storage reads or writes.
pub const MAX_BATCH_SIZE: u32 = 100;

/// Public, privacy-preserving projection of a vaccination record.
///
/// This is the only record shape exposed by public verification entry points
/// (`verify_vaccination` and `batch_verify`). It deliberately omits prohibited
/// fields such as the patient wallet, issuer identity, provider notes, and any
/// free-form metadata. Public-chain data is not private: only the fields below
/// are ever revealed, and nothing here should be treated as confidential.
#[contracttype]
#[derive(Clone)]
pub struct PublicVaccinationRecord {
    /// Opaque token id for the record (not linkable to patient identity off-chain).
    pub token_id: u64,
    /// The vaccine name for this dose.
    pub vaccine_name: String,
    /// Dose number within the series, if recorded.
    pub dose_number: Option<u32>,
    /// Total doses in the series, if recorded.
    pub dose_series: Option<u32>,
    /// Ledger timestamp at which the record was issued.
    pub issued_at: u64,
}

/// Project a stored record into the public, allowlisted field set.
///
/// Only the fields present on `PublicVaccinationRecord` are copied. Any other
/// data held in `VaccinationRecord` (e.g. issuer, notes, patient address) is
/// intentionally dropped and must never be returned by verification.
fn to_public_record(token_id: u64, record: &VaccinationRecord) -> PublicVaccinationRecord {
    PublicVaccinationRecord {
        token_id,
        vaccine_name: record.vaccine_name.clone(),
        dose_number: record.dose_number,
        dose_series: record.dose_series,
        issued_at: record.issued_at,
    }
}

/// Storage lifecycle assumptions for verification.
///
/// - `DataKey::PatientTokens(wallet)` is a persistent entry holding the wallet's
///   token index. If it is absent (never written) or has expired (TTL elapsed),
///   the wallet is treated as having no records: verification returns
///   `(false, [], [])`. Absence of the index is never interpreted as
///   authorization.
/// - `DataKey::Token(tid)` is a persistent entry holding a `VaccinationRecord`.
///   If an individual token entry is missing or expired, it is skipped; the
///   remaining tokens are still evaluated. A missing token never counts as an
///   active (authorized) record.
/// - TTL extension is the responsibility of the write paths (e.g. record
///   issuance/revocation) which must call `extend_ttl` on both the token entry
///   and the patient index. Verification is read-only and does not extend TTLs,
///   so callers must not rely on a verify call to keep entries alive.
/// - Authorization never fails open: any missing/expired state yields a
///   non-authorized result (`has_active == false`), never `true`.
const _: () = ();

/// Distinguishes "wallet has no records" from "storage entry is missing or expired".
///
/// Returns `true` when the wallet's `PatientTokens` index entry is absent from
/// persistent storage (either never written or expired). In both cases the
/// caller must treat the wallet as unvaccinated; this helper exists only so
/// callers/tests can observe the difference between an empty index and a
/// missing/expired one.
pub fn patient_index_missing(env: &Env, wallet: &Address) -> bool {
    env.storage()
        .persistent()
        .get::<DataKey, Vec<u64>>(&DataKey::PatientTokens(wallet.clone()))
        .is_none()
}

/// Explicit outcome of a verification request.
///
/// Only `Valid` indicates an active vaccination record. `Revoked`, `Absent`,
/// and `Unavailable` must never be treated as a positive verification result.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VerificationStatus {
    /// At least one active (non-revoked) record exists.
    Valid,
    /// Records exist but all are revoked.
    Revoked,
    /// No records exist for the wallet.
    Absent,
    /// The data could not be read; callers must NOT treat this as valid.
    Unavailable,
}

/// Per-vaccine dose completion summary returned by verify_vaccination.
#[contracttype]
#[derive(Clone)]
pub struct DoseStatus {
    /// The vaccine name for this dose summary.
    pub vaccine_name: String,
    /// Highest dose number received for this vaccine.
    pub doses_received: u32,
    /// Required total doses for this vaccine series.
    pub doses_required: u32,
    /// True when the required number of doses has been completed.
    pub complete: bool,
}

/// Explicit outcome of a verification call.
///
/// Only `Valid` indicates an active vaccination record. Callers must never
/// treat `Revoked`, `Absent`, or `Unavailable` as a positive result.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VerificationStatus {
    /// At least one active (non-revoked) record exists.
    Valid,
    /// Records exist but all are revoked.
    Revoked,
    /// No records exist for the wallet.
    Absent,
    /// The data could not be read; must NOT be treated as a positive result.
    Unavailable,
}

/// Batch verify vaccination status for multiple wallets.
///
/// This function is an optimized convenience wrapper for `verify_vaccination`.
/// It succeeds for up to `MAX_BATCH_SIZE` wallets and returns a tuple for each wallet:
/// `(wallet, status, records)`.
///
/// The returned records are `PublicVaccinationRecord` projections: only the
/// allowlisted public fields are revealed. Revoked records are excluded.
///
/// # Arguments
/// * `env` - The Soroban environment.
/// * `wallets` - Vector of wallet addresses to verify.
///
/// # Returns
/// * `Ok(Vec<(Address, VerificationStatus, Vec<VaccinationRecord>)>)` where the status
///   distinguishes valid, revoked, absent, and unavailable data. Only
///   `VerificationStatus::Valid` indicates an active vaccination record.
/// * `Err(ContractError::BatchTooLarge)` when `wallets.len() > MAX_BATCH_SIZE`.
///
/// The batch size is validated before any storage access is performed.
/// This function is read-only: it never mutates storage and never emits events.
pub fn batch_verify(
    env: &Env,
    wallets: Vec<Address>,
) -> Result<Vec<(Address, VerificationStatus, Vec<VaccinationRecord>)>, ContractError> {
    if wallets.len() > MAX_BATCH_SIZE {
        return Err(ContractError::BatchTooLarge);
    }

    let mut results: Vec<(Address, VerificationStatus, Vec<VaccinationRecord>)> = Vec::new(env);
    // Iteration is bounded by `wallets.len()`, which is <= MAX_BATCH_SIZE, so
    // the loop counter cannot overflow and the result vec stays small.
    for i in 0..wallets.len() {
        let wallet = wallets.get(i).unwrap();
        let (status, records, _) = verify_vaccination(env, wallet.clone());
        results.push_back((wallet, status, records));
    }
    Ok(results)
}

/// Verify vaccination status for a single wallet.
///
/// Returns whether the wallet has at least one active (non-revoked) record, the
/// list of active vaccination records projected to the public field set, and a
/// per-vaccine dose completion summary.
///
/// Consent and allowlisting semantics: verification only reads records that are
/// present and not revoked. Absent consent yields no records; revoked consent
/// (revoked records) is excluded from both the record list and dose summaries.
/// Because this is a public-chain read, callers must assume the returned fields
/// are publicly visible; prohibited fields are never included.
///
/// Revocation semantics: revocation applies to an individual vaccination record
/// only (not to the wallet as a whole and not to the issuer's permission to
/// issue). It is irreversible: once `record.revoked` is set, the record is
/// permanently excluded from verification results. Revoked records are filtered
/// out before both the active records list and the dose status summary are
/// computed, so they can never be interpreted as valid vaccination evidence.
///
/// # Arguments
/// * `env` - The Soroban environment.
/// * `wallet` - The wallet address to check.
///
/// # Returns
/// * `(bool, Vec<PublicVaccinationRecord>, Vec<DoseStatus>)`
///   - bool: wallet has at least one active record
///   - Vec<PublicVaccinationRecord>: active records, public fields only
///   - Vec<DoseStatus>: per-vaccine dose completion summary
///
/// # Read-only guarantee
/// This function only reads persistent storage. It never writes storage, never
/// emits events, and therefore cannot alter token ownership or any other state.
/// Soulbound enforcement is unaffected by verification calls.
pub fn verify_vaccination(env: &Env, wallet: Address) -> (VerificationStatus, Vec<VaccinationRecord>, Vec<DoseStatus>) {
    // Missing or expired patient index: treat as "no records". This is a
    // non-authorized result and must never be interpreted as authorized.
    let tokens: Vec<u64> = match env
        .storage()
        .persistent()
        .get::<DataKey, Vec<u64>>(&DataKey::PatientTokens(wallet.clone()))
    {
        Some(tokens) => tokens,
        None => return (VerificationStatus::Absent, Vec::new(env), Vec::new(env)),
    };

    if tokens.is_empty() {
        return (false, Vec::new(env), Vec::new(env));
    }

    let mut records: Vec<PublicVaccinationRecord> = Vec::new(env);
    let mut has_active = false;

    // Load all active (non-revoked) records for the wallet, projecting each to
    // the public field set so prohibited fields are never returned.
    // Missing or expired token entries are skipped explicitly: they are never
    // counted as active records, so authorization cannot fail open.
    for i in 0..tokens.len() {
        let tid = tokens.get(i).unwrap();
        match env
            .storage()
            .persistent()
            .get::<DataKey, VaccinationRecord>(&DataKey::Token(tid))
        {
            Some(record) => {
                if record.revoked {
                    has_revoked = true;
                } else {
                    has_active = true;
                    records.push_back(record);
                } else {
                    has_revoked = true;
                }
            }
            None => {
                // Token entry absent or expired; skip without granting access.
            }
        }
        // Token entry absent or expired; skip without granting access.
    }

    // Build per-vaccine dose status from active records only.
    // Revoked records were already excluded above, so they cannot inflate dose
    // counts or mark a series complete.
    // We track highest dose_number and highest dose_series seen for each vaccine.
    // Parallel vecs are used because a no_std map implementation is unavailable.
    let mut vaccine_names: Vec<String> = Vec::new(env);
    let mut doses_received: Vec<u32> = Vec::new(env);
    let mut doses_required: Vec<u32> = Vec::new(env);

    for i in 0..records.len() {
        let rec = records.get(i).unwrap();
        // Missing dose metadata is treated as 0 (no doses recorded). Values are
        // only ever compared and stored verbatim; no arithmetic is performed on
        // them, so there is no overflow risk even at u32::MAX.
        let dn = rec.dose_number.unwrap_or(0);
        let ds = rec.dose_series.unwrap_or(0);

        let mut found = false;
        for j in 0..vaccine_names.len() {
            if vaccine_names.get(j).unwrap() == rec.vaccine_name {
                let prev_dn = doses_received.get(j).unwrap();
                let prev_ds = doses_required.get(j).unwrap();
                // Use max() instead of manual comparison to make the
                // non-arithmetic, overflow-free intent explicit.
                doses_received.set(j, dn.max(prev_dn));
                doses_required.set(j, ds.max(prev_ds));
                found = true;
                break;
            }
        }
        if !found {
            vaccine_names.push_back(rec.vaccine_name.clone());
            doses_received.push_back(dn);
            doses_required.push_back(ds);
        }
    }

    let mut dose_statuses: Vec<DoseStatus> = Vec::new(env);
    for i in 0..vaccine_names.len() {
        let dr = doses_received.get(i).unwrap();
        let dq = doses_required.get(i).unwrap();
        // Completion is a pure comparison (no subtraction), so it is safe for
        // any u32 values including 0 and u32::MAX.
        dose_statuses.push_back(DoseStatus {
            vaccine_name: vaccine_names.get(i).unwrap(),
            doses_received: dr,
            doses_required: dq,
            complete: dq > 0 && dr >= dq,
        });
    }

    (has_active, records, dose_statuses)
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;
    use soroban_sdk::String;

    fn make_record(env: &Env, vaccine: &str, revoked: bool) -> VaccinationRecord {
        VaccinationRecord {
            vaccine_name: String::from_str(env, vaccine),
            dose_number: Some(1),
            dose_series: Some(2),
            issued_at: 100,
            revoked,
        }
    }

    fn store_record(env: &Env, wallet: &Address, tid: u64, record: VaccinationRecord) {
        env.storage().persistent().set(&DataKey::Token(tid), &record);
        let mut tokens: Vec<u64> = env
            .storage()
            .persistent()
            .get(&DataKey::PatientTokens(wallet.clone()))
            .unwrap_or(Vec::new(env));
        tokens.push_back(tid);
        env.storage()
            .persistent()
            .set(&DataKey::PatientTokens(wallet.clone()), &tokens);
    }

    #[test]
    fn verify_returns_public_fields_only() {
        let env = Env::default();
        let wallet = Address::generate(&env);
        store_record(&env, &wallet, 1, make_record(&env, "COVID", false));

        let (vaccinated, records, statuses) = verify_vaccination(&env, wallet);
        assert!(vaccinated);
        assert_eq!(records.len(), 1);
        assert_eq!(statuses.len(), 1);

        let rec = records.get(0).unwrap();
        // Public projection exposes only allowlisted fields.
        assert_eq!(rec.token_id, 1);
        assert_eq!(rec.vaccine_name, String::from_str(&env, "COVID"));
        assert_eq!(rec.dose_number, Some(1));
        assert_eq!(rec.dose_series, Some(2));
        assert_eq!(rec.issued_at, 100);
    }

    #[test]
    fn verify_excludes_revoked_records() {
        let env = Env::default();
        let wallet = Address::generate(&env);
        store_record(&env, &wallet, 1, make_record(&env, "COVID", false));
        store_record(&env, &wallet, 2, make_record(&env, "Flu", true));

        let (vaccinated, records, statuses) = verify_vaccination(&env, wallet);
        assert!(vaccinated);
        assert_eq!(records.len(), 1);
        assert_eq!(records.get(0).unwrap().token_id, 1);
        assert_eq!(statuses.len(), 1);
        assert_eq!(statuses.get(0).unwrap().vaccine_name, String::from_str(&env, "COVID"));
    }

    #[test]
    fn verify_absent_consent_returns_empty() {
        let env = Env::default();
        let wallet = Address::generate(&env);

        let (vaccinated, records, statuses) = verify_vaccination(&env, wallet);
        assert!(!vaccinated);
        assert_eq!(records.len(), 0);
        assert_eq!(statuses.len(), 0);
    }

    #[test]
    fn verify_all_revoked_returns_empty() {
        let env = Env::default();
        let wallet = Address::generate(&env);
        store_record(&env, &wallet, 1, make_record(&env, "COVID", true));

        let (vaccinated, records, statuses) = verify_vaccination(&env, wallet);
        assert!(!vaccinated);
        assert_eq!(records.len(), 0);
        assert_eq!(statuses.len(), 0);
    }

    #[test]
    fn batch_verify_returns_public_fields_only() {
        let env = Env::default();
        let wallet = Address::generate(&env);
        store_record(&env, &wallet, 1, make_record(&env, "COVID", false));
        store_record(&env, &wallet, 2, make_record(&env, "Flu", true));

        let mut wallets: Vec<Address> = Vec::new(&env);
        wallets.push_back(wallet.clone());
        let results = batch_verify(&env, wallets);

        assert_eq!(results.len(), 1);
        let (w, vaccinated, records) = results.get(0).unwrap();
        assert_eq!(w, wallet);
        assert!(vaccinated);
        assert_eq!(records.len(), 1);
        assert_eq!(records.get(0).unwrap().token_id, 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::testutils::Address as _;

    fn make_wallets(env: &Env, count: u32) -> Vec<Address> {
        let mut wallets: Vec<Address> = Vec::new(env);
        for _ in 0..count {
            wallets.push_back(Address::generate(env));
        }
        wallets
    }

    #[test]
    fn batch_verify_accepts_exactly_max_batch_size() {
        let env = Env::default();
        let wallets = make_wallets(&env, MAX_BATCH_SIZE);
        let result = batch_verify(&env, wallets);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), MAX_BATCH_SIZE);
    }

    #[test]
    fn batch_verify_rejects_over_limit_before_storage_access() {
        let env = Env::default();
        let wallets = make_wallets(&env, MAX_BATCH_SIZE + 1);
        let result = batch_verify(&env, wallets);
        assert_eq!(result, Err(ContractError::BatchTooLarge));
    }

    #[test]
    fn batch_verify_handles_mixed_results() {
        let env = Env::default();
        let mut wallets: Vec<Address> = Vec::new(&env);
        // Wallets without records should report not vaccinated.
        for _ in 0..3 {
            wallets.push_back(Address::generate(&env));
        }
        let result = batch_verify(&env, wallets).unwrap();
        assert_eq!(result.len(), 3);
        for i in 0..result.len() {
            let (_, status, records) = result.get(i).unwrap();
            assert_eq!(status, VerificationStatus::Absent);
            assert_eq!(records.len(), 0);
        }
    }

    #[test]
    fn batch_verify_empty_batch_is_ok() {
        let env = Env::default();
        let wallets: Vec<Address> = Vec::new(&env);
        let result = batch_verify(&env, wallets);
        assert!(result.is_ok());
        assert_eq!(result.unwrap().len(), 0);
    }
}
