# Production Deployment Guide

This guide covers deploying VacciChain to a production environment on AWS ECS Fargate, including Stellar Mainnet contract deployment, environment configuration, and post-deployment verification.

**Prerequisites before starting:**
- AWS account with admin-level IAM access
- AWS CLI v2 installed and configured (`aws configure`)
- Docker installed locally
- Rust toolchain with `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)
- Stellar CLI (`stellar` / `soroban`) installed
- Terraform >= 1.6 installed
- A registered domain name for your production deployment

---

## Table of Contents

1. [Pre-Deployment Checklist](#1-pre-deployment-checklist)
2. [Contract Release Checklist and Go/No-Go Gates](#2-contract-release-checklist-and-gono-go-gates)
3. [Artifact Provenance Verification](#3-artifact-provenance-verification)
4. [Key Generation](#4-key-generation)
5. [Contract Deployment to Stellar Mainnet](#5-contract-deployment-to-stellar-mainnet)
6. [AWS Infrastructure Setup](#6-aws-infrastructure-setup)
7. [Environment Variable Configuration](#7-environment-variable-configuration)
8. [Build and Push Container Images](#8-build-and-push-container-images)
9. [Deploy Services to ECS Fargate](#9-deploy-services-to-ecs-fargate)
10. [TLS and Domain Configuration](#10-tls-and-domain-configuration)
11. [Verifying a Successful Deployment](#11-verifying-a-successful-deployment)
12. [Monitoring and Alerting](#12-monitoring-and-alerting)
13. [CloudWatch Logs](#13-cloudwatch-logs)
14. [Rollback Procedure](#14-rollback-procedure)

---

## 1. Pre-Deployment Checklist

Complete these steps before touching any infrastructure.

- [ ] External security audit completed and all critical findings resolved
- [ ] All tests passing: `npm test` (backend), `cargo test` (contracts), `pytest` (python-service)
- [ ] Dependency scans clean: `npm audit`, `cargo audit`, `pip audit`
- [ ] Domain DNS configured and propagated
- [ ] AWS account limits reviewed (ECS tasks, ECR storage, Secrets Manager)
- [ ] Mainnet launch checklist reviewed: [`docs/mainnet-launch.md`](./mainnet-launch.md)
- [ ] Contract release checklist completed and signed off: [`docs/contract-release-checklist.md`](./contract-release-checklist.md)
- [ ] Artifact provenance verified for every image and WASM being deployed (see [section 3](#3-artifact-provenance-verification))

---

## 2. Contract Release Checklist and Go/No-Go Gates

Every contract release — testnet, staging, or mainnet — **must** be gated by the
[Contract Release Checklist](./contract-release-checklist.md). The checklist is the
single source of truth for release prerequisites; this section summarizes the gates
and how they are enforced. Do not deploy a contract until every gate below is marked
**GO** and recorded in the checklist.

### 2.1 Go/No-Go Gates

| Gate | What must be recorded | Blocking condition (NO-GO) |
|---|---|---|
| **Security** | External audit report reference, all critical/high findings resolved, dependency scans clean (`npm audit`, `cargo audit`, `pip audit`) | Any unresolved critical/high finding, or a scan with known exploitable advisories |
| **Resource** | Contract resource profile (CPU instructions, memory, ledger entry reads/writes) within the limits agreed for the network | Any operation exceeds the configured Soroban resource limits or the documented budget |
| **Compatibility** | Contract ABI/interface version, client SDK version, and storage schema compatibility confirmed | Breaking ABI change without a migration plan, or storage layout incompatible with existing on-chain state |
| **Artifact integrity** | SHA-256 hash of the WASM and container images, matching the hash produced by the release build | Hash mismatch between the reviewed artifact and the artifact being deployed |
| **Network identifiers** | `STELLAR_NETWORK`, `STELLAR_NETWORK_PASSPHRASE`, `SOROBAN_RPC_URL`, `HORIZON_URL`, and the expected `VACCINATIONS_CONTRACT_ID` | Any identifier missing, or a value that does not match the target network |
| **Admin keys** | Admin public key, issuer public key, SEP-10 server key, and multisig threshold, with confirmation that secrets are held in Secrets Manager / hardware wallet | Keys stored in plaintext, committed to the repo, or an admin key that differs from the approved key |
| **Verification** | Post-deploy verification results: `verify_vaccination` call succeeds, contract visible on Stellar Expert, SEP-10 challenge/verify flow passes | Any verification step failing or not performed |

### 2.2 Mainnet Approval Requirement

A mainnet contract release **cannot proceed** unless all of the following are true:

- Every gate in [section 2.1](#21-gono-go-gates) is marked **GO** in the checklist.
- The checklist records an explicit **approval** (approver name, role, UTC timestamp,
  and the release commit SHA) from an authorized release approver.
- The recorded `VACCINATIONS_CONTRACT_ID` and network identifiers match the values
  configured in `vaccichain/prod/stellar` (see [section 7](#7-environment-variable-configuration)).
- The artifact hashes recorded in the checklist match the artifacts verified in
  [section 3](#3-artifact-provenance-verification).

If any of these conditions is unmet, the release is **NO-GO** and must not be deployed.

---

## 3. Artifact Provenance Verification

Before deploying to **staging or production**, verify that every container image and
the contract WASM were built from the expected source revision by the trusted build
workflow, and that their hashes match the values recorded in the release checklist.

### 3.1 Expected Inputs

Record these values in the release checklist before verification:

- **Source revision** — the full Git commit SHA being released (`git rev-parse HEAD`).
- **Build workflow** — the CI workflow run that produced the artifacts (e.g. the
  GitHub Actions run URL/ID for `.github/workflows/cd.yml`).
- **Dependency inputs** — lockfile hashes (`package-lock.json`, `Cargo.lock`,
  `requirements.txt` / lockfile) used by the build.
- **Expected hashes** — SHA-256 of the WASM and of each container image digest.

### 3.2 Verify Artifact Hashes

```bash
# Contract WASM: rebuild from the recorded source revision and compare hashes
git checkout <SOURCE_REVISION>
cd contracts && make build
sha256sum target/wasm32-unknown-unknown/release/vaccichain.wasm
# Must equal the hash recorded in docs/contract-release-checklist.md

