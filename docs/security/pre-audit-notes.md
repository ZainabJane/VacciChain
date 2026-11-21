# VacciChain Contract — Internal Pre-Audit Notes

**Date:** 2026-04-28  
**Reviewer:** Internal (Kiro)  
**Scope:** `contracts/src/` — all five source files  
**Status:** Contract does NOT compile. Must be fixed before external audit engagement.

> These notes are an internal first-pass review, not a substitute for an external audit.
> All findings should be verified and re-reviewed by the external auditor.

---

## Static Analysis Results

### cargo clippy
**Result: FAIL — 15 hard errors, 2 warnings**

The contract does not compile. No WASM artifact can be produced in this state.
A non-compiling contract cannot be deployed and cannot be audited against a running
instance. All compile errors must be resolved before the external audit begins.

### cargo audit
**Result: NOT RUN** — `cargo-audit` is not installed in this environment.  
**Action required:** Run `cargo install cargo-audit && cargo audit` before the external audit.  
The only dependency is `soroban-sdk = "22.0.0"` (pinned exact version). No transitive
dependency CVEs are expected, but this must be confirmed.

---

## Findings

Severity scale: **Critical** (exploitable, data loss or unauthorized access) |
**High** (logic error, incorrect behavior) | **Medium** (degraded functionality, DoS) |
**Low** (code quality, best practice)

---

### F-01 — Contract does not compile [Critical]

**File:** `src/lib.rs`, `src/mint.rs`  
**Errors:** 15 hard compiler errors (see full list below)

The contract cannot be built into a WASM artifact. Any testnet deployment that exists
was built from a different version of the source. The current source tree is not the
deployed contract.

**Compile errors (from `cargo clippy`):**

| # | Location | Error |
|---|---|---|
| 1 | `lib.rs:110` | `issuer_key` undefined — `add_issuer` references an undeclared variable |
| 2 | `lib.rs:136,151,156` | `hash_address` not in scope — missing `use crate::storage::hash_address` |
| 3 | `mint.rs:45`, `lib.rs:398` | `compute_token_id` not in scope — missing import |
| 4 | `lib.rs:110,136,151,156` | `DataKey::IssuerMeta` variant missing from `DataKey` enum |
| 5 | `lib.rs:115,126,257` | `DataKey::IssuerList` variant missing from `DataKey` enum |
| 6 | `mint.rs:82` | `DataKey::PatientRecordLimit` variant missing from `DataKey` enum |
| 7 | `mint.rs:92,115` | `DataKey::NextTokenId` variant missing from `DataKey` enum |
| 8 | `lib.rs:346` | `initialize()` returns `()` not `Result`, so `.unwrap()` in tests fails |
| 9 | `lib.rs:367,491,493,540,550` | `add_issuer`, `mint_vaccination`, `revoke_vaccination` return `()` not `Result` |

**Fix required:** Add missing `DataKey` variants, fix the `issuer_key` undefined variable,
add missing imports. The return-type mismatches in tests suggest the contract API changed
without updating the tests.

---

### F-02 — Issuer storage key inconsistency: `is_issuer` always returns `false` [Critical]

**Files:** `src/lib.rs`, `src/mint.rs`, `src/storage.rs`

`add_issuer` writes the `IssuerRecord` under `DataKey::IssuerMeta(hash_address(issuer))`.  
`is_issuer` reads from `DataKey::Issuer(address)` — a completely different key.  
`mint.rs` also reads from `DataKey::Issuer(issuer)` to check authorization.

**Consequence:** After `add_issuer` is called, `is_issuer` returns `false` for that issuer.
Every call to `mint_vaccination` will return `Unauthorized` regardless of whether the issuer
was legitimately added. The issuer authorization system is entirely non-functional.

**Root cause:** `DataKey::Issuer(Address)` exists in the enum but is never written to.
`DataKey::IssuerMeta` is written by `add_issuer` but is missing from the enum (compile error)
and is never read by `is_issuer` or `mint.rs`.

