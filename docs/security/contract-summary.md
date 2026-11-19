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
| `upgrade(new_wasm_hash)` | Replaces contract WASM. Emits `upgraded`. |

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
| `batch_verify(wallets)` | Batch version, max 100 wallets. |
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
   The backend currently signs this with `ADMIN_SECRET_KEY` as a placeholder — this must
   be fixed before mainnet (see threat model).

4. **On-chain data is public.** All vaccination records, issuer lists, and patient wallet
   addresses are readable by anyone. There is no privacy layer. The allowlist gates
   *issuance*, not *readability* — see §6.1. Do not describe allowlisted records as
   private; only non-PII fields are ever stored on-chain.

5. **Date format not validated.** `date_administered` is a free-form string (max 100 chars).
   The contract does not validate ISO 8601 format or reject future dates.

6. **No reentrancy risk.** Soroban's single-entry invocation model prevents reentrancy.
   Cross-contract calls are not used.

---

## 8. Known Limitations (Pre-Audit)

These are documented issues that must be resolved before the audit. See
`docs/security/pre-audit-notes.md` for full details.

| Issue | Impact |
|---|---|
| Contract does not compile (15 errors) | No deployable artifact from current source |
| `is_issuer` always returns false (key mismatch) | Minting is permanently broken |
| `batch_verify` panics on oversized input | Opaque error, no structured response |
| Record limit exceeded panics | Opaque error, no structured response |
| Persistent storage TTL never extended | Records may be evicted from ledger |
| No on-chain consent revocation | Consent withdrawal enforced only at API boundary (§6.1) |
| Error codes not yet frozen in source | Backend mapping tests pin the intended stable mapping (§4.2) |

---

## 9. Events

| Event topic | Payload | Emitted by |
|---|---|---|
| `(minted, token_id)` | `(patient, vaccine_name, issuer, timestamp)` | `mint_vaccination` |
| `(revoked, token_id)` | `(revoker, timestamp)` | `revoke_vaccination` |
| `(iss_add,)` | `(issuer, admin, timestamp)` | `add_issuer` |
| `(iss_rev,)` | `(issuer, admin, timestamp)` | `emit_issuer_revoked` (not called) |
| `(adm_prop,)` | `(current_admin, new_admin, expires_at)` | `propose_admin` |
| `(adm_acc,)` | `(new_admin, timestamp)` | `accept_admin` |
| `(upgraded,)` | `(new_wasm_hash, admin, timestamp)` | `upgrade` |
| `(pat_reg,)` | `(patient, timestamp)` | `register_patient` |

> **Note:** `emit_issuer_revoked` is defined in `events.rs` but never called by
> `revoke_issuer`. Revocation events are not emitted.

---

## 10. Audit Scope

The following are **in scope** for the external audit:

- All logic in `src/lib.rs`, `src/mint.rs`, `src/verify.rs`, `src/storage.rs`, `src/events.rs`
- Access control correctness for all privileged functions
- Storage key consistency and data integrity
- Duplicate detection and record limit enforcement
- Soulbound enforcement (`transfer` always reverts)
- Admin transfer two-step flow and expiry
- Contract upgrade authorization
- Input validation completeness
- Event emission correctness and completeness
- Error-code stability and backend mapping coverage (§4.2)
- Consent/allowlist state transitions and privacy boundary (§6.1)
- Soroban-specific concerns: storage TTL, auth model, host function usage

The following are **out of scope** for the contract audit (covered separately):

- Backend API (`backend/`)
- Frontend (`frontend/`)
- Python analytics service (`python-service/`)
- SEP-10 authentication flow
- Infrastructure and deployment
