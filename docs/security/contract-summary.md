# VacciChain Contract — Audit-Ready Summary

**Version:** 0.2.0  
**Date:** 2026-05-12  
**Language:** Rust (Soroban SDK 22.0.0)  
**Network:** Stellar (Soroban smart contracts)  
**Lines of code:** ~500 (excluding tests and comments)

**Pinned source revision (audit target):** `git rev-parse HEAD` at engagement start —
recorded in `docs/security/audit-scope.md` together with the reproducible build command.
**WASM hash (audit target):** SHA-256 of the release build artifact, recorded in
`docs/security/audit-scope.md` and re-verified against the deployed contract before
mainnet approval.

> Prepared for external auditors. All pre-audit findings have been resolved; see
> `docs/security/pre-audit-notes.md` for the resolution record and
> `docs/security/audit-scope.md` for scope, pinned revision, WASM hash, and findings.
> Critical and high findings must be fixed and independently verified before mainnet
> approval.

---

## 1. Purpose

VacciChain issues vaccination records as soulbound (non-transferable) NFTs on the Stellar
network. Healthcare providers mint records to patient wallets. Patients, employers, schools,
and border agencies can verify vaccination status on-chain without a central database.

---

## 2. Source Files

| File | Purpose | LoC |
|---|---|---|
| `src/lib.rs` | Contract entry point, all public functions, tests | ~400 |
| `src/mint.rs` | Minting logic, duplicate detection, record limit | ~120 |
| `src/verify.rs` | Single-wallet and batch verification | ~40 |
| `src/storage.rs` | Data types, `DataKey` enum, `hash_address`, `compute_token_id`, TTL extension helpers | ~150 |
| `src/events.rs` | On-chain event emission helpers | ~60 |

---

## 3. Architecture

```
                    ┌─────────────────────────────────────┐
                    │         VacciChainContract           │
                    │                                      │
  Admin ───────────►│ initialize / add_issuer / revoke_issuer
                    │ propose_admin / accept_admin / upgrade
                    │                                      │
  Issuer ──────────►│ mint_vaccination / revoke_vaccination │
                    │                                      │
  Patient ─────────►│ register_patient                     │
                    │                                      │
  Anyone ──────────►│ verify_vaccination / batch_verify    │
                    │ is_issuer / get_all_issuers           │
                    │ is_patient_registered / get_issuer   │
                    └─────────────────────────────────────┘
                                    │
                          Soroban Persistent Storage
```

---

## 4. Public Interface

### Admin functions (require admin `require_auth()`)

| Function | Description |
|---|---|
| `initialize(admin)` | One-time setup. Sets admin address. Guarded by `AlreadyInitialized`. |
| `add_issuer(issuer, name, license, country)` | Authorizes a healthcare provider. Stores `IssuerRecord`. Emits `iss_add`. |
| `revoke_issuer(issuer)` | Sets `IssuerRecord.authorized = false`. Record preserved for audit. Emits `iss_rev`. Idempotent: revoking an already-revoked issuer is a no-op that still emits the event. |
| `propose_admin(new_admin)` | Two-step admin transfer. Sets pending admin with 24-hour expiry. Emits `adm_prop`. |
| `accept_admin(new_admin)` | Second step of admin transfer. Requires pending admin's `require_auth()`, must be within expiry window. Emits `adm_acc`. |
| `upgrade(new_wasm_hash)` | Replaces contract WASM. Requires current admin `require_auth()`; the new WASM hash must be reviewed and approved per the upgrade policy (see §7.1). Emits `upgraded` (schema v1). |

### Issuer functions (require issuer `require_auth()` + issuer allowlist check)

| Function | Description |
|---|---|
| `mint_vaccination(patient, vaccine_name, date_administered, issuer)` | Mints soulbound NFT. Checks patient allowlist, issuer authorization, duplicate detection, per-patient record limit (50), and input length bounds (see §5.1). Returns `token_id`. |
| `revoke_vaccination(token_id, revoker)` | Marks record revoked. Original issuer or admin only. Record never deleted. |

### Patient functions (require patient `require_auth()`)

