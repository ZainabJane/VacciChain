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


#[contracttype]
#[derive(Clone)]
pub struct VaccinationRecord {
    /// Unique token identifier for the vaccination record.
    pub token_id: u64,
    /// The patient wallet address owning this record.
    pub patient: Address,
    /// Vaccine name, stored as a Soroban string.
    pub vaccine_name: String,
    /// Date when the vaccine was administered.
    pub date_administered: String,
    /// Issuer address that minted the record.
    pub issuer: Address,
    /// Ledger timestamp at mint time.
    pub timestamp: u64,
    /// Schema version for backwards compatibility.
    pub schema_version: u32,
    /// Revocation flag; true when this record has been revoked.
    ///
    /// Revocation is scoped to this individual record only. It does not
    /// affect the patient wallet status, other records owned by the patient,
    /// or the issuing issuer's authorization. Revocation is irreversible:
    /// once set to `true` it can never be cleared.
    pub revoked: bool,
    /// Ledger timestamp at which the record was revoked, if revoked.
    pub revoked_at: Option<u64>,
    /// Which dose in the series this record represents (e.g. 1, 2, 3).
    /// `None` indicates a single-dose or legacy record.
    pub dose_number: Option<u32>,
    /// Total doses required for the series (e.g. 3 for a primary series).
    /// `None` indicates a single-dose or legacy record.
    pub dose_series: Option<u32>,
}

/// Lifecycle state of an issuer.
///
/// Transitions:
/// * `Active` -> `Revoked` (allowed, auditable)
/// * `Revoked` -> `Active` (allowed only via explicit re-add by admin)
/// * `Active` -> `Active` (idempotent no-op)
/// * `Revoked` -> `Revoked` (idempotent no-op)
#[contracttype]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum IssuerState {
    /// Issuer may mint vaccination records.
    Active,
    /// Issuer may no longer mint; existing records remain valid.
    Revoked,
}

#[contracttype]
#[derive(Clone)]
pub struct IssuerRecord {
    /// Human-friendly issuer name.
    pub name: String,
    /// Issuer license or registration identifier.
    pub license: String,
    /// Issuer country of operation.
    pub country: String,
    /// Authorization status for minting vaccination records.
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
    IssuerList,
    /// Token IDs owned by a patient wallet.
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