# Container images: compare the registry digest to the recorded digest
aws ecr describe-images \
  --repository-name vaccichain-backend \
  --image-ids imageTag=<TAG> \
  --query 'imageDetails[0].imageDigest' \
  --region us-east-1
# Repeat for vaccichain-frontend and vaccichain-python
```

### 3.3 Verify Provenance and Attestations

Confirm the artifacts carry trusted provenance metadata linking them to the source
revision, build workflow, and dependency inputs:

```bash
# Inspect the build provenance attestation for an image (SLSA / in-toto)
cosign verify-attestation \
  --type slsaprovenance \
  --certificate-identity-regexp 'https://github.com/<ORG>/<REPO>/.github/workflows/cd.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/vaccichain-backend@<DIGEST>

# Confirm the attested source revision matches the release commit
cosign verify-attestation \
  --type slsaprovenance \
  <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/vaccichain-backend@<DIGEST> \
  | jq -r '.payload' | base64 -d | jq '.predicate.invocation.configSource'
```

**Deployment is blocked** if any artifact is missing provenance metadata, if the
attested source revision differs from the release commit, or if a hash does not match
the value recorded in the checklist. Record the verification result (pass/fail, hashes,
attestation references) in the release checklist before proceeding.

---

## 4. Key Generation

Generate all Stellar keypairs before deploying. Use a hardware wallet or an air-gapped machine for mainnet keys. **Never store secret keys in plaintext or commit them to version control.**

```bash
# Generate admin keypair (controls contract admin operations)
stellar keys generate admin-prod --network mainnet
stellar keys show admin-prod

# Generate issuer keypair (signs mint/revoke transactions)
stellar keys generate issuer-prod --network mainnet
stellar keys show issuer-prod

# Generate SEP-10 server keypair (signs auth challenges)
stellar keys generate sep10-prod --network mainnet
stellar keys show sep10-prod
```

Each command prints a public key (`G...`) and secret key (`S...`). Record them securely — you will need them in steps 5 and 7.

Fund the admin and issuer accounts on mainnet before deploying the contract:

```bash
# Verify accounts are funded (must have XLM for transaction fees)
stellar account show <ADMIN_PUBLIC_KEY> --network mainnet
stellar account show <ISSUER_PUBLIC_KEY> --network mainnet
```

---

## 5. Contract Deployment to Stellar Mainnet

> **Mandatory prerequisite:** the [Contract Release Checklist](./contract-release-checklist.md)
> must be complete with all gates **GO** and, for mainnet, a recorded approval
> (see [section 2](#2-contract-release-checklist-and-gono-go-gates)). Provenance must be
> verified per [section 3](#3-artifact-provenance-verification).

### 5.1 Build the Contract

```bash
cd contracts
make build
```

The compiled WASM artifact is written to:
`contracts/target/wasm32-unknown-unknown/release/vaccichain.wasm`

### 5.2 Deploy to Mainnet

The `Makefile` targets `testnet` by default. For mainnet, pass the network flags explicitly:

```bash
cd contracts

stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/vaccichain.wasm \
  --source <ADMIN_SECRET_KEY> \
  --network mainnet \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --rpc-url https://mainnet.sorobanrpc.com
```

The command prints the contract ID (a 56-character address starting with `C`). **Record this value** — it becomes `VACCINATIONS_CONTRACT_ID`.

### 5.3 Initialize the Contract

The contract must be initialized once after deployment to set the admin address:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_SECRET_KEY> \
  --network mainnet \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --rpc-url https://mainnet.sorobanrpc.com \
  -- initialize \
  --admin <ADMIN_PUBLIC_KEY>
```

### 5.4 Add the Initial Issuer

Authorize the issuer account to mint vaccination records:

```bash
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_SECRET_KEY> \
  --network mainnet \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --rpc-url https://mainnet.sorobanrpc.com \
  -- add_issuer \
  --issuer <ISSUER_PUBLIC_KEY> \
  --name "Your Healthcare Organization" \
  --license "LICENSE-NUMBER" \
  --country "US"
```

### 5.5 Verify the Contract

Confirm the contract is live and callable:

```bash
# Verify a wallet (returns false with empty records for a new wallet — that is expected)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_SECRET_KEY> \
  --network mainnet \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --rpc-url https://mainnet.sorobanrpc.com \
  -- verify_vaccination \
  --wallet <ADMIN_PUBLIC_KEY>
```

Also confirm the contract is visible on Stellar Expert:
`https://stellar.expert/explorer/public/contract/<CONTRACT_ID>`

---

## 6. AWS Infrastructure Setup

VacciChain uses Terraform to provision all AWS resources. The production configuration lives in `infra/envs/production/`.

### 6.1 Bootstrap Remote State

Create the S3 bucket for Terraform state once per AWS account:

```bash
aws s3api create-bucket \
  --bucket vaccichain-tfstate \
  --region us-east-1

aws s3api put-bucket-versioning \
  --bucket vaccichain-tfstate \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket vaccichain-tfstate \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}
    }]
  }'
```

### 6.2 Create ECR Repositories

```bash
for repo in vaccichain-backend vaccichain-frontend vaccichain-python; do
  aws ecr create-repository \
    --repository-name $repo \
    --region us-east-1 \
    --image-scanning-configuration scanOnPush=true \
    --encryption-configuration encryptionType=AES256
done
```

Note the repository URIs from the output — you will need them in step 6.

### 6.3 Create IAM Roles

**ECS Task Execution Role** (used by ECS to pull images and fetch secrets):

```bash
# Save trust policy
cat > ecs-trust-policy.json << 'POLICY'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {"Service": "ecs-tasks.amazonaws.com"},
    "Action": "sts:AssumeRole"
  }]
}
POLICY

aws iam create-role \
  --role-name vaccichain-prod-execution-role \
  --assume-role-policy-document file://ecs-trust-policy.json

aws iam attach-role-policy \
  --role-name vaccichain-prod-execution-role \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

aws iam put-role-policy \
  --role-name vaccichain-prod-execution-role \
  --policy-name SecretsManagerAccess \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
      "Resource": "arn:aws:secretsmanager:*:*:secret:vaccichain/prod/*"
    }]
  }'
```

**ECS Task Role** (used by the running containers):

```bash
aws iam create-role \
  --role-name vaccichain-prod-task-role \
  --assume-role-policy-document file://ecs-trust-policy.json

aws iam put-role-policy \
  --role-name vaccichain-prod-task-role \
  --policy-name BackendPermissions \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [{
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:*:*:secret:vaccichain/prod/*"
    }]
  }'
```

### 6.4 Provision Infrastructure with Terraform

