# VacciChain Smart Contract Documentation

## Overview

VacciChain is a Stellar Soroban smart contract that implements a soulbound NFT system for vaccination records. The contract ensures vaccination records are immutable, non-transferable, and verifiable while maintaining privacy and preventing fraud.

## Architecture Summary

The contract is organized into several modules:
- **lib.rs**: Main contract implementation with public functions and error definitions
- **storage.rs**: Data structures and storage key definitions
- **mint.rs**: Vaccination record minting logic
- **verify.rs**: Verification and batch verification functions
- **events.rs**: Event emission functions for contract interactions

## Public Functions

### Administrative Functions

#### `initialize(env: Env, admin: Address) -> Result<(), ContractError>`
Initializes the contract with an admin address. Can only be called once.

**Parameters:**
- `admin`: Address that will have administrative privileges

**Returns:**
- `Ok(())` on success
- `ContractError::AlreadyInitialized` if contract is already initialized

**Authorization:** Requires `admin` signature

---

#### `add_issuer(env: Env, issuer: Address, name: String, license: String, country: String) -> Result<(), ContractError>`
Authorizes a new issuer to mint vaccination records.

**Parameters:**
- `issuer`: Address of the issuer to authorize
- `name`: Issuer organization name (max 100 chars)
- `license`: Issuer license number (max 100 chars)
- `country`: Issuer country (max 100 chars)

**Returns:**
- `Ok(())` on success
- `ContractError::InvalidInputIssuerName` if name exceeds 100 characters
- `ContractError::InvalidInputLicense` if license exceeds 100 characters
- `ContractError::InvalidInputCountry` if country exceeds 100 characters

**Authorization:** Requires admin signature

---

#### `revoke_issuer(env: Env, issuer: Address)`
Revokes an issuer's authorization to mint new records. Existing records minted by the issuer are unaffected.

**Parameters:**
- `issuer`: Address of the issuer to revoke

**Authorization:** Requires admin signature

**Issuer Lifecycle State Machine:**

States: `None` (address never added), `Active` (authorized to mint), `Revoked` (previously authorized, now disabled).

| From | Operation | To | Result |
|------|-----------|----|--------|
| `None` | `add_issuer` | `Active` | Ok |
| `Active` | `add_issuer` | `Active` | Ok (idempotent; metadata updated) |
| `Revoked` | `add_issuer` | `Active` | Ok (re-add permitted) |
| `Active` | `revoke_issuer` | `Revoked` | Ok |
| `Revoked` | `revoke_issuer` | `Revoked` | Ok (idempotent no-op) |
| `None` | `revoke_issuer` | `None` | Ok (idempotent no-op) |
| `None`/`Revoked` | `mint_vaccination` | unchanged | `ContractError::Unauthorized` |
| `Active` | `mint_vaccination` | `Active` | Ok |

All transitions emit events (`IssuerAdded`, `IssuerRevoked`) for auditability. Re-add after revoke is a distinct auditable transition, not a silent reactivation.

---

#### `propose_admin(env: Env, new_admin: Address) -> Result<(), ContractError>`
Proposes a new admin address. Proposal expires after 24 hours.

**Parameters:**
- `new_admin`: Address of the proposed new admin

**Returns:**
- `Ok(())` on success
- `ContractError::NotInitialized` if contract not initialized

**Authorization:** Requires current admin signature

**Admin Recovery & Rotation Policy (formal):**
- **Threshold:** Rotation requires two distinct signatures — the current admin (`propose_admin`) and the proposed admin (`accept_admin`). No single party can unilaterally take control.
- **Delay:** A proposal is valid for a 24-hour window from creation. Acceptance before the proposal is recorded or after expiry fails (`ContractError::ProposalExpired`).
- **Cancellation:** The current admin may cancel a pending proposal before acceptance; the pending transfer and expiry are cleared. A cancelled or expired proposal cannot be replayed.
- **Replay protection:** Each proposal is single-use; `accept_admin` clears the pending state atomically, so a second acceptance fails with `ContractError::NoPendingTransfer`.
- **Emergency path:** If the admin key is lost or compromised, recovery uses the same propose/accept flow initiated by the current admin. There is no bypass that skips the two-signature threshold; emergency rotation is bounded by the same delay and cancellation rules. Compromise response is to propose a new admin immediately and cancel any attacker-initiated proposal.

---

#### `accept_admin(env: Env) -> Result<(), ContractError>`
Accepts a pending admin transfer proposal.

**Returns:**
- `Ok(())` on success
- `ContractError::NoPendingTransfer` if no pending transfer exists
- `ContractError::ProposalExpired` if proposal has expired

**Authorization:** Requires proposed admin signature

