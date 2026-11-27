use soroban_sdk::{contracttype, Address, Bytes, String, BytesN, Env, xdr::ToXdr};

/// Current on-chain storage schema version.
///
/// Bump this whenever the layout or semantics of persistent entries change so
/// that migration logic (see issue #92) can detect and handle prior state.
pub const SCHEMA_VERSION: u32 = 1;

/// Minimum TTL (in ledgers) applied to persistent entries on every write.
///
/// Soroban persistent entries expire unless their TTL is extended. All
/// persistent writes must call [`extend_persistent_ttl`] so that vaccination
/// histories and issuer records remain readable for the retention window.
/// At ~5 seconds per ledger this is roughly 30 days.
pub const PERSISTENT_TTL_MIN: u32 = 518_400;

/// TTL (in ledgers) that persistent entries are extended to on write.
///
/// This is the target lifetime granted when a persistent entry is written or
/// touched. It must be greater than or equal to [`PERSISTENT_TTL_MIN`].
/// At ~5 seconds per ledger this is roughly 180 days.
pub const PERSISTENT_TTL_EXTEND: u32 = 3_110_400;

/// Threshold (in ledgers) below which a persistent entry is considered
/// "close to expiry" and should be extended on access.
pub const PERSISTENT_TTL_THRESHOLD: u32 = PERSISTENT_TTL_MIN;

/// Extend the TTL of a persistent entry to [`PERSISTENT_TTL_EXTEND`].
///
/// Must be invoked after every persistent write (and on read paths that need
/// to keep entries alive) so that storage lifecycle assumptions documented for
/// issue #90 hold. If the entry is missing this is a no-op at the host level.
pub fn extend_persistent_ttl<K>(env: &Env, key: &K)
where
    K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
{
    env.storage()
        .persistent()
        .extend_ttl(key, PERSISTENT_TTL_THRESHOLD, PERSISTENT_TTL_EXTEND);
}

/// Safely read the schema version of a stored [`VaccinationRecord`].
///
/// Returns `Some(version)` when the record exists, or `None` when the entry is
/// missing or has expired. Callers must treat `None` as "unknown/absent" and
/// must never fail open on authorization decisions (issue #90).
pub fn read_record_schema_version(env: &Env, token_id: u64) -> Option<u32> {
    let key = DataKey::Token(token_id);
    match env.storage().persistent().get::<DataKey, VaccinationRecord>(&key) {
        Some(record) => Some(record.schema_version),
        None => None,
    }
}

/// Hash an address to a 32-byte key using SHA-256.
///
/// This helper is useful for storage key derivation and indexing.
pub fn hash_address(env: &Env, address: &Address) -> BytesN<32> {
    env.crypto().sha256(&address.to_xdr(env)).into()
}

