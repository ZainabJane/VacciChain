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
2. [Key Generation](#2-key-generation)
3. [Contract Deployment to Stellar Mainnet](#3-contract-deployment-to-stellar-mainnet)
4. [AWS Infrastructure Setup](#4-aws-infrastructure-setup)
5. [Environment Variable Configuration](#5-environment-variable-configuration)
6. [Build and Push Container Images](#6-build-and-push-container-images)
7. [Deploy Services to ECS Fargate](#7-deploy-services-to-ecs-fargate)
8. [TLS and Domain Configuration](#8-tls-and-domain-configuration)
9. [Verifying a Successful Deployment](#9-verifying-a-successful-deployment)
10. [Monitoring and Alerting](#10-monitoring-and-alerting)
11. [CloudWatch Logs](#11-cloudwatch-logs)
12. [Persistence Architecture](#12-persistence-architecture)
13. [Proxy Headers and Client IP Derivation](#13-proxy-headers-and-client-ip-derivation)
14. [Audit Log Rotation, Retention, and Integrity](#14-audit-log-rotation-retention-and-integrity)
15. [Rollback Procedure](#15-rollback-procedure)
16. [Base Image Pinning and Update Cadence](#16-base-image-pinning-and-update-cadence)
17. [Terraform Dependency Scanning](#17-terraform-dependency-scanning)
18. [Canary / Blue-Green Deployment and Rollback Drills](#18-canary--blue-green-deployment-and-rollback-drills)
19. [Image and Artifact Retention Policy](#19-image-and-artifact-retention-policy)

---

## 1. Pre-Deployment Checklist

Complete these steps before touching any infrastructure.

- [ ] External security audit completed and all critical findings resolved
- [ ] All tests passing: `npm test` (backend), `cargo test` (contracts), `pytest` (python-service)
- [ ] Staging smoke tests passing (`npm run smoke:staging` against staging) — production promotion is blocked otherwise
- [ ] Dependency scans clean: `npm audit`, `cargo audit`, `pip audit`
- [ ] Terraform provider/module scan clean (see [section 14](#14-terraform-dependency-scanning))
- [ ] Base images pinned to controlled tags or digests (see [section 13](#13-base-image-pinning-and-update-cadence))
- [ ] Domain DNS configured and propagated
- [ ] AWS account limits reviewed (ECS tasks, ECR storage, Secrets Manager)
- [ ] Mainnet launch checklist reviewed: [`docs/mainnet-launch.md`](./mainnet-launch.md)
- [ ] Multisig signer set and threshold agreed with key custodians and documented in [`docs/admin-multisig.md`](./admin-multisig.md) (see [section 13](#13-multisig-admin-configuration))

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

The `Makefile` targets `testnet` by default. For mainnet, pass the network flags explicitly.

> **The deployment command requires an explicit network.** Deployments without an explicit `--network` (and the matching `--network-passphrase` / `--rpc-url`) are rejected by the deployment tooling — there is no implicit default. This prevents accidentally deploying to the wrong Stellar network.

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

#### Network-specific configuration validation

Before any deploy or invoke, the tooling validates that the network name, passphrase, RPC URL, and Horizon URL are a consistent set for the selected network. A mismatch (for example `--network mainnet` combined with the testnet passphrase or a testnet RPC URL) aborts the command before a transaction is submitted.

| Network | `STELLAR_NETWORK` | `STELLAR_NETWORK_PASSPHRASE` | `SOROBAN_RPC_URL` | `HORIZON_URL` |
|---|---|---|---|---|
| `mainnet` | `mainnet` | `Public Global Stellar Network ; September 2015` | `https://mainnet.sorobanrpc.com` | `https://horizon.stellar.org` |
| `testnet` | `testnet` | `Test SDF Network ; September 2015` | `https://soroban-testnet.stellar.org` | `https://horizon-testnet.stellar.org` |

The same validation runs at backend startup: if `STELLAR_NETWORK` does not match `STELLAR_NETWORK_PASSPHRASE` and the configured RPC/Horizon URLs, the service refuses to start. See [Section 5](#5-environment-variable-configuration) for the production values.

#### Record the artifact hash

Compute and record the SHA-256 hash of the WASM artifact you are about to deploy. You will need it for the post-deploy smoke test in [Section 9.7](#97-contract-id-and-artifact-hash-smoke-test):

```bash
sha256sum target/wasm32-unknown-unknown/release/vaccichain.wasm
```

### 3.3 Initialize the Contract

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
| `AUDIT_LOG_MAX_BYTES` | `104857600` | Rotate the audit log at 100 MiB |
| `AUDIT_LOG_RETENTION_DAYS` | `90` | Rotated segments older than this are purged |
| `AUDIT_LOG_HASH_ALGORITHM` | `sha256` | Hash chain algorithm for tamper evidence |
| `DATABASE_PATH` | `/data/vaccichain.db` | Persistent EFS mount |
| `DATABASE_BUSY_TIMEOUT_MS` | `5000` | SQLite lock wait before failing a write |
| `DATABASE_WAL_ENABLED` | `true` | Write-ahead logging for concurrent readers |
| `TRUST_PROXY` | `1` | Number of trusted proxy hops (ALB only) |
| `BACKEND_URL` | `http://backend:4000` | Internal service URL |
| `ANALYTICS_API_KEY` | *(set in Secrets Manager)* | Generate with `openssl rand -hex 32` |
| `RATE_LIMIT_SEP10` | `10` | Adjust based on expected traffic |
| `RATE_LIMIT_VERIFY` | `60` | Adjust based on expected traffic |
| `SOROBAN_FEE` | `1000` | Higher fee for mainnet priority |
| `MULTISIG_THRESHOLD` | `2` | Require 2 approvals for admin ops — must equal the on-chain threshold documented in [`docs/admin-multisig.md`](./admin-multisig.md) |

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

Base images in the Dockerfiles must follow the pinning policy in [section 13](#13-base-image-pinning-and-update-cadence). Record the resulting image digest after pushing — the digest is the immutable reference used for deployment and for cleanup protection:

```bash
aws ecr describe-images \
  --repository-name vaccichain-backend \
  --image-ids imageTag=$TAG \
  --query 'imageDetails[0].imageDigest' \
  --output text
```

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

Deployments are driven by GitHub Actions. Two things gate every merge and deploy: the required CI check and the deployment environments.

#### Required CI check

Branch protection on `main` requires a single status check named **`ci-required`**. That job is an aggregate gate that depends on the individual lint, test, coverage, dependency-scan, and image-scan jobs. Each test suite runs exactly once per workflow path and uploads its real coverage output as an artifact; the aggregate job only inspects those results, so no suite is executed twice. Do not add the individual job names to branch protection — only `ci-required` should be required, so the required-check list stays stable as jobs are added or renamed.

#### GitHub Environments

Two separate GitHub Environments isolate staging from production:

| Environment | Secrets scope | Protection |
|---|---|---|
| `staging` | `AWS_ROLE_TO_ASSUME_STAGING`, `ECS_CLUSTER_STAGING`, `ECS_SERVICE_STAGING`, testnet Stellar keys | No reviewers; restricted to `develop` |
| `production` | `AWS_ROLE_TO_ASSUME_PROD`, `ECS_CLUSTER_PROD`, `ECS_SERVICE_PROD`, mainnet Stellar keys | Required reviewers; restricted to `main` |

Secrets are defined per environment, never at repository scope, so a staging run cannot read production credentials (and vice versa). The `production` environment must have **required reviewers** configured in repository settings; a production deploy job will wait for manual approval before it starts. Shared non-sensitive values (`AWS_REGION`, `ECR_REGISTRY`) may remain repository-level variables.

#### Pre-deploy policy gate

A policy job runs before any deploy job and blocks production deploys unless all of the following hold:

- the ref is `main` (staging is restricted to `develop`)
- the triggering event is `push` or an approved `workflow_dispatch` — `pull_request` and other events are rejected for production
- the `ci-required` check succeeded for the same commit
- the `production` environment approval has been granted

If any condition fails, the deploy job is skipped and the workflow fails the gate. This prevents a production deploy from an unapproved branch or event even if the environment is misconfigured.

#### Contract deploy / upgrade / no-op decision

Contract changes no longer deploy a new contract on every push. The workflow inspects the change set and the deployment manifest (`contracts/deployments/<network>.json`, which records the deployed contract ID and WASM hash) and takes one of three paths:

| Path | When | Action |
|---|---|---|
| `deploy` | No contract recorded in the manifest for the network | `stellar contract deploy`, then write the new contract ID to the manifest |
| `upgrade` | Manifest has a contract ID and the WASM hash differs | `stellar contract install` + `upgrade` on the **explicit** `target_contract` input |
| `no-op` | Manifest contract ID and WASM hash already match the build | Skip; report success without touching the network |

Upgrades require an explicit `target_contract` workflow input (the contract ID to upgrade); the workflow fails if it is missing or does not match the manifest. Because the manifest is committed back after a successful deploy, re-running a completed deployment resolves to `no-op` and cannot silently create a second production contract. See [`docs/contract-upgrade.md`](./contract-upgrade.md) for the manual equivalent.

#### Terraform fmt / validate / plan review

CI runs `terraform fmt -check -recursive` and `terraform validate` for every directory under `infra/envs/*` and `infra/modules/*`. On pull requests, a plan job runs with **isolated, read-only credentials** (a dedicated plan role that cannot apply) and posts the plan for review. `terraform apply` runs only after the plan is approved and the environment gate passes; it uses the environment-scoped apply role, never the plan credentials.

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

> **Staging smoke-test gate:** Production promotion is blocked until the release-level smoke tests pass against staging. See [Section 9.0](#90-staging-smoke-test-gate) for what the gate covers and how to run it.

### 9.0 Staging Smoke Test Gate

Before any release is promoted to production, the same container images must be deployed to staging and pass the release-level smoke test suite. The CI/CD pipeline (`.github/workflows/cd.yml`) runs this gate automatically; a failure blocks the production promotion step.

The smoke tests exercise the **real deployed staging environment** (not mocks) and cover:

| Check | What it verifies |
|---|---|
| **Frontend route load** | The staging frontend URL serves the app shell and key routes (e.g. `/`, `/verify`) with HTTP 200 and expected content |
| **API health** | `GET /health` on the staging backend returns `{"status":"ok"}` and ECS tasks are stable |
| **Analytics reachability** | The Python analytics service responds on its health/readiness endpoint and is reachable from the backend |
| **Public verification** | A safe, known public verification case (a wallet with no records) returns the expected `{"vaccinated": false, "records": []}` shape |

Run the gate manually against staging:

```bash
# Point the suite at the staging environment
export SMOKE_BASE_URL=https://staging.yourdomain.com
export SMOKE_ANALYTICS_URL=https://staging.yourdomain.com/analytics
export SMOKE_VERIFY_WALLET=<KNOWN_EMPTY_TESTNET_WALLET_ADDRESS>

npm run smoke:staging
```

**Promotion is blocked when any smoke test fails.** Do not override the gate to ship a release; fix the failing check on staging (or roll back the staging deployment) and re-run the suite until it passes.

### 11.1 Service Health

```bash
# Check ECS service is stable (all tasks running)
aws ecs describe-services \
  --cluster vaccichain-prod \
  --services vaccichain-backend \
  --query 'services[0].{running:runningCount,desired:desiredCount,status:status}'

# Liveness probe — process-only, no dependency checks
curl -sf https://app.yourdomain.com/health/live
# Expected: {"status":"ok"}

# Readiness probe — verifies database and required RPC state
curl -sf https://app.yourdomain.com/health/ready
# Expected: {"status":"ready","checks":{"database":"ok","rpc":"ok"}}

# Swagger UI accessible
curl -sf -o /dev/null -w "%{http_code}" https://app.yourdomain.com/docs
# Expected: 200
```

#### Liveness vs. Readiness Semantics

The backend exposes two distinct health endpoints. They exist to keep orchestration from restarting healthy processes during transient dependency outages.

| Endpoint | Purpose | Dependencies checked | Failure meaning |
|---|---|---|---|
| `GET /health/live` | Liveness — is the process alive and able to serve HTTP? | **None.** No database, no RPC, no external calls. | The process is wedged or crashed and should be restarted. |
| `GET /health/ready` | Readiness — can this instance serve real traffic right now? | **Database** (SQLite at `DATABASE_PATH`) and **required RPC** (`SOROBAN_RPC_URL` reachability). | The instance is temporarily unable to serve traffic; it should be removed from rotation but **not** restarted. |

**Dependency expectations:**

- **Liveness (`/health/live`)** must never depend on the database or Stellar RPC. A temporary RPC or database outage must not cause liveness failures, otherwise orchestrators will crash-loop otherwise-healthy tasks.
- **Readiness (`/health/ready`)** returns non-200 when the database is unreachable or the required Soroban RPC endpoint is down. It returns 200 only when both are healthy. Readiness failures are expected during dependency outages and should resolve automatically once the dependency recovers.

**Response hygiene:** health responses never include secrets, connection strings, credentials, or raw upstream error payloads. They report only a coarse status per dependency (`ok` / `unavailable`) so the endpoints are safe to expose to load balancers and monitoring.

#### Orchestration Guidance

Map each probe to exactly one endpoint:

| Orchestrator mechanism | Endpoint | Action on failure |
|---|---|---|
| ALB target group health check | `/health/ready` | Deregister the target from rotation (no task restart) |
| ECS container health check | `/health/live` | ECS replaces the unhealthy task |
| ECS deployment circuit breaker | `/health/ready` (via ALB) | Roll back the deployment if new tasks never become ready |
| External uptime monitoring | `/health/ready` | Page on sustained failure |

Do **not** point the ALB target group at `/health/live` — that would keep routing traffic to instances whose database or RPC dependency is down. Do **not** point the ECS container health check at `/health/ready` — that would restart tasks during temporary RPC outages. When creating the backend service (step 7.2), set the target group health check path to `/health/ready` and the container health check command to probe `/health/live`.

### 9.2 Stellar Connectivity

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

The automated staging gate in [Section 9.0](#90-staging-smoke-test-gate) must pass before this manual production check. Then:

1. Connect a Freighter wallet (mainnet) to `https://app.yourdomain.com`
2. Authenticate via SEP-10 — you should receive a JWT
3. As an authorized issuer, issue a test vaccination record
4. Navigate to the patient dashboard and confirm the record appears
5. Use the public verify endpoint to confirm the record is on-chain

### 9.7 Multisig Admin Configuration Verification

Confirm the on-chain admin signer set and threshold match the values documented in [`docs/admin-multisig.md`](./admin-multisig.md). This is the post-deploy check required by issue #83.

```bash
# Read the on-chain admin configuration (signers + threshold)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source <ADMIN_SECRET_KEY> \
  --network mainnet \
  --network-passphrase "Public Global Stellar Network ; September 2015" \
  --rpc-url https://mainnet.sorobanrpc.com \
  -- get_admin_config
```

Verify all of the following before signing off:

- [ ] Every signer returned on-chain is listed in the documented signer set, and no extra signers are present
- [ ] The on-chain threshold equals `MULTISIG_THRESHOLD` in the task definition and the documented threshold
- [ ] Each signer's key custody matches the documented custodian (hardware wallet / air-gapped machine)
- [ ] The documented approval procedure (who signs, in what order, where approvals are recorded) is current
- [ ] A testnet drill has demonstrated both normal administration and signer-unavailable recovery (see [`docs/admin-multisig.md`](./admin-multisig.md))

If any value differs, **stop** and reconcile the runbook and contract configuration before proceeding.

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

## 12. Persistence Architecture

### 12.1 Selected Architecture

The event index remains on **SQLite in WAL mode on the shared EFS mount**, with a single writer per database file enforced by the backend's write serialization. This decision was made after a load and failure analysis comparing the current storage with a multi-writer database option (PostgreSQL on RDS).

**Why SQLite was retained:**

- The index is append-heavy with a small, bounded working set; measured write throughput at 2 ECS tasks stays well below the SQLite ceiling.
- EFS provides durable, shared storage with automatic replication within the region; the database file survives task replacement and AZ failover.
- Operational simplicity: no additional managed database to patch, monitor, or pay for at current volume.

**Known limits and the trigger to revisit:**

- SQLite serializes writers. If sustained write latency exceeds 50 ms p95 or write contention errors (`SQLITE_BUSY`) appear in logs, the index must move to a multi-writer database.
- The migration path to PostgreSQL is documented in [`docs/persistence-migration.md`](./persistence-migration.md); the backend's data access layer is abstracted so the swap does not change API behavior.

### 12.2 Locking Behavior

- WAL mode is enabled (`DATABASE_WAL_ENABLED=true`) so readers are never blocked by the writer.
- Writers acquire the database lock with a bounded wait (`DATABASE_BUSY_TIMEOUT_MS`); on timeout the request fails with a retryable error rather than hanging.
- Only one backend task performs index writes at a time; additional tasks serve reads. Scaling beyond one writer requires the PostgreSQL migration.

### 12.3 Backup and Restore

```bash
# Consistent online backup (safe while the service is running)
sqlite3 /data/vaccichain.db ".backup '/data/backups/vaccichain-$(date +%Y%m%d%H%M%S).db'"

# Verify integrity of a backup before relying on it
sqlite3 /data/backups/<BACKUP_FILE> "PRAGMA integrity_check;"
# Expected: ok
```

Backups are written to `/data/backups` on EFS and copied to S3 on a daily schedule. Restore procedure: stop the backend service, replace `/data/vaccichain.db` with the chosen backup, run `PRAGMA integrity_check`, then restart the service.

### 12.4 Failover

- EFS is mounted in multiple AZs; if a task or AZ fails, ECS reschedules the task and it reattaches to the same database file.
- Because writes are serialized, a failed writer task does not leave the database in a partially written state — WAL recovery on next open rolls back any incomplete transaction.
- After any failover, confirm recovery succeeded:

```bash
aws logs tail /ecs/vaccichain-production/backend --filter-pattern "database" --since 10m
# Expected: no "database is locked" or "disk I/O error" entries
```

### 12.5 Migration

Schema migrations run automatically at backend startup and are idempotent. Before deploying a release that includes a migration:

1. Take an online backup (section 12.3) and verify its integrity.
2. Deploy to staging and confirm the migration completes and the smoke test passes.
3. Deploy to production; watch logs for migration errors during the first 10 minutes.

If a migration fails, roll back the service to the previous task definition revision (section 15.1) and restore the pre-migration backup.

---

## 13. Proxy Headers and Client IP Derivation

The backend runs behind an Application Load Balancer. Express must trust exactly the proxies in front of it so that client IPs used for rate limiting and audit attribution cannot be spoofed by a caller-supplied `X-Forwarded-For` header.

### 13.1 Trust-Proxy Configuration

- Set `TRUST_PROXY=1` in the production task definition. This trusts exactly one hop — the ALB — and ignores any additional `X-Forwarded-For` entries supplied by the client.
- Do **not** set `TRUST_PROXY=true` (trust all proxies) in production; that allows clients to forge their address.
- If a CDN or WAF is added in front of the ALB, increment `TRUST_PROXY` to match the new hop count and update this document.

### 13.2 Verification

```bash
# Direct request to the ALB: client IP should be the caller's address
curl -sf https://app.yourdomain.com/health -H "X-Forwarded-For: 203.0.113.9"
# The spoofed header must be ignored; logs should show the real source IP

# Confirm the derived client IP in the audit log
aws logs tail /ecs/vaccichain-production/backend --filter-pattern "clientIp" --since 5m
```

Integration tests in the backend suite cover both direct and proxied requests and assert the derived client identity matches the expected hop count.

---

## 14. Audit Log Rotation, Retention, and Integrity

The backend writes an append-only NDJSON audit log to `AUDIT_LOG_PATH` on the EFS mount. Every mint, revoke, consent, and administrative change records the actor, request ID, action outcome, and timestamp.

### 14.1 Rotation

- The active log rotates when it reaches `AUDIT_LOG_MAX_BYTES`; the rotated segment is renamed with a timestamp suffix (e.g. `audit.log.20250101T000000Z`).
- Rotation is performed under a lock so concurrent tasks never write to a segment being rotated.
- A new active log is opened immediately; no audit events are dropped during rotation.

### 14.2 Retention

- Rotated segments older than `AUDIT_LOG_RETENTION_DAYS` are purged by the scheduled cleanup job.
- Segments are also shipped to CloudWatch Logs and to S3 (with Object Lock) for long-term retention beyond the local window.
- Retention changes require a documented review; do not shorten retention below the compliance minimum.

### 14.3 Integrity Verification

- Each log entry includes a hash of the previous entry, forming a hash chain. Any modification or deletion of an entry breaks the chain.
- Verify a segment with the audit verification tool:

```bash
npm run audit:verify -- /data/audit.log
# Expected: "chain intact" with the entry count
```

- Run verification after every rotation and as part of the daily backup job. A broken chain is a security incident — escalate immediately.

### 14.4 Failure Handling

- If the audit log cannot be written, the operation that requires auditing **fails closed**: the mint/revoke/consent/admin action is rejected rather than proceeding unaudited.
- Write failures are logged to CloudWatch and trigger the `vaccichain-prod-audit-write-failure` alarm.
- If the EFS mount is unavailable, the backend reports unhealthy on `/health` so ECS replaces the task rather than serving unaudited traffic.

---

## 15. Rollback Procedure

### 15.1 Rolling Back a Service

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

### 15.2 Rolling Back a Contract Deployment

The Soroban contract supports upgrades via the `upgrade` function (admin-only). To revert:

1. Build the previous WASM from the prior Git tag
2. Upload the WASM to Stellar (the network must be passed explicitly):
   ```bash
   stellar contract install \
     --wasm target/wasm32-unknown-unknown/release/vaccichain.wasm \
     --source <ADMIN_SECRET_KEY> \
     --network mainnet \
     --network-passphrase "Public Global Stellar Network ; September 2015" \
     --rpc-url https://mainnet.sorobanrpc.com
   ```
3. Call `upgrade` with the previous WASM hash:
   ```bash
   stellar contract invoke \
     --id <CONTRACT_ID> \
     --source <ADMIN_SECRET_KEY> \
     --network mainnet \
     --network-passphrase "Public Global Stellar Network ; September 2015" \
     --rpc-url https://mainnet.sorobanrpc.com \
     -- upgrade \
     --new_wasm_hash <PREVIOUS_WASM_HASH>
   ```
4. Re-run the [contract ID and artifact hash smoke test](#97-contract-id-and-artifact-hash-smoke-test) to confirm the rollback landed on the expected network with the expected artifact.

See [`docs/contract-upgrade.md`](./contract-upgrade.md) for the full upgrade and rollback process.

### 15.3 Rollback Criteria

Initiate a rollback if any of the following occur within 30 minutes of deployment:

- `GET /health/ready` returns non-200 for more than 2 minutes (after dependency recovery has been ruled out)
- `GET /health/live` returns non-200 (indicates a wedged or crashed process)
- 5xx error rate exceeds 1% of requests
- ECS tasks are crash-looping (more than 3 restarts)
- Contract calls are failing with unexpected errors
- Audit log shows unauthorized access attempts

For canary/blue-green rollback and the rollback drill procedure, see [section 18](#18-canary--blue-green-deployment-and-rollback-drills).

---

## 16. Base Image Pinning and Update Cadence

Production images must be built from controlled base images so that every build is reproducible and auditable.

### 16.1 Pinning Rules

- **Production Dockerfiles** (`backend/Dockerfile`, `frontend/Dockerfile`, `python-service/Dockerfile`) must reference base images by **digest** (`FROM node:20.11.1-bookworm-slim@sha256:<digest>`) or, at minimum, by a fully qualified version tag — never `latest`, `stable`, or an unversioned major tag.
- Digest pinning is preferred for production; the human-readable tag is kept alongside the digest for readability.
- Base image changes are made only through automated dependency PRs (Renovate) or an explicitly reviewed manual PR.
- The pinned digest is recorded in the PR description when it changes, so the change is traceable in the audit trail.

### 16.2 Update Cadence

| Update type | Cadence | Merge policy |
|---|---|---|
| Digest-only refresh (same tag) | Weekly (Renovate schedule) | Auto-merge once CI is green |
| Patch version bump (e.g. `20.11.1` → `20.11.2`) | Weekly | Auto-merge once CI is green |
| Minor version bump (e.g. `20.x` → `22.x`) | As released | Manual review required |
| Major version bump (e.g. `20` → `22`) | As released | Manual review + staging soak required |

Renovate opens base-image PRs on a weekly schedule. Digest and patch updates auto-merge after CI passes; minor and major updates require a reviewer and a successful staging deployment before merging.

### 16.3 Verifying Pins

```bash
# Fail if any Dockerfile uses an unpinned or floating base image
grep -nE '^\s*FROM\s+\S+:(latest|stable)\b' backend/Dockerfile frontend/Dockerfile python-service/Dockerfile && exit 1 || true

# Show current pins
grep -nE '^\s*FROM\s+' backend/Dockerfile frontend/Dockerfile python-service/Dockerfile
```

---

## 17. Terraform Dependency Scanning

CI scans Terraform providers and modules for known vulnerabilities and policy violations. The scan runs on every pull request that touches `infra/` and on a nightly schedule.

### 17.1 What Is Scanned

- Terraform **providers** locked in `.terraform.lock.hcl` (via `terraform providers lock` and a vulnerability scanner such as `trivy config` / `tfsec`)
- Terraform **modules** referenced in `infra/` (registry and git sources)
- Terraform **configuration** for insecure defaults (public buckets, open security groups, unencrypted volumes)

### 17.2 Security Policy

| Severity | Action |
|---|---|
| `CRITICAL` | CI **fails**; merge blocked; fix or documented exception required |
| `HIGH` | CI **fails**; merge blocked; fix or documented exception required |
| `MEDIUM` | CI warns; tracked as a follow-up issue |
| `LOW` | Reported only |

Exceptions must be recorded in `infra/security-exceptions.md` with an owner and expiry date. Expired exceptions fail CI.

### 17.3 Running the Scan Locally

```bash
cd infra/envs/production
terraform init -backend=false
terraform providers lock -platform=linux_amd64

# Vulnerability and misconfiguration scan
trivy config --severity HIGH,CRITICAL --exit-code 1 .
```

A non-zero exit code means the change violates the security policy and must not be merged.

---

## 18. Canary / Blue-Green Deployment and Rollback Drills

Backend releases use a blue/green traffic switch with a canary stage so that a failing release can be rolled back without downtime.

### 18.1 Deployment Flow

1. **Deploy green** — register a new task definition revision and create/update the green target group with the new image digest. No production traffic is sent yet.
2. **Wait for healthy targets** — the deployment blocks until the green target group reports all targets healthy and `/health` returns `200`.
3. **Canary switch (10%)** — shift 10% of ALB traffic to green and observe for 10 minutes. Abort on any 5xx increase or failed health check.
4. **Full switch (100%)** — shift remaining traffic to green, keep blue running for 30 minutes as the rollback target.
5. **Retire blue** — after the soak window and passing smoke tests, scale blue down to zero.

```bash
# Example: shift 10% of traffic to the green target group
aws elbv2 modify-listener \
  --listener-arn $LISTENER_ARN \
  --default-actions '[{
    "Type": "forward",
    "ForwardConfig": {
      "TargetGroups": [
        {"TargetGroupArn": "'"$BLUE_TG_ARN"'", "Weight": 90},
        {"TargetGroupArn": "'"$GREEN_TG_ARN"'", "Weight": 10}
      ]
    }
  }]'
```

The deployment fails (and does not switch traffic) if green targets do not become healthy within the configured grace period.

### 18.2 Rollback

If the canary or smoke checks fail, shift 100% of traffic back to blue and stop the green deployment:

```bash
aws elbv2 modify-listener \
  --listener-arn $LISTENER_ARN \
  --default-actions Type=forward,TargetGroupArn=$BLUE_TG_ARN

aws ecs update-service \
  --cluster vaccichain-prod \
  --service vaccichain-backend \
  --task-definition vaccichain-prod:<PREVIOUS_REVISION>
```

### 18.3 Rollback Drill

The rollback path must be exercised at least once per quarter using a deliberately failing test release:

1. Build a test image that fails its health check (e.g. returns `500` from `/health`).
2. Deploy it through the normal pipeline to a staging (or production canary) target group.
3. Confirm the deployment **does not** complete the traffic switch and that the canary is aborted.
4. Confirm traffic returns to the previous (blue) target group and the service remains healthy.
5. Record the drill date, outcome, and any issues in the release log.

A drill that does not abort cleanly is treated as a release blocker until fixed.

---

## 19. Image and Artifact Retention Policy

Retention keeps registries and workflow artifacts within cost limits while preserving release evidence.

### 19.1 Retention Classes

| Class | Examples | Retention |
|---|---|---|
| Disposable build outputs | PR/preview images, untagged layers, CI artifacts from non-release runs | 14 days |
| Release candidates | Tagged images from `main` that were not promoted | 30 days |
| Signed production releases | Images referenced by a production deployment, signed release artifacts, SBOMs, provenance attestations | Indefinite (never auto-deleted) |

### 19.2 Cleanup Rules

- ECR lifecycle policies delete untagged images after 14 days and non-release tagged images after 30 days.
- GitHub Actions artifacts from non-release workflows expire after 14 days.
- Signed production release artifacts (image digests, SBOMs, signatures, deployment records) are retained indefinitely as audit evidence.

### 19.3 Protection of Deployed Images

Automated cleanup **must not** delete:

- The image digest currently deployed to any production ECS service
- The previous revision kept as the rollback target
- Any image referenced by a signed release record

Before deleting, the cleanup job resolves the digests in use by production services and excludes them:

```bash
# Digests currently deployed in production — must be excluded from cleanup
aws ecs describe-services \
  --cluster vaccichain-prod \
  --services vaccichain-backend \
  --query 'services[0].taskDefinition' --output text | \
  xargs -I{} aws ecs describe-task-definition --task-definition {} \
  --query 'taskDefinition.containerDefinitions[].image' --output text
```

Cleanup jobs run in dry-run mode first and log every candidate for deletion; any candidate matching a protected digest is skipped and reported.

---

## 13. Multisig Admin Configuration

On-chain admin operations are protected by a multisignature policy. The authoritative record of the signer set, threshold, key custody, and approval procedures lives in [`docs/admin-multisig.md`](./admin-multisig.md) (issue #83).

**Deployment runbook and contract configuration must agree on:**

- **Signer set** — the exact public keys authorized to approve admin operations, and the custodian responsible for each
- **Threshold** — the minimum number of signatures required, which must match `MULTISIG_THRESHOLD` in the task definition (see [section 5.2](#52-non-secret-environment-variables))
- **Approval procedure** — how approvals are requested, collected, and recorded for each admin operation

Before deploying, confirm the documented signer set and threshold are current. After deploying, complete the verification in [section 9.7](#97-multisig-admin-configuration-verification).

### 13.1 Signer-Unavailable Recovery

If a signer key is lost or a custodian is unavailable, follow the recovery procedure in [`docs/admin-multisig.md`](./admin-multisig.md). Recovery must be rehearsed on testnet before mainnet launch, demonstrating both normal administration and signer-unavailable recovery.

---

## References

- [Infra README](../infra/README.md) — Terraform module details
- [Secrets Management](./secrets-management.md) — AWS Secrets Manager setup
- [Configuration Reference](./configuration.md) — All environment variables
- [TLS Setup](./tls-setup.md) — HTTPS and certificate configuration
- [Contract Release Checklist](./contract-release-checklist.md) — Mandatory go/no-go gates for every contract release
- [Mainnet Launch Checklist](./mainnet-launch.md) — Pre-launch sign-off checklist
- [Contract Upgrade Guide](./contract-upgrade.md) — Upgrading the Soroban contract
- [Persistence Migration](./persistence-migration.md) — Moving the event index to PostgreSQL
- [Staging Setup](./staging-setup.md) — Staging environment reference
- [Staging Smoke Tests](./staging-setup.md#smoke-tests) — Release-level smoke-test gate that blocks production promotion
- [Infra Security Exceptions](../infra/security-exceptions.md) — Documented scan exceptions
- [Stellar Documentation](https://developers.stellar.org/)
- [AWS ECS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/)