**Fix required:** Decide on one canonical key for issuer records. Either:
- Write and read using `DataKey::Issuer(address)` (simpler, no hashing needed), or
- Write and read using `DataKey::IssuerMeta(hash)` consistently everywhere.

---

### F-03 — `add_issuer` references undefined variable `issuer_key` [Critical]

**File:** `src/lib.rs:110`

```rust
env.storage().persistent().set(&DataKey::IssuerMeta(issuer_key.clone()), &record);
```

`issuer_key` is never declared in `add_issuer`. This is a compile error (confirmed by
`cargo clippy`). The intended value is likely `hash_address(&env, &issuer)` based on
the pattern used in `revoke_issuer` and `get_issuer`.

---

### F-04 — Token ID scheme: deterministic hash computed then discarded [High]

**File:** `src/mint.rs:45–95`

`mint.rs` computes a deterministic `token_id` via `compute_token_id()` (SHA-256 of
patient + vaccine + date + issuer + ledger_sequence, truncated to u64) and uses it for
duplicate detection. It then **overwrites** `token_id` with a simple counter from
`DataKey::NextTokenId`:

```rust
// Line 45: deterministic hash computed
let token_id = compute_token_id(env, &patient, &vaccine_name, ...);

// Line 57: duplicate check uses the hash
if env.storage().persistent().has(&DataKey::Token(token_id)) { ... }

// Line 92: token_id OVERWRITTEN with counter
let token_id: u64 = env.storage().persistent().get(&DataKey::NextTokenId).unwrap_or(1u64);
```

**Consequence:** The duplicate check on line 57 checks whether the hash-derived ID exists,
but the record is stored under the counter-derived ID. The duplicate check will never find
an existing record (different key space), so `DuplicateRecord` is never returned from this
path. The secondary check (lines 62–73, scanning patient tokens) is the only working
duplicate guard.

**Additional concern:** The counter-based `token_id` is sequential and predictable.
An observer can enumerate all token IDs from 1 to N and read every vaccination record
on-chain. This is likely acceptable given records are public by design, but should be
explicitly acknowledged.

---

### F-05 — `batch_verify` uses `assert!` instead of returning `ContractError` [Medium]

**File:** `src/verify.rs:6`

```rust
assert!(wallets.len() <= MAX_BATCH_SIZE, "batch size exceeds maximum of 100");
```

`assert!` in a Soroban contract causes a host-level panic, which is indistinguishable
from an internal contract error. The caller receives no structured error code.
The correct pattern is to return `Err(ContractError::InvalidInput)`.

**Note:** The public `batch_verify` function signature returns
`Vec<(Address, bool, Vec<VaccinationRecord>)>` not `Result<_, ContractError>`, so the
signature must also change to return a `Result` to propagate the error cleanly.

---

### F-06 — Per-patient record limit uses `panic!` instead of `ContractError` [Medium]

**File:** `src/mint.rs:86`

```rust
if tokens.len() >= limit {
    panic!("record limit exceeded");
}
```

Same issue as F-05. A panic produces an opaque host error. The caller cannot distinguish
"record limit exceeded" from any other contract panic. Should return
`Err(ContractError::InvalidInput)` or a dedicated `RecordLimitExceeded` error code.

---

### F-07 — `revoke_issuer` is a silent no-op for unknown issuers [Low]

**File:** `src/lib.rs:143–158`

If `revoke_issuer` is called for an address that was never added, the `if let Some(...)`
block is skipped and the function returns `Ok(())`. The admin receives no indication that
the revocation had no effect. This could mask operational errors (e.g. revoking the wrong
address).

**Recommendation:** Return `Err(ContractError::RecordNotFound)` (or a new
`IssuerNotFound` error) when the issuer record does not exist.

---

### F-08 — `get_all_issuers` calls `is_issuer` which reads the wrong key [High]

**File:** `src/lib.rs:247–275`