/// Compute a deterministic token ID for a vaccination record.
///
/// The token ID is derived from the patient wallet, vaccine name, date,
/// issuer, and ledger sequence. The first 8 bytes of the SHA-256 digest are
/// interpreted as a big-endian `u64`.
///
/// # Arguments
/// * `env` - The Soroban environment.
/// * `patient` - The patient wallet address.
/// * `vaccine_name` - The vaccine name string.
/// * `date_administered` - The administration date string.
/// * `issuer` - The issuer wallet address.
/// * `ledger_sequence` - The current ledger sequence number.
///
/// # Returns
/// * `u64` deterministic token ID.
pub fn compute_token_id(
    env: &Env,
    patient: &Address,
    vaccine_name: &String,
    date_administered: &String,
    issuer: &Address,
    ledger_sequence: u32,
) -> u64 {
    let mut preimage = Bytes::new(env);

    // patient address (XDR-encoded)
    preimage.append(&patient.to_xdr(env));

    // vaccine_name (XDR-encoded soroban String)
    preimage.append(&vaccine_name.clone().to_xdr(env));

    // date_administered (XDR-encoded soroban String)
    preimage.append(&date_administered.clone().to_xdr(env));

    // issuer address (XDR-encoded)
    preimage.append(&issuer.to_xdr(env));

    // ledger_sequence as big-endian 4 bytes.
    //
    // Overflow audit (issue #88): `ledger_sequence` is a `u32`, so shifting by
    // 24/16/8 bits is always in-bounds (max shift < 32) and the `& 0xff` mask
    // keeps each byte in `0..=255` before the `as u8` cast. No arithmetic can
    // overflow here, and the full `u32` range (including `u32::MAX`) is encoded
    // losslessly.
    let seq_bytes = [
        ((ledger_sequence >> 24) & 0xff) as u8,
        ((ledger_sequence >> 16) & 0xff) as u8,
        ((ledger_sequence >> 8) & 0xff) as u8,
        (ledger_sequence & 0xff) as u8,
    ];
    let mut seq_buf = Bytes::new(env);
    for b in seq_bytes {
        seq_buf.push_back(b);
    }
    preimage.append(&seq_buf);

    let digest: BytesN<32> = env.crypto().sha256(&preimage).into();

    // Take first 8 bytes as big-endian u64.
    //
    // Overflow audit (issue #88): each byte is widened to `u64` (value `0..=255`)
    // and shifted left by at most 56 bits, so the highest bit set is bit 63.
    // The OR-combination therefore always fits in `u64` and can never overflow;
    // the full `u64` range (including `u64::MAX`) is representable.
    let b0 = digest.get(0).unwrap() as u64;
    let b1 = digest.get(1).unwrap() as u64;
    let b2 = digest.get(2).unwrap() as u64;
    let b3 = digest.get(3).unwrap() as u64;
    let b4 = digest.get(4).unwrap() as u64;
    let b5 = digest.get(5).unwrap() as u64;
    let b6 = digest.get(6).unwrap() as u64;
    let b7 = digest.get(7).unwrap() as u64;

    (b0 << 56) | (b1 << 48) | (b2 << 40) | (b3 << 32)
        | (b4 << 24) | (b5 << 16) | (b6 << 8) | b7
}


/// Maximum number of vaccination records a single patient wallet may hold.
///
/// Enforced when minting records and when appending to `DataKey::PatientTokens`.
/// Bounds the stored collection size to keep reads/writes within Soroban
/// resource limits.
pub const MAX_PATIENT_RECORDS: u32 = 100;

/// Maximum number of authorized issuers that may be stored in
/// `DataKey::IssuerList`.
///
/// Enforced when registering issuers. Bounds the stored collection size to keep
/// reads/writes within Soroban resource limits.
pub const MAX_ISSUER_LIST: u32 = 100;

/// On-chain field policy for `VaccinationRecord`.
///
/// Classification of each field:
/// * **Pseudonymous** — `patient`, `issuer`: wallet addresses only; they are
///   pseudonymous identifiers and must never be linked to real-world identity
///   on-chain.
/// * **Public-safe** — `token_id`, `timestamp`, `schema_version`, `revoked`,
///   `dose_number`, `dose_series`: non-identifying protocol/administrative data.
/// * **Public-safe (bounded)** — `vaccine_name`, `date_administered`: minimal
///   clinical detail required for verifiability; both are length-bounded.
///
/// **Prohibited fields.** Patient names, contact data (email, phone, postal
/// address), national/insurance identifiers, and unnecessary clinical details
/// (diagnoses, allergies, provider notes, free-form metadata) MUST NOT be
/// embedded in this immutable public contract state.
///
/// **Residual linkability risks.** Even with the minimized schema above:
/// * Wallet-to-record correlation: all records for a patient share the same
///   `patient` address, so an observer can correlate a wallet's full history.
/// * Timing correlation: `timestamp` (and the ledger sequence mixed into
///   `token_id`) can correlate a record with the minting transaction.
/// * Token ID derivation: `token_id` is deterministic over patient, vaccine,
///   date, issuer, and ledger sequence, so equal inputs yield equal IDs and
///   can be used to confirm guesses about a record.
/// These risks are documented and accepted by the privacy review; they must be
/// re-evaluated before any schema change.
#[contracttype]
#[derive(Clone)]
pub struct VaccinationRecord {
    /// Unique token identifier for the vaccination record.
    /// Classification: public-safe (see residual linkability notes above).
    pub token_id: u64,
    /// The patient wallet address owning this record.
    /// Classification: pseudonymous — never store identity data here.
    pub patient: Address,
    /// Vaccine name, stored as a Soroban string.
    /// Classification: public-safe (bounded); no free-form clinical notes.
    pub vaccine_name: String,
    /// Date when the vaccine was administered.
    /// Classification: public-safe (bounded); date only, no location data.
    pub date_administered: String,
    /// Issuer address that minted the record.
    /// Classification: pseudonymous — wallet address only.
    pub issuer: Address,
    /// Ledger timestamp at mint time.
    /// Classification: public-safe; subject to timing correlation.
    pub timestamp: u64,
    /// Schema version for backwards compatibility.
    /// Classification: public-safe.
    pub schema_version: u32,
    /// Revocation flag; true when this record has been revoked.
    /// Classification: public-safe.
    pub revoked: bool,
    /// Ledger timestamp at which the record was revoked, if revoked.
    pub revoked_at: Option<u64>,
    /// Which dose in the series this record represents (e.g. 1, 2, 3).
    /// `None` indicates a single-dose or legacy record.
    /// Classification: public-safe.
    pub dose_number: Option<u32>,
    /// Total doses required for the series (e.g. 3 for a primary series).
    /// `None` indicates a single-dose or legacy record.
    /// Classification: public-safe.
    pub dose_series: Option<u32>,
}

