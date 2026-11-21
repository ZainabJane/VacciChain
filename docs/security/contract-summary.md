# VacciChain Contract — Audit-Ready Summary

**Version:** 0.1.0  
**Date:** 2026-04-28  
**Language:** Rust (Soroban SDK 22.0.0)  
**Network:** Stellar (Soroban smart contracts)  
**Lines of code:** ~500 (excluding tests and comments)

> Prepared for external auditors. See `docs/security/pre-audit-notes.md` for known
> issues that must be resolved before the audit engagement begins.

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
| `src/storage.rs` | Data types, `DataKey` enum, `hash_address`, `compute_token_id` | ~110 |
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
| `revoke_issuer(issuer)` | Sets `IssuerRecord.authorized = false`. Record preserved for audit. |
| `propose_admin(new_admin)` | Two-step admin transfer. Sets pending admin with 24-hour expiry. |
| `upgrade(new_wasm_hash)` | Replaces contract WASM. Requires current admin `require_auth()`; the new WASM hash must be reviewed and approved per the upgrade policy (see §7.1). Emits `upgraded` (schema v1). |

### Issuer functions (require issuer `require_auth()` + issuer allowlist check)

| Function | Description |
|---|---|
| `mint_vaccination(patient, vaccine_name, date_administered, issuer)` | Mints soulbound NFT. Checks patient allowlist, issuer authorization, duplicate detection, per-patient record limit (50). Returns `token_id`. |
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
```

> **Note:** `IssuerMeta`, `IssuerList`, `NextTokenId`, and `PatientRecordLimit` are used
> in the source but missing from the `DataKey` enum — compile errors. See pre-audit notes.

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
   The backend currently signs this with `ADMIN_SECRET_KEY` as a placeholder — this must
   be fixed before mainnet (see threat model).

4. **On-chain data is public.** All vaccination records, issuer lists, and patient wallet
   addresses are readable by anyone. There is no privacy layer.

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

## 8. Known Limitations (Pre-Audit)

These are documented issues that must be resolved before the audit. See
`docs/security/pre-audit-notes.md` for full details.

| Issue | Impact |
|---|---|
| Contract does not compile (15 errors) | No deployable artifact from current source |
| `is_issuer` always returns false (key mismatch) | Minting is permanently broken |
| `batch_verify` panics on oversized input | Opaque error, no structured response (target: structured `BatchTooLarge`, see §4) |
| Record limit exceeded panics | Opaque error, no structured response |
| Persistent storage TTL never extended | Records may be evicted from ledger |
| Event schemas not versioned in emitted topics | Indexers cannot distinguish payload versions after upgrade (see §9) |
| No reproducible build pipeline | Release WASM hash cannot be independently verified (see §11) |

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
| `(iss_rev, v1)` | `(issuer, admin, timestamp, schema_version)` | `emit_issuer_revoked` (not called) |
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

> **Note:** `emit_issuer_revoked` is defined in `events.rs` but never called by
> `revoke_issuer`. Revocation events are not emitted.

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
- Duplicate detection and record limit enforcement
- Soulbound enforcement (`transfer` always reverts)
- Admin transfer two-step flow and expiry
- Contract upgrade authorization and rollback limitations (§7.1)
- Input validation completeness, including batch size limits (§4)
- Event emission correctness, completeness, and schema versioning (§9)
- Reproducible build process and artifact hash verification (§10)
- Soroban-specific concerns: storage TTL, auth model, host function usage

The following are **out of scope** for the contract audit (covered separately):

- Backend API (`backend/`)
- Frontend (`frontend/`)
- Python analytics service (`python-service/`)
- SEP-10 authentication flow
- Infrastructure and deployment
