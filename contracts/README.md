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
Revokes an issuer's authorization to mint new records.

**Parameters:**
- `issuer`: Address of the issuer to revoke

**Authorization:** Requires admin signature

---

#### `propose_admin(env: Env, new_admin: Address) -> Result<(), ContractError>`
Proposes a new admin address. Proposal expires after 24 hours.

**Parameters:**
- `new_admin`: Address of the proposed new admin

**Returns:**
- `Ok(())` on success
- `ContractError::NotInitialized` if contract not initialized

**Authorization:** Requires current admin signature

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
- `ContractError::DuplicateRecord` if identical record already exists
- `ContractError::InvalidInputVaccineName` if vaccine name exceeds 100 characters
- `ContractError::InvalidInputDateAdministered` if date exceeds 100 characters

**Authorization:** Requires issuer signature

---

#### `revoke_vaccination(env: Env, token_id: u64, revoker: Address) -> Result<(), ContractError>`
Revokes a vaccination record. Record is marked as revoked but preserved for audit trail.

**Parameters:**
- `token_id`: ID of the token to revoke
- `revoker`: Address performing the revocation (must be original issuer or admin)

**Returns:**
- `Ok(())` on success
- `ContractError::RecordNotFound` if token doesn't exist
- `ContractError::AlreadyRevoked` if record is already revoked
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

### Soulbound Enforcement

#### `transfer(env: Env, from: Address, to: Address, token_id: u64)`
Transfer function that always panics to enforce soulbound nature.

**Behavior:** Always panics with "soulbound: transfers are disabled"

## Storage Schema

### Data Structures

#### `VaccinationRecord`
```rust
pub struct VaccinationRecord {
    pub token_id: u64,           // Unique token identifier
    pub patient: Address,        // Patient's wallet address
    pub vaccine_name: String,    // Name of the vaccine
    pub date_administered: String, // Date vaccine was given
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

## Build & Test Instructions

### Prerequisites
- Rust toolchain with `wasm32-unknown-unknown` target
- Soroban CLI tools

### Building the Contract

```bash
# Build the contract
make build

# Or manually:
cargo build --target wasm32-unknown-unknown --release
```

The compiled WASM artifact will be located at:
`target/wasm32-unknown-unknown/release/vaccichain.wasm`

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
- Revocation mechanisms
- Batch verification
- Soulbound transfer prevention
- Edge cases and error conditions
- Storage lifecycle: missing/expired entries and fail-closed authorization (#90)
- Schema migration fixtures against prior on-chain state (#92)

## Deployment Guide

### Local Development

1. Start a local Stellar network (e.g., using Stellar Quickstart)
2. Build the contract: `make build`
3. Deploy using Soroban CLI with your local network configuration

### Testnet Deployment

```bash
# Set environment variables
export ADMIN_SECRET_KEY="your_admin_secret_key"

# Deploy to testnet
make deploy
```

### Mainnet Deployment

1. Ensure thorough testing on testnet
2. Update network configuration to mainnet
3. Use production admin keys
4. Deploy with appropriate resource limits

### Post-Deployment Steps

1. Initialize the contract with `initialize(admin_address)`
2. Add authorized issuers using `add_issuer()`
3. Test basic functionality with a test vaccination record
4. Set up monitoring for contract events

## Security Considerations

- **Soulbound Nature**: Transfers are permanently disabled via panic
- **Authorization**: Only authorized issuers can mint records
- **Duplicate Prevention**: Identical records are blocked
- **Audit Trail**: Revoked records are preserved, not deleted
- **Input Validation**: All string inputs are length-validated
- **Admin Controls**: Two-step admin transfer with expiry protection