---

#### `upgrade(env: Env, new_wasm_hash: BytesN<32>) -> Result<(), ContractError>`
Upgrades the contract WASM code.

**Parameters:**
- `new_wasm_hash`: Hash of the new WASM code

**Returns:**
- `Ok(())` on success
- `ContractError::NotInitialized` if contract not initialized

**Authorization:** Requires admin signature

**Upgrade authorization and compatibility process:**

1. **Proposer**: Only the current admin (as set by `initialize` / `accept_admin`)
   may call `upgrade`. There is no separate proposer role; the admin is the sole
   authorized proposer.
2. **Approval**: The upgrade is authorized by the admin's signature on the
   `upgrade` invocation. Multi-party approval, if required by governance, must be
   enforced off-chain (e.g., a multisig admin address) before the call is made.
3. **Artifact review**: The `new_wasm_hash` must correspond to a WASM artifact
   that has been reproducibly built (see *Reproducible Builds*) and reviewed
   against the tagged source release. The hash is the sole on-chain commitment
   to the reviewed artifact.
4. **Rollback limitations**: Soroban upgrades replace the WASM in place. There is
   no automatic rollback; reverting requires a subsequent `upgrade` call with the
   previously reviewed hash. Storage written by a new version is **not** migrated
   or reverted automatically, so upgrades must be storage-compatible or perform
   explicit, idempotent migrations.
5. **Client compatibility**: `VaccinationRecord.schema_version` and the versioned
   event schemas (see *Events*) allow clients and indexers to interpret data
   across upgrades. New versions must not reorder or reuse `ContractError` codes
   or event field positions; additions are append-only.
6. **Unauthorized upgrades**: Calls from any address other than the admin fail
   with `ContractError::Unauthorized`, and contract state is left unchanged.
   Tests verify unauthorized upgrades fail and that state remains valid across
   supported upgrade paths.

### Issuer Functions

#### `mint_vaccination(env: Env, patient: Address, vaccine_name: String, date_administered: String, issuer: Address) -> Result<u64, ContractError>`
Mints a new vaccination record NFT.

**Parameters:**
- `patient`: Address of the patient receiving the vaccination
- `vaccine_name`: Name of the vaccine (max 100 chars)
- `date_administered`: Date the vaccine was administered (max 100 chars)
- `issuer`: Address of the authorized issuer

**Returns:**
- `Ok(token_id)` with the new token ID on success
- `ContractError::Unauthorized` if issuer is not authorized
- `ContractError::DuplicateRecord` if an equivalent record already exists (see Duplicate Key Definition)
- `ContractError::InvalidInputVaccineName` if vaccine name exceeds 100 characters
- `ContractError::InvalidInputDateAdministered` if date exceeds 100 characters

**Authorization:** Requires issuer signature

**Duplicate Key Definition (formal):** Two records are duplicates iff their normalized duplicate keys are equal. The duplicate key is the tuple:

```
(patient_wallet, normalize(vaccine_name), normalize(date_administered), dose_number)
```

Normalization rules (applied identically in API and contract):
- `patient_wallet`: canonical Stellar address (case-sensitive, no transformation).
- `vaccine_name`: trimmed of leading/trailing whitespace, internal whitespace collapsed to a single space, and lowercased (Unicode-aware). Formatting variants such as `"COVID-19"`, `" covid-19 "`, and `"Covid-19"` are equivalent.
- `date_administered`: normalized to ISO-8601 `YYYY-MM-DD`; equivalent representations of the same calendar date are treated as equal.
- `dose_number`: integer dose index (1-based) distinguishing legitimate repeat doses.

**Repeat doses:** Legitimate repeat doses are allowed because `dose_number` is part of the key. Minting dose 2 of the same vaccine on the same date for the same patient is not a duplicate; minting the same `dose_number` again is. Concurrency cannot bypass the check: the duplicate lookup and insertion occur within a single contract invocation, and Soroban serializes invocations per contract instance.

---

#### `revoke_vaccination(env: Env, token_id: u64, revoker: Address) -> Result<(), ContractError>`
Revokes a single vaccination record. Record is marked as revoked but preserved for audit trail.

**Revocation Scope (formal):**
- Revocation is **record-level only**. It affects exactly one `token_id`.
- Revocation **never** changes wallet-level status directly; wallet status is derived from the set of non-revoked records at query time.
- Revocation **never** affects issuer authorization. Issuer permission is governed solely by `revoke_issuer` (see Issuer Lifecycle State Machine).
- Revocation is **irreversible**: a revoked record can never be un-revoked or re-minted under the same `token_id`. Re-vaccination must be minted as a new record (subject to duplicate rules).