| Function | Description |
|---|---|
| `register_patient(patient)` | Self-registers wallet into allowlist. Required before minting. |

### Public read functions (no auth required)

| Function | Description |
|---|---|
| `verify_vaccination(wallet)` | Returns `(bool, Vec<VaccinationRecord>)` — active (non-revoked) records only. |
| `batch_verify(wallets)` | Batch version. Maximum batch size is `MAX_BATCH_SIZE = 100` wallets, documented in `src/verify.rs` and validated against `wallets.len()` before any storage access. Over-limit input is rejected with a structured `BatchTooLarge` error (no panic, no partial reads). |
| `is_issuer(address)` | Returns `true` if address is an authorized issuer. |
| `get_all_issuers(start, limit)` | Paginated list of authorized issuers. |
| `is_patient_registered(patient)` | Returns `true` if patient has self-registered. |
| `get_issuer(address)` | Returns `IssuerRecord` metadata. |
| `transfer(from, to, token_id)` | Always returns `SoulboundToken` error. |

### 4.1 Authorization summary (source-derived)

Every state-changing entry point calls `require_auth()` on the relevant address; the
Soroban host enforces the signature. The table below is derived directly from the
`require_auth()` calls in `src/lib.rs` and `src/mint.rs`.

| Function | Auth required on | Additional checks |
|---|---|---|
| `initialize` | `admin` | `Initialized` must be false |
| `add_issuer` | `admin` | caller must equal stored `Admin` |
| `revoke_issuer` | `admin` | caller must equal stored `Admin` |
| `propose_admin` | `admin` | caller must equal stored `Admin` |
| `accept_admin` | `new_admin` | pending admin must match, not expired |
| `upgrade` | `admin` | caller must equal stored `Admin` |
| `mint_vaccination` | `issuer` | issuer authorized, patient allowlisted, no duplicate, record limit |
| `revoke_vaccination` | `revoker` | revoker is original issuer or admin |
| `register_patient` | `patient` | idempotent (re-registration is a no-op) |

### 4.2 Error codes (stable contract surface)

Contract errors are returned as `Result<_, ContractError>`. The numeric discriminants
below are part of the public ABI and **must not be renumbered**; new variants are
appended only. The backend maps each variant to a stable HTTP response (see
`backend/` mapping tests).

| Variant | Code | Meaning | Backend mapping |
|---|---|---|---|
| `AlreadyInitialized` | 1 | `initialize` called twice | `409 Conflict` |
| `NotInitialized` | 2 | Admin action before `initialize` | `503 Service Unavailable` |
| `Unauthorized` | 3 | Caller is not admin / not issuer | `403 Forbidden` |
| `IssuerNotAuthorized` | 4 | Issuer missing or revoked | `403 Forbidden` |
| `PatientNotRegistered` | 5 | Patient not on allowlist | `422 Unprocessable Entity` |
| `DuplicateRecord` | 6 | Same vaccine + date already minted | `409 Conflict` |
| `RecordLimitExceeded` | 7 | Per-patient limit (50) reached | `422 Unprocessable Entity` |
| `TokenNotFound` | 8 | Unknown `token_id` | `404 Not Found` |
| `SoulboundToken` | 9 | `transfer` attempted | `400 Bad Request` |
| `BatchTooLarge` | 10 | `batch_verify` over 100 wallets | `400 Bad Request` |
| `AdminTransferExpired` | 11 | `accept_admin` after expiry | `410 Gone` |
| `InvalidInput` | 12 | Empty/oversized string argument | `400 Bad Request` |

> Codes are illustrative of the intended stable mapping; the authoritative source is
> the `ContractError` enum in `src/lib.rs`. Backend mapping tests
> (`backend/tests/contract_error_mapping.*`) assert one-to-one coverage of every variant.

### 4.3 Version-specific behavior

- `VaccinationRecord.schema_version` is currently always `1`. Readers must treat
  unknown `schema_version` values as forward-compatible: parse known fields, ignore
  unknown ones, and never reject a record solely on version.
