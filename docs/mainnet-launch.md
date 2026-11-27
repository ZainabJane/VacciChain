# Mainnet Launch Checklist

This document provides a comprehensive checklist for graduating VacciChain from Stellar Testnet to Mainnet. A missed step could result in lost records or funds.

**Last Updated**: April 28, 2026  
**Status**: Ready for Review

> **Related**: The per-release contract release checklist (security, resource, compatibility, and artifact-integrity gates) lives in [Contract Release Checklist](./contract-release-checklist.md). Every contract release must satisfy those gates before the mainnet gates below can be signed off.

---

## Mandatory Mainnet Release Gate

No mainnet deployment may proceed unless **all** of the following are recorded and approved. This gate is enforced by the release-gate check (`make release-gate-check` / `scripts/release-gate-check.sh`), which fails the release if any required gate is missing or unapproved.

### Required Gates

| Gate | Requirement | Evidence | Status |
|------|-------------|----------|--------|
| Security gate | Audit sign-off; all critical/high findings resolved | Audit report + remediation log | ⬜ |
| Resource gate | Contract resource limits (CPU, memory, ledger entries) within budget | Resource test results | ⬜ |
| Compatibility gate | Contract ABI/interface compatible with deployed backend and clients | Compatibility test results | ⬜ |
| Artifact-integrity gate | Deployed WASM hash matches the reviewed, checksummed build artifact | Artifact checksum + hash comparison | ⬜ |

### Expected Contract and Network Identifiers

These identifiers must be recorded and match the deployment target exactly. A mismatch is an automatic **No-Go**.

| Identifier | Expected Value | Recorded Value | Verified |
|------------|----------------|----------------|----------|
| Network | `mainnet` | _______________ | ⬜ |
| Network passphrase | `Public Global Stellar Network ; September 2015` | _______________ | ⬜ |
| Horizon URL | `https://horizon.stellar.org` | _______________ | ⬜ |
| Soroban RPC URL | _______________ (official mainnet RPC) | _______________ | ⬜ |
| Contract ID | _______________ (reviewed release artifact) | _______________ | ⬜ |
| WASM artifact hash | _______________ (from artifact-integrity gate) | _______________ | ⬜ |

### Recorded Approval

Mainnet release cannot proceed without recorded approval from the required approvers below.

| Approver Role | Name | Date | Approval |
|---------------|------|------|----------|
| Security Lead | _______________ | _______________ | ⬜ |
| Dev Lead | _______________ | _______________ | ⬜ |
| DevOps Lead | _______________ | _______________ | ⬜ |

**Go/No-Go Criteria**: All four gates pass, all identifiers match the expected values, and all approvals are recorded. Otherwise the release is **No-Go**.

---

## Pre-Launch Phase (2-4 weeks before)

### 1. Security Audit

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| Record audit scope | Security Lead | ⬜ | Document in-scope contracts, modules, and out-of-scope items (auth, storage, lifecycle, upgrade, privacy) |
| Pin audited source revision | Dev Lead | ⬜ | Record the exact git commit SHA reviewed by the auditor |
| Record audited WASM hash | Dev Lead | ⬜ | Record SHA-256 of the built WASM; must match the deployed artifact |
| Contract code review by external auditor | Security Lead | ⬜ | Engage third-party auditor; allow 2-3 weeks |
| Record audit findings | Security Lead | ⬜ | Log all findings with severity, status, and remediation links |
| Audit report remediation | Dev Lead | ⬜ | Address all critical and high findings |
| Independent verification of critical/high fixes | Security Lead | ⬜ | Auditor re-verifies each critical/high fix before mainnet approval |
| Audit sign-off | Security Lead | ⬜ | Obtain written approval from auditor |
| Privacy review sign-off | Security Lead | ⬜ | Approve minimized on-chain schema; document residual linkability risks |
| Soulbound enforcement review | Security Lead | ⬜ | Threat model covers every ownership-changing operation; tests prove prohibited actions fail without storage mutation or misleading events |
| Input-bound boundary tests | QA Lead | ⬜ | Zero, maximum valid, and one-over-limit tests for every public argument and stored collection |
| Internal security review | Tech Lead | ⬜ | Review auth, key management, rate limiting |
| Dependency vulnerability scan | DevOps | ⬜ | Run `npm audit`, `cargo audit`, `pip audit` |
| Penetration testing (optional) | Security Lead | ⬜ | Consider for high-value deployments |