**Event:** Emits `VaccinationRevoked { token_id: u64, revoker: Address, timestamp: u64 }` where `timestamp` is the ledger timestamp at revocation.

**Verifier semantics:** Verifiers MUST treat any record with `revoked == true` as invalid. `verify_vaccination` and `batch_verify` exclude revoked records from returned lists and from `is_vaccinated` computation. A wallet with only revoked records is reported as not vaccinated.

**Parameters:**
- `token_id`: ID of the token to revoke
- `revoker`: Address performing the revocation (must be original issuer or admin)

**Returns:**
- `Ok(())` on success
- `ContractError::RecordNotFound` if token doesn't exist
- `ContractError::AlreadyRevoked` if record is already revoked (revocation is not idempotent; repeated calls error)
- `ContractError::Unauthorized` if revoker is not authorized

**Authorization:** Requires revoker signature

### Public Query Functions

#### `verify_vaccination(env: Env, wallet: Address) -> (bool, Vec<VaccinationRecord>)`
Verifies vaccination status for a single wallet.

**Parameters:**
- `wallet`: Address to verify

**Returns:**
- Tuple of `(is_vaccinated: bool, records: Vec<VaccinationRecord>)`
- Only returns non-revoked records
- `is_vaccinated` is true if any non-revoked records exist

---

#### `batch_verify(env: Env, wallets: Vec<Address>) -> Vec<(Address, bool, Vec<VaccinationRecord>)>`
Batch verification for multiple wallets (max 100).

**Parameters:**
- `wallets`: Vector of addresses to verify (max 100 addresses)

**Returns:**
- Vector of tuples `(address, is_vaccinated, records)` for each wallet

**Panics:** If more than 100 addresses provided

**Batch maximum and resource limits:**
- The maximum batch size is **100 wallets** (`MAX_BATCH_SIZE`). This limit is
  validated at the very start of `batch_verify`, before any ledger storage is
  read, so an over-limit call fails fast without incurring storage-access cost.
- Each wallet in the batch performs a bounded number of storage reads (patient
  token list + one read per token). The per-invocation limit is therefore
  `100 × (1 + tokens_per_patient)` reads; callers should keep per-patient token
  counts small to stay within Soroban CPU/memory budgets.
- Mixed results are supported: a batch may contain wallets with no records
  (`is_vaccinated == false`, empty vector), wallets with only revoked records
  (also `false`), and wallets with active records (`true`). The output vector
  preserves input order and has exactly one entry per input wallet.
- Over-limit input (more than 100 wallets) is rejected with a panic before any
  storage access; this is covered by resource tests alongside maximum-size and
  mixed-result cases.

---

#### `get_issuer(env: Env, address: Address) -> Option<IssuerRecord>`
Retrieves issuer metadata.

**Parameters:**
- `address`: Issuer address to query

**Returns:**
- `Some(IssuerRecord)` if issuer exists
- `None` if issuer not found

---

#### `is_issuer(env: Env, address: Address) -> bool`
Checks if an address is an authorized issuer.

**Parameters:**
- `address`: Address to check

**Returns:**
- `true` if address is an authorized issuer
- `false` otherwise

## Events

Events are versioned and stable so indexers can safely interpret payloads across
upgrades. Every event carries a `version: u32` field (currently `1`) as its first
data field, and event names are stable strings. New fields are appended only;
existing field order and meaning never change within a version. A breaking change
requires a new event name or a bumped `version`, and indexers must key on
`(name, version)`.

| Event name | Version | Fields (in order) | Emitted by |
|------------|---------|-------------------|------------|
| `init` | 1 | `version`, `admin` | `initialize` |
| `issuer_added` | 1 | `version`, `issuer`, `name`, `license`, `country` | `add_issuer` |
| `issuer_revoked` | 1 | `version`, `issuer` | `revoke_issuer` |
| `admin_proposed` | 1 | `version`, `new_admin`, `expiry` | `propose_admin` |
| `admin_accepted` | 1 | `version`, `new_admin` | `accept_admin` |
| `upgraded` | 1 | `version`, `new_wasm_hash` | `upgrade` |
| `mint` | 1 | `version`, `token_id`, `patient`, `issuer`, `schema_version` | `mint_vaccination` |
| `revoke` | 1 | `version`, `token_id`, `revoker` | `revoke_vaccination` |

**Compatibility rules:**
- Event names and field order are part of the public interface and are covered by
  contract tests and indexer fixtures.
- `schema_version` on `VaccinationRecord` and `version` on events advance
  independently; indexers must handle records whose `schema_version` is older
  than the current event `version`.
- Unknown future versions must be ignored (not misclassified) by indexers rather
  than treated as the current version.

### Soulbound Enforcement

