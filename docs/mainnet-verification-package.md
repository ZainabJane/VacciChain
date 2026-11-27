# Mainnet Contract Verification Package

This document is the canonical verification package for the mainnet deployment of the contract. It provides operators and integrators with everything needed to independently audit the deployed contract: the source commit, reproducible WASM artifact hash, audit report, deployment transaction, and verified contract ID.

> **Backlog item:** #100 — Publish a mainnet contract verification package
> **Dependencies:** #73 (reproducible build), #93 (audit report), #94 (mainnet deployment)

---

## 1. Release Summary

| Field | Value |
| --- | --- |
| Network | Mainnet |
| Contract ID | `CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM` |
| WASM SHA-256 hash | `0000000000000000000000000000000000000000000000000000000000000000` |
| Source commit | `0000000000000000000000000000000000000000` |
| Source repository | `https://github.com/example/contracts` |
| Release tag | `v1.0.0` |
| Deployment transaction hash | `0000000000000000000000000000000000000000000000000000000000000000` |
| Deployment ledger | `00000000` |
| Audit report | [`audits/v1.0.0-audit-report.pdf`](../audits/v1.0.0-audit-report.pdf) |
| Auditor | Example Security Firm |
| Audit date | 2025-01-01 |
| Build toolchain | `rustc 1.XX.X`, `soroban-sdk X.X.X`, `stellar-cli X.X.X` |

> **Note to maintainers:** Replace every placeholder value above with the real values from the release. The values in this table are the single source of truth referenced by all verification steps below.

---

## 2. Artifacts

The release package contains the following artifacts. Each must be downloadable and hash-verifiable.

| Artifact | Location | SHA-256 |
| --- | --- | --- |
| Contract WASM | `artifacts/contract.wasm` | `0000000000000000000000000000000000000000000000000000000000000000` |
| Audit report | `audits/v1.0.0-audit-report.pdf` | `0000000000000000000000000000000000000000000000000000000000000000` |
| Build manifest | `artifacts/build-manifest.json` | `0000000000000000000000000000000000000000000000000000000000000000` |
| Source archive | `artifacts/source-v1.0.0.tar.gz` | `0000000000000000000000000000000000000000000000000000000000000000` |

The **WASM SHA-256 hash** in the Release Summary is the hash of `artifacts/contract.wasm` and must match the on-chain contract code hash (see Step 4).

---

## 3. Reproducible Build

The WASM artifact is produced by a deterministic build. Anyone can rebuild it from the pinned source commit and confirm the hash matches.

### 3.1 Toolchain

The exact toolchain is pinned in `rust-toolchain.toml` and recorded in `artifacts/build-manifest.json`. The build uses the official Soroban/Stellar reproducible build container.

### 3.2 Build command

```bash
# Clone the repository and check out the pinned commit
git clone https://github.com/example/contracts.git
cd contracts
git checkout 0000000000000000000000000000000000000000

# Verify the working tree is clean and matches the tag
git status --porcelain   # must be empty
git rev-parse HEAD       # must equal the Source commit above

# Build inside the pinned reproducible container
docker run --rm -v "$PWD":/src -w /src \
  stellar/rust-reproducible-build:latest \
  cargo build --release --locked --target wasm32-unknown-unknown

# Compute the artifact hash
sha256sum target/wasm32-unknown-unknown/release/contract.wasm
```

The resulting hash **must equal** the WASM SHA-256 hash in the Release Summary. If it does not, stop and report a discrepancy — do not proceed.

---

## 4. On-Chain Verification

### 4.1 Confirm the deployment transaction

```bash
stellar contract fetch \
  --id CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM \
  --network mainnet \
  --out fetched.wasm

sha256sum fetched.wasm
```

The hash of the fetched WASM **must equal** the WASM SHA-256 hash in the Release Summary.

### 4.2 Inspect the deployment transaction

```bash
stellar tx info \
  --hash 0000000000000000000000000000000000000000000000000000000000000000 \
  --network mainnet
```

Confirm that:
- The transaction succeeded (`status: SUCCESS`).
- The transaction created/uploaded the contract code whose hash matches the Release Summary.
- The contract ID in the transaction result matches the Contract ID in the Release Summary.
- The ledger matches the Deployment ledger in the Release Summary.

### 4.3 Confirm the contract ID

```bash
stellar contract id wasm \
  --wasm fetched.wasm \
  --network mainnet
```

The printed contract ID **must equal** the Contract ID in the Release Summary.

---

## 5. Step-by-Step Verification Instructions

Follow these steps in order. Each step has an expected result; if any step fails, stop and file an issue referencing this document.

1. **Download the release package.** Obtain the artifacts listed in Section 2 from the release page.
2. **Verify artifact hashes.** Run `sha256sum` on each artifact and compare against the table in Section 2. All must match.
3. **Rebuild from source.** Follow Section 3. The rebuilt WASM hash must match the Release Summary.
4. **Fetch on-chain code.** Follow Section 4.1. The fetched WASM hash must match the Release Summary.
5. **Inspect the deployment transaction.** Follow Section 4.2. Confirm status, code hash, contract ID, and ledger.
6. **Confirm the contract ID.** Follow Section 4.3. The derived contract ID must match the Release Summary.
7. **Review the audit report.** Open the audit report and confirm it covers the pinned source commit and the audited WASM hash. Confirm there are no unresolved critical or high findings.
8. **Record your result.** Complete the reviewer checklist in Section 6 and attach it to the release.

---

## 6. Independent Reviewer Checklist

This checklist must be completed by a reviewer **independent of the deployer**. The reviewer must not have authored the deployment or the release artifacts.

| # | Check | Expected | Result |
| --- | --- | --- | --- |
| 1 | Source commit matches release tag | `git rev-parse HEAD` == Source commit | ☐ |
| 2 | Working tree clean at pinned commit | `git status --porcelain` empty | ☐ |
| 3 | Rebuilt WASM hash matches Release Summary | Equal | ☐ |
| 4 | Fetched on-chain WASM hash matches Release Summary | Equal | ☐ |
| 5 | Deployment transaction status | `SUCCESS` | ☐ |
| 6 | Deployment transaction code hash matches | Equal | ☐ |
| 7 | Deployment transaction contract ID matches | Equal | ☐ |
| 8 | Deployment ledger matches | Equal | ☐ |
| 9 | Derived contract ID matches | Equal | ☐ |
| 10 | Audit report covers pinned commit and WASM hash | Confirmed | ☐ |
| 11 | No unresolved critical/high audit findings | Confirmed | ☐ |
| 12 | All artifact hashes in Section 2 match | Equal | ☐ |

**Reviewer sign-off**

- Reviewer name: ______________________
- Reviewer affiliation (independent of deployer): ______________________
- Date: ______________________
- Overall result: ☐ PASS ☐ FAIL
- Notes / discrepancies: ______________________

---

## 7. Discrepancy Reporting

If any verification step fails or any hash does not match, do **not** use the contract. Report the discrepancy by opening an issue in the source repository with the label `release` and include:

- The step number that failed.
- The expected and observed values.
- Your environment (OS, toolchain versions, container image digest).

---

## 8. References

- Backlog item #100 — Publish a mainnet contract verification package
- Dependency #73 — Reproducible build pipeline
- Dependency #93 — Security audit report
- Dependency #94 — Mainnet deployment
- Stellar CLI documentation: `https://developers.stellar.org/docs/tools/developer-tools/cli`
- Soroban reproducible builds: `https://github.com/stellar/rs-soroban-env`