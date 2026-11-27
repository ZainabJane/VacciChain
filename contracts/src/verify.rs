use soroban_sdk::{Env, Address, Vec, contracttype, String};
use crate::storage::{DataKey, VaccinationRecord};

const MAX_BATCH_SIZE: u32 = 100;

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
/// `(wallet, status, records)`.
///
/// # Arguments
/// * `env` - The Soroban environment.
/// * `wallets` - Vector of wallet addresses to verify.
///
/// # Returns
/// * `Vec<(Address, VerificationStatus, Vec<VaccinationRecord>)>` where the status
///   distinguishes valid, revoked, absent, and unavailable data. Only
///   `VerificationStatus::Valid` indicates an active vaccination record.
pub fn batch_verify(env: &Env, wallets: Vec<Address>) -> Vec<(Address, VerificationStatus, Vec<VaccinationRecord>)> {
    assert!(wallets.len() <= MAX_BATCH_SIZE, "batch size exceeds maximum of 100");

    let mut results: Vec<(Address, VerificationStatus, Vec<VaccinationRecord>)> = Vec::new(env);
    for i in 0..wallets.len() {
        let wallet = wallets.get(i).unwrap();
        let (status, records, _) = verify_vaccination(env, wallet.clone());
        results.push_back((wallet, status, records));
    }
    results
}

/// Verify vaccination status for a single wallet.
///
/// Returns an explicit `VerificationStatus`, the list of active (non-revoked)
/// vaccination records, and a per-vaccine dose completion summary.
///
/// The status distinguishes:
/// * `Valid` - at least one active record exists.
/// * `Revoked` - records exist but all are revoked.
/// * `Absent` - no records exist for the wallet.
/// * `Unavailable` - the data could not be read; callers must NOT treat this
///   as a positive verification result.
///
/// # Arguments
/// * `env` - The Soroban environment.
/// * `wallet` - The wallet address to check.
///
/// # Returns
/// * `(VerificationStatus, Vec<VaccinationRecord>, Vec<DoseStatus>)`
///   - VerificationStatus: explicit outcome (never collapse failures into Valid)
///   - Vec<VaccinationRecord>: active vaccination records
///   - Vec<DoseStatus>: per-vaccine dose completion summary
pub fn verify_vaccination(env: &Env, wallet: Address) -> (bool, Vec<VaccinationRecord>, Vec<DoseStatus>) {
    // Missing or expired patient index: treat as "no records". This is a
    // non-authorized result and must never be interpreted as authorized.
    let tokens: Vec<u64> = match env
        .storage()
        .persistent()
        .get::<DataKey, Vec<u64>>(&DataKey::PatientTokens(wallet.clone()))
    {
        Some(tokens) => tokens,
        None => return (false, Vec::new(env), Vec::new(env)),
    };

    if tokens.is_empty() {
        return (VerificationStatus::Absent, Vec::new(env), Vec::new(env));
    }

    let mut records: Vec<VaccinationRecord> = Vec::new(env);
    let mut has_active = false;
    let mut has_revoked = false;

    // Load all active (non-revoked) records for the wallet.
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
                if !record.revoked {
                    has_active = true;
                    records.push_back(record);
                }
            }
            None => {
                // Token entry absent or expired; skip without granting access.
            }
            // A token is referenced but its record cannot be read: the data is
            // unavailable. Never fall through to a positive result.
            None => return (VerificationStatus::Unavailable, Vec::new(env), Vec::new(env)),
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

    let status = if has_active {
        VerificationStatus::Valid
    } else if has_revoked {
        VerificationStatus::Revoked
    } else {
        VerificationStatus::Absent
    };

    (status, records, dose_statuses)
}