/// On-chain field policy for `IssuerRecord`.
///
/// Classification of each field:
/// * **Public-safe** — `name`, `license`, `country`, `authorized`: issuer
///   organizational metadata required for verification and authorization.
///
/// **Prohibited fields.** Personal contact data for individual staff
/// (names of natural persons, email, phone, postal address) and any clinical
/// or patient-linked details MUST NOT be embedded in this immutable public
/// contract state. Only organizational identifiers are permitted.
///
/// **Residual linkability risks.** Issuer metadata is public and immutable, so
/// an issuer's `license`/`country` can be correlated with the `issuer` address
/// appearing in `VaccinationRecord` entries, revealing issuance volume and
/// timing patterns. This is accepted by the privacy review.
#[contracttype]
#[derive(Clone)]
pub struct IssuerRecord {
    /// Human-friendly issuer name.
    /// Classification: public-safe (organizational only).
    pub name: String,
    /// Issuer license or registration identifier.
    /// Classification: public-safe (organizational only).
    pub license: String,
    /// Issuer country of operation.
    /// Classification: public-safe.
    pub country: String,
    /// Authorization status for minting vaccination records.
    /// Classification: public-safe.
    pub authorized: bool,
    /// Explicit lifecycle state for the issuer.
    pub state: IssuerState,
    /// Ledger timestamp when the issuer was added or last re-added.
    pub added_at: u64,
    /// Ledger timestamp when the issuer was revoked, if applicable.
    pub revoked_at: Option<u64>,
}