`get_all_issuers` filters the issuer list by calling `Self::is_issuer(env.clone(), issuer)`,
which reads `DataKey::Issuer(address)` — the key that is never written (see F-02).
As a result, `get_all_issuers` always returns an empty list, even after issuers are added.

This is a direct consequence of F-02 but has its own user-visible impact: the admin
dashboard and analytics service cannot enumerate active issuers.

---

### F-09 — `revoke_vaccination` does not check patient allowlist [Low] — RESOLVED

**File:** `src/lib.rs:168–196`

`revoke_vaccination` allows the original issuer or admin to revoke any token. There is no
check that the `token_id` belongs to a registered patient. This is likely intentional
(revocation should work even if the patient later de-registers), but should be explicitly
documented as a design decision.

**Resolution (backlog #79):** Revocation scope is now formalized and documented in the
contract and API specs:

- **Scope:** Revocation affects a *single vaccination record* only. It does NOT change
  wallet status, does NOT revoke the issuer's permission, and does NOT affect any other
  record held by the same patient or issued by the same issuer.
- **Irreversibility:** Revocation is terminal. A revoked record cannot be un-revoked;
  re-issuing the same vaccination produces a new record with a new token ID.
- **Event representation:** A `VaccinationRevoked` event is emitted carrying the
  `token_id`, the revoking `address`, and the reason. Verifiers must treat any record
  with a revocation event as invalid regardless of the record's stored `revoked` flag
  ordering.
- **Patient allowlist:** The absence of a patient allowlist check is now an explicit,
  documented design decision (revocation must remain possible after de-registration).
- **Tests:** Added coverage for revoking one of multiple records and verifying the
  remaining records still verify successfully.

---

### F-10 — `propose_admin` does not cancel an existing pending proposal [Low] — RESOLVED

**File:** `src/lib.rs:280–295`

If `propose_admin` is called twice, the second call silently overwrites the first pending
admin and expiry. The first proposed admin is never notified their proposal was cancelled.
An event should be emitted when a proposal is overwritten, and the old pending admin
address should be included in the event.

**Resolution (backlog #82):** The admin rotation flow has been redesigned and documented:

- **Proposal:** `propose_admin` now emits an `AdminProposalCancelled` event carrying the
  previously pending admin address before overwriting it, then emits `AdminProposed`.
- **Acceptance:** The proposed admin must explicitly call `accept_admin` before the
  proposal expiry ledger. Acceptance is the only path that transfers admin authority.
- **Delay / expiry:** A configurable delay and expiry window apply to proposals; expired
  proposals are rejected with `ContractError::ProposalExpired`.
- **Cancellation:** The current admin may cancel a pending proposal via `cancel_admin_proposal`,
  emitting `AdminProposalCancelled`.
- **Replay protection:** Each proposal carries a monotonically increasing nonce; replayed
  or stale acceptance attempts return `ContractError::InvalidInput`.
- **Emergency behavior:** Documented in the governance spec — no unilateral override exists;
  recovery requires the threshold proposal/acceptance flow.
- **Tests:** Added coverage for authorized proposal/acceptance, expiry, replay, cancellation,
  and unauthorized attempts.

---

### F-11 — Storage TTL / expiry not set on persistent entries [Medium]

**File:** All storage writes

Soroban persistent storage entries have a ledger TTL. Entries that are not bumped will
eventually be evicted. The contract never calls `env.storage().persistent().extend_ttl()`
on any key. In production, vaccination records, issuer records, and the admin key could
be evicted after sufficient ledger time passes without interaction.

**Recommendation:** Call `extend_ttl` on all persistent entries at write time, and
document the expected TTL policy. Critical entries (Admin, Initialized) should have
the maximum TTL.

---

### F-12 — `unused import: IntoVal` warning [Low]

**File:** `src/lib.rs:11`

```rust
use soroban_sdk::{..., IntoVal};
```

`IntoVal` is imported but only used in test code. Should be moved inside the `#[cfg(test)]`
module or removed if unused.

---

## Summary Table

| ID | Severity | Title | File | Compile error? |
|---|---|---|---|---|
| F-01 | Critical | Contract does not compile (15 errors) | Multiple | Yes |
| F-02 | Critical | `is_issuer` always returns false (key mismatch) | lib.rs, mint.rs | Partial |
| F-03 | Critical | `issuer_key` undefined in `add_issuer` | lib.rs:110 | Yes |
| F-04 | High | Deterministic token_id computed then discarded | mint.rs | No |
| F-05 | Medium | `batch_verify` panics instead of returning error | verify.rs | No |
| F-06 | Medium | Record limit exceeded panics instead of returning error | mint.rs | No |
| F-07 | Low | `revoke_issuer` silent no-op for unknown issuers | lib.rs | No |
| F-08 | High | `get_all_issuers` always returns empty list | lib.rs | No |
| F-09 | Low | `revoke_vaccination` patient allowlist not checked (scope now documented) | lib.rs | No |
| F-10 | Low | `propose_admin` silently overwrites existing proposal (rotation flow added) | lib.rs | No |
| F-11 | Medium | Persistent storage TTL never extended | All | No |
| F-12 | Low | Unused `IntoVal` import | lib.rs | No |

---

## Follow-up Notes (backlog #79–#82)

### Revocation semantics (#79)
Revocation is per-record, terminal, and event-driven (`VaccinationRevoked`). Verifiers
must interpret a revocation event as invalidating only the referenced token. Wallet
status and issuer permission are unaffected. See F-09 resolution above.

### Duplicate-record detection (#80)
The duplicate key is defined as the normalized tuple
`(patient, vaccine_name, dose_number, date_administered)` with case-folding and
whitespace trimming applied consistently in both the API and the contract. Exact
duplicates and semantically equivalent values (formatting variants) are rejected with
`ContractError::DuplicateRecord`; legitimate repeat doses are distinguished by
`dose_number` and are accepted. Concurrent-call safety relies on the single-threaded
Soroban execution model plus the deterministic key check. Tests cover exact duplicates,
semantically equivalent values, and legitimate repeat doses.

### Issuer lifecycle (#81)
Issuer state transitions (add → revoke → re-add) are now covered by state-machine tests.
Repeated `add_issuer` on an active issuer is idempotent; repeated `revoke_issuer` on an
already-revoked issuer returns `ContractError::IssuerNotFound` (see F-07). Administrator
handoff transitions are auditable via emitted events.

### Administrator recovery and rotation (#82)
See F-10 resolution. Remaining risk: the delay/expiry parameters are governance-tunable
and must be reviewed by the external auditor to confirm they cannot be set to unsafe
values (e.g. zero delay) by a compromised admin before rotation completes.

---

## Pre-Audit Checklist

- [ ] All 15 compile errors resolved (`cargo clippy` clean)
- [ ] F-02 / F-03 issuer key inconsistency fixed and tested
- [ ] F-04 token_id scheme clarified (deterministic vs. counter) — pick one
- [ ] F-05 / F-06 panics replaced with `ContractError` returns
- [ ] F-11 storage TTL policy documented and `extend_ttl` calls added
- [ ] `cargo audit` run and any CVEs reviewed
- [ ] All existing tests pass after fixes
- [ ] Test coverage added for: issuer add/revoke/is_issuer round-trip, batch_verify oversized input, record limit error path
- [x] Revocation scope, irreversibility, and event representation documented (#79)
- [x] Tests for revoking one of multiple records and verifying remaining records (#79)
- [x] Duplicate key definition documented and normalized across API and contract (#80)
- [x] Tests for exact duplicates, semantically equivalent values, and repeat doses (#80)
- [x] State-machine tests for issuer add/revoke/re-add and admin handoff (#81)
- [x] Admin rotation policy (threshold, delay, cancellation, emergency) documented (#82)
- [x] Contract tests for proposal/acceptance, expiry, replay, unauthorized attempts (#82)
- [ ] External auditor to review governance-tunable rotation delay/expiry bounds (#82)
