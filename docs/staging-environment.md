# Staging Environment Guide

This guide is for QA engineers and stakeholders who need to test VacciChain against the staging environment before changes reach production.

---

## Accessing the Staging Environment

The staging environment runs on Stellar **testnet** and is deployed continuously from the `main` branch.

| Service | URL |
|---|---|
| Frontend | `https://staging.vaccichain.app` |
| Backend API | `https://api.staging.vaccichain.app` |
| Soroban RPC | `https://soroban-testnet.stellar.org` |
| Horizon | `https://horizon-testnet.stellar.org` |

> **Note:** These URLs are placeholders. Replace them with the actual deployed addresses from your infrastructure team before sharing this guide externally.

### Prerequisites

- [Freighter wallet](https://www.freighter.app/) browser extension installed and configured for **Testnet**
- A funded testnet Stellar account — use [Friendbot](https://friendbot.stellar.org) to fund a new keypair:
  ```
  https://friendbot.stellar.org/?addr=<YOUR_PUBLIC_KEY>
  ```
- For issuer testing: a testnet keypair that has been added as an authorized issuer by the staging admin

---

## Weekly Reset Schedule

The staging environment is **reset every Monday at 00:00 UTC**.

What the reset does:
- Redeploys the Soroban contract to a fresh instance with a new contract ID
- Clears all on-chain vaccination records and issuer registrations
- Rotates the staging `JWT_SECRET`, invalidating all active sessions
- Wipes the audit log

**Implications for testers:**
- Any token IDs, wallet addresses, or contract IDs noted from a previous week are invalid after a reset
- Issuer accounts must be re-authorized by the staging admin after each reset
- JWTs obtained before a reset will be rejected — re-authenticate after Monday
- Bookmark the staging frontend URL, not any deep-linked record URLs, as record IDs change each cycle

If you need a reset outside the weekly schedule (e.g., to clear a corrupted state), contact the maintainers via the project issue tracker.

---

## Testing Procedures

### Issuer Flow

Issuers authenticate via SEP-10 wallet challenge and can mint and revoke vaccination records.

#### 1. Authenticate as an issuer

1. Open the staging frontend and click **Connect Wallet**
2. Approve the connection in Freighter — ensure Freighter is set to **Testnet**
3. The app requests a SEP-10 challenge from the backend (`POST /auth/sep10`)
4. Sign the challenge transaction in Freighter
5. The app submits the signed transaction (`POST /auth/verify`) and receives a JWT
6. Confirm the role shown in the UI is **issuer** — if it shows **patient**, your wallet has not been added as an authorized issuer; contact the staging admin

#### 2. Mint a vaccination record

1. Navigate to **Issue Vaccination**
2. Fill in the form:
   - **Patient wallet address** — a valid Stellar public key (starts with `G`)
   - **Vaccine name** — max 100 characters
   - **Date administered** — max 100 characters (e.g. `2026-05-28`)
3. Review the confirmation dialog and click **Confirm**
4. Wait for the transaction to be confirmed on testnet (typically 5–10 seconds)
5. Note the returned `token_id` — you will need it to test revocation

Expected API call: `POST /vaccination/issue`  
Expected response: `{ "success": true, "token_id": <number> }`

#### 3. Revoke a vaccination record

1. Navigate to **Revoke Vaccination**
2. Enter the `token_id` from the mint step
3. Confirm the revocation
4. Verify the record no longer appears in the patient's vaccination list

Expected API call: `POST /vaccination/revoke`  
Expected response: `{ "success": true, "token_id": <number> }`

#### 4. Review the audit log

1. Navigate to **Admin → Audit Log**
2. Confirm that the mint and revoke actions appear with the correct actor, target, and result fields
3. Use the `from` / `to` date filters to narrow results

Expected API call: `GET /admin/audit`

---

### Patient Flow

Patients can authenticate to view their own records, and anyone can verify a wallet publicly without authentication.

#### 1. Authenticate as a patient

1. Open the staging frontend and click **Connect Wallet**
2. Approve the connection in Freighter (Testnet)
3. Sign the SEP-10 challenge
4. Confirm the role shown is **patient**

#### 2. View your vaccination records

1. After authenticating, navigate to **My Records**
2. The app fetches records for your wallet (`GET /vaccination/:wallet`)
3. Confirm that any records minted by an issuer in the issuer flow above appear here

Expected response shape:
```json
{
  "wallet": "G...",
  "vaccinated": true,
  "records": [
    {
      "token_id": 1,
      "vaccine_name": "COVID-19",
      "date_administered": "2026-05-28",
      "issuer": "G..."
    }
  ]
}
```

#### 3. Public verification (no login required)

Any third party can verify a wallet without authenticating:

```bash
curl https://api.staging.vaccichain.app/verify/<PATIENT_WALLET_ADDRESS>
```

Expected response:
```json
{
  "wallet": "G...",
  "vaccinated": true,
  "record_count": 1,
  "records": [...]
}
```

This endpoint is rate-limited to 60 requests per IP per minute on staging (same as production).

---

## Known Limitations

| Limitation | Detail |
|---|---|
| **Testnet only** | Staging uses Stellar testnet. Testnet is occasionally reset by the Stellar Development Foundation, which can cause unexpected contract failures independent of the weekly VacciChain reset. |
| **No email notifications** | Staging does not send any email or push notifications. Notification flows cannot be tested here. |
| **Shared issuer key** | All staging issuers share a single `ISSUER_SECRET_KEY` configured on the backend. Individual issuer key rotation cannot be tested in staging. |
| **Rate limits are enforced** | SEP-10 challenge requests are capped at 10 per IP per minute. If you hit this limit during automated testing, wait 60 seconds or use a different IP. |
| **No SLA** | Staging has no uptime guarantee. It may be unavailable during deployments or maintenance. |
| **Audit log is ephemeral** | The audit log is wiped on each weekly reset. Do not rely on it for long-running test evidence. |
| **Contract ID changes weekly** | After each reset the contract is redeployed to a new address. Any hardcoded contract IDs in test scripts must be updated after a reset. |
| **No mainnet passphrase** | The staging network passphrase is `Test SDF Network ; September 2015`. Transactions signed with the mainnet passphrase will be rejected. |

---

## Quick Reference

### Useful testnet tools

- **Friendbot** (fund a new account): `https://friendbot.stellar.org/?addr=<PUBLIC_KEY>`
- **Stellar Expert (testnet explorer)**: `https://stellar.expert/explorer/testnet`
- **Horizon testnet**: `https://horizon-testnet.stellar.org`

### Re-authenticating after a reset

```bash
# 1. Request a new SEP-10 challenge
curl -X POST https://api.staging.vaccichain.app/auth/sep10 \
  -H "Content-Type: application/json" \
  -d '{"public_key": "<YOUR_PUBLIC_KEY>"}'

# 2. Sign the returned transaction with your Stellar keypair, then verify
curl -X POST https://api.staging.vaccichain.app/auth/verify \
  -H "Content-Type: application/json" \
  -d '{"transaction": "<SIGNED_XDR>", "nonce": "<NONCE>"}'
```

The response includes a `token` (JWT) valid for 1 hour. Pass it as `Authorization: Bearer <token>` on subsequent requests.

### Reporting staging issues

Open an issue in the project repository with the label `staging` and include:
- The date and time of the failure (UTC)
- The API endpoint or UI action that failed
- The full error message or HTTP response body
- Your wallet public key (never share your secret key)
# Staging Environment

VacciChain maintains a production-equivalent staging environment for testing before production deployment.

## Overview

- **Network:** Stellar Testnet (matches production configuration, uses testnet)
- **Deployment:** Automatic on merge to `main`
- **URL:** https://staging.vaccichain.example.com
- **Infrastructure:** AWS ECS Fargate (same as production)
- **Secrets:** AWS Secrets Manager (same as production)

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Staging Environment                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │   Frontend   │  │   Backend    │  │   Python     │  │
│  │   (nginx)    │  │  (Express)   │  │  (FastAPI)   │  │
│  │   Port 80    │  │  Port 4000   │  │  Port 8001   │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│         │                  │                  │         │
│         └──────────────────┼──────────────────┘         │
│                            │                            │
│                    ┌───────▼────────┐                   │
│                    │ AWS Secrets    │                   │
│                    │ Manager        │                   │
│                    └────────────────┘                   │
│                                                         │
│                    ┌───────────────┐                    │
│                    │ Stellar       │                    │
│                    │ Testnet       │                    │
│                    └───────────────┘                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

## Deployment Process

### Automatic Deployment

1. Code is pushed to `main` branch
2. CI tests run (contract, backend, python, docker)
3. On success, `deploy-staging.yml` workflow triggers
4. Docker images are built and pushed to ECR
5. New task definition revision is registered (blue/green target group)
6. Green (new) tasks are started alongside the existing blue (current) tasks
7. Deployment waits for green targets to pass health checks
8. A canary slice of traffic is shifted to green and smoke tests run
9. Remaining traffic is shifted to green; blue tasks are drained and stopped
10. Deployment summary posted to GitHub

### Blue/Green Deployment with Canary Traffic Shift

Staging uses AWS CodeDeploy blue/green deployments on ECS, mirroring production.

| Phase | Traffic to green | Gate before proceeding |
|---|---|---|
| Provision | 0% | Green tasks reach `HEALTHY` in the target group (2 consecutive passing checks) |
| Canary | 10% | Smoke tests pass and error rate stays below 1% for 5 minutes |
| Linear shift | 10% → 100% in 10% steps every 2 minutes | Health checks and SLO error-rate alarm stay green |
| Complete | 100% | Blue tasks drained (connection draining, 30s) and terminated |

If any gate fails, CodeDeploy automatically rolls back to the blue task set and the workflow fails.

Health checks used as gates:

- **ECS/ALB health check:** `GET /health` — must return `200` with `{"status":"ok"}`
- **Smoke tests:** `npm run test:smoke` against the canary target group
- **SLO alarm:** the staging `error-rate` CloudWatch alarm (see [Monitoring Staging](#monitoring-staging)) must remain in `OK`

### Manual Deployment

```bash
# Trigger deployment manually
gh workflow run deploy-staging.yml
```

### Rollback Procedure

Rollback is a first-class operation and is exercised on every release candidate (see failure injection below).

**Automatic rollback:** triggered by CodeDeploy when a health check, smoke test, or SLO alarm gate fails. No action required; the previous blue task set resumes 100% of traffic.

**Manual rollback:**

```bash
# 1. Find the current deployment
aws deploy list-deployments \
  --application-name vaccichain-staging \
  --deployment-group-name vaccichain-staging-dg \
  --include-only-statuses InProgress

# 2. Stop and roll back the in-progress deployment
aws deploy stop-deployment \
  --deployment-id <deployment-id> \
  --auto-rollback-enabled

# 3. Confirm traffic is back on the previous task set
aws deploy get-deployment --deployment-id <deployment-id> \
  --query 'deploymentInfo.{status:status,rollback:rollbackInfo}'

# 4. Verify service health
curl https://staging.vaccichain.example.com/health
```

**Rollback verification checklist:**

- [ ] CodeDeploy deployment status is `STOPPED` or `ROLLED_BACK`
- [ ] ALB target group shows the previous task set as `HEALTHY` and receiving 100% traffic
- [ ] `/health` returns `200`
- [ ] Smoke tests pass against the restored environment
- [ ] The failing release is recorded in the deployment summary and a follow-up issue is opened

### Failure Injection (Rollback & SLO Alert Testing)

Staging is the environment where rollback and alerting are deliberately broken to prove they work. Run this before promoting a release:

1. **Deliberately failing release:** deploy a build with a broken health endpoint (e.g. `HEALTH_CHECK_FORCE_FAIL=true` in the staging task definition) via `gh workflow run deploy-staging.yml -f inject_failure=health`
2. **Confirm the gate holds:** the canary must never exceed 10% traffic; CodeDeploy should roll back automatically within the canary window
3. **Confirm rollback:** follow the rollback verification checklist above
4. **Confirm SLO alerts fire:** the injected failure should trip the staging `error-rate` and `latency-p99` alarms; verify the alert reaches the on-call channel with its runbook link
5. **Clean up:** remove the failure flag and redeploy the good build

Failure injection runs only in staging and must never be enabled in production.

## Testing in Staging

### Access Staging Environment

```bash
# Frontend
https://staging.vaccichain.example.com

# Backend API
https://staging.vaccichain.example.com/api

# Health check
curl https://staging.vaccichain.example.com/health
```

### Test Vaccination Flow

1. Connect Freighter wallet (set to Testnet)
2. Request SEP-10 challenge: `POST /auth/sep10`
3. Sign challenge with wallet
4. Verify signature: `POST /auth/verify`
5. Receive JWT token
6. Issue vaccination: `POST /vaccination/issue`
7. Verify vaccination: `GET /verify/{wallet}`

### Run Integration Tests

```bash
# From project root
npm run test:staging

# Or manually
curl -X POST https://staging.vaccichain.example.com/auth/sep10 \
  -H "Content-Type: application/json" \
  -d '{"account": "GAAAA..."}'
```

## Monitoring Staging

### CloudWatch Logs

```bash
# View backend logs
aws logs tail /ecs/vaccichain-staging --follow --filter-pattern "backend"

# View frontend logs
aws logs tail /ecs/vaccichain-staging --follow --filter-pattern "frontend"

# View python-service logs
aws logs tail /ecs/vaccichain-staging --follow --filter-pattern "python-service"
```

### ECS Metrics

```bash
# Check service status
aws ecs describe-services \
  --cluster vaccichain-staging \
  --services vaccichain-staging

# View task status
aws ecs list-tasks --cluster vaccichain-staging
aws ecs describe-tasks --cluster vaccichain-staging --tasks <task-arn>
```

### Service-Level Objectives and Alerts

Staging carries the same SLO definitions as production so alerts can be validated before release. Each SLI has an owner, severity, and runbook.

| SLI | Objective (staging) | Alert threshold | Severity | Owner | Runbook |
|---|---|---|---|---|---|
| Availability (`/health` success rate) | 99.5% over 1h | < 99% for 5m | P1 | Backend on-call | `docs/runbooks/availability.md` |
| Error rate (5xx / total) | < 1% over 1h | > 1% for 5m | P1 | Backend on-call | `docs/runbooks/error-rate.md` |
| Latency (p99 API) | < 800ms over 1h | > 800ms for 10m | P2 | Backend on-call | `docs/runbooks/latency.md` |
| Poller lag | < 30s | > 60s for 5m | P2 | Indexer on-call | `docs/runbooks/poller-lag.md` |
| Data freshness | < 2 min | > 5m | P2 | Indexer on-call | `docs/runbooks/data-freshness.md` |

Alerts are validated with the controlled failure injection described in [Failure Injection](#failure-injection-rollback--slo-alert-testing) — a failing release must trip the error-rate and latency alarms before it is promoted.

## Secrets Management in Staging

Staging uses the same AWS Secrets Manager setup as production:

```bash
# View staging secrets
aws secretsmanager describe-secret \
  --secret-id vaccichain/staging/stellar

# Update staging secrets
aws secretsmanager update-secret \
  --secret-id vaccichain/staging/stellar \
  --secret-string '{...}'
```

## Troubleshooting

### Deployment Failed

1. Check GitHub Actions workflow logs
2. Review the CodeDeploy deployment status and rollback info: `aws deploy get-deployment --deployment-id <deployment-id>`
3. Review ECS task logs: `aws logs tail /ecs/vaccichain-staging`
4. Verify secrets exist in Secrets Manager
5. Check IAM permissions for ECS task role
6. If the deployment rolled back, confirm the previous task set is healthy before retrying

### Service Not Responding

```bash
# Check service health
curl https://staging.vaccichain.example.com/health

# Check ECS task status
aws ecs describe-tasks \
  --cluster vaccichain-staging \
  --tasks $(aws ecs list-tasks --cluster vaccichain-staging --query 'taskArns[0]' --output text)

# View recent logs
aws logs tail /ecs/vaccichain-staging --follow --since 10m
```

### Secrets Not Loading

1. Verify secret exists: `aws secretsmanager get-secret-value --secret-id vaccichain/staging/stellar`
2. Check task role has permissions
3. Review backend logs for auth errors
4. Restart service: `aws ecs update-service --cluster vaccichain-staging --service vaccichain-staging --force-new-deployment`

## Promoting to Production

When staging is verified and ready:

1. Update `CHANGELOG.md` with release notes for the new version.
2. Create a release tag: `git tag v1.0.0`
3. Push tag: `git push origin v1.0.0`
4. Trigger production deployment: `gh workflow run deploy.yml -f network=mainnet`
5. Monitor production deployment

## Cost Optimization

Staging runs on:
- **ECS Fargate**: t3.small (0.25 vCPU, 512 MB) - ~$15/month
- **ECR**: ~$0.10/GB storage
- **Secrets Manager**: ~$0.40/secret/month
- **CloudWatch Logs**: ~$0.50/GB ingested

Total estimated cost: ~$20-30/month

To reduce costs:
- Scale down during off-hours
- Use spot instances for non-critical workloads
- Archive old logs to S3

## References

- [AWS ECS Documentation](https://docs.aws.amazon.com/ecs/)
- [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/)
- [GitHub Actions Workflows](https://docs.github.com/en/actions/using-workflows)
