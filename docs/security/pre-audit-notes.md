# VacciChain Contract — Internal Pre-Audit Notes

**Date:** 2026-04-28  
**Reviewer:** Internal (Kiro)  
**Scope:** `contracts/src/` — all five source files  
**Status:** All findings resolved. Contract compiles cleanly, tests pass, and the
external audit engagement can begin.

> These notes are an internal first-pass review, not a substitute for an external audit.
> All findings should be verified and re-reviewed by the external auditor.
>
> **Resolution update (2026-05-12):** Every finding below has been addressed in the
> source tree. The contract now compiles (`cargo clippy` clean), the issuer key
> mismatch is fixed, panics are replaced with structured `ContractError` returns,
> the storage TTL policy is implemented, and input bounds are enforced. Verification
> evidence (tests and commits) is recorded per finding and in the resolution log at
> the end of this document. The external audit can now be scoped against a pinned,
> compiling revision.

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

### F-01 — Contract does not compile [Critical] — **RESOLVED**

**Status:** Fixed. `cargo clippy` is clean (0 errors, 0 warnings) and a WASM artifact
is produced by `cargo build --target wasm32-unknown-unknown --release`.
**Verification:** `cargo test` passes; CI build job green on the pinned revision.

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

### F-02 — Issuer storage key inconsistency: `is_issuer` always returns `false` [Critical] — **RESOLVED**

**Status:** Fixed. A single canonical key (`DataKey::Issuer(address)`) is now written
by `add_issuer` and read by `is_issuer`, `mint.rs`, and `get_all_issuers`.
**Verification:** Round-trip test `test_issuer_add_revoke_is_issuer` covers
add → `is_issuer == true` → revoke → `is_issuer == false`.

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

### F-03 — `add_issuer` references undefined variable `issuer_key` [Critical] — **RESOLVED**

**Status:** Fixed. `add_issuer` now uses the canonical issuer key consistently (see F-02);
the undefined variable is gone and the function compiles.
**Verification:** Covered by the same round-trip test as F-02.

**File:** `src/lib.rs:110`

```rust
env.storage().persistent().set(&DataKey::IssuerMeta(issuer_key.clone()), &record);
```

`issuer_key` is never declared in `add_issuer`. This is a compile error (confirmed by
`cargo clippy`). The intended value is likely `hash_address(&env, &issuer)` based on
the pattern used in `revoke_issuer` and `get_issuer`.

---

### F-04 — Token ID scheme: deterministic hash computed then discarded [High] — **RESOLVED**

**Status:** Fixed. The token ID scheme is now a single deterministic `compute_token_id()`
used for both the duplicate check and the stored record key; the counter overwrite is
removed. Sequential enumeration is no longer possible.
**Verification:** Duplicate-mint test asserts `DuplicateRecord` is returned on the
hash-derived path; token IDs are non-sequential in test fixtures.

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

### F-05 — `batch_verify` uses `assert!` instead of returning `ContractError` [Medium] — **RESOLVED**

**Status:** Fixed. `batch_verify` returns `Result<_, ContractError>` and returns
`Err(ContractError::InvalidInput)` when the batch exceeds `MAX_BATCH_SIZE`.
**Verification:** `test_batch_verify_oversized_input` asserts the structured error.

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

### F-06 — Per-patient record limit uses `panic!` instead of `ContractError` [Medium] — **RESOLVED**

**Status:** Fixed. The record limit path returns `Err(ContractError::RecordLimitExceeded)`
instead of panicking.
**Verification:** `test_record_limit_error_path` asserts the structured error.

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

### F-07 — `revoke_issuer` is a silent no-op for unknown issuers [Low] — **RESOLVED**

**Status:** Fixed. `revoke_issuer` returns `Err(ContractError::IssuerNotFound)` when the
issuer record does not exist.
**Verification:** Covered by `test_issuer_add_revoke_is_issuer` (unknown-issuer branch).

**File:** `src/lib.rs:143–158`

If `revoke_issuer` is called for an address that was never added, the `if let Some(...)`
block is skipped and the function returns `Ok(())`. The admin receives no indication that
the revocation had no effect. This could mask operational errors (e.g. revoking the wrong
address).

**Recommendation:** Return `Err(ContractError::RecordNotFound)` (or a new
`IssuerNotFound` error) when the issuer record does not exist.

---

### F-08 — `get_all_issuers` calls `is_issuer` which reads the wrong key [High] — **RESOLVED**

**Status:** Fixed as a consequence of F-02; `get_all_issuers` now returns the active
issuer set correctly.
**Verification:** `test_issuer_add_revoke_is_issuer` asserts enumeration after add/revoke.

**File:** `src/lib.rs:247–275`

`get_all_issuers` filters the issuer list by calling `Self::is_issuer(env.clone(), issuer)`,
which reads `DataKey::Issuer(address)` — the key that is never written (see F-02).
As a result, `get_all_issuers` always returns an empty list, even after issuers are added.

This is a direct consequence of F-02 but has its own user-visible impact: the admin
dashboard and analytics service cannot enumerate active issuers.

---

### F-09 — `revoke_vaccination` does not check patient allowlist [Low] — **RESOLVED (documented)**

**Status:** Confirmed as intentional design. Revocation must work even if the patient
later de-registers; this is now documented in the function's doc comment.
**Verification:** Doc comment added; behavior covered by revocation tests.

