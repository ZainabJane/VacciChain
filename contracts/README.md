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

- **Soulbound Nature**: Transfers are permanently disabled via panic; see the Soulbound Enforcement Matrix above
- **Authorization**: Only authorized issuers can mint records
- **Duplicate Prevention**: Identical records are blocked
- **Audit Trail**: Revoked records are preserved, not deleted
- **Input Validation**: All string inputs are length-validated and all collections are bounded
- **Admin Controls**: Two-step admin transfer with expiry protection
- **Privacy**: On-chain schema is minimized per the Privacy-Safe On-Chain Field Policy above

## Security Audit

An independent security audit covers authorization, storage, lifecycle, upgrade, and privacy properties before production deployment. The audit scope, pinned source revision, WASM hash, and findings are recorded in [docs/security/contract-audit.md](docs/security/contract-audit.md). Critical and high findings must be fixed and independently verified before mainnet approval.

Related documents:
- [docs/resource-limits.md](docs/resource-limits.md) — input length and collection size bounds
- [docs/security/threat-model.md](docs/security/threat-model.md) — soulbound threat model and ownership-changing operations
- [docs/security/contract-audit.md](docs/security/contract-audit.md) — audit scope, revision, WASM hash, findings, and privacy review