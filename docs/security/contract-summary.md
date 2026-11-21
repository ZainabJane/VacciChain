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
| `revoke_issuer(issuer)` | Sets `IssuerRecord.authorized = false`. Record preserved for audit. Emits `iss_rev`. Idempotent: revoking an already-revoked issuer is a no-op that still emits the event. |
| `propose_admin(new_admin)` | Two-step admin transfer. Sets pending admin with 24-hour expiry. Emits `adm_prop`. |
| `accept_admin(new_admin)` | Second step of admin transfer. Requires pending admin's `require_auth()`, must be within expiry window. Emits `adm_acc`. |
| `upgrade(new_wasm_hash)` | Replaces contract WASM. Emits `upgraded`. |

### Issuer functions (require issuer `require_auth()` + issuer allowlist check)

| Function | Description |
|---|---|
| `mint_vaccination(patient, vaccine_name, date_administered, issuer)` | Mints soulbound NFT. Checks patient allowlist, issuer authorization, duplicate detection, per-patient record limit (50). Returns `token_id`. |
| `revoke_vaccination(token_id, revoker)` | Marks a single record revoked. Original issuer or admin only. Record never deleted. Irreversible. Emits `revoked`. |

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

---

## 9. Events

| Event topic | Payload | Emitted by |
|---|---|---|
| `(minted, token_id)` | `(patient, vaccine_name, issuer, timestamp)` | `mint_vaccination` |
| `(revoked, token_id)` | `(revoker, timestamp)` | `revoke_vaccination` |
| `(iss_add,)` | `(issuer, admin, timestamp)` | `add_issuer` |
| `(iss_rev,)` | `(issuer, admin, timestamp)` | `revoke_issuer` |
| `(adm_prop,)` | `(current_admin, new_admin, expires_at)` | `propose_admin` |
| `(adm_acc,)` | `(new_admin, timestamp)` | `accept_admin` |
| `(upgraded,)` | `(new_wasm_hash, admin, timestamp)` | `upgrade` |
| `(pat_reg,)` | `(patient, timestamp)` | `register_patient` |

> **Note:** `emit_issuer_revoked` is called by `revoke_issuer`, so issuer-revocation
> events are emitted. Record-level revocation events (`revoked`) are emitted by
> `revoke_vaccination`.

---

## 9a. Issuer Lifecycle State Machine

An issuer transitions between the following states:

```
                 add_issuer()                revoke_issuer()
   (absent) ───────────────────► (authorized) ────────────────► (revoked)
        ▲                              ▲                            │
        │                              │      add_issuer()          │
        │                              └────────────────────────────┘
        │                                   (re-add allowed)
        └────────────────────────────────────────────────────────────
```

- **Allowed transitions.** `absent → authorized` (`add_issuer`), `authorized → revoked`
  (`revoke_issuer`), `revoked → authorized` (`add_issuer` re-add).
- **Disallowed transitions.** `revoked → revoked` via `revoke_issuer` is idempotent (no
  state change, event still emitted). `authorized → authorized` via `add_issuer` overwrites
  metadata and is idempotent with respect to `authorized`.
- **Auditability.** `IssuerRecord` is never deleted; the `authorized` flag records current
  state, and `iss_add`/`iss_rev` events provide the full history.
- **Administrator handoff.** Admin transfer does not alter issuer states; the new admin
  inherits authority over all issuers.

---

## 9b. Administrator Recovery & Rotation

- **Two-step transfer.** `propose_admin(new_admin)` records `PendingAdmin` and
  `AdminTransferExpiry` (24 hours). `accept_admin(new_admin)` requires the pending admin's
  signature and must occur before expiry.
- **Expiry.** After expiry the proposal is invalid; `accept_admin` returns `AdminTransferExpired`.
  A new proposal may be made by the current admin.
- **Cancellation.** The current admin may overwrite `PendingAdmin` with a new proposal,
  implicitly cancelling the prior one.
- **Replay.** `accept_admin` clears `PendingAdmin` on success, so a proposal cannot be
  replayed.
- **Unauthorized attempts.** `propose_admin` requires the current admin's auth;
  `accept_admin` requires the pending admin's auth. Any other caller receives `Unauthorized`.
- **Emergency behavior.** There is no unilateral emergency override; recovery requires the
  current admin key to propose a replacement. Loss of the admin key is unrecoverable at the
  contract level (see Trust Assumptions §7.1).

---

## 10. Audit Scope

The following are **in scope** for the external audit:

- All logic in `src/lib.rs`, `src/mint.rs`, `src/verify.rs`, `src/storage.rs`, `src/events.rs`
- Access control correctness for all privileged functions
- Storage key consistency and data integrity
- Duplicate detection (normalization, equivalence, repeat doses) and record limit enforcement
- Revocation semantics (record-level scope, irreversibility, verifier interpretation, events)
- Issuer lifecycle state machine (add, revoke, re-add, handoff)
- Soulbound enforcement (`transfer` always reverts)
- Admin transfer two-step flow, expiry, cancellation, replay resistance
- Contract upgrade authorization
- Input validation completeness
- Event emission correctness and completeness
- Soroban-specific concerns: storage TTL, auth model, host function usage

The following are **out of scope** for the contract audit (covered separately):

- Backend API (`backend/`)
- Frontend (`frontend/`)
- Python analytics service (`python-service/`)
- SEP-10 authentication flow
- Infrastructure and deployment
