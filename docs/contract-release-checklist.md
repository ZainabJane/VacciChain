# Contract Release Checklist

> **Applies to:** every contract release (testnet and mainnet).
> **Owner:** Contracts Release Manager.
> **Related:** [`docs/deployment.md`](./deployment.md), [`docs/mainnet-launch.md`](./mainnet-launch.md), release-gate script [`scripts/check-release-gates.sh`](../scripts/check-release-gates.sh).

This checklist consolidates **all** prerequisites for a contract release — test, audit, artifact, network, admin-key, and verification — into explicit **go/no-go gates**. A release may only proceed when **every** gate below is marked **GO** with a recorded sign-off. Any **NO-GO** blocks the release.

---

## How to use this checklist

1. Copy this file into the release record (e.g. `releases/<version>/checklist.md`) or fill it in place and attach it to the release ticket.
2. Complete each gate in order. Each gate has **explicit go/no-go criteria** and a **sign-off block** (name, role, date, approval reference).
3. A gate is **GO** only when *all* of its criteria are satisfied and a sign-off is recorded. Otherwise it is **NO-GO**.
4. The **Mainnet Gate** (Section 8) is mandatory and is additionally enforced by `scripts/check-release-gates.sh`. Mainnet deployment is refused unless approval records and the expected contract/network identifiers are present.
5. Archive the completed checklist with the release artifacts.

**Release metadata**

| Field | Value |
|---|---|
| Release version / tag | |
| Contract name | |
| Target network | `testnet` / `mainnet` |
| Expected contract ID | |
| Expected network passphrase | |
| Expected RPC URL | |
| Release commit SHA | |
| Release manager | |

---

## 1. Security Gate

**Go/No-Go criteria (all required):**
- [ ] Independent security audit completed and **audit sign-off** recorded.
- [ ] **No open critical or high severity findings.** Medium/low findings are either fixed or have an accepted, documented risk with owner and due date.
- [ ] Dependency vulnerability scans are **clean** (no critical/high) for all build and runtime dependencies.
- [ ] Static analysis / linters pass with no blocking issues.
- [ ] Secrets scan clean (no credentials committed).

| Result | ☐ GO | ☐ NO-GO |
|---|---|---|

**Sign-off**

| Name | Role | Date | Approval reference |
|---|---|---|---|
| | Security Lead | | |
| | Auditor (external) | | |

---

## 2. Resource Gate

**Go/No-Go criteria (all required):**
- [ ] CPU and memory limits verified against the target network's constraints.
- [ ] Ledger entry / storage footprint verified within limits.
- [ ] Gas / resource benchmarks recorded and **within budget** (attach benchmark report).
- [ ] No unbounded loops or unbounded storage growth identified in review.

| Result | ☐ GO | ☐ NO-GO |
|---|---|---|

**Sign-off**

| Name | Role | Date | Approval reference |
|---|---|---|---|
| | Performance Engineer | | |

---

## 3. Compatibility Gate

**Go/No-Go criteria (all required):**
- [ ] SDK version compatibility verified (contract built and tested against the pinned SDK version).
- [ ] Network passphrase compatibility verified for the target network.
- [ ] Contract interface compatibility verified (ABI/interface unchanged or migration documented).
- [ ] **Testnet dry-run** completed successfully with the release artifact.

| Result | ☐ GO | ☐ NO-GO |
|---|---|---|

**Sign-off**

| Name | Role | Date | Approval reference |
|---|---|---|---|
| | Integration Lead | | |

---

## 4. Artifact Integrity Gate

**Go/No-Go criteria (all required):**
- [ ] WASM **SHA-256 hash recorded** below.
- [ ] Recorded hash **matches the build output** (recomputed and compared).
- [ ] Build is reproducible from the tagged commit.
- [ ] **Provenance attestation verified** (signed build / SLSA attestation present and valid).

| Artifact | SHA-256 |
|---|---|
| `contract.wasm` | |

| Result | ☐ GO | ☐ NO-GO |
|---|---|---|

**Sign-off**

| Name | Role | Date | Approval reference |
|---|---|---|---|
| | Build/Release Engineer | | |

---

## 5. Network Identifiers Gate

**Go/No-Go criteria (all required):**
- [ ] Expected **network passphrase** recorded and matches target network.
- [ ] Expected **RPC URL** recorded and reachable.
- [ ] Expected **contract ID** recorded (for upgrades: matches the deployed contract).
- [ ] Identifiers match those used in the testnet dry-run.

| Identifier | Expected value |
|---|---|
| Network passphrase | |
| RPC URL | |
| Contract ID | |

| Result | ☐ GO | ☐ NO-GO |
|---|---|---|

**Sign-off**

| Name | Role | Date | Approval reference |
|---|---|---|---|
| | Network Operations | | |

---

## 6. Admin-Key Handling Gate

**Go/No-Go criteria (all required):**
- [ ] Admin key ceremony performed using a **hardware wallet** or **air-gapped** machine.
- [ ] Key rotation procedure documented and, if applicable, executed.
- [ ] **Multisig approval** configured/obtained for admin operations.
- [ ] No admin keys present in CI, source, or logs.

| Result | ☐ GO | ☐ NO-GO |
|---|---|---|

**Sign-off**

| Name | Role | Date | Approval reference |
|---|---|---|---|
| | Key Custodian | | |
| | Security Lead | | |

---

## 7. Verification Gate

**Go/No-Go criteria (all required):**
- [ ] **Smoke tests** pass against the deployed contract.
- [ ] **Event checks** confirm expected events are emitted.
- [ ] **Post-deploy verification** completed (state, balances, admin config as expected).
- [ ] Rollback / incident plan confirmed.

| Result | ☐ GO | ☐ NO-GO |
|---|---|---|

**Sign-off**

| Name | Role | Date | Approval reference |
|---|---|---|---|
| | QA / Verification Lead | | |

---

## 8. Mainnet Gate (MANDATORY)

> **Mainnet release cannot proceed without recorded approval and the expected contract/network identifiers.**

**Go/No-Go criteria (all required):**
- [ ] All gates 1–7 marked **GO** with sign-offs recorded.
- [ ] **Recorded approval** from the required approvers (see below) present in the release record.
- [ ] **Expected contract ID** recorded and present in the release record.
- [ ] **Expected network passphrase** recorded and present in the release record.
- [ ] **Expected RPC URL** recorded and present in the release record.
- [ ] `scripts/check-release-gates.sh` executed and returned success (exit code 0).

**Approval records**

| Approver | Name | Role | Date | Approval reference |
|---|---|---|---|---|
| Approver 1 | | Engineering Lead | | |
| Approver 2 | | Security Lead | | |
| Approver 3 | | Operations Lead | | |

| Result | ☐ GO | ☐ NO-GO |
|---|---|---|

---

## Release-Gate Enforcement

Mainnet deployment is **refused** unless approval records and the expected contract/network identifiers are present. This is enforced by:

```
scripts/check-release-gates.sh
```

The script validates the release record (approval records + expected contract ID, network passphrase, and RPC URL) and exits non-zero if any are missing, blocking the mainnet deployment step in CI. Run it as a mandatory step before any mainnet deploy:

```
./scripts/check-release-gates.sh --network mainnet --release-record <path>
```

Document the script output (exit code and summary) in the release record.

---

## Final Sign-Off

| Field | Value |
|---|---|
| Overall result | ☐ GO (all gates GO) / ☐ NO-GO |
| Release manager | |
| Date | |
| Approval reference | |
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>