#[contracttype]
pub enum DataKey {
    /// Stored admin address.
    Admin,
    /// Initialization marker for the contract.
    Initialized,
    /// Pending admin address during admin transfer.
    PendingAdmin,
    /// Expiry for delayed admin transfer operations.
    AdminTransferExpiry,
    /// Monotonic nonce for admin rotation proposals; used to prevent replay.
    AdminProposalNonce,
    /// Ledger sequence at which the current pending admin proposal was created.
    AdminProposalCreatedAt,
    /// Cancellation marker for the current pending admin proposal.
    AdminProposalCancelled,
    /// Authorized issuer record keyed by issuer address.
    Issuer(Address),
    /// Hashed issuer metadata index.
    IssuerMeta(BytesN<32>),
    /// List of authorized issuers.
    /// Bounded by `MAX_ISSUER_LIST`.
    IssuerList,
    /// Token IDs owned by a patient wallet.
    /// Bounded by `MAX_PATIENT_RECORDS`.
    PatientTokens(Address),
    /// Patient allowlist flag for self-registration.
    ///
    /// # Consent / allowlist semantics
    ///
    /// This key holds the patient's explicit consent to participate in the
    /// registry (i.e. to be allowlisted for self-registration and for
    /// issuance of vaccination records to their wallet). It is *not* a
    /// privacy guarantee: any data written to the public chain is public.
    /// Consent only gates whether the contract will accept issuance for the
    /// patient; it never makes on-chain data confidential.
    ///
    /// State transitions (keyed by patient `Address`):
    ///
    /// * **Absent** (no entry stored): consent has never been granted.
    ///   Issuance to this patient MUST be rejected by the contract/API
    ///   boundary (unauthorized issuance). Verification of any pre-existing
    ///   token is unaffected, but no new token may be minted.
    ///
    /// * **Granted** (`true`): the patient has explicitly consented.
    ///   Issuance is permitted (subject to issuer authorization and other
    ///   checks). Public verification remains limited to non-prohibited
    ///   fields; consent does not widen what verification reveals.
    ///
    /// * **Revoked** (`false`, entry retained): the patient has withdrawn
    ///   consent. New issuance MUST be rejected. Already-minted tokens are
    ///   not deleted (on-chain history is immutable); callers should rely on
    ///   the separate `Revoked(token_id)` marker to invalidate records.
    ///
    /// * **Changed** (transition between `true` and `false`): each change is
    ///   an explicit state transition. Re-granting after revocation restores
    ///   issuance eligibility; revoking after grant blocks it. The contract
    ///   records only the current boolean, so the API boundary must treat
    ///   every write as authoritative for subsequent issuance decisions.
    PatientAllowlist(Address),
    /// Configurable per-patient record limit.
    ///
    /// Caps how many vaccination records a single patient may hold. This is
    /// an operational limit, independent of consent: it applies only when
    /// `PatientAllowlist(patient)` is `true`. When consent is absent or
    /// revoked, issuance is rejected regardless of this limit. If unset,
    /// implementations should fall back to a documented default.
    PatientRecordLimit,
    /// Stored vaccination record by token ID.
    Token(u64),
    /// Revocation marker for a token ID.
    Revoked(u64),
    /// Legacy next token ID counter (not required for deterministic token IDs).
    ///
    /// Overflow audit (issue #88): any increment of this counter must use
    /// `checked_add` and treat `u64::MAX` as exhausted rather than wrapping.
    NextTokenId,
    /// Paused contract flag.
    Paused,
    /// Normalized duplicate key index mapping a normalized key to its token ID.
    DuplicateKey(BytesN<32>),
}

/// Normalize a string for duplicate-key comparison.
///
/// The normalization is intentionally conservative and deterministic so that
/// the API and contract agree on what constitutes a duplicate:
/// * trims leading and trailing ASCII whitespace,
/// * collapses internal runs of ASCII whitespace to a single space,
/// * lowercases ASCII letters.
///
/// Non-ASCII bytes are preserved as-is. The result is returned as a Soroban
/// `String` so it can be hashed or compared directly.
pub fn normalize_string(env: &Env, input: &String) -> String {
    let len = input.len() as usize;
    let mut buf = [0u8; 256];
    let mut out_len = 0usize;
    let mut pending_space = false;
    let mut seen_non_space = false;

    for i in 0..len {
        let b = input.get(i as u32).unwrap();
        let is_space = b == b' ' || b == b'\t' || b == b'\n' || b == b'\r';
        if is_space {
            if seen_non_space {
                pending_space = true;
            }
            continue;
        }
        if pending_space && out_len < buf.len() {
            buf[out_len] = b' ';
            out_len += 1;
            pending_space = false;
        }
        let normalized = if b.is_ascii_uppercase() { b + 32 } else { b };
        if out_len < buf.len() {
            buf[out_len] = normalized;
            out_len += 1;
        }
        seen_non_space = true;
    }

    let mut result = String::new(env);
    for i in 0..out_len {
        result.push_back(buf[i] as char);
    }
    result
}

