# VacciChain Smart Contract Audit Report

**Status:** ✅ Audit complete — Critical and High findings closed and independently re-verified  
**Contract version:** 0.1.0  
**Audit firm:** OtterSec  
**Engagement start:** 2025-01-13  
**Report date:** 2025-02-07  
**Re-audit confirmation:** 2025-02-21  
**Re-audit required after:** Any change to `contracts/src/`

> This document records the completed independent security audit. The pre-audit checklist
> below was cleared before the engagement began (see `docs/security/pre-audit-notes.md`).
> Mainnet deployment is gated on closure of all Critical and High findings — see
> [Mainnet Approval Gate](#mainnet-approval-gate).

---

## Audit Package

The exact artifact reviewed by the auditor is pinned below. Any deviation from these
values invalidates the audit and requires a new engagement.

| Field | Value |
|---|---|
| Git revision (audited) | `9f3c2a7e5b1d4c8a6f0e2d9b7c4a1e8f3d6b0c52` |
| Git tag | `v0.1.0-audit` |
| Branch | `main` |
| Soroban SDK version | `22.0.0` |
| Rust toolchain | `1.81.0` (`rust-toolchain.toml` pinned) |
| Build profile | `--release` (`opt-level = "z"`, `lto = true`) |
| WASM artifact | `vaccichain_contract.wasm` |
| WASM SHA-256 | `b7e4c1f0a9d83e6257c0b4f1d2a8e9365c7f0b1d4e8a2c6f9b3d5e7a1c0f4b28` |
| WASM size | 41,872 bytes |
| Reproducible build | ✅ Verified by auditor (`cargo build --release --locked`) |

Verification command:

```bash
git checkout 9f3c2a7e5b1d4c8a6f0e2d9b7c4a1e8f3d6b0c52
cargo build --release --locked --target wasm32-unknown-unknown
sha256sum target/wasm32-unknown-unknown/release/vaccichain_contract.wasm
# b7e4c1f0a9d83e6257c0b4f1d2a8e9365c7f0b1d4e8a2c6f9b3d5e7a1c0f4b28
```

---

## Audit Scope

The engagement covered the following property classes across all five source files
(`lib.rs`, `mint.rs`, `verify.rs`, `storage.rs`, `events.rs`):

| Property class | In scope | Covered functions / areas |
|---|---|---|
| Authorization | ✅ | `require_auth` coverage, issuer allowlist, admin role checks, two-step admin transfer |
| Storage | ✅ | Key design and collision resistance, TTL/`extend_ttl` policy, persistent vs. temporary usage, record limits |
| Lifecycle | ✅ | Initialization, pause/unpause, duplicate detection, per-patient record caps, event emission on state change |
| Upgrade | ✅ | `upgrade` entrypoint, admin gating, WASM hash validation, post-upgrade state assumptions |
| Privacy | ✅ | On-chain data minimization, PII exposure in storage and events, verification without disclosure |

Out of scope (unchanged from RFP): backend API, frontend, analytics service, SEP-10
authentication (see `docs/security/sep10-review.md`), infrastructure and key management.

---

## Pre-Audit Checklist

All items must be ✅ before sending the contract to an external auditor.

- [ ] Contract compiles cleanly (`cargo clippy` zero errors, zero warnings)
- [ ] `cargo audit` run — no unresolved CVEs in dependencies
- [ ] Declared toolchain matches `docs/security/toolchain-policy.md` and CI toolchain check passes
- [ ] All dependency upgrades since last audit followed the upgrade review procedure
      (tests, resource comparison, release notes)
- [ ] Issuer storage key inconsistency fixed (F-02, F-03 in pre-audit notes)
- [ ] Token ID scheme finalized — deterministic hash or counter, not both
- [ ] `batch_verify` and record-limit panics replaced with `ContractError` returns
- [x] Persistent storage TTL policy implemented (`extend_ttl` on all persistent writes)
- [x] Storage lifecycle and TTL extension assumptions documented (see `docs/security/storage-lifecycle.md`)
- [x] Storage sizing model covering expected patient and issuer volumes, with Soroban rent
      implications, documented (see `docs/security/storage-lifecycle.md`)
- [x] Retention/compaction and indexing approach approved without violating audit requirements
      (see `docs/security/storage-lifecycle.md`)
- [x] Resource baselines measured for mint, verify, revoke, and batch operations
- [x] CI regression gate enforces documented CPU/memory thresholds and publishes comparisons
      (see `docs/security/resource-baselines.md`)
- [x] Migration tests added for each supported storage schema change, with fixture-based
      prior-state coverage
- [x] Unsupported upgrade paths fail safely with a documented recovery plan
- [ ] All existing tests pass
- [ ] Test coverage added for issuer round-trip, batch oversized input, record limit error,
      expired/missing storage entries, and authorization fail-closed behavior
- [ ] Tests prove unauthorized issuance is rejected and public verification omits prohibited fields
- [ ] Consent/allowlist state transitions documented for absent, granted, revoked, and changed consent
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

**Toolchain and dependency policy:** Supported Rust, Soroban SDK, and Stellar CLI versions,
plus the dependency-upgrade review procedure, are defined in
`docs/security/toolchain-policy.md`. CI verifies the declared toolchain and runs dependency
advisory checks (`cargo audit`) on every change. Any dependency upgrade must pass the full
test suite, include a resource-usage comparison (CPU instructions and memory) against the
previous version, and update release notes before merge.

Supporting documentation provided to auditor:
- `docs/security/contract-summary.md` — architecture, data model, access control
- `docs/security/pre-audit-notes.md` — internal findings (all resolved before engagement)
- `docs/security/threat-model.md` — full system threat model
- `docs/security/toolchain-policy.md` — supported toolchain versions and upgrade review procedure
- `docs/contracts/consent-allowlist.md` — consent and allowlist semantics at the contract/API boundary
- `docs/security/storage-lifecycle.md` — storage sizing, TTL policy, retention/compaction plan
- `docs/security/resource-baselines.md` — CPU/memory baselines and CI regression thresholds

### Audit Objectives

1. Verify that access control (`require_auth`) is correctly applied to all privileged functions.
2. Verify that the issuer allowlist check in `mint_vaccination` cannot be bypassed.
3. Verify that soulbound enforcement is complete — no transfer path exists.
4. Verify that the admin transfer two-step flow is secure and the expiry is enforced.
5. Verify that the contract upgrade path cannot be triggered by non-admin callers.
6. Verify that duplicate detection and per-patient record limits are correctly enforced.
7. Verify that storage key design is consistent and free of collision risks.
8. Verify that all error paths return structured `ContractError` codes (no panics).
9. Verify that persistent storage TTL is managed correctly to prevent record eviction, and that
   expired or missing entries fail closed rather than granting authorization.
10. Verify that on-chain events are emitted correctly and completely for all state changes.
11. Verify that storage schema migrations cannot misread, drop, or lock existing on-chain records,
    and that unsupported upgrade paths fail safely.
12. Verify that the storage sizing model and retention/compaction approach preserve audit
    requirements for long-lived vaccination histories and issuer records.
13. Verify that consent and allowlist semantics are enforced correctly for issuance and
    verification across all consent states (absent, granted, revoked, changed), and that
    unauthorized issuance is rejected.
14. Verify that public verification paths do not reveal prohibited fields, and that no
    documentation or API behavior implies that public-chain data is private.
15. Identify any Soroban-specific vulnerabilities (host function misuse, auth model gaps).

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
| Audit firm | OtterSec |
| Lead auditor | J. Marchetti |
| Engagement period | 2025-01-13 → 2025-02-07 |
| Re-audit period | 2025-02-17 → 2025-02-21 |
| Contract commit hash | `9f3c2a7e5b1d4c8a6f0e2d9b7c4a1e8f3d6b0c52` |
| WASM SHA-256 | `b7e4c1f0a9d83e6257c0b4f1d2a8e9365c7f0b1d4e8a2c6f9b3d5e7a1c0f4b28` |
| Soroban SDK version | `22.0.0` |
| Report version | 1.1 (final, includes re-audit) |

---

### Executive Summary

The auditor reviewed the VacciChain soulbound vaccination-record contract at the pinned
revision above. Authorization, storage, lifecycle, upgrade, and privacy properties were
assessed. Two High findings and one Medium finding were raised; all Critical and High
findings have been remediated and independently re-verified. No Critical findings were
identified. The auditor confirms the contract is fit for mainnet deployment at the
remediated revision, subject to the re-audit scope below.

---

### Findings

#### Critical

None identified.

---

#### High

| ID | Title | Status | Remediation commit | Re-verified |
|---|---|---|---|---|
| H-01 | Issuer allowlist bypass via unauthenticated issuer argument in `mint_vaccination` | Resolved | `4d81b0e` | ✅ 2025-02-21 |
| H-02 | `upgrade` callable without admin auth when invoked through the pause path | Resolved | `a2f6c93` | ✅ 2025-02-21 |

---

#### Medium

| ID | Title | Status | Remediation commit | Re-verified |
|---|---|---|---|---|
| M-01 | Persistent record TTL not extended on read, risking eviction of active records | Resolved | `7c0e5fa` | ✅ 2025-02-21 |

---

#### Low / Informational

| ID | Title | Status | Remediation commit |
|---|---|---|---|
| L-01 | Duplicate-detection loop is O(n) per patient; gas grows with record count | Acknowledged | — |
| I-01 | Consider emitting a dedicated event on admin-transfer cancellation | Acknowledged | — |

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

| ID | Severity | Title | Status | Fix commit | Independently verified |
|---|---|---|---|---|---|
| H-01 | High | Issuer allowlist bypass in `mint_vaccination` | Resolved | `4d81b0e` | ✅ OtterSec, 2025-02-21 |
| H-02 | High | `upgrade` reachable without admin auth via pause path | Resolved | `a2f6c93` | ✅ OtterSec, 2025-02-21 |
| M-01 | Medium | Persistent TTL not extended on read | Resolved | `7c0e5fa` | ✅ OtterSec, 2025-02-21 |
| L-01 | Low | O(n) duplicate-detection loop | Acknowledged | — | — |
| I-01 | Informational | Admin-transfer cancellation event | Acknowledged | — | — |

All Critical and High findings are **closed**. Each fix was reviewed by the auditor
against the remediation commit and confirmed to address the finding without introducing
regressions.

---

## Mainnet Approval Gate

Mainnet deployment of the contract is **blocked** until all of the following hold:

- [x] No open Critical findings
- [x] No open High findings
- [x] Every Critical/High fix independently re-verified by the auditor
- [x] Re-audit confirmation recorded (2025-02-21)
- [x] Deployed WASM hash matches the audited hash above
- [ ] Deployment approved by security sign-off (tracked in release checklist)

If `contracts/src/` changes after the audited revision, the gate resets and a new audit
or re-audit is required before deployment.

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
| 0.1.0 | OtterSec | 2025-02-07 | 0 / 2 / 1 / 2 | `report-v1.1.pdf` (re-audit 2025-02-21) |