#### `transfer(env: Env, from: Address, to: Address, token_id: u64)`
Transfer function that always panics to enforce soulbound nature.

**Behavior:** Always panics with "soulbound: transfers are disabled"

### Function Compatibility Contract

The following guarantees apply to callers and are derived from `contracts/src`:

- **Function names and argument order are stable.** New optional behavior must be added via new functions or new error codes, never by reordering existing arguments.
- **Error codes are stable integers** (see [Error Codes](#error-codes)). Callers must branch on the numeric code, not the variant name, and must treat unknown codes as a generic failure.
- **Authorization is part of the contract surface.** Changing which address must sign a function is a breaking change and requires a version bump plus release notes.
- **Version-specific behavior** is recorded in the table below. `schema_version` on `VaccinationRecord` identifies the record layout; readers must tolerate records with a higher `schema_version` by ignoring unknown fields.

| Contract version | Behavior notes |
|------------------|----------------|
| v1 (current) | `mint_vaccination` requires the patient to be allowlisted (`PatientNotRegistered` otherwise). `verify_vaccination` returns only non-revoked records. `transfer` always panics. |

### Backend Error Mapping

Backend API layers must map contract errors to stable HTTP responses. The mapping is verified by tests in the backend test suite.

| Contract error | API status | Stable API code |
|----------------|-----------|-----------------|
| `Unauthorized` (3) | 403 | `FORBIDDEN` |
| `RecordNotFound` (7) | 404 | `NOT_FOUND` |
| `DuplicateRecord` (6) | 409 | `CONFLICT` |
| `AlreadyRevoked` (8) | 409 | `CONFLICT` |
| `InvalidInput*` (9–14) | 400 | `INVALID_INPUT` |
| `PatientNotRegistered` (16) | 403 | `CONSENT_REQUIRED` |
| `NotInitialized` (2), `AlreadyInitialized` (1) | 500 | `CONTRACT_STATE` |
| Unknown code | 502 | `UPSTREAM_ERROR` |
=======

## Storage Schema

### Data Structures

#### `VaccinationRecord`
```rust
pub struct VaccinationRecord {
    pub token_id: u64,           // Unique token identifier
    pub patient: Address,        // Patient's wallet address
    pub vaccine_name: String,    // Name of the vaccine
    pub date_administered: String, // Date vaccine was given
    pub dose_number: u32,        // 1-based dose index (part of duplicate key)
    pub issuer: Address,         // Issuer who minted the record
    pub timestamp: u64,          // Block timestamp when minted
    pub schema_version: u32,     // Schema version for future upgrades
    pub revoked: bool,           // Whether record has been revoked
}
```

#### `IssuerRecord`
```rust
pub struct IssuerRecord {
    pub name: String,        // Organization name
    pub license: String,     // License number
    pub country: String,     // Country of operation
    pub authorized: bool,    // Whether issuer is currently authorized
}
```

### Storage Keys

#### `DataKey` Enum
```rust
pub enum DataKey {
    Admin,                          // Current admin address
    Initialized,                    // Contract initialization flag
    PendingAdmin,                   // Pending admin transfer address
    AdminTransferExpiry,            // Admin transfer expiry timestamp
    AdminProposalNonce,             // Monotonic nonce for replay protection
    Issuer(BytesN<32>),            // Issuer authorization (hashed address)
    PatientTokens(BytesN<32>),     // Patient's token list (hashed address)
    Token(u64),                    // Individual vaccination record
    NextTokenId,                   // Next available token ID
    Revoked(u64),                  // Revocation flag for fast lookup
}
```

### Key Formats

- **Admin Keys**: Simple enum variants stored directly
- **Issuer Keys**: `Issuer(hash)` where hash is SHA-256 of the issuer address
- **Patient Keys**: `PatientTokens(hash)` where hash is SHA-256 of patient address
- **Token Keys**: `Token(id)` where id is the sequential token ID
- **Revocation Keys**: `Revoked(id)` for fast revocation status lookup

### Storage Relationships

1. **Admin → Issuers**: Admin can authorize/revoke issuers
2. **Issuers → Records**: Authorized issuers can mint vaccination records
3. **Patients → Records**: Each patient has a list of their token IDs
4. **Records → Revocation**: Each record can be revoked by original issuer or admin

## ADR: Storage Sizing, Rent, and Archival Strategy

**Status:** Approved
**Context:** Backlog items #78 (storage growth/archival), #90 (missing/expired storage), #92 (schema migrations).

This ADR quantifies persistent storage cost for long-lived vaccination histories and issuer
records, and defines the approved retention/compaction/indexing approach. It must not violate
audit requirements: **records are never deleted, only revoked.**

### Per-Entry Size Estimates

Soroban charges rent per ledger entry based on serialized size plus a fixed per-entry overhead.
The estimates below are approximate serialized sizes (bytes) for the dominant fields; treat them
as upper bounds for planning.

| Entry | Contents | Est. size (bytes) |
|-------|----------|-------------------|
| `Token(u64)` → `VaccinationRecord` | token_id (8) + patient Address (~32) + vaccine_name (≤100) + date_administered (≤100) + issuer Address (~32) + timestamp (8) + schema_version (4) + revoked (1) + struct/key overhead (~64) | **~350** |
| `Revoked(u64)` | key (8) + bool (1) + overhead (~32) | **~40** |
| `Issuer(BytesN<32>)` → `IssuerRecord` | name (≤100) + license (≤100) + country (≤100) + authorized (1) + overhead (~64) | **~370** |
| `PatientTokens(BytesN<32>)` → `Vec<u64>` | 32-byte hash key + 8 bytes per token id + vec overhead (~32) | **~40 + 8·N** |
| `Admin` / `Initialized` / `PendingAdmin` / `AdminTransferExpiry` / `NextTokenId` | scalar entries | **~40 each (~200 total)** |

Note: `PatientTokens` grows linearly with the number of records per patient, so a patient with
`N` records costs roughly `350·N` (records) + `40·N` (revocation flags) + `8·N` (index) bytes.

### Projected Storage at Expected Volumes

Assumptions: average 3 vaccination records per patient, 1 issuer per ~5,000 patients.

| Scenario | Patients | Records | Issuers | Est. total bytes | Est. total (MiB) |
|----------|----------|---------|---------|------------------|------------------|
| Pilot | 10,000 | 30,000 | 5 | ~12.0 MB | ~11.5 |
| Regional | 1,000,000 | 3,000,000 | 200 | ~1.20 GB | ~1,145 |
| National | 50,000,000 | 150,000,000 | 10,000 | ~60 GB | ~57,220 |

Issuer records are negligible relative to vaccination records; growth is dominated by
`Token` entries and their per-patient index entries.

### Soroban Rent Implications

- Every persistent entry accrues rent proportional to its size and the length of time it stays
  live. Long-lived vaccination histories therefore have an ongoing, non-trivial rent cost.
- Entries whose TTL is not extended will **expire** (be archived) and become unavailable to the
  contract until restored. Reads of expired entries return "missing" and must be handled
  explicitly (see #90).
- The contract extends TTLs on write paths (mint, revoke, issuer add/revoke) so that active
  records remain live. Extension thresholds and bump amounts are documented in
  [`docs/resource-limits.md`](../docs/resource-limits.md).
- Rent and resource consumption per operation are measured in [`GAS_REPORT.md`](../GAS_REPORT.md).
  Any change to storage layout must be re-measured there.

### Approved Retention / Compaction / Indexing Approach

1. **Never delete records.** Revocation sets `revoked = true` and the `Revoked(id)` flag; the
   `VaccinationRecord` and its `PatientTokens` entry are retained permanently for audit. There is
   no delete path in the contract.
2. **TTL extension, not compaction.** Active entries have their TTL extended on write. Expired
   entries are restored (via Soroban archival restore) rather than recreated, preserving the
   original data and audit trail.
3. **Off-chain indexing.** Query-heavy workloads (history lookups, reporting, analytics) are
   served by an off-chain indexer that consumes contract events and mirrors state. The contract
   remains the source of truth; the indexer is a read-optimized cache and is never authoritative.
4. **Bounded inputs.** All string fields are length-validated (≤100 chars) to keep per-entry size
   and rent bounded.
5. **Schema versioning.** `VaccinationRecord.schema_version` allows forward-compatible reads.
   Schema changes require fixture-based migration tests against prior state, and unsupported
   upgrade paths must fail safely with a documented recovery plan (see #92).

### Storage Lifecycle & Missing/Expired Entries

- Missing or expired entries must be treated as "not found", never as "authorized". Authorization
  checks (`is_issuer`, admin checks) must fail closed when the relevant entry is absent.
- Tests cover expired/missing entries and assert that authorization cannot fail open (see #90).

## Error Codes

Error codes are stable integers. Do not reorder or reuse codes; append new variants with a new code.

| Code | Name | Description | When triggered |
|------|------|-------------|----------------|
| 1 | `AlreadyInitialized` | Contract has already been initialized | `initialize` called after initialization |
| 2 | `NotInitialized` | Contract has not been initialized | Admin-only actions called before `initialize` (e.g., `add_issuer`, `revoke_issuer`, `propose_admin`, `upgrade`, `revoke_vaccination`) |
| 3 | `Unauthorized` | Caller is not authorized for this action | Issuer is not authorized to mint, or revoker is neither issuer nor admin |
| 4 | `ProposalExpired` | Admin transfer proposal has expired | `accept_admin` after the 24-hour window |
| 5 | `NoPendingTransfer` | No pending admin transfer exists | `accept_admin` called without a proposal |
| 6 | `DuplicateRecord` | Identical vaccination record already exists | `mint_vaccination` detects a duplicate record |
| 7 | `RecordNotFound` | Vaccination record does not exist | `revoke_vaccination` called with an unknown token ID |
| 8 | `AlreadyRevoked` | Vaccination record is already revoked | `revoke_vaccination` on an already revoked record |
| 9 | `InvalidInput` | Input failed validation at the contract boundary | Generic input validation failure or unknown field name in length validator |
| 10 | `InvalidInputVaccineName` | `vaccine_name` exceeds maximum length | `mint_vaccination` with `vaccine_name` longer than 100 characters |
| 11 | `InvalidInputDateAdministered` | `date_administered` exceeds maximum length | `mint_vaccination` with `date_administered` longer than 100 characters |
| 12 | `InvalidInputIssuerName` | issuer name exceeds maximum length | `add_issuer` with `name` longer than 100 characters |
| 13 | `InvalidInputLicense` | issuer license exceeds maximum length | `add_issuer` with `license` longer than 100 characters |
| 14 | `InvalidInputCountry` | issuer country exceeds maximum length | `add_issuer` with `country` longer than 100 characters |
| 15 | `SoulboundToken` | Transfers are disabled for soulbound records | Any call to `transfer` |
| 16 | `PatientNotRegistered` | Patient has not self-registered | `mint_vaccination` when patient is not allowlisted |

### Input Validation

All string inputs are validated at the contract boundary with a maximum length of 100 characters:
- `vaccine_name`: maximum 100 characters
- `date_administered`: maximum 100 characters  
- `name` (issuer metadata): maximum 100 characters
- `license` (issuer metadata): maximum 100 characters
- `country` (issuer metadata): maximum 100 characters

This prevents excessively long strings from being stored on ledger state and keeps ledger fees bounded.

## Input Length and Collection Size Bounds

Every public argument and every stored collection has a documented maximum. Values at the limit are accepted; one-over-limit values are rejected with the corresponding `ContractError` (or panic for collection bounds, as noted). Boundary tests cover zero, maximum valid, and one-over-limit values for each bound.

### Public Argument Bounds

| Function | Argument | Type | Maximum | On violation |
|----------|----------|------|---------|--------------|
| `initialize` | `admin` | `Address` | n/a (fixed size) | — |
| `add_issuer` | `name` | `String` | 100 chars | `InvalidInputIssuerName` (12) |
| `add_issuer` | `license` | `String` | 100 chars | `InvalidInputLicense` (13) |
| `add_issuer` | `country` | `String` | 100 chars | `InvalidInputCountry` (14) |
| `revoke_issuer` | `issuer` | `Address` | n/a (fixed size) | — |
| `propose_admin` | `new_admin` | `Address` | n/a (fixed size) | — |
| `accept_admin` | — | — | — | — |
| `upgrade` | `new_wasm_hash` | `BytesN<32>` | 32 bytes (fixed) | — |
| `mint_vaccination` | `vaccine_name` | `String` | 100 chars | `InvalidInputVaccineName` (10) |
| `mint_vaccination` | `date_administered` | `String` | 100 chars | `InvalidInputDateAdministered` (11) |
| `revoke_vaccination` | `token_id` | `u64` | n/a (fixed size) | — |
| `verify_vaccination` | `wallet` | `Address` | n/a (fixed size) | — |
| `batch_verify` | `wallets` | `Vec<Address>` | 100 entries | Panic (batch size exceeded) |
| `get_issuer` | `address` | `Address` | n/a (fixed size) | — |
| `is_issuer` | `address` | `Address` | n/a (fixed size) | — |
| `transfer` | `token_id` | `u64` | n/a (always panics) | `SoulboundToken` (15) |

### Stored Collection Bounds

| Collection | Storage key | Maximum | Notes |
|------------|-------------|---------|-------|
| Patient token list | `PatientTokens(hash)` | 100 token IDs | Minting beyond the cap fails; keeps per-patient history within Soroban entry-size limits |
| Batch verification result | (return value) | 100 tuples | Bounded by the `batch_verify` argument cap |
| Issuer registry | `Issuer(hash)` | One record per issuer address | Individual records bounded by the 100-char string limits above |
| Revocation flags | `Revoked(id)` | One flag per token | Fixed-size boolean |

Zero-length strings are permitted for optional metadata fields but are rejected where a non-empty value is semantically required. See [docs/resource-limits.md](docs/resource-limits.md) for the full bound policy, rationale, and boundary test matrix.

## Soulbound Enforcement Matrix

Soulbound tokens must never change ownership after minting. The threat model covers every public ownership-changing operation and integration path; contract tests prove prohibited actions fail without mutating storage or emitting misleading events.

| Entry point | Ownership effect | Enforcement | Failure mode |
|-------------|------------------|-------------|--------------|
| `transfer(from, to, token_id)` | Would move token | Always panics | `SoulboundToken` (15); no storage write, no event |
| `approve` / `set_approval_for_all` | Would delegate control | Not implemented | No such entry point exists in the contract ABI |
| `clawback` | Would seize token | Not implemented | No such entry point exists in the contract ABI |
| `mint_vaccination` | Creates token for `patient` | Allowed (issuance only) | Requires authorized issuer; patient must be registered |
| `revoke_vaccination` | Marks record revoked | Allowed (status only) | Ownership unchanged; record preserved for audit trail |
| `upgrade` | Replaces contract code | Admin-gated | Requires admin signature; audited under #73 |
| `initialize` | Sets admin | One-time | `AlreadyInitialized` (1) on repeat |

Integration paths (SEP-41-style token clients, wallets, and indexers) must treat any transfer attempt as a hard failure. The full threat model, including alternate entry points and event-spoofing analysis, is in [docs/security/threat-model.md](docs/security/threat-model.md).

## Privacy-Safe On-Chain Field Policy

Immutable public contract state must not contain personally identifying or clinically sensitive data. Each field in the on-chain schema is classified below; patient names, contact data, and unnecessary clinical details are excluded.

| Field | Classification | On-chain | Rationale |
|-------|----------------|----------|-----------|
| `token_id` | Public identifier | Yes | Sequential, non-linkable on its own |
| `patient` | Pseudonymous identifier | Yes | Wallet address only; no name or contact data |
| `vaccine_name` | Health-adjacent, minimized | Yes | Generic vaccine identifier only; no lot, dose, or clinical notes |
| `date_administered` | Health-adjacent, minimized | Yes | Date only; no time-of-day or location |
| `issuer` | Organizational identifier | Yes | Issuer wallet address |
| `timestamp` | Public metadata | Yes | Ledger timestamp of minting |
| `schema_version` | Public metadata | Yes | Enables future migrations |
| `revoked` | Public status | Yes | Boolean status flag |
| Issuer `name` / `license` / `country` | Organizational, public | Yes | Issuer metadata, not patient data |
| Patient name, contact data, address | PII | **No** | Never stored on-chain |
| Clinical details (dose, lot, reactions) | Sensitive health data | **No** | Kept off-chain; not required for verification |

Residual linkability risks (e.g., correlating a wallet address with off-chain records, or inferring vaccination timing from `timestamp`) are documented and accepted in the privacy review. The minimized schema and residual-risk analysis are recorded alongside the audit materials in [docs/security/contract-audit.md](docs/security/contract-audit.md).

## Build & Test Instructions

### Prerequisites
- Rust toolchain with `wasm32-unknown-unknown` target (pinned version)
- Soroban CLI tools (version matching the pinned SDK)

### Building the Contract

```bash
# Build the contract
make build

# Or manually:
cargo build --target wasm32-unknown-unknown --release
```

The compiled WASM artifact will be located at:
`target/wasm32-unknown-unknown/release/vaccichain.wasm`

### Reproducible Builds

Release WASM artifacts must be independently reproducible so the deployed hash can
be compared against the reviewed source release.

- **Pinned toolchain**: The Rust toolchain is pinned via `rust-toolchain.toml`
  (channel and components). Builds must use this pinned toolchain.
- **Pinned dependencies**: `Cargo.lock` is committed and must not be regenerated
  during a release build. Dependency versions are locked.
- **Deterministic flags**: Build with `--locked` and the release profile; the
  `wasm32-unknown-unknown` target is pinned in the toolchain file.
- **Artifact hash**: After building, generate the SHA-256 of the WASM artifact and
  record it with the release candidate:

  ```bash
  cargo build --locked --target wasm32-unknown-unknown --release
  sha256sum target/wasm32-unknown-unknown/release/vaccichain.wasm
  ```

- **Verification**: A clean runner (fresh checkout, pinned toolchain, committed
  `Cargo.lock`) must reproduce the same artifact hash. Any nondeterministic input
  (e.g., absolute paths, timestamps, or unpinned tooling) must be documented in
  the release notes; if the hash cannot be reproduced, the release is blocked.

### Running Tests

```bash
# Run all tests
make test

# Or manually:
cargo test
```

### Test Coverage

The contract includes comprehensive tests covering:
- Basic minting and verification flows
- Duplicate record prevention
- Authorization checks
- Input validation
- Admin transfer functionality
- Revocation mechanisms (record-level scope, irreversibility, revoking one of multiple records)
- Duplicate detection (exact duplicates, normalized-equivalent values, legitimate repeat doses)
- Issuer lifecycle state transitions (add, revoke, re-add, idempotency)
- Admin recovery/rotation (proposal, acceptance, expiry, replay, unauthorized attempts)
- Batch verification (maximum batch size, mixed results, over-limit rejection)
- Event schema compatibility (names, field order, versions)
- Upgrade authorization (unauthorized upgrades fail, state valid across paths)
- Soulbound transfer prevention
- Edge cases and error conditions
- Storage lifecycle: missing/expired entries and fail-closed authorization (#90)
- Schema migration fixtures against prior on-chain state (#92)

## Deployment Guide

### Network Selection and Validation

Deployment **requires an explicit network**. There is no default network; the deploy command must fail if the network is not specified.

```bash
# The network is mandatory and must be one of: local, testnet, mainnet
make deploy NETWORK=testnet
```

Validation performed before any transaction is submitted:

1. **Explicit network** — `NETWORK` must be set to a known value; unknown or empty values abort the deploy.
2. **Network-specific configuration** — the RPC URL, network passphrase, and admin key must match the selected network. A mismatch (e.g., testnet passphrase with a mainnet RPC URL) aborts the deploy.
3. **Contract ID format** — the contract ID must be a valid Stellar contract address (`C...`) for the selected network.
4. **Artifact hash** — the locally built WASM hash must match the hash recorded for the release being deployed.

### Local Development

1. Start a local Stellar network (e.g., using Stellar Quickstart)
2. Build the contract: `make build`
3. Deploy with an explicit network: `make deploy NETWORK=local`

### Testnet Deployment

```bash
# Set environment variables
export ADMIN_SECRET_KEY="your_admin_secret_key"

# Deploy to testnet (network is mandatory)
make deploy NETWORK=testnet
```

### Mainnet Deployment

1. Ensure thorough testing on testnet
2. Deploy with an explicit network: `make deploy NETWORK=mainnet`
3. Use production admin keys
4. Deploy with appropriate resource limits

### Post-Deployment Smoke Tests

Smoke tests confirm the deployed contract belongs to the expected network and artifact:

1. **Network check** — query the contract ID on the expected network and confirm it exists; confirm the same ID is absent on other networks.
2. **Artifact hash check** — fetch the deployed WASM and confirm its hash matches the locally built artifact hash.
3. **Initialization check** — confirm `initialize` has been called and the admin matches the expected address.
4. **Functional check** — mint a test record with an authorized issuer and verify it via `verify_vaccination`.
5. **Negative check** — confirm an unauthorized address cannot mint (`Unauthorized`).

### Post-Deployment Steps

1. Initialize the contract with `initialize(admin_address)`
2. Add authorized issuers using `add_issuer()`
3. Run the smoke tests above
4. Set up monitoring for contract events

## Security Considerations

- **Soulbound Nature**: Transfers are permanently disabled via panic; see the Soulbound Enforcement Matrix above
- **Authorization**: Only authorized issuers can mint records
- **Duplicate Prevention**: Identical records are blocked
- **Audit Trail**: Revoked records are preserved, not deleted
- **Input Validation**: All string inputs are length-validated and all collections are bounded
- **Admin Controls**: Two-step admin transfer with expiry protection
- **Upgrade Authorization**: Only the admin can upgrade; artifacts are reviewed and reproducibly built before deployment
- **Event Stability**: Versioned event schemas let indexers interpret payloads safely across upgrades
- **Bounded Batch Verification**: Batch size is capped and validated before storage access to bound resource usage
- **Privacy**: On-chain schema is minimized per the Privacy-Safe On-Chain Field Policy above

## Security Audit

An independent security audit covers authorization, storage, lifecycle, upgrade, and privacy properties before production deployment. The audit scope, pinned source revision, WASM hash, and findings are recorded in [docs/security/contract-audit.md](docs/security/contract-audit.md). Critical and high findings must be fixed and independently verified before mainnet approval.

Related documents:
- [docs/resource-limits.md](docs/resource-limits.md) — input length and collection size bounds
- [docs/security/threat-model.md](docs/security/threat-model.md) — soulbound threat model and ownership-changing operations
- [docs/security/contract-audit.md](docs/security/contract-audit.md) — audit scope, revision, WASM hash, findings, and privacy review