```bash
cd infra/envs/production

terraform init

# Review the plan before applying
terraform plan \
  -var="backend_image=<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/vaccichain-backend:<TAG>" \
  -var="frontend_image=<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/vaccichain-frontend:<TAG>" \
  -var="analytics_image=<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/vaccichain-python:<TAG>"

terraform apply \
  -var="backend_image=<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/vaccichain-backend:<TAG>" \
  -var="frontend_image=<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/vaccichain-frontend:<TAG>" \
  -var="analytics_image=<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com/vaccichain-python:<TAG>"
```

Terraform provisions: VPC, subnets, NAT gateways, ECS cluster, Fargate services, Application Load Balancer, EFS volume for the SQLite database, and CloudWatch log groups.

---

## 7. Environment Variable Configuration

Production secrets are stored in AWS Secrets Manager and injected into containers at runtime. **Do not use `.env` files in production.**

### 7.1 Create the Production Secret

```bash
aws secretsmanager create-secret \
  --name vaccichain/prod/stellar \
  --region us-east-1 \
  --secret-string '{
    "STELLAR_NETWORK": "mainnet",
    "HORIZON_URL": "https://horizon.stellar.org",
    "SOROBAN_RPC_URL": "https://mainnet.sorobanrpc.com",
    "STELLAR_NETWORK_PASSPHRASE": "Public Global Stellar Network ; September 2015",
    "VACCINATIONS_CONTRACT_ID": "<CONTRACT_ID from step 5.2>",
    "ADMIN_SECRET_KEY": "<S... from step 4>",
    "ADMIN_PUBLIC_KEY": "<G... from step 4>",
    "SEP10_SERVER_KEY": "<S... from step 4>",
    "ISSUER_SECRET_KEY": "<S... from step 4>",
    "JWT_SECRET": "<generate with: openssl rand -hex 32>"
  }'
```

### 7.2 Non-Secret Environment Variables

These are safe to set directly in the ECS task definition (not in Secrets Manager):

| Variable | Production Value | Notes |
|---|---|---|
| `NODE_ENV` | `production` | Enables production mode in Express |
| `STELLAR_NETWORK` | `mainnet` | Must match secret value |
| `HORIZON_URL` | `https://horizon.stellar.org` | Official Stellar Horizon |
| `SOROBAN_RPC_URL` | `https://mainnet.sorobanrpc.com` | Mainnet Soroban RPC |
| `STELLAR_NETWORK_PASSPHRASE` | `Public Global Stellar Network ; September 2015` | Exact string required |
| `USE_AWS_SECRETS` | `true` | Enables Secrets Manager integration |
| `AWS_SECRET_NAME` | `vaccichain/prod/stellar` | Matches secret created above |
| `PORT` | `4000` | Backend port |
| `ALLOWED_ORIGINS` | `https://app.yourdomain.com` | Your production frontend URL |
| `AUDIT_LOG_PATH` | `/data/audit.log` | Persistent EFS mount |
| `DATABASE_PATH` | `/data/vaccichain.db` | Persistent EFS mount |
| `BACKEND_URL` | `http://backend:4000` | Internal service URL |
| `ANALYTICS_API_KEY` | *(set in Secrets Manager)* | Generate with `openssl rand -hex 32` |
| `RATE_LIMIT_SEP10` | `10` | Adjust based on expected traffic |
| `RATE_LIMIT_VERIFY` | `60` | Adjust based on expected traffic |
| `SOROBAN_FEE` | `1000` | Higher fee for mainnet priority |
| `MULTISIG_THRESHOLD` | `2` | Require 2 approvals for admin ops |

### 7.3 Production Task Definition

Create `infra/envs/production/task-definition.json` based on the staging template at `staging/task-definition-backend.json`, with these key differences:

- Replace `testnet` URLs with mainnet URLs
- Set `STELLAR_NETWORK` to `mainnet`
- Set `STELLAR_NETWORK_PASSPHRASE` to `Public Global Stellar Network ; September 2015`
- Update secret ARNs to reference `vaccichain/prod/stellar`
- Set CPU to `2048` and memory to `4096` for production load
- Point log group to `/ecs/vaccichain-prod`

```bash
# Create CloudWatch log group
aws logs create-log-group --log-group-name /ecs/vaccichain-prod --region us-east-1

# Register the task definition
aws ecs register-task-definition \
  --cli-input-json file://infra/envs/production/task-definition.json
```

For full secrets management documentation, see [`docs/secrets-management.md`](./secrets-management.md).

---

## 8. Build and Push Container Images

