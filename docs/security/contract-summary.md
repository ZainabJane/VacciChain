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
| `batch_verify(wallets)` | Batch version, max 100 wallets. Oversized input returns a structured error instead of panicking. |
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

> **Note:** `revoke_issuer` emits `iss_rev` via `emit_issuer_revoked`.

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
- Input validation completeness and the input/collection bound policy (§5.1)
- Privacy-safe field classification and on-chain schema minimization (§5.2)
- Soulbound enforcement across all paths (§6.1)
- Event emission correctness and completeness
- Soroban-specific concerns: storage TTL, auth model, host function usage
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