- `verify_vaccination` returns only non-revoked records; revoked records remain
  retrievable via `Token(token_id)` for audit but are excluded from verification.
- Function argument evolution: new optional arguments are added as new functions
  (e.g. `mint_vaccination_v2`) rather than changing existing signatures, so existing
  callers keep working. Deprecations are announced one release ahead.

---

## 4a. Revocation Semantics

Revocation is **record-level**, not wallet-level or issuer-level:

- **Scope.** `revoke_vaccination(token_id, revoker)` affects exactly one `VaccinationRecord`.
  It sets `record.revoked = true` and `Revoked(token_id) = true`. Other records for the same
  patient, and the patient's wallet registration, are unaffected. Revoking an issuer
  (`revoke_issuer`) does **not** revoke records that issuer previously minted — those remain
  valid unless individually revoked.
- **Authorization.** Only the record's original `issuer` or the current `admin` may revoke.
  Any other caller receives `Unauthorized`.
- **Irreversibility.** Revocation is permanent. There is no un-revoke function; a revoked
  record can never be reactivated. Re-revoking an already-revoked record is idempotent
  (no state change, no error).
- **Verifier interpretation.** `verify_vaccination` and `batch_verify` return only active
  (non-revoked) records. A revoked record is excluded from the returned `Vec` and does not
  contribute to the `bool` validity flag. Verifiers MUST treat absence of a record as
  equivalent to a revoked record for status purposes.
- **Event representation.** Revocation emits `(revoked, token_id)` with payload
  `(revoker, timestamp)`. Off-chain indexers should treat this event as the authoritative
  signal of revocation; the `Revoked(token_id)` storage key is redundant with
  `record.revoked` and exists only for fast lookup.

---

## 4b. Duplicate-Record Detection

The duplicate key is defined as the tuple:

```
(patient, normalized_vaccine_name, normalized_date_administered)
```

- **Normalization.** `vaccine_name` and `date_administered` are trimmed of leading/trailing
  whitespace and lowercased (ASCII) before comparison. This prevents bypass via casing or
  padding variants. The normalization MUST be identical in the contract and the backend API.
- **Semantically equivalent values.** Two records with the same patient, vaccine, and date
  are duplicates regardless of formatting variants (e.g. `"COVID-19"` vs `"covid-19 "`).
- **Legitimate repeat doses.** A repeat dose is distinguished by a different
  `date_administered`; the same vaccine on a different date is **not** a duplicate.
- **Concurrency.** Duplicate detection and insertion occur within a single Soroban
  invocation (atomic), so concurrent calls cannot both succeed for the same key.

---

## 5. Data Model

### `VaccinationRecord`
```rust
pub struct VaccinationRecord {
    pub token_id: u64,
    pub patient: Address,
    pub vaccine_name: String,       // max 100 chars
    pub date_administered: String,  // max 100 chars, format not validated on-chain
    pub issuer: Address,
    pub timestamp: u64,             // ledger timestamp at mint
    pub schema_version: u32,        // currently always 1
    pub revoked: bool,
}
```

### `IssuerRecord`
```rust
pub struct IssuerRecord {
    pub name: String,       // max 100 chars
    pub license: String,    // max 100 chars
    pub country: String,    // max 100 chars
    pub authorized: bool,
}
```

### 5.1 Input and Collection Bound Policy

All variable-length inputs and collections are bounded on-chain. Exceeding a bound
returns a structured contract error; no path panics on user-controlled input.

| Input / collection | Bound | Enforcement |
|---|---|---|
| `vaccine_name` | 100 chars | `mint_vaccination` rejects oversized input |
| `date_administered` | 100 chars | `mint_vaccination` rejects oversized input |
| `IssuerRecord.name` / `.license` / `.country` | 100 chars each | `add_issuer` rejects oversized input |
| Records per patient (`PatientTokens`) | 50 | `mint_vaccination` returns structured error |
| `batch_verify` wallet list | 100 wallets | `batch_verify` returns structured error |
| `get_all_issuers` page size | caller-supplied `limit` | paginated read, no unbounded iteration |

### 5.2 Privacy-Safe Field Classification

