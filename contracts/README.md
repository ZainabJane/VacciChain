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

## Consent and Allowlist Semantics

Patient allowlisting and consent gate **issuance**, not verification visibility. All data written to the contract is public on the Stellar ledger; allowlisting and consent must never be described as making on-chain data private.

### State Transitions

| State | Meaning | Effect on `mint_vaccination` | Effect on `verify_vaccination` |
|-------|---------|------------------------------|-------------------------------|
| **Absent** | Patient has not self-registered | Rejected with `PatientNotRegistered` (16) | Returns `(false, [])` |
| **Granted** | Patient is allowlisted and has consented | Allowed for authorized issuers | Returns `(true, records)` for non-revoked records |
| **Revoked** | Patient withdrew consent / was de-allowlisted | Rejected with `PatientNotRegistered` (16) | Existing records remain on-chain and are still returned; no new records can be minted |
| **Changed** | Consent scope or issuer changed | New mints use the new scope; previously minted records are unchanged | Unchanged; records are immutable except for revocation |

### Privacy Boundary

- **On-chain data is public.** Vaccine name, date, issuer, patient address, and timestamps are readable by anyone querying the ledger.
- **Off-chain data must not be placed on-chain.** No PII beyond the fields defined in `VaccinationRecord` may be stored.
- **Verification responses** must not include fields beyond those in `VaccinationRecord`; the backend must not enrich verification responses with prohibited fields (e.g., national ID, contact details).
- **Revocation does not delete data.** Revoked records remain queryable for audit; callers must treat `revoked: true` as "not currently valid" rather than "not present".

### Required Tests

- An issuance attempt for a patient in the **Absent** or **Revoked** state is rejected with `PatientNotRegistered`.
- Public verification of a granted patient returns only the documented `VaccinationRecord` fields and no prohibited fields.
- Revoking consent blocks new mints but leaves existing records verifiable.

## Toolchain and Dependency Policy

### Supported Versions

The supported toolchain is pinned in `rust-toolchain.toml` and `Cargo.toml`; CI fails if the declared versions drift.

| Component | Supported version | Source of truth |
|-----------|-------------------|-----------------|
| Rust | Pinned stable (see `rust-toolchain.toml`) | `rust-toolchain.toml` |
| `wasm32-unknown-unknown` target | Required | `rust-toolchain.toml` |
| `soroban-sdk` | Pinned in `Cargo.toml` | `Cargo.toml` |
| Soroban CLI | Version matching the pinned SDK | `Makefile` / CI config |

### CI Enforcement

- CI verifies the declared toolchain by building with the pinned Rust version and target.
- CI runs `cargo audit` (or equivalent advisory check) and fails on known advisories in contract dependencies.
- CI builds the WASM artifact and records its hash for comparison against deployed artifacts.

### Dependency Upgrade Procedure

Any upgrade of Rust, `soroban-sdk`, or the Soroban CLI must:

1. Open a dedicated PR that changes only the toolchain/dependency versions.
2. Pass the full contract test suite (`make test`).
3. Include a **resource comparison**: report CPU instructions and ledger read/write bytes for the standard mint/verify flows before and after the upgrade.
4. Update release notes describing the version change and any behavioral impact.
5. Be reviewed by at least one maintainer familiar with the contract.

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

- **Soulbound Nature**: Transfers are permanently disabled via panic
- **Authorization**: Only authorized issuers can mint records
- **Duplicate Prevention**: Identical records are blocked
- **Audit Trail**: Revoked records are preserved, not deleted
- **Input Validation**: All string inputs are length-validated
- **Admin Controls**: Two-step admin transfer with expiry protection