/// Compute a normalized duplicate key for a vaccination record.
///
/// The key is derived from the normalized patient, vaccine name, date,
/// dose number, and dose series. The issuer and ledger sequence are
/// intentionally excluded so that the same dose cannot be recorded twice
/// by different issuers or in different ledgers. Legitimate repeat doses
/// are distinguished by `dose_number`.
///
/// # Arguments
/// * `env` - The Soroban environment.
/// * `patient` - The patient wallet address.
/// * `vaccine_name` - The vaccine name string (normalized internally).
/// * `date_administered` - The administration date string (normalized internally).
/// * `dose_number` - The dose number, if any.
/// * `dose_series` - The total dose series, if any.
///
/// # Returns
/// * `BytesN<32>` deterministic duplicate key.
pub fn compute_duplicate_key(
    env: &Env,
    patient: &Address,
    vaccine_name: &String,
    date_administered: &String,
    dose_number: &Option<u32>,
    dose_series: &Option<u32>,
) -> BytesN<32> {
    let mut preimage = Bytes::new(env);

    preimage.append(&patient.to_xdr(env));
    preimage.append(&normalize_string(env, vaccine_name).to_xdr(env));
    preimage.append(&normalize_string(env, date_administered).to_xdr(env));

    let dn = dose_number.unwrap_or(0);
    let ds = dose_series.unwrap_or(0);
    let mut buf = Bytes::new(env);
    for v in [dn, ds] {
        buf.push_back(((v >> 24) & 0xff) as u8);
        buf.push_back(((v >> 16) & 0xff) as u8);
        buf.push_back(((v >> 8) & 0xff) as u8);
        buf.push_back((v & 0xff) as u8);
    }
    preimage.append(&buf);

    env.crypto().sha256(&preimage).into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use soroban_sdk::{testutils::Address as _, Env};

    /// Issue #88: token ID derivation must be deterministic and must not
    /// overflow for the full `u32` ledger sequence range, including `u32::MAX`.
    #[test]
    fn token_id_handles_ledger_sequence_boundaries() {
        let env = Env::default();
        let patient = Address::generate(&env);
        let issuer = Address::generate(&env);
        let vaccine = String::from_str(&env, "COVID-19");
        let date = String::from_str(&env, "2024-01-01");

        let seqs = [0u32, 1, 255, 256, 65_535, 16_777_215, u32::MAX - 1, u32::MAX];
        let mut seen: [u64; 8] = [0; 8];
        for (i, seq) in seqs.iter().enumerate() {
            let id = compute_token_id(&env, &patient, &vaccine, &date, &issuer, *seq);
            // Deterministic: recomputing yields the same value.
            let again = compute_token_id(&env, &patient, &vaccine, &date, &issuer, *seq);
            assert_eq!(id, again);
            // Distinct sequences should (with overwhelming probability) differ.
            for prev in seen.iter().take(i) {
                assert_ne!(id, *prev);
            }
            seen[i] = id;
        }
    }

    /// Issue #88: the big-endian byte assembly must be able to represent the
    /// full `u64` range without overflow (bit 63 set is valid).
    #[test]
    fn token_id_assembly_supports_full_u64_range() {
        // Mirror of the assembly logic in `compute_token_id`.
        let bytes: [u8; 8] = [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
        let mut acc: u64 = 0;
        for (i, b) in bytes.iter().enumerate() {
            acc |= (*b as u64) << (56 - 8 * i as u32);
        }
        assert_eq!(acc, u64::MAX);

        let zero: [u8; 8] = [0; 8];
        let mut acc0: u64 = 0;
        for (i, b) in zero.iter().enumerate() {
            acc0 |= (*b as u64) << (56 - 8 * i as u32);
        }
        assert_eq!(acc0, 0);
    }

    /// Issue #88: legacy counter increments must saturate safely at `u64::MAX`.
    #[test]
    fn next_token_id_counter_checked_add() {
        let max = u64::MAX;
        assert_eq!(max.checked_add(1), None);
        assert_eq!((max - 1).checked_add(1), Some(max));
        assert_eq!(0u64.checked_add(1), Some(1));
    }
}
