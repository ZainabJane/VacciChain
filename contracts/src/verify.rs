use soroban_sdk::{Env, Address, Vec, contracttype, String};
use crate::storage::{DataKey, VaccinationRecord};

const MAX_BATCH_SIZE: u32 = 100;

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
/// The returned records are `PublicVaccinationRecord` projections: only the
/// allowlisted public fields are revealed. Revoked records are excluded.
///
/// # Arguments
/// * `env` - The Soroban environment.
/// * `wallets` - Vector of wallet addresses to verify.
///
/// # Returns
/// * `Vec<(Address, bool, Vec<PublicVaccinationRecord>)>` where the bool indicates whether the wallet has any active vaccination records.
pub fn batch_verify(env: &Env, wallets: Vec<Address>) -> Vec<(Address, bool, Vec<PublicVaccinationRecord>)> {
    assert!(wallets.len() <= MAX_BATCH_SIZE, "batch size exceeds maximum of 100");

    let mut results: Vec<(Address, bool, Vec<PublicVaccinationRecord>)> = Vec::new(env);
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
/// list of active vaccination records projected to the public field set, and a
/// per-vaccine dose completion summary.
///
/// Consent and allowlisting semantics: verification only reads records that are
/// present and not revoked. Absent consent yields no records; revoked consent
/// (revoked records) is excluded from both the record list and dose summaries.
/// Because this is a public-chain read, callers must assume the returned fields
/// are publicly visible; prohibited fields are never included.
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
pub fn verify_vaccination(env: &Env, wallet: Address) -> (bool, Vec<PublicVaccinationRecord>, Vec<DoseStatus>) {
    let tokens: Vec<u64> = env
        .storage()
        .persistent()
        .get(&DataKey::PatientTokens(wallet.clone()))
        .unwrap_or(Vec::new(env));

    if tokens.is_empty() {
        return (false, Vec::new(env), Vec::new(env));
    }

    let mut records: Vec<PublicVaccinationRecord> = Vec::new(env);
    let mut has_active = false;

    // Load all active (non-revoked) records for the wallet, projecting each to
    // the public field set so prohibited fields are never returned.
    for i in 0..tokens.len() {
        let tid = tokens.get(i).unwrap();
        if let Some(record) = env.storage().persistent().get::<DataKey, VaccinationRecord>(&DataKey::Token(tid)) {
            if !record.revoked {
                has_active = true;
                records.push_back(to_public_record(tid, &record));
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
        let dn = rec.dose_number.unwrap_or(0);
        let ds = rec.dose_series.unwrap_or(0);

        let mut found = false;
        for j in 0..vaccine_names.len() {
            if vaccine_names.get(j).unwrap() == rec.vaccine_name {
                let prev_dn = doses_received.get(j).unwrap();
                let prev_ds = doses_required.get(j).unwrap();
                if dn > prev_dn {
                    doses_received.set(j, dn);
                }
                if ds > prev_ds {
                    doses_required.set(j, ds);
                }
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