> **Mandatory prerequisite:** verify artifact provenance and hashes per
> [section 3](#3-artifact-provenance-verification) before pushing or deploying images.

### 8.1 Authenticate with ECR

```bash
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com
```

### 8.2 Build and Tag Images

Use a versioned tag (e.g., the Git SHA or a semantic version) — never deploy `latest` to production.

```bash
export TAG=$(git rev-parse --short HEAD)
export ECR=<ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com

# Backend
docker build -t vaccichain-backend:$TAG ./backend
docker tag vaccichain-backend:$TAG $ECR/vaccichain-backend:$TAG

# Frontend
docker build -t vaccichain-frontend:$TAG ./frontend
docker tag vaccichain-frontend:$TAG $ECR/vaccichain-frontend:$TAG

# Python analytics service
docker build -t vaccichain-python:$TAG ./python-service
docker tag vaccichain-python:$TAG $ECR/vaccichain-python:$TAG
```

### 8.3 Push Images

```bash
docker push $ECR/vaccichain-backend:$TAG
docker push $ECR/vaccichain-frontend:$TAG
docker push $ECR/vaccichain-python:$TAG
```

---

## 9. Deploy Services to ECS Fargate

### 9.1 Create the ECS Cluster

```bash
aws ecs create-cluster \
  --cluster-name vaccichain-prod \
  --capacity-providers FARGATE FARGATE_SPOT \
  --region us-east-1
```

### 9.2 Create ECS Services

```bash
# Get subnet and security group IDs from Terraform output
cd infra/envs/production
SUBNET_IDS=$(terraform output -raw private_subnet_ids)
SG_ID=$(terraform output -raw ecs_security_group_id)
TG_ARN=$(terraform output -raw target_group_arn)

# Create backend service
aws ecs create-service \
  --cluster vaccichain-prod \
  --service-name vaccichain-backend \
  --task-definition vaccichain-prod:1 \
  --desired-count 2 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={
    subnets=[$SUBNET_IDS],
    securityGroups=[$SG_ID],
    assignPublicIp=DISABLED
  }" \
  --load-balancers "targetGroupArn=$TG_ARN,containerName=backend,containerPort=4000" \
  --health-check-grace-period-seconds 60 \
  --region us-east-1
```

### 9.3 Configure GitHub Actions for CI/CD

Add these secrets to your GitHub repository for automated deployments:

```
AWS_ROLE_TO_ASSUME_PROD   — ARN of the GitHub Actions IAM role
AWS_REGION                — us-east-1
ECR_REGISTRY              — <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com
ECS_CLUSTER_PROD          — vaccichain-prod
ECS_SERVICE_PROD          — vaccichain-backend
```

The GitHub Actions workflow at `.github/workflows/cd.yml` handles image builds and service updates on pushes to `main`.

---

## 10. TLS and Domain Configuration

### 10.1 Request an ACM Certificate

```bash
aws acm request-certificate \
  --domain-name app.yourdomain.com \
  --validation-method DNS \
  --region us-east-1
```

Follow the DNS validation instructions in the AWS Console to confirm domain ownership.

### 10.2 Configure the ALB Listener

```bash
# Get the certificate ARN from ACM
CERT_ARN=$(aws acm list-certificates --query \
  "CertificateSummaryList[?DomainName=='app.yourdomain.com'].CertificateArn" \
  --output text)

ALB_ARN=$(cd infra/envs/production && terraform output -raw alb_arn)
TG_ARN=$(cd infra/envs/production && terraform output -raw target_group_arn)

# HTTPS listener (port 443)
aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTPS \
  --port 443 \
  --certificates CertificateArn=$CERT_ARN \
  --ssl-policy ELBSecurityPolicy-TLS13-1-2-2021-06 \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN

# HTTP → HTTPS redirect (port 80)
aws elbv2 create-listener \
  --load-balancer-arn $ALB_ARN \
  --protocol HTTP \
  --port 80 \
  --default-actions '[{
    "Type": "redirect",
    "RedirectConfig": {
      "Protocol": "HTTPS",
      "Port": "443",
      "StatusCode": "HTTP_301"
    }
  }]'
```

### 10.3 Update DNS

Point your domain's A record (or CNAME) to the ALB DNS name:

```bash
aws elbv2 describe-load-balancers \
  --names vaccichain-prod-alb \
  --query 'LoadBalancers[0].DNSName' \
  --output text
```

For full TLS configuration details, see [`docs/tls-setup.md`](./tls-setup.md).

---

## 11. Verifying a Successful Deployment

Run these checks after every production deployment and record the results in the
[Contract Release Checklist](./contract-release-checklist.md) verification gate.

### 11.1 Service Health

```bash
# Check ECS service is stable (all tasks running)
aws ecs describe-services \
  --cluster vaccichain-prod \
  --services vaccichain-backend \
  --query 'services[0].{running:runningCount,desired:desiredCount,status:status}'

# Backend health endpoint
curl -sf https://app.yourdomain.com/health
# Expected: {"status":"ok"}

# Swagger UI accessible
curl -sf -o /dev/null -w "%{http_code}" https://app.yourdomain.com/docs
# Expected: 200
```

### 11.2 Stellar Connectivity

```bash
# Confirm backend is connected to mainnet (check logs)
aws logs tail /ecs/vaccichain-prod --filter-pattern "mainnet" --since 5m

# Verify contract is reachable via the API
curl -sf https://app.yourdomain.com/verify/<ANY_MAINNET_WALLET_ADDRESS>
# Expected: {"vaccinated": false, "records": []}
```

### 11.3 Authentication Flow

```bash
# Step 1: Request a SEP-10 challenge
curl -sf "https://app.yourdomain.com/auth/challenge?account=<YOUR_WALLET_ADDRESS>"
# Expected: JSON with "transaction" field

# Step 2: Sign the challenge with your Stellar wallet and submit to /auth/verify
# Expected: JSON with "token" field (JWT)
```

### 11.4 Contract Verification

Confirm the deployed contract is visible and callable on Stellar Expert:

```
https://stellar.expert/explorer/public/contract/<VACCINATIONS_CONTRACT_ID>
```

### 11.5 Log Inspection

```bash
# Tail live logs for all services
aws logs tail /ecs/vaccichain-prod --follow

# Check for startup errors
aws logs filter-log-events \
  --log-group-name /ecs/vaccichain-prod \
  --filter-pattern "ERROR" \
  --start-time $(date -d '10 minutes ago' +%s000)
```

### 11.6 End-to-End Smoke Test

1. Connect a Freighter wallet (mainnet) to `https://app.yourdomain.com`
2. Authenticate via SEP-10 — you should receive a JWT
3. As an authorized issuer, issue a test vaccination record
4. Navigate to the patient dashboard and confirm the record appears
5. Use the public verify endpoint to confirm the record is on-chain

---

## 12. Monitoring and Alerting

### 12.1 CloudWatch Alarms

Set up alarms for critical metrics:

```bash
# High error rate alarm
aws cloudwatch put-metric-alarm \
  --alarm-name vaccichain-prod-5xx-errors \
  --metric-name HTTPCode_Target_5XX_Count \
  --namespace AWS/ApplicationELB \
  --statistic Sum \
  --period 60 \
  --threshold 10 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2 \
  --alarm-actions <SNS_TOPIC_ARN>

# ECS task count alarm (detects crashed tasks)
aws cloudwatch put-metric-alarm \
  --alarm-name vaccichain-prod-task-count \
  --metric-name RunningTaskCount \
  --namespace ECS/ContainerInsights \
  --dimensions Name=ClusterName,Value=vaccichain-prod \
  --statistic Average \
  --period 60 \
  --threshold 1 \
  --comparison-operator LessThanThreshold \
  --evaluation-periods 2 \
  --alarm-actions <SNS_TOPIC_ARN>
```

### 12.2 Anomaly Detection Alerts

Configure the Python analytics service to send alerts when issuers exceed the mint threshold. Set these in Secrets Manager or the task definition:

```
ALERT_WEBHOOK_URL   — your Slack/PagerDuty webhook URL
ALERT_WEBHOOK_TYPE  — slack | pagerduty | email
ANOMALY_THRESHOLD   — 50 (adjust after observing baseline traffic)
```

See [`docs/configuration.md`](./configuration.md) for full alert configuration options.

### 12.3 Audit Log Monitoring

The backend writes an append-only NDJSON audit log to `AUDIT_LOG_PATH`. In production this is on the EFS mount at `/data/audit.log`. Review it regularly for suspicious activity:

```bash
# Stream audit log from a running task
TASK_ARN=$(aws ecs list-tasks --cluster vaccichain-prod \
  --service-name vaccichain-backend --query 'taskArns[0]' --output text)

aws ecs execute-command \
  --cluster vaccichain-prod \
  --task $TASK_ARN \
  --container backend \
  --interactive \
  --command "tail -f /data/audit.log"
```

---

## 13. CloudWatch Logs

All services ship logs to CloudWatch Logs via the `awslogs` log driver configured in each ECS task definition.

### Log Groups

Each service writes to its own log group, named by environment:

| Service | Log Group |
|---|---|
| Backend | `/ecs/vaccichain-{env}/backend` |
| Frontend | `/ecs/vaccichain-{env}/frontend` |
| Python service | `/ecs/vaccichain-{env}/python-service` |

Where `{env}` is `staging` or `production`. Log groups are created by Terraform (`infra/modules/ecs/main.tf`) with **30-day retention**.

### Viewing Logs

```bash
# Tail backend logs (replace REGION and ENV as needed)
aws logs tail /ecs/vaccichain-production/backend --follow --region us-east-1

# Tail python-service logs
aws logs tail /ecs/vaccichain-production/python-service --follow --region us-east-1
```

### Querying Structured JSON Logs (CloudWatch Insights)

The backend emits structured JSON logs via Winston. Use CloudWatch Logs Insights to query them:

1. Open **CloudWatch → Logs Insights** in the AWS Console.
2. Select the log group `/ecs/vaccichain-{env}/backend`.
3. Example queries:

```
# All errors in the last hour
fields @timestamp, level, message, requestId
| filter level = "error"
| sort @timestamp desc
| limit 50
```

```
# Request latency by route
fields @timestamp, message, responseTime, path
| filter ispresent(responseTime)
| stats avg(responseTime), max(responseTime) by path
| sort avg(responseTime) desc
```

### IAM Permissions

The ECS task execution role (`ecsTaskExecutionRole`) is granted `logs:CreateLogStream` and `logs:PutLogEvents` via the `AmazonECSTaskExecutionRolePolicy` managed policy. No additional IAM changes are required.

---

## 14. Rollback Procedure

### 14.1 Rolling Back a Service

To revert to the previous image tag:

```bash
# Find the previous task definition revision
aws ecs list-task-definitions \
  --family-prefix vaccichain-prod \
  --sort DESC \
  --query 'taskDefinitionArns[:3]'

# Update the service to use the previous revision
aws ecs update-service \
  --cluster vaccichain-prod \
  --service vaccichain-backend \
  --task-definition vaccichain-prod:<PREVIOUS_REVISION> \
  --region us-east-1
```

### 14.2 Rolling Back a Contract Deployment

The Soroban contract supports upgrades via the `upgrade` function (admin-only). To revert:

1. Build the previous WASM from the prior Git tag
2. Upload the WASM to Stellar:
   ```bash
   stellar contract install \
     --wasm target/wasm32-unknown-unknown/release/vaccichain.wasm \
     --source <ADMIN_SECRET_KEY> \
     --network mainnet
   ```
3. Call `upgrade` with the previous WASM hash:
   ```bash
   stellar contract invoke \
     --id <CONTRACT_ID> \
     --source <ADMIN_SECRET_KEY> \
     --network mainnet \
     -- upgrade \
     --new_wasm_hash <PREVIOUS_WASM_HASH>
   ```

See [`docs/contract-upgrade.md`](./contract-upgrade.md) for the full upgrade and rollback process.

### 14.3 Rollback Criteria

Initiate a rollback if any of the following occur within 30 minutes of deployment:

- `GET /health` returns non-200 for more than 2 minutes
- 5xx error rate exceeds 1% of requests
- ECS tasks are crash-looping (more than 3 restarts)
- Contract calls are failing with unexpected errors
- Audit log shows unauthorized access attempts

---

## References

- [Infra README](../infra/README.md) — Terraform module details
- [Secrets Management](./secrets-management.md) — AWS Secrets Manager setup
- [Configuration Reference](./configuration.md) — All environment variables
- [TLS Setup](./tls-setup.md) — HTTPS and certificate configuration
- [Contract Release Checklist](./contract-release-checklist.md) — Mandatory go/no-go gates for every contract release
- [Mainnet Launch Checklist](./mainnet-launch.md) — Pre-launch sign-off checklist
- [Contract Upgrade Guide](./contract-upgrade.md) — Upgrading the Soroban contract
- [Staging Setup](./staging-setup.md) — Staging environment reference
- [Stellar Documentation](https://developers.stellar.org/)
- [AWS ECS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/)
