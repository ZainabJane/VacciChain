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
| **Contract ID changes weekly** | After each reset the contract is redeployed to a new address. Any hardcoded contract IDs in test scripts must be updated after a reset. The post-deploy smoke test compares the deployed contract ID and artifact hash against the expected values for the current deployment and fails on a mismatch. |
| **No mainnet passphrase** | The staging network passphrase is `Test SDF Network ; September 2015`. Transactions signed with the mainnet passphrase will be rejected. Deployments require an explicit `network=testnet` and the smoke test verifies the passphrase, contract ID, and artifact hash. |

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
- **GitHub Environment:** `staging`

## Environment Isolation

Staging is bound to the GitHub environment `staging`. This environment has its own
scoped secrets and variables; it does **not** inherit any production secrets.

- All staging workflows must declare `environment: staging` so they resolve
  staging-scoped secrets (e.g. `AWS_ROLE_ARN`, `STELLAR_NETWORK_PASSPHRASE`,
  `ISSUER_SECRET_KEY`) from the `staging` environment only.
- Production secrets live in the separate `production` environment and are never
  exposed to staging jobs.
- Staging is configured with the Stellar **testnet** passphrase
  (`Test SDF Network ; September 2015`) and testnet RPC/Horizon endpoints. It has
  no mainnet credentials, no mainnet contract IDs, and no mainnet network
  passphrase, so a staging deployment cannot reach mainnet resources.
- Production deploys require a deliberate approval: the `production` environment
  has required reviewers, and production is deployed only via the separate
  `deploy.yml` workflow (manual `workflow_dispatch` with `network=mainnet`), never
  from the staging workflow.
- Merges to `main` are gated by the `ci-required` aggregate status check, which
  passes only when all required CI jobs succeed.

## Terraform Backend Configuration

Staging uses its **own isolated Terraform state**. It never reads or writes the
production state bucket, and no account IDs, regions, bucket names, or
environment-specific values are hardcoded in the Terraform source. All of these
are supplied explicitly per environment.

### Required Inputs

| Variable | Purpose | Example (staging) |
|---|---|---|
| `aws_account_id` | Target AWS account for staging | `111122223333` |
| `aws_region` | Region for all staging resources | `us-east-1` |
| `environment` | Environment name used in resource naming/tags | `staging` |
| `state_bucket` | S3 bucket holding **staging** state only | `vaccichain-tfstate-staging` |
| `state_key` | Key prefix within the staging bucket | `staging/terraform.tfstate` |
| `lock_table` | DynamoDB table for state locking | `vaccichain-tflock-staging` |

These values are provided via a per-environment backend config file
(`backend/staging.hcl`) and a per-environment variable file
(`env/staging.tfvars`). Neither file contains credentials.

### Bootstrap Prerequisites

Before the first staging plan, the following must exist in the staging account:

1. **S3 state bucket** — versioned, server-side encrypted, public access blocked.
2. **DynamoDB lock table** — partition key `LockID` (string).
3. **IAM role for Terraform** — scoped to the staging account only, with access
   to the staging state bucket and lock table (and nothing in production).
4. **Secrets** — `vaccichain/staging/*` entries in Secrets Manager (see below).

Bootstrap is performed once per environment by an operator with staging-account
access. State credentials are never committed; Terraform authenticates via the
standard AWS credential chain (SSO, assumed role, or CI OIDC role).

### Initializing and Validating

```bash
# Initialize against the staging backend only
terraform init -backend-config=backend/staging.hcl

# Validate configuration and variables for staging
terraform validate
terraform plan -var-file=env/staging.tfvars -out=staging.tfplan
```

A clean staging plan must succeed without any reference to production state. If
`terraform init` reports a backend mismatch, confirm `backend/staging.hcl` points
at the staging bucket and not the production bucket.

### Deployment Process Changes

- CI passes `-backend-config=backend/staging.hcl` and
  `-var-file=env/staging.tfvars` to every `init`/`plan`/`apply` invocation.
- The deploy workflow assumes the staging-scoped IAM role via OIDC; no static
  AWS keys are stored in GitHub.
- Plans are validated per environment before apply; a staging plan that resolves
  against production state fails the workflow.

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

Deployments **require an explicit network**. The workflow refuses to run without `network` set to `testnet` for staging, and validates the network-specific configuration (RPC URL, Horizon URL, network passphrase, and expected contract ID) before any container is updated.

```bash
# Trigger deployment manually — network is mandatory
gh workflow run deploy-staging.yml -f network=testnet
```