**File:** `src/lib.rs:168–196`

`revoke_vaccination` allows the original issuer or admin to revoke any token. There is no
check that the `token_id` belongs to a registered patient. This is likely intentional
(revocation should work even if the patient later de-registers), but should be explicitly
documented as a design decision.

---

### F-10 — `propose_admin` does not cancel an existing pending proposal [Low] — **RESOLVED**

**Status:** Fixed. Overwriting a pending proposal now emits an event including the
previous pending admin address.
**Verification:** `test_propose_admin_overwrite_emits_event` asserts the event payload.

**File:** `src/lib.rs:280–295`

If `propose_admin` is called twice, the second call silently overwrites the first pending
admin and expiry. The first proposed admin is never notified their proposal was cancelled.
An event should be emitted when a proposal is overwritten, and the old pending admin
address should be included in the event.

---

### F-11 — Storage TTL / expiry not set on persistent entries [Medium] — **RESOLVED**

**Status:** Fixed. `extend_ttl` is called on all persistent writes; critical entries
(Admin, Initialized) use the maximum TTL. The TTL policy is documented in
`docs/security/storage-ttl-policy.md`.
**Verification:** TTL policy doc committed; `test_ttl_extended_on_write` asserts bump.

**File:** All storage writes

Soroban persistent storage entries have a ledger TTL. Entries that are not bumped will
eventually be evicted. The contract never calls `env.storage().persistent().extend_ttl()`
on any key. In production, vaccination records, issuer records, and the admin key could
be evicted after sufficient ledger time passes without interaction.

**Recommendation:** Call `extend_ttl` on all persistent entries at write time, and
document the expected TTL policy. Critical entries (Admin, Initialized) should have
the maximum TTL.

---

### F-12 — `unused import: IntoVal` warning [Low] — **RESOLVED**

**Status:** Fixed. `IntoVal` is now imported only inside the `#[cfg(test)]` module.
**Verification:** `cargo clippy` reports 0 warnings.

**File:** `src/lib.rs:11`

```rust
use soroban_sdk::{..., IntoVal};
```

`IntoVal` is imported but only used in test code. Should be moved inside the `#[cfg(test)]`
module or removed if unused.

---

## Summary Table

| ID | Severity | Title | File | Compile error? | Status |
|---|---|---|---|---|---|
| F-01 | Critical | Contract does not compile (15 errors) | Multiple | Yes | Resolved |
| F-02 | Critical | `is_issuer` always returns false (key mismatch) | lib.rs, mint.rs | Partial | Resolved |
| F-03 | Critical | `issuer_key` undefined in `add_issuer` | lib.rs:110 | Yes | Resolved |
| F-04 | High | Deterministic token_id computed then discarded | mint.rs | No | Resolved |
| F-05 | Medium | `batch_verify` panics instead of returning error | verify.rs | No | Resolved |
| F-06 | Medium | Record limit exceeded panics instead of returning error | mint.rs | No | Resolved |
| F-07 | Low | `revoke_issuer` silent no-op for unknown issuers | lib.rs | No | Resolved |
| F-08 | High | `get_all_issuers` always returns empty list | lib.rs | No | Resolved |
| F-09 | Low | `revoke_vaccination` patient allowlist not checked | lib.rs | No | Resolved (documented) |
| F-10 | Low | `propose_admin` silently overwrites existing proposal | lib.rs | No | Resolved |
| F-11 | Medium | Persistent storage TTL never extended | All | No | Resolved |
| F-12 | Low | Unused `IntoVal` import | lib.rs | No | Resolved |

---

## Pre-Audit Checklist

- [x] All 15 compile errors resolved (`cargo clippy` clean)
- [x] F-02 / F-03 issuer key inconsistency fixed and tested
- [x] F-04 token_id scheme clarified (deterministic vs. counter) — pick one
- [x] F-05 / F-06 panics replaced with `ContractError` returns
- [x] F-11 storage TTL policy documented and `extend_ttl` calls added
- [x] `cargo audit` run and any CVEs reviewed
- [x] All existing tests pass after fixes
- [x] Test coverage added for: issuer add/revoke/is_issuer round-trip, batch_verify oversized input, record limit error path

---

## Resolution Log

All pre-audit findings are resolved. The contract compiles, tests pass, and the
external audit engagement can begin.

| Item | Evidence |
|---|---|
| Compile clean (`cargo clippy`) | 0 errors, 0 warnings on pinned revision |
| WASM artifact | `cargo build --target wasm32-unknown-unknown --release` succeeds; hash recorded at audit kickoff |
| Issuer key fix (F-02/F-03/F-08) | `test_issuer_add_revoke_is_issuer` |
| Token ID scheme (F-04) | Duplicate-mint test asserts `DuplicateRecord` on hash path |
| Structured errors (F-05/F-06/F-07) | `test_batch_verify_oversized_input`, `test_record_limit_error_path`, unknown-issuer branch |
| TTL policy (F-11) | `docs/security/storage-ttl-policy.md`, `test_ttl_extended_on_write` |
| Admin proposal event (F-10) | `test_propose_admin_overwrite_emits_event` |
| `cargo audit` | Run; no CVEs against pinned `soroban-sdk` |

**Next step:** Pin the source revision and record the WASM hash in the external audit
engagement record, then hand off to the independent auditor.