On-chain state is immutable and publicly readable. Every field is classified below;
personally identifying and clinically sensitive data are excluded by policy. See
`docs/security/privacy-review.md` for the privacy review sign-off and residual
linkability analysis.

| Field | Classification | Rationale |
|---|---|---|
| `token_id` | Public identifier | Opaque sequential ID; no personal meaning |
| `patient` (Address) | Pseudonymous identifier | Wallet address only; no name or contact data |
| `vaccine_name` | Sensitive-but-required | Minimum clinical detail needed for verification |
| `date_administered` | Sensitive-but-required | Minimum clinical detail needed for verification |
| `issuer` (Address) | Public identifier | Provider wallet address |
| `timestamp` | Public metadata | Ledger time of mint |
| `schema_version` | Public metadata | Schema evolution |
| `revoked` | Public metadata | Verification status |
| `IssuerRecord.name` / `.license` / `.country` | Public provider metadata | Organizational, not patient, data |

**Excluded by policy (must never be written on-chain):** patient names, dates of birth,
contact details (email, phone, address), national ID numbers, insurance identifiers,
free-text clinical notes, and any field not listed above. Residual linkability risk
(wallet addresses are persistent pseudonyms and can be correlated across records) is
documented and accepted in the privacy review.

### Storage Keys (`DataKey` enum)
```
Admin                        → Address (current admin)
Initialized                  → bool
PendingAdmin                 → Address
AdminTransferExpiry          → u64 (ledger timestamp)
Issuer(Address)              → IssuerRecord
PatientTokens(Address)       → Vec<u64> (token IDs owned by patient)
Token(u64)                   → VaccinationRecord
Revoked(u64)                 → bool (redundant with record.revoked)
PatientAllowlist(Address)    → bool
IssuerMeta(Address)          → IssuerRecord
IssuerList                   → Vec<Address>
NextTokenId                  → u64
PatientRecordLimit           → u32
```

> **Note:** All keys used in the source are present in the `DataKey` enum. Persistent
> storage TTL is extended on every write path.

### Storage Lifecycle and TTL

All persistent entries are written with an explicit TTL extension via
`extend_ttl` in `src/storage.rs`. The assumptions are:

- **Minimum TTL:** every persistent write (records, issuer records, allowlist
  entries, token lists) extends the entry to at least `MIN_TTL_LEDGERS`
  (~30 days at 5s ledgers) so entries cannot expire between routine touches.
- **Read-path extension:** `verify_vaccination`, `batch_verify`, and
  `get_issuer` extend the TTL of the entries they read, so active records are
  refreshed by verification traffic.
- **Expiry behavior:** if an entry does expire, reads return `None` and the
  contract surfaces a typed error (`RecordNotFound` / `IssuerNotFound`) rather
  than panicking. Authorization checks are performed against the caller's
  `require_auth()` and the stored allowlist; a missing allowlist entry denies
  the operation (fail-closed), never grants it.
- **Tests:** `tests/storage_lifecycle.rs` covers expired/missing entries for
  records, issuer records, and allowlist entries, and asserts that a missing
  entry cannot bypass authorization.

### Storage Sizing and Archival Strategy

See `docs/architecture/storage-and-archival.md` for the full analysis. Summary:

- **Per-record footprint:** a `VaccinationRecord` (two `Address`es, two
  ≤100-char strings, u64/u32/bool fields) plus its `Token(u64)` key and
  `PatientTokens` list entry is estimated at ~0.5–0.7 KB of ledger entry data.
- **Volume estimates:** at 10k issuers and 1M patients with an average of 5
  records each, persistent state is on the order of 3–4 GB of ledger entries;
  Soroban rent is charged per entry per ledger, so the dominant cost is the
  number of live entries, not their byte size.
- **Retention/compaction:** records are never deleted (audit requirement).
  Revoked records remain on-chain; the redundant `Revoked(u64)` key is a
  candidate for removal in a future schema version to halve revocation
  overhead. Off-chain indexing (event replay from `minted`/`revoked` topics)
  provides query performance without on-chain compaction.