If `network` is omitted or set to anything other than `testnet`, the workflow fails fast with a validation error. This prevents accidentally deploying staging configuration against mainnet.

### Post-Deploy Smoke Test: Network and Contract ID Validation

After the new containers are healthy, the `deploy-staging.yml` workflow runs a smoke test that confirms the deployment targets the expected network and contract:

1. **Network passphrase check** — the backend reports its configured network passphrase; it must equal `Test SDF Network ; September 2015`. Any other passphrase (including the mainnet passphrase) fails the smoke test.
2. **RPC/Horizon check** — the configured Soroban RPC and Horizon URLs must be the testnet endpoints listed in this guide.
3. **Contract ID check** — the deployed contract ID is read from the backend configuration and compared against the expected contract ID recorded for the current staging deployment. A mismatch fails the smoke test.
4. **Artifact hash check** — the deployed contract WASM hash is compared against the artifact hash produced by the CI build for the deployed commit. A mismatch means the running contract does not match the tested artifact and fails the smoke test.

The smoke test fails the workflow (and the deployment is marked failed) if any check does not match. To verify manually:

```bash
# Confirm the network passphrase reported by the backend
curl -s https://staging.vaccichain.example.com/health | jq '.network_passphrase'
# Expected: "Test SDF Network ; September 2015"

# Confirm the deployed contract ID and artifact hash
curl -s https://staging.vaccichain.example.com/health | jq '{contract_id, wasm_hash}'
# Compare contract_id against the expected staging contract ID and
# wasm_hash against the artifact hash from the CI build for this commit
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

### Release Smoke Tests

Every staging deployment runs a release-level smoke-test suite against the live
staging environment. These tests exercise real deployed routing, health, auth,
and verification behavior — they are not mocks.

The suite covers:

| Check | What it verifies |
|---|---|
| **Frontend route load** | The frontend root and key SPA routes return `200` and serve the app shell (no blank page or 5xx from nginx). |
| **API health** | `GET /health` on the backend returns `200` with a healthy status payload. |
| **Analytics reachability** | The analytics endpoint is reachable and responds successfully from the deployed environment. |
| **Public verification** | A safe, read-only public verification case: `GET /verify/{wallet}` for a known staging wallet returns `200` with the expected response shape. No writes, mints, or revocations are performed. |

#### Run the smoke tests manually

```bash
# From project root — runs the full smoke suite against staging
npm run test:smoke:staging

# Override the target base URL if needed
STAGING_BASE_URL=https://staging.vaccichain.example.com npm run test:smoke:staging
```

The suite exits non-zero if any check fails, so it can be wired into any CI job
or run locally before promoting a release.

#### Promotion gate

Staging smoke tests are a **required gate for production promotion**:

- The `deploy-staging.yml` workflow runs the smoke suite after deploying to staging.
- The production deployment (`deploy.yml`) is **blocked** when the latest staging
  smoke run has failed or has not completed successfully for the release being promoted.
- If smoke tests fail, the deployment stops and the failure is reported in the
  GitHub Actions summary. Fix the issue, redeploy to staging, and re-run the
  smoke suite before attempting promotion again.

Do not bypass the gate by triggering production deployment manually unless the
failure has been investigated and explicitly waived by a maintainer.

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

Staging uses the same AWS Secrets Manager setup as production, but with its own
`vaccichain/staging/*` secrets. State credentials are never stored in Terraform
files or committed to the repository; Terraform uses the ambient AWS credential
chain scoped to the staging account.

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

Staging and production are deliberately separated. A staging deployment never
reaches mainnet resources, and production requires explicit approval.

When staging is verified and ready:

1. Confirm the staging smoke tests pass (`npm run test:smoke:staging`). Production
   promotion is blocked if the staging smoke suite has not passed for this release.
2. Update `CHANGELOG.md` with release notes for the new version.
3. Create a release tag: `git tag v1.0.0`
4. Push tag: `git push origin v1.0.0`
5. Trigger the separate production workflow: `gh workflow run deploy.yml -f network=mainnet`
6. A required reviewer must approve the run in the `production` GitHub environment before any deployment step executes
7. Monitor production deployment

Production deploys are blocked unless all of the following hold:

- The workflow is `deploy.yml` (the staging workflow cannot deploy to production)
- The run is a deliberate `workflow_dispatch` on an approved branch (or an approved release tag) — pushes and pull request events are rejected
- The `production` environment approval has been granted by a required reviewer
- The `ci-required` aggregate check passed for the commit being deployed

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