**Go/No-Go Criteria**: Audit scope, pinned source revision, WASM hash, and findings are recorded; all critical and high findings are fixed and independently verified; privacy review and soulbound enforcement review signed off; input-bound boundary tests pass; audit report approved.

---

### 2. Admin Key Ceremony

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| Generate mainnet admin keypair | Security Lead | ⬜ | Use hardware wallet or secure key generation |
| Backup admin secret key (encrypted) | Security Lead | ⬜ | Store in secure vault (e.g., HashiCorp Vault) |
| Backup admin public key | Security Lead | ⬜ | Store in version control (non-sensitive) |
| Generate issuer keypair | Security Lead | ⬜ | Separate from admin key |
| Backup issuer secret key (encrypted) | Security Lead | ⬜ | Store in secure vault |
| Generate SEP-10 server keypair | Security Lead | ⬜ | For challenge signing |
| Backup SEP-10 secret key (encrypted) | Security Lead | ⬜ | Store in secure vault |
| Document key rotation schedule | Security Lead | ⬜ | Plan for quarterly rotation |
| Distribute keys to authorized personnel | Security Lead | ⬜ | Use secure channels (e.g., encrypted email, in-person) |

**Go/No-Go Criteria**: All keys generated, backed up, and securely distributed. No keys stored in plaintext.

---

### 3. Environment Configuration

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| Create mainnet `.env` file | DevOps | ⬜ | Use mainnet Horizon and Soroban RPC URLs |
| Set `STELLAR_NETWORK=mainnet` | DevOps | ⬜ | Explicit network selection is **required**; deployment tooling must reject missing or ambiguous network values |
| Set `HORIZON_URL` to mainnet endpoint | DevOps | ⬜ | Use official Stellar Horizon: https://horizon.stellar.org |
| Set `SOROBAN_RPC_URL` to mainnet endpoint | DevOps | ⬜ | Use official Soroban RPC endpoint |
| Set `STELLAR_NETWORK_PASSPHRASE` | DevOps | ⬜ | Must be: `Public Global Stellar Network ; September 2015` |
| Validate network-specific configuration | DevOps | ⬜ | Run the deployment tooling's network validation; it must confirm Horizon URL, Soroban RPC URL, and network passphrase all match the selected network |
| Set admin and issuer keys in `.env` | DevOps | ⬜ | Use keys from key ceremony |
| Set JWT_SECRET to strong random value | DevOps | ⬜ | Min 32 characters; rotate before launch |
| Configure rate limits for production | DevOps | ⬜ | Adjust based on expected traffic |
| Set up audit logging | DevOps | ⬜ | Configure `AUDIT_LOG_PATH` to persistent storage |
| Verify all required env vars are set | DevOps | ⬜ | Run backend startup check |

**Go/No-Go Criteria**: Network explicitly selected; network-specific configuration validated (Horizon URL, Soroban RPC URL, and passphrase all match the selected network); all environment variables configured; backend starts without errors.

---

## Deployment Phase (1 week before)