- **Rent funding:** the contract's rent is funded operationally; archival
  (entry eviction and restoration) is documented as a recovery path, not a
  routine operation, because restoration requires the original entry XDR.

### Resource Baselines and Regression Gates

Measured Soroban CPU-instruction and memory baselines for representative
operations (mint, verify, revoke, batch verify) are recorded in
`docs/performance/resource-baselines.md`. CI runs the benchmark suite and
fails the build when an operation exceeds its documented threshold, publishing
the before/after comparison as a CI artifact.

### Migration Test Coverage

Schema changes are covered by fixture-based migration tests in
`tests/migrations/`. Each supported schema version transition has a fixture
containing prior-version state and asserts that the new contract reads it
correctly. Unsupported upgrade paths (e.g. downgrades or unknown
`schema_version` values) fail safely with a typed error; the recovery plan is
documented in `docs/architecture/storage-and-archival.md`.

---

## 6. Access Control Model

```
Role        │ How established                    │ What it controls
────────────┼────────────────────────────────────┼──────────────────────────────────
Admin       │ Set at initialize(); transferred    │ add/revoke issuers, upgrade WASM,
            │ via propose_admin/accept_admin      │ propose admin transfer
────────────┼────────────────────────────────────┼──────────────────────────────────
Issuer      │ Added by admin via add_issuer()     │ mint_vaccination,
            │ Revoked by admin via revoke_issuer()│ revoke_vaccination (own records)
────────────┼────────────────────────────────────┼──────────────────────────────────
Patient     │ Self-registers via register_patient │ Must register before receiving
            │ Requires patient's own signature    │ a vaccination record
────────────┼────────────────────────────────────┼──────────────────────────────────
Anyone      │ No auth required                   │ verify_vaccination, batch_verify,
            │                                    │ is_issuer, get_all_issuers
```

All privileged operations use Soroban's `require_auth()` — the host enforces that the
named address has signed the invocation. There is no off-chain bypass.

### 6.1 Soulbound Enforcement Matrix

| Path | Transfer allowed? | Enforcement |
|---|---|---|
| `transfer(from, to, token_id)` | No | Always returns `SoulboundToken` error |
| Record reassignment via `mint_vaccination` | No | `PatientTokens` is append-only per patient; records are never moved |
| `revoke_vaccination` | N/A | Marks `revoked = true`; record and ownership are never deleted or reassigned |
| Direct storage write | No | No public function mutates `Token`/`PatientTokens` ownership |

---

## 6.1 Consent and allowlist semantics (contract/API boundary)

The allowlist is a **consent gate**, not a privacy mechanism. It records that a patient
has authorized their wallet to receive records; it does **not** make on-chain data private.

### State transitions

| State | Trigger | Contract effect | API behavior |
|---|---|---|---|
| **Absent** | Patient never registered | `PatientAllowlist(addr)` unset; `is_patient_registered` → `false` | `mint_vaccination` → `PatientNotRegistered` (422); API returns `consent: "absent"` |
| **Granted** | `register_patient(patient)` signed by patient | `PatientAllowlist(addr) = true`; emits `pat_reg` | API returns `consent: "granted"`; issuance permitted |
| **Revoked** | No on-chain revoke exists in v0.1.0; consent withdrawal is handled off-chain by the API refusing to submit mints | Allowlist entry remains `true` on-chain | API returns `consent: "revoked"` and rejects issuance before it reaches the contract |
| **Changed** | Patient rotates wallet: register new wallet, API stops minting to old | New wallet `true`; old wallet retains historical records | API returns `consent: "changed"` with both wallet references |

> **Important:** Because there is no on-chain consent revocation in v0.1.0, a revoked
> consent is enforced at the API boundary only. Auditors should note this gap; an
> on-chain `revoke_patient` is planned (see pre-audit notes).

### Privacy boundary

- **Public on-chain:** wallet addresses, vaccine names, dates, issuer addresses,
  timestamps, revocation flags. Anyone can read these via `verify_vaccination`.
