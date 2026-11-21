use soroban_sdk::{Env, Address, Vec, contracttype, String};
use crate::storage::{DataKey, VaccinationRecord};

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
/// Revocation semantics: revocation is **record-level** and **irreversible**.
/// A revoked record is never returned in the active records list and never
/// contributes to dose status, so a wallet with one revoked record among
/// several still verifies as vaccinated based on its remaining active records.
///
/// # Arguments
/// * `env` - The Soroban environment.
/// * `wallets` - Vector of wallet addresses to verify.
///
/// # Returns
/// * `Vec<(Address, bool, Vec<VaccinationRecord>)>` where the bool indicates whether the wallet has any active (non-revoked) vaccination records.
pub fn batch_verify(env: &Env, wallets: Vec<Address>) -> Vec<(Address, bool, Vec<VaccinationRecord>)> {
    assert!(wallets.len() <= MAX_BATCH_SIZE, "batch size exceeds maximum of 100");

    let mut results: Vec<(Address, bool, Vec<VaccinationRecord>)> = Vec::new(env);
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
/// * `(bool, Vec<VaccinationRecord>, Vec<DoseStatus>)`
///   - bool: wallet has at least one active (non-revoked) record
///   - Vec<VaccinationRecord>: active (non-revoked) vaccination records only
///   - Vec<DoseStatus>: per-vaccine dose completion summary derived from active records only
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
    // Revocation is record-level and irreversible: revoked records are skipped
    // entirely and never surface in the active records list or dose status.
    for i in 0..tokens.len() {
        let tid = tokens.get(i).unwrap();
        if let Some(record) = env.storage().persistent().get::<DataKey, VaccinationRecord>(&DataKey::Token(tid)) {
            if record.revoked {
                continue;
            }
            has_active = true;
            records.push_back(record);
        }
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
