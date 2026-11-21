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

**Authorization:** Requires issuer signature

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
- Revocation mechanisms (record-level scope, irreversibility, revoking one of multiple records)
- Duplicate detection (exact duplicates, normalized-equivalent values, legitimate repeat doses)
- Issuer lifecycle state transitions (add, revoke, re-add, idempotency)
- Admin recovery/rotation (proposal, acceptance, expiry, replay, unauthorized attempts)
- Batch verification
- Soulbound transfer prevention
- Edge cases and error conditions

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
- **Duplicate Prevention**: Records are blocked when their normalized duplicate key `(patient, normalized vaccine_name, normalized date, dose_number)` matches an existing record
- **Audit Trail**: Revoked records are preserved, not deleted; revocation is record-level and irreversible
- **Revocation Semantics**: Verifiers treat revoked records as invalid; revocation does not affect issuer permission or other records
- **Input Validation**: All string inputs are length-validated
- **Admin Controls**: Two-step admin transfer with 24-hour expiry, cancellation, and replay protection; no unilateral control path