- **Never on-chain:** patient names, dates of birth, government IDs, contact details,
  or any PII. The contract stores only the fields in `VaccinationRecord`.
- **Public verification** (`verify_vaccination`, `batch_verify`) returns only the
  fields above and never reveals prohibited PII — there is none to reveal. Tests
  (`src/verify.rs` and backend verification tests) assert the returned struct contains
  no PII fields.
- **Unauthorized issuance** is rejected: `mint_vaccination` requires a valid issuer
  signature and an allowlisted patient, returning `IssuerNotAuthorized` or
  `PatientNotRegistered` otherwise.

---

## 7. Trust Assumptions

1. **Admin key security.** The admin key controls issuer authorization and contract upgrades.
   A compromised admin key can add malicious issuers or replace the contract WASM entirely.
   The two-step admin transfer (propose + accept, 24-hour expiry) mitigates accidental
   transfers but does not protect against a stolen key.

2. **Issuer key security.** A compromised issuer key can mint fraudulent vaccination records
   to any registered patient wallet. Records are permanent (revocation marks them but does
   not delete them).

3. **Patient self-registration.** The patient allowlist prevents unsolicited minting, but
   requires the patient to sign a `register_patient` transaction before receiving records.
   The backend signs this with the patient's own key; the earlier `ADMIN_SECRET_KEY`
   placeholder has been removed.

4. **On-chain data is public.** All vaccination records, issuer lists, and patient wallet
   addresses are readable by anyone. There is no privacy layer; the on-chain schema is
   minimized per the field classification in §5.2 and residual linkability risk is
   documented in the privacy review.

5. **Date format not validated.** `date_administered` is a free-form string (max 100 chars).
   The contract does not validate ISO 8601 format or reject future dates.

6. **No reentrancy risk.** Soroban's single-entry invocation model prevents reentrancy.
   Cross-contract calls are not used.

### 7.1 Upgrade Authorization and Compatibility

Contract upgrades are a privileged, admin-only operation. The process is:

1. **Proposal.** A release candidate WASM is built reproducibly (see §11) and its
   SHA-256 hash is published alongside the reviewed source tag.
2. **Approval.** At least one reviewer independent of the author must approve the
   artifact hash and the diff against the previous release. The approval record is
   stored off-chain in the release notes.
3. **Execution.** The current admin calls `upgrade(new_wasm_hash)` with the approved
   hash. The host enforces `require_auth()` on the admin address; any other caller
   fails with an auth error and no state change.
4. **Rollback.** Soroban does not support reverting to a previous WASM in place.
   Rollback requires a new `upgrade` call to the prior approved hash, which must
   itself go through steps 1–3. There is no time-limited rollback window.

Client compatibility: storage layout and event schemas are versioned (see §9). A
new WASM must remain backward compatible with the previous schema version for at
least one release cycle, or ship a migration path documented in the release notes.

---

## 8. Resolved Pre-Audit Findings

All previously documented pre-audit issues have been fixed and covered by tests. See
`docs/security/pre-audit-notes.md` for the resolution record.

| Issue | Resolution |
|---|---|
| Contract did not compile (15 errors) | `DataKey` enum completed; contract builds cleanly |
| `is_issuer` always returned false (key mismatch) | Storage key usage aligned; covered by tests |
| `batch_verify` panicked on oversized input | Returns structured error; bound documented in §5.1 |
| Record limit exceeded panicked | Returns structured error; bound documented in §5.1 |
| Persistent storage TTL never extended | TTL extended on every write path |
| `emit_issuer_revoked` never called | `revoke_issuer` now emits `iss_rev` |
| Event schemas not versioned in emitted topics | Schemas now versioned; indexers can distinguish payload versions after upgrade (see §9) |
| No reproducible build pipeline | Reproducible build pipeline added; release WASM hash can be independently verified (see §11) |

> **Resolved:** persistent storage TTL extension is now implemented (see
> §5 "Storage Lifecycle and TTL"); storage sizing, archival strategy, resource
> baselines, and migration test coverage are documented in §5 and the
> referenced docs.

---

## 9. Events

Event schemas are versioned. Every emitted event carries a `schema_version: u32`
field as the final element of its payload, and the topic tuple includes the
version so indexers can route payloads without decoding them first. The current
schema version is **1**; new fields are appended (never reordered or removed)
and a version bump is required for any breaking change.

| Event topic | Payload (schema v1) | Emitted by |
|---|---|---|
| `(minted, token_id, v1)` | `(patient, vaccine_name, issuer, timestamp, schema_version)` | `mint_vaccination` |
| `(revoked, token_id, v1)` | `(revoker, timestamp, schema_version)` | `revoke_vaccination` |
| `(iss_add, v1)` | `(issuer, admin, timestamp, schema_version)` | `add_issuer` |
| `(iss_rev, v1)` | `(issuer, admin, timestamp, schema_version)` | `revoke_issuer` |
| `(adm_prop, v1)` | `(current_admin, new_admin, expires_at, schema_version)` | `propose_admin` |
| `(adm_acc, v1)` | `(new_admin, timestamp, schema_version)` | `accept_admin` |
| `(upgraded, v1)` | `(new_wasm_hash, admin, timestamp, schema_version)` | `upgrade` |
| `(pat_reg, v1)` | `(patient, timestamp, schema_version)` | `register_patient` |

Compatibility rules:

- Indexers must key on the version element in the topic and ignore unknown
  trailing payload fields (forward compatibility).
- A payload with an unknown version must be recorded but not interpreted.
- Contract tests assert the exact topic tuple and payload shape for each event,
  and indexer fixtures in the backend test suite validate the same shapes.

> **Note:** `revoke_issuer` emits `iss_rev` via `emit_issuer_revoked`.

---

## 10. Reproducible Builds

Release WASM artifacts must be independently reproducible from the reviewed
source tag:

- **Toolchain pinning.** The Rust toolchain is pinned via `rust-toolchain.toml`
  and the Soroban SDK version is pinned in `Cargo.toml`; `Cargo.lock` is
  committed and must not be regenerated for a release build.
- **Build command.** `cargo build --release --target wasm32-unknown-unknown`
  with `SOURCE_DATE_EPOCH` set from the release tag commit time.
- **Artifact hash.** The SHA-256 of the resulting `.wasm` is published in the
  release notes and compared against the hash passed to `upgrade`.
- **Clean runner.** A CI job on a clean runner rebuilds the artifact and fails
  the release if the hash differs. Any nondeterministic input (e.g. absolute
  paths, build timestamps) must be documented in the release notes.

---

## 11. Audit Scope

The following are **in scope** for the external audit:

- All logic in `src/lib.rs`, `src/mint.rs`, `src/verify.rs`, `src/storage.rs`, `src/events.rs`
- Access control correctness for all privileged functions
- Storage key consistency and data integrity
- Duplicate detection (normalization, equivalence, repeat doses) and record limit enforcement
- Revocation semantics (record-level scope, irreversibility, verifier interpretation, events)
- Issuer lifecycle state machine (add, revoke, re-add, handoff)
- Soulbound enforcement (`transfer` always reverts)
- Admin transfer two-step flow, expiry, cancellation, replay resistance
- Contract upgrade authorization and rollback limitations (§7.1)
- Input validation completeness, including batch size limits (§4) and the input/collection bound policy (§5.1)
- Privacy-safe field classification and on-chain schema minimization (§5.2)
- Soulbound enforcement across all paths (§6.1)
- Event emission correctness, completeness, and schema versioning (§9)
- Reproducible build process and artifact hash verification (§10)
- Soroban-specific concerns: storage TTL extension, auth model, host function usage
- Storage growth, archival, and migration test coverage (see §5)
- Contract lifecycle and upgrade authorization

The pinned source revision and WASM hash under audit are recorded in
`docs/security/audit-scope.md`. Critical and high findings must be fixed and
independently verified before mainnet approval.

The following are **out of scope** for the contract audit (covered separately):

- Backend API (`backend/`)
- Frontend (`frontend/`)
- Python analytics service (`python-service/`)
- SEP-10 authentication flow
- Infrastructure and deployment
