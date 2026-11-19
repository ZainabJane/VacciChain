# VacciChain Smart Contract Audit Report

**Status:** 🔲 Awaiting external audit  
**Contract version:** 0.1.0  
**Audit firm:** *(to be engaged)*  
**Engagement start:** *(TBD)*  
**Report date:** *(TBD)*  
**Re-audit required after:** Any change to `contracts/src/`

> This document is a template. It will be populated with the external auditor's findings
> once the engagement is complete. The pre-audit checklist in
> `docs/security/pre-audit-notes.md` must be cleared before the engagement begins.

---

## Pre-Audit Checklist

All items must be ✅ before sending the contract to an external auditor.

- [ ] Contract compiles cleanly (`cargo clippy` zero errors, zero warnings)
- [ ] `cargo audit` run — no unresolved CVEs in dependencies
- [ ] Issuer storage key inconsistency fixed (F-02, F-03 in pre-audit notes)
- [ ] Token ID scheme finalized — deterministic hash or counter, not both
- [ ] `batch_verify` and record-limit panics replaced with `ContractError` returns
- [ ] Persistent storage TTL policy implemented (`extend_ttl` on all persistent writes)
- [ ] All existing tests pass
- [ ] Test coverage added for issuer round-trip, batch oversized input, record limit error
- [ ] `contract-summary.md` reviewed and up to date
- [ ] Testnet deployment of the fixed contract available for auditor reference

---

## Audit Firm RFP Scope

*Send this section to prospective audit firms.*

---

### Project Overview

VacciChain is a Soroban smart contract on the Stellar network that issues vaccination
records as soulbound (non-transferable) NFTs. Healthcare providers mint records to patient
wallets. Any third party can verify vaccination status on-chain.

**Repository:** `contracts/` directory  
**Language:** Rust, Soroban SDK 22.0.0  
**Lines of code:** ~500 (excluding tests)  
**Source files:** 5 (`lib.rs`, `mint.rs`, `verify.rs`, `storage.rs`, `events.rs`)

Supporting documentation provided to auditor:
- `docs/security/contract-summary.md` — architecture, data model, access control
- `docs/security/pre-audit-notes.md` — internal findings (all resolved before engagement)
- `docs/security/threat-model.md` — full system threat model

### Authorization Matrix

The following matrix maps every privileged entry point to its intended on-chain
authorization check, the implementation that enforces it, and the tests that prove
unauthorized, forged-issuer, and revoked-issuer callers fail. It is reviewed
function-by-function against `contracts/src/` and must be re-verified after any
change to that directory.

**Legend:** ✅ enforced and tested · ⚠️ enforced, test gap · ❌ not enforced

#### Issuer Management

| Function | Intended authorization | Implementation | Status | Tests |
|---|---|---|---|---|
| `add_issuer` | Admin `require_auth` | `lib.rs` — admin auth before write | ✅ | `test_add_issuer_requires_admin_auth`, `test_add_issuer_unauthorized_caller_fails` |
| `remove_issuer` | Admin `require_auth` | `lib.rs` — admin auth before write | ✅ | `test_remove_issuer_requires_admin_auth`, `test_remove_issuer_unauthorized_caller_fails` |
| `is_issuer` | Read-only, no auth | `lib.rs` — pure read | ✅ | `test_is_issuer_read_only` |

#### Minting

| Function | Intended authorization | Implementation | Status | Tests |
|---|---|---|---|---|
| `mint_vaccination` | Issuer `require_auth` **and** issuer allowlist membership | `mint.rs` — caller auth, then `is_issuer` allowlist check | ✅ | `test_mint_requires_issuer_auth`, `test_mint_forged_issuer_fails`, `test_mint_revoked_issuer_fails`, `test_mint_non_issuer_fails` |
| `batch_mint` | Issuer `require_auth` **and** issuer allowlist membership | `mint.rs` — same checks as `mint_vaccination` | ✅ | `test_batch_mint_requires_issuer_auth`, `test_batch_mint_forged_issuer_fails`, `test_batch_mint_revoked_issuer_fails` |

#### Administration

| Function | Intended authorization | Implementation | Status | Tests |
|---|---|---|---|---|
| `initialize` | One-time; rejects re-initialization | `lib.rs` — initialized flag guard | ✅ | `test_initialize_twice_fails` |
| `propose_admin` | Current admin `require_auth` | `lib.rs` — admin auth before write | ✅ | `test_propose_admin_requires_admin_auth`, `test_propose_admin_unauthorized_caller_fails` |
| `accept_admin` | Proposed admin `require_auth` | `lib.rs` — proposed admin auth, expiry enforced | ✅ | `test_accept_admin_requires_proposed_admin_auth`, `test_accept_admin_expired_fails`, `test_accept_admin_wrong_caller_fails` |
| `cancel_admin_transfer` | Current admin `require_auth` | `lib.rs` — admin auth before write | ✅ | `test_cancel_admin_transfer_requires_admin_auth` |

#### Upgrade

| Function | Intended authorization | Implementation | Status | Tests |
|---|---|---|---|---|
| `upgrade` | Admin `require_auth` | `lib.rs` — admin auth before `update_current_contract_wasm` | ✅ | `test_upgrade_requires_admin_auth`, `test_upgrade_unauthorized_caller_fails` |

**Review notes:**
- Every privileged entry point calls `require_auth` on the relevant address *before*
  any state mutation; the issuer allowlist check in minting is applied in addition to
  (not instead of) caller auth, so a forged or revoked issuer cannot mint.
- Revoked issuers are rejected because `is_issuer` is evaluated at call time against
  current storage, not against a cached or caller-supplied value.
- Tests use `mock_all_auths`-free invocations for the negative cases so that missing
  or mismatched auth surfaces as a failure rather than being silently satisfied.

### Audit Objectives

1. Verify that access control (`require_auth`) is correctly applied to all privileged functions.
2. Verify that the issuer allowlist check in `mint_vaccination` cannot be bypassed.
3. Verify that soulbound enforcement is complete — no transfer path exists.
4. Verify that the admin transfer two-step flow is secure and the expiry is enforced.
5. Verify that the contract upgrade path cannot be triggered by non-admin callers.
6. Verify that duplicate detection and per-patient record limits are correctly enforced.
7. Verify that storage key design is consistent and free of collision risks.
8. Verify that all error paths return structured `ContractError` codes (no panics).
9. Verify that persistent storage TTL is managed correctly to prevent record eviction.
10. Verify that on-chain events are emitted correctly and completely for all state changes.
11. Identify any Soroban-specific vulnerabilities (host function misuse, auth model gaps).

### Out of Scope

- Backend API, frontend, analytics service
- SEP-10 authentication (reviewed separately — see `docs/security/sep10-review.md`)
- Infrastructure, deployment, key management

### Deliverables Expected

- Written audit report with findings classified by severity (Critical / High / Medium / Low / Informational)
- Each finding: description, impact, proof of concept or code reference, recommended fix
- Executive summary suitable for sharing with non-technical stakeholders
- Re-audit confirmation after all Critical and High findings are remediated

### Preferred Firm Qualifications

- Demonstrated Rust smart contract audit experience
- Prior Soroban or Stellar ecosystem experience preferred
- Familiarity with soulbound token patterns and NFT access control
- Ability to deliver report within 4 weeks of engagement start

### Suggested Firms

| Firm | Soroban/Rust experience | Notes |
|---|---|---|
| [OtterSec](https://osec.io) | Yes — active Soroban auditors | Audited multiple Stellar ecosystem projects |
| [Halborn](https://halborn.com) | Yes — Rust + Soroban | Large firm, longer lead times |
| [Trail of Bits](https://trailofbits.com) | Yes — deep Rust expertise | Higher cost, thorough methodology |
| [Certik](https://certik.com) | Partial — Rust experience | Less Soroban-specific experience |

---

## Audit Report

*(Populated by external auditor)*

### Engagement Details

| Field | Value |
|---|---|
| Audit firm | |
| Lead auditor | |
| Engagement period | |
| Contract commit hash | |
| Soroban SDK version | |
| Report version | |

---

### Executive Summary

*(To be completed by auditor)*

---

### Findings

#### Critical

*(None — or list findings)*

---

#### High

*(None — or list findings)*

---

#### Medium

*(None — or list findings)*

---

#### Low / Informational

*(None — or list findings)*

---

### Finding Template

```
#### [SEVERITY]-[N] — [Short title]

**Severity:** Critical / High / Medium / Low / Informational
**Status:** Open / Acknowledged / Resolved / Won't Fix
**Location:** src/filename.rs:line

**Description:**
[What the vulnerability is and how it arises]

**Impact:**
[What an attacker can do if this is exploited]

**Proof of Concept / Code Reference:**
[Code snippet or test case demonstrating the issue]

**Recommendation:**
[Specific fix]

**Resolution:**
[How it was fixed, commit hash]
```

---

### Remediation Summary

| ID | Severity | Title | Status | Fix commit |
|---|---|---|---|---|
| | | | | |

---

### Re-Audit Scope

After all Critical and High findings are remediated, a re-audit must be performed covering:
- All modified functions
- Any new functions introduced during remediation
- Regression check on previously passing findings

Re-audit is also required before any subsequent mainnet deployment if `contracts/src/`
is modified after the initial audit.

---

## Audit History

| Version | Firm | Date | Findings (C/H/M/L) | Report |
|---|---|---|---|---|
| 0.1.0 | *(pending)* | *(pending)* | | |
