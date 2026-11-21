use soroban_sdk::{Env, Address, Vec, contracttype, String};
use crate::storage::{DataKey, VaccinationRecord};

/// Maximum number of wallets accepted by `batch_verify`.
///
/// Kept as a `u32` so it can be compared directly against `Vec::len()` without
/// any narrowing/widening casts. The value is a small compile-time constant, so
/// no overflow is possible in the comparison below.
const MAX_BATCH_SIZE: u32 = 100;

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

/// Batch verify vaccination status for multiple wallets.
///
/// This function is an optimized convenience wrapper for `verify_vaccination`.
/// It succeeds for up to `MAX_BATCH_SIZE` wallets and returns a tuple for each wallet:
/// `(wallet, vaccinated, records)`.
///
/// # Arguments
/// * `env` - The Soroban environment.
/// * `wallets` - Vector of wallet addresses to verify.
///
/// # Returns
/// * `Vec<(Address, bool, Vec<VaccinationRecord>)>` where the bool indicates whether the wallet has any active vaccination records.
pub fn batch_verify(env: &Env, wallets: Vec<Address>) -> Vec<(Address, bool, Vec<VaccinationRecord>)> {
    // `wallets.len()` is bounded by the host's vec length (u32). Comparing it
    // against the constant MAX_BATCH_SIZE is a plain, non-overflowing check.
    assert!(wallets.len() <= MAX_BATCH_SIZE, "batch size exceeds maximum of 100");

    let mut results: Vec<(Address, bool, Vec<VaccinationRecord>)> = Vec::new(env);
    // Iteration is bounded by `wallets.len()`, which is <= MAX_BATCH_SIZE, so
    // the loop counter cannot overflow and the result vec stays small.
    for i in 0..wallets.len() {
        let wallet = wallets.get(i).unwrap();
        let (vaccinated, records, _) = verify_vaccination(env, wallet.clone());
        results.push_back((wallet, vaccinated, records));
    }
    results
}

/// Verify vaccination status for a single wallet.
///
/// Returns whether the wallet has at least one active (non-revoked) record, the
/// list of active vaccination records, and a per-vaccine dose completion summary.
///
/// # Arguments
/// * `env` - The Soroban environment.
/// * `wallet` - The wallet address to check.
///
/// # Returns
/// * `(bool, Vec<VaccinationRecord>, Vec<DoseStatus>)`
///   - bool: wallet has at least one active record
///   - Vec<VaccinationRecord>: active vaccination records
///   - Vec<DoseStatus>: per-vaccine dose completion summary
pub fn verify_vaccination(env: &Env, wallet: Address) -> (bool, Vec<VaccinationRecord>, Vec<DoseStatus>) {
    let tokens: Vec<u64> = env
        .storage()
        .persistent()
        .get(&DataKey::PatientTokens(wallet.clone()))
        .unwrap_or(Vec::new(env));

    if tokens.is_empty() {
        return (false, Vec::new(env), Vec::new(env));
    }

    let mut records: Vec<VaccinationRecord> = Vec::new(env);
    let mut has_active = false;

    // Load all active (non-revoked) records for the wallet.
    for i in 0..tokens.len() {
        let tid = tokens.get(i).unwrap();
        if let Some(record) = env.storage().persistent().get::<DataKey, VaccinationRecord>(&DataKey::Token(tid)) {
            if !record.revoked {
                has_active = true;
                records.push_back(record);
            }
        }
    }

    // Build per-vaccine dose status.
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
    use soroban_sdk::{Env, String, Vec};

    fn make_record(
        env: &Env,
        vaccine_name: &str,
        dose_number: Option<u32>,
        dose_series: Option<u32>,
        revoked: bool,
    ) -> VaccinationRecord {
        VaccinationRecord {
            vaccine_name: String::from_str(env, vaccine_name),
            dose_number,
            dose_series,
            revoked,
            // Remaining fields are not exercised by verify_vaccination.
            ..Default::default()
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
    fn batch_verify_accepts_exactly_max_batch_size() {
        let env = Env::default();
        let mut wallets: Vec<Address> = Vec::new(&env);
        for _ in 0..MAX_BATCH_SIZE {
            wallets.push_back(Address::generate(&env));
        }
        // Boundary: exactly MAX_BATCH_SIZE must succeed.
        let results = batch_verify(&env, wallets);
        assert_eq!(results.len(), MAX_BATCH_SIZE);
    }

    #[test]
    #[should_panic(expected = "batch size exceeds maximum of 100")]
    fn batch_verify_rejects_max_batch_size_plus_one() {
        let env = Env::default();
        let mut wallets: Vec<Address> = Vec::new(&env);
        for _ in 0..(MAX_BATCH_SIZE + 1) {
            wallets.push_back(Address::generate(&env));
        }
        batch_verify(&env, wallets);
    }

    #[test]
    fn verify_handles_max_dose_values() {
        let env = Env::default();
        let wallet = Address::generate(&env);
        store_record(
            &env,
            &wallet,
            1,
            make_record(&env, "COVID", Some(u32::MAX), Some(u32::MAX), false),
        );

        let (vaccinated, records, statuses) = verify_vaccination(&env, wallet);
        assert!(vaccinated);
        assert_eq!(records.len(), 1);
        assert_eq!(statuses.len(), 1);
        let status = statuses.get(0).unwrap();
        assert_eq!(status.doses_received, u32::MAX);
        assert_eq!(status.doses_required, u32::MAX);
        assert!(status.complete);
    }

    #[test]
    fn verify_handles_zero_and_missing_dose_values() {
        let env = Env::default();
        let wallet = Address::generate(&env);
        store_record(&env, &wallet, 1, make_record(&env, "Flu", Some(0), Some(0), false));
        store_record(&env, &wallet, 2, make_record(&env, "Flu", None, None, false));

        let (vaccinated, _, statuses) = verify_vaccination(&env, wallet);
        assert!(vaccinated);
        assert_eq!(statuses.len(), 1);
        let status = statuses.get(0).unwrap();
        assert_eq!(status.doses_received, 0);
        assert_eq!(status.doses_required, 0);
        // A zero required dose count is never considered complete.
        assert!(!status.complete);
    }

    #[test]
    fn verify_ignores_revoked_records_for_dose_status() {
        let env = Env::default();
        let wallet = Address::generate(&env);
        store_record(
            &env,
            &wallet,
            1,
            make_record(&env, "COVID", Some(u32::MAX), Some(u32::MAX), true),
        );

        let (vaccinated, records, statuses) = verify_vaccination(&env, wallet);
        assert!(!vaccinated);
        assert_eq!(records.len(), 0);
        assert_eq!(statuses.len(), 0);
    }
}