### 4. Smart Contract Deployment

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| Deploy contract to mainnet | Dev Lead | ⬜ | Use `make deploy` with an **explicit** network argument (e.g., `NETWORK=mainnet`); deployment must fail if the network is omitted |
| Confirm deployment tooling validated network config | Dev Lead | ⬜ | Tooling must verify Horizon URL, Soroban RPC URL, and passphrase match the selected network before submitting |
| Record contract ID | Dev Lead | ⬜ | Store in version control and `.env` |
| Record deployment transaction hash | Dev Lead | ⬜ | Store in the verification package (see below) |
| Record deployed artifact hash | Dev Lead | ⬜ | Capture the WASM hash of the deployed artifact for later verification |
| Record reproducible WASM hash | Dev Lead | ⬜ | Rebuild from the tagged commit; hashes must match |
| Verify contract on Stellar Expert | Dev Lead | ⬜ | Check https://stellar.expert/explorer/public |
| Test contract functions on mainnet | QA Lead | ⬜ | Call mint, verify, revoke with test data |
| Verify issuer allowlist is empty | Dev Lead | ⬜ | No issuers should be pre-authorized |
| Add initial issuer (if applicable) | Dev Lead | ⬜ | Call `add_issuer` with authorized healthcare provider |
| Document contract address | Dev Lead | ⬜ | Share with all teams |
| Publish contract verification package | Dev Lead | ⬜ | See [Contract Verification Package](#contract-verification-package) |
| Independent reviewer executes verification instructions | Independent Reviewer | ⬜ | Reviewer must not be the deployer; record sign-off below |

**Go/No-Go Criteria**: Network explicitly specified and validated; contract deployed; all functions callable; issuer allowlist configured; verification package published and independently verified.

---

### 4a. Contract Verification Package

The release package must be published alongside the deployment and contain:

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| Source commit link | Dev Lead | ⬜ | Tagged commit used to build the deployed WASM |
| WASM hash (reproducible build) | Dev Lead | ⬜ | SHA-256 of the deployed WASM artifact |
| Audit report link | Security Lead | ⬜ | Final signed audit report from step 1 |
| Network transaction link | Dev Lead | ⬜ | Stellar Expert link to the deployment transaction |
| Verified contract ID | Dev Lead | ⬜ | Contract ID confirmed on Stellar Expert |
| Verification instructions | Dev Lead | ⬜ | Step-by-step rebuild and hash comparison guide |
| Independent verification sign-off | Independent Reviewer | ⬜ | Reviewer confirms instructions work as written |

**Go/No-Go Criteria**: Package is complete; an independent reviewer has reproduced the WASM hash and confirmed the contract ID and transaction.

---

### 5. Backend Deployment

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| Build backend Docker image | DevOps | ⬜ | Tag with version (e.g., `v1.0.0-mainnet`) |
| Push image to container registry | DevOps | ⬜ | Use private registry or Docker Hub |
| Review Terraform plan | DevOps | ⬜ | CI runs `terraform fmt -check` and `terraform validate` for all environment and module directories; review the plan artifact from the isolated-credentials plan job |
| Approve Terraform apply | DevOps | ⬜ | Apply requires manual approval of the `production` GitHub environment; plan and apply use separate scoped credentials |
| Deploy to production infrastructure | DevOps | ⬜ | Use Kubernetes, ECS, or similar; production deploys only from approved branches/events |
| Verify backend health endpoint | DevOps | ⬜ | `GET /health` should return `{"status":"ok"}` |
| Verify Swagger UI is accessible | QA Lead | ⬜ | `GET /docs` should load OpenAPI spec |
| Test SEP-10 auth flow | QA Lead | ⬜ | Generate challenge, sign, verify JWT |
| Test vaccination issue endpoint | QA Lead | ⬜ | Issue test vaccination record |
| Test verification endpoint | QA Lead | ⬜ | Verify test wallet status |
| Monitor backend logs for errors | DevOps | ⬜ | Check for startup errors, connection issues |

**Go/No-Go Criteria**: Backend running; all endpoints responding; no error logs.

---

### 6. Frontend Deployment

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| Build frontend with mainnet config | DevOps | ⬜ | Set backend URL to mainnet endpoint |
| Deploy frontend to CDN or web server | DevOps | ⬜ | Use HTTPS only |
| Verify frontend loads | QA Lead | ⬜ | Check landing page, no console errors |
| Test Freighter wallet connection | QA Lead | ⬜ | Connect with mainnet wallet |
| Test patient dashboard | QA Lead | ⬜ | View vaccination records |
| Test issuer dashboard | QA Lead | ⬜ | Issue test vaccination record |
| Test verification page | QA Lead | ⬜ | Verify test wallet |
| Verify SSL certificate is valid | DevOps | ⬜ | Check certificate expiration |

**Go/No-Go Criteria**: Frontend loads; all pages functional; no security warnings.

---

### 7. Analytics Service Deployment

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| Deploy Python analytics service | DevOps | ⬜ | Use mainnet backend URL |
| Verify analytics endpoints respond | QA Lead | ⬜ | Test `/analytics/rates`, `/analytics/issuers` |
| Test batch verification endpoint | QA Lead | ⬜ | Verify multiple wallets |
| Monitor analytics logs | DevOps | ⬜ | Check for connection errors |

**Go/No-Go Criteria**: Analytics service running; endpoints responding.

---

## Testing Phase (3-5 days before)

### 8. Smoke Tests

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| End-to-end patient flow | QA Lead | ⬜ | Connect wallet → view records → export |
| End-to-end issuer flow | QA Lead | ⬜ | Issue vaccination → verify on-chain |
| End-to-end verifier flow | QA Lead | ⬜ | Verify wallet status via public endpoint |
| Test with real mainnet wallet | QA Lead | ⬜ | Use funded testnet wallet (if available) |
| Contract-ID/network smoke test | QA Lead | ⬜ | Confirm the deployed contract ID exists on the expected network (query Horizon/Soroban RPC for the selected network) |
| Contract-ID/artifact-hash smoke test | QA Lead | ⬜ | Confirm the on-chain WASM hash for the contract ID matches the recorded deployed artifact hash |
| Verify audit logs are being written | QA Lead | ⬜ | Check audit log file for entries |
| Test rate limiting | QA Lead | ⬜ | Verify rate limits are enforced |
| Test error handling | QA Lead | ⬜ | Trigger errors; verify graceful responses |
| Load test (optional) | QA Lead | ⬜ | Simulate expected traffic volume |

**Go/No-Go Criteria**: All smoke tests pass, including confirmation that the deployed contract ID belongs to the expected network and its artifact hash matches the recorded deployment; no critical errors; performance acceptable.

---

### 9. Security Verification

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| Verify HTTPS is enforced | Security Lead | ⬜ | All endpoints should redirect HTTP to HTTPS |
| Verify JWT tokens are short-lived | Security Lead | ⬜ | Tokens should expire in 1 hour |
| Verify API keys are not logged | Security Lead | ⬜ | Check logs for sensitive data |
| Verify CORS is properly configured | Security Lead | ⬜ | Only allow trusted origins |
| Verify rate limits are active | Security Lead | ⬜ | Test with excessive requests |
| Verify contract is immutable | Security Lead | ⬜ | Confirm no upgrade path exists |
| Verify deployed WASM hash matches audited hash | Security Lead | ⬜ | Compare on-chain WASM hash to the hash recorded in the audit |
| Verify soulbound enforcement | Security Lead | ⬜ | Attempt transfer, approval, clawback, and alternate entry points; all should fail without storage mutation or misleading events |
| Verify input bounds are enforced | Security Lead | ⬜ | Confirm one-over-limit inputs are rejected for every public argument and stored collection |
| Verify privacy-safe on-chain fields | Security Lead | ⬜ | Confirm no patient names, contact data, or unnecessary clinical details are stored on-chain |

**Go/No-Go Criteria**: All security checks pass; no vulnerabilities found; deployed WASM matches the audited revision; privacy review and soulbound enforcement verification complete.

---

## Launch Day

### 10. Final Checks (2 hours before launch)

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| Verify all systems are running | DevOps | ⬜ | Backend, frontend, analytics, contract |
| Confirm production environment approvals | DevOps | ⬜ | `production` GitHub environment has required reviewers and separate scoped secrets from `staging` |
| Confirm pre-deploy policy gate passed | DevOps | ⬜ | Policy check blocks production deploys from unapproved branches and events; staging cannot reach mainnet resources |
| Check monitoring and alerting | DevOps | ⬜ | Ensure alerts are configured |
| Verify backup systems are in place | DevOps | ⬜ | Database backups, key backups |
| Notify stakeholders | Product Lead | ⬜ | Send launch notification to team |
| Prepare rollback plan | DevOps | ⬜ | Document rollback steps |
| Have incident response team on standby | DevOps | ⬜ | Team available for 24 hours post-launch |

**Go/No-Go Criteria**: All systems operational; team ready; rollback plan documented. Confirm the Mandatory Mainnet Release Gate is fully approved and the release-gate check passes before proceeding.

---

### 11. Launch Execution

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| Announce mainnet launch | Product Lead | ⬜ | Update website, social media, docs |
| Monitor system health for 1 hour | DevOps | ⬜ | Watch logs, metrics, error rates |
| Monitor system health for 24 hours | DevOps | ⬜ | Continue monitoring; be ready to rollback |
| Collect user feedback | Product Lead | ⬜ | Monitor support channels |
| Document any issues | DevOps | ⬜ | Create issues for post-launch improvements |

**Go/No-Go Criteria**: No critical errors; system stable; users able to transact.

---

## Post-Launch (1-2 weeks after)

### 12. Stabilization

| Item | Owner | Status | Notes |
|------|-------|--------|-------|
| Monitor system performance | DevOps | ⬜ | Track latency, error rates, throughput |
| Review audit logs for anomalies | Security Lead | ⬜ | Look for suspicious activity |
| Collect metrics on vaccination issuance | Analytics Lead | ⬜ | Track adoption, usage patterns |
| Address any reported bugs | Dev Lead | ⬜ | Prioritize critical issues |
| Publish post-launch report | Product Lead | ⬜ | Document launch results, lessons learned |

**Go/No-Go Criteria**: System stable; no critical issues; metrics healthy.

---

## Rollback Plan

If critical issues are discovered, follow this rollback procedure:

### Immediate Actions (within 15 minutes)

1. **Notify all stakeholders** — Send alert to team, leadership, users
2. **Stop accepting new transactions** — Disable issue/revoke endpoints
3. **Assess severity** — Determine if rollback is necessary
4. **Prepare rollback** — Have DevOps team ready to execute

### Rollback Execution (if needed)

1. **Revert frontend** — Deploy previous stable version
2. **Revert backend** — Deploy previous stable version
3. **Verify contract state** — Ensure no corrupted data
4. **Communicate status** — Update users on rollback progress
5. **Post-mortem** — Document root cause and prevention measures

### Rollback Criteria

- Data corruption detected
- Security vulnerability exploited
- System unavailable for >30 minutes
- Loss of funds or records

---

## Sign-Off

This checklist must be reviewed and approved by at least two contributors before mainnet launch.

### Reviewer 1

- **Name**: ___________________
- **Role**: ___________________
- **Date**: ___________________
- **Signature**: ___________________

### Reviewer 2

- **Name**: ___________________
- **Role**: ___________________
- **Date**: ___________________
- **Signature**: ___________________

### Independent Verification Reviewer

The reviewer below must be independent of the deployer and must have executed the verification instructions from the contract verification package.

- **Name**: ___________________
- **Role**: ___________________
- **Date**: ___________________
- **Source commit verified**: ___________________
- **WASM hash reproduced**: ___________________
- **Contract ID / transaction confirmed**: ___________________
- **Signature**: ___________________

---

## Deployment Approval and Policy Gates

Production deployments are gated by the following controls:

- **Separate GitHub environments** — `staging` and `production` have distinct scoped secrets. The `production` environment requires reviewer approval; staging credentials cannot access mainnet resources.
- **Pre-deploy policy gate** — A workflow policy check blocks production deploys from unapproved branches and events (e.g., only `main` pushes and tagged releases may deploy to production).
- **Idempotent contract deployment** — The `deploy-contracts` workflow distinguishes `deploy`, `upgrade`, and `no-op` paths. Upgrades require an explicit target contract, and the deployment manifest prevents re-runs from silently creating a second production contract.
- **Terraform plan review** — CI runs `terraform fmt -check` and `terraform validate` for all environment and module directories, publishes a reviewable plan using isolated credentials, and requires approval before apply.

---

## References

- [Contract Release Checklist](./contract-release-checklist.md)
- [Stellar Documentation](https://developers.stellar.org/)
- [Soroban Smart Contracts](https://soroban.stellar.org/)
- [VacciChain Architecture](../README.md)
- [Security Threat Model](./security/threat-model.md)
- [Configuration Guide](./configuration.md)
- [Contract Verification Package](./contract-verification.md)
