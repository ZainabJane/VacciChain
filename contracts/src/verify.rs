use soroban_sdk::{Env, Address, Vec, contracttype, String};
use crate::storage::{DataKey, VaccinationRecord};

const MAX_BATCH_SIZE: u32 = 100;

/// Explicit outcome of a vaccination verification query.
///
/// This enum exists so that callers cannot collapse a failure or a missing
/// record into a positive verification result. Only `Valid` may be treated as
/// evidence of vaccination; every other variant must be surfaced to the user
/// as "not verified" and must never be interpreted as a medical determination.
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VerificationStatus {
    /// At least one active (non-revoked) record exists for the wallet.
    Valid,
    /// The wallet has records, but all of them have been revoked.
    Revoked,
    /// No records exist for the wallet (unknown or never vaccinated).
    Absent,
    /// The data could not be read (storage/RPC failure). Never treat as Valid.
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
pub fn verify_vaccination(env: &Env, wallet: Address) -> (VerificationStatus, Vec<VaccinationRecord>, Vec<DoseStatus>) {
    // A missing PatientTokens entry means the wallet has no records (Absent).
    // Any read failure is surfaced as Unavailable rather than silently treated
    // as an empty (and therefore non-positive) result.
    let tokens: Vec<u64> = match env
        .storage()
        .persistent()
        .get(&DataKey::PatientTokens(wallet.clone()))
    {
        Some(tokens) => tokens,
        None => return (VerificationStatus::Absent, Vec::new(env), Vec::new(env)),
    };

    if tokens.is_empty() {
        return (VerificationStatus::Absent, Vec::new(env), Vec::new(env));
    }

    let mut records: Vec<VaccinationRecord> = Vec::new(env);
    let mut has_active = false;
    let mut has_revoked = false;

    // Load all active (non-revoked) records for the wallet.
    for i in 0..tokens.len() {
        let tid = tokens.get(i).unwrap();
        match env.storage().persistent().get::<DataKey, VaccinationRecord>(&DataKey::Token(tid)) {
            Some(record) => {
                if record.revoked {
                    has_revoked = true;
                } else {
                    has_active = true;
                    records.push_back(record);
                }
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
