use soroban_sdk::{contracttype, Address, Bytes, String, BytesN, Env, xdr::ToXdr};

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

    // ledger_sequence as big-endian 4 bytes
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

    // Take first 8 bytes as big-endian u64
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
    PatientAllowlist(Address),
    /// Configurable per-patient record limit.
    PatientRecordLimit,
    /// Stored vaccination record by token ID.
    Token(u64),
    /// Revocation marker for a token ID.
    Revoked(u64),
    /// Legacy next token ID counter (not required for deterministic token IDs).
    NextTokenId,
    /// Paused contract flag.
    Paused,
}
