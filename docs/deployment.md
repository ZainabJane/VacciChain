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
12. [Rollback Procedure](#12-rollback-procedure)
13. [Base Image Pinning and Update Cadence](#13-base-image-pinning-and-update-cadence)
14. [Terraform Dependency Scanning](#14-terraform-dependency-scanning)
15. [Canary / Blue-Green Deployment and Rollback Drills](#15-canary--blue-green-deployment-and-rollback-drills)
16. [Image and Artifact Retention Policy](#16-image-and-artifact-retention-policy)

---

## 1. Pre-Deployment Checklist

Complete these steps before touching any infrastructure.

- [ ] External security audit completed and all critical findings resolved
- [ ] All tests passing: `npm test` (backend), `cargo test` (contracts), `pytest` (python-service)
- [ ] Dependency scans clean: `npm audit`, `cargo audit`, `pip audit`
- [ ] Terraform provider/module scan clean (see [section 14](#14-terraform-dependency-scanning))
- [ ] Base images pinned to controlled tags or digests (see [section 13](#13-base-image-pinning-and-update-cadence))
- [ ] Domain DNS configured and propagated
- [ ] AWS account limits reviewed (ECS tasks, ECR storage, Secrets Manager)
- [ ] Mainnet launch checklist reviewed: [`docs/mainnet-launch.md`](./mainnet-launch.md)

---

## 2. Key Generation

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

## 3. Contract Deployment to Stellar Mainnet

### 3.1 Build the Contract

```bash
cd contracts
make build
```

The compiled WASM artifact is written to:
`contracts/target/wasm32-unknown-unknown/release/vaccichain.wasm`

### 3.2 Deploy to Mainnet

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

### 3.4 Add the Initial Issuer

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

### 3.5 Verify the Contract

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

## 4. AWS Infrastructure Setup

VacciChain uses Terraform to provision all AWS resources. The production configuration lives in `infra/envs/production/`.

### 4.1 Bootstrap Remote State

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

### 4.2 Create ECR Repositories

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

### 4.3 Create IAM Roles

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

### 4.4 Provision Infrastructure with Terraform

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

## 5. Environment Variable Configuration

Production secrets are stored in AWS Secrets Manager and injected into containers at runtime. **Do not use `.env` files in production.**

### 5.1 Create the Production Secret

```bash
aws secretsmanager create-secret \
  --name vaccichain/prod/stellar \
  --region us-east-1 \
  --secret-string '{
    "STELLAR_NETWORK": "mainnet",
    "HORIZON_URL": "https://horizon.stellar.org",
    "SOROBAN_RPC_URL": "https://mainnet.sorobanrpc.com",
    "STELLAR_NETWORK_PASSPHRASE": "Public Global Stellar Network ; September 2015",
    "VACCINATIONS_CONTRACT_ID": "<CONTRACT_ID from step 3.2>",
    "ADMIN_SECRET_KEY": "<S... from step 2>",
    "ADMIN_PUBLIC_KEY": "<G... from step 2>",
    "SEP10_SERVER_KEY": "<S... from step 2>",
    "ISSUER_SECRET_KEY": "<S... from step 2>",
    "JWT_SECRET": "<generate with: openssl rand -hex 32>"
  }'
```

### 5.2 Non-Secret Environment Variables

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

### 5.3 Production Task Definition

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

## 6. Build and Push Container Images

### 6.1 Authenticate with ECR

```bash
aws ecr get-login-password --region us-east-1 | \
  docker login --username AWS --password-stdin \
  <ACCOUNT_ID>.dkr.ecr.us-east-1.amazonaws.com
```

### 6.2 Build and Tag Images

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

### 6.3 Push Images

```bash
docker push $ECR/vaccichain-backend:$TAG
docker push $ECR/vaccichain-frontend:$TAG
docker push $ECR/vaccichain-python:$TAG
```

---

## 7. Deploy Services to ECS Fargate

### 7.1 Create the ECS Cluster

```bash
aws ecs create-cluster \
  --cluster-name vaccichain-prod \
  --capacity-providers FARGATE FARGATE_SPOT \
  --region us-east-1
```

### 7.2 Create ECS Services

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

### 7.3 Configure GitHub Actions for CI/CD

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

## 8. TLS and Domain Configuration

### 8.1 Request an ACM Certificate

```bash
aws acm request-certificate \
  --domain-name app.yourdomain.com \
  --validation-method DNS \
  --region us-east-1
```

Follow the DNS validation instructions in the AWS Console to confirm domain ownership.

### 8.2 Configure the ALB Listener

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

### 8.3 Update DNS

Point your domain's A record (or CNAME) to the ALB DNS name:

```bash
aws elbv2 describe-load-balancers \
  --names vaccichain-prod-alb \
  --query 'LoadBalancers[0].DNSName' \
  --output text
```

For full TLS configuration details, see [`docs/tls-setup.md`](./tls-setup.md).

---

## 9. Verifying a Successful Deployment

Run these checks after every production deployment.

### 9.1 Service Health

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

### 9.2 Stellar Connectivity

```bash
# Confirm backend is connected to mainnet (check logs)
aws logs tail /ecs/vaccichain-prod --filter-pattern "mainnet" --since 5m

# Verify contract is reachable via the API
curl -sf https://app.yourdomain.com/verify/<ANY_MAINNET_WALLET_ADDRESS>
# Expected: {"vaccinated": false, "records": []}
```

### 9.3 Authentication Flow

```bash
# Step 1: Request a SEP-10 challenge
curl -sf "https://app.yourdomain.com/auth/challenge?account=<YOUR_WALLET_ADDRESS>"
# Expected: JSON with "transaction" field

# Step 2: Sign the challenge with your Stellar wallet and submit to /auth/verify
# Expected: JSON with "token" field (JWT)
```

### 9.4 Contract Verification

Confirm the deployed contract is visible and callable on Stellar Expert:

```
https://stellar.expert/explorer/public/contract/<VACCINATIONS_CONTRACT_ID>
```

### 9.5 Log Inspection

```bash
# Tail live logs for all services
aws logs tail /ecs/vaccichain-prod --follow

# Check for startup errors
aws logs filter-log-events \
  --log-group-name /ecs/vaccichain-prod \
  --filter-pattern "ERROR" \
  --start-time $(date -d '10 minutes ago' +%s000)
```

### 9.6 End-to-End Smoke Test

1. Connect a Freighter wallet (mainnet) to `https://app.yourdomain.com`
2. Authenticate via SEP-10 — you should receive a JWT
3. As an authorized issuer, issue a test vaccination record
4. Navigate to the patient dashboard and confirm the record appears
5. Use the public verify endpoint to confirm the record is on-chain

---

## 10. Monitoring and Alerting

### 10.1 CloudWatch Alarms

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

### 10.2 Anomaly Detection Alerts

Configure the Python analytics service to send alerts when issuers exceed the mint threshold. Set these in Secrets Manager or the task definition:

```
ALERT_WEBHOOK_URL   — your Slack/PagerDuty webhook URL
ALERT_WEBHOOK_TYPE  — slack | pagerduty | email
ANOMALY_THRESHOLD   — 50 (adjust after observing baseline traffic)
```

See [`docs/configuration.md`](./configuration.md) for full alert configuration options.

### 10.3 Audit Log Monitoring

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

## 11. CloudWatch Logs

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

## 12. Rollback Procedure

### 12.1 Rolling Back a Service

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

### 12.2 Rolling Back a Contract Deployment

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

### 12.3 Rollback Criteria

Initiate a rollback if any of the following occur within 30 minutes of deployment:

- `GET /health` returns non-200 for more than 2 minutes
- 5xx error rate exceeds 1% of requests
- ECS tasks are crash-looping (more than 3 restarts)
- Contract calls are failing with unexpected errors
- Audit log shows unauthorized access attempts

For canary/blue-green rollback and the rollback drill procedure, see [section 15](#15-canary--blue-green-deployment-and-rollback-drills).

---

## 13. Base Image Pinning and Update Cadence

Production images must be built from controlled base images so that every build is reproducible and auditable.

### 13.1 Pinning Rules

- **Production Dockerfiles** (`backend/Dockerfile`, `frontend/Dockerfile`, `python-service/Dockerfile`) must reference base images by **digest** (`FROM node:20.11.1-bookworm-slim@sha256:<digest>`) or, at minimum, by a fully qualified version tag — never `latest`, `stable`, or an unversioned major tag.
- Digest pinning is preferred for production; the human-readable tag is kept alongside the digest for readability.
- Base image changes are made only through automated dependency PRs (Renovate) or an explicitly reviewed manual PR.
- The pinned digest is recorded in the PR description when it changes, so the change is traceable in the audit trail.

### 13.2 Update Cadence

| Update type | Cadence | Merge policy |
|---|---|---|
| Digest-only refresh (same tag) | Weekly (Renovate schedule) | Auto-merge once CI is green |
| Patch version bump (e.g. `20.11.1` → `20.11.2`) | Weekly | Auto-merge once CI is green |
| Minor version bump (e.g. `20.x` → `22.x`) | As released | Manual review required |
| Major version bump (e.g. `20` → `22`) | As released | Manual review + staging soak required |

Renovate opens base-image PRs on a weekly schedule. Digest and patch updates auto-merge after CI passes; minor and major updates require a reviewer and a successful staging deployment before merging.

### 13.3 Verifying Pins

```bash
# Fail if any Dockerfile uses an unpinned or floating base image
grep -nE '^\s*FROM\s+\S+:(latest|stable)\b' backend/Dockerfile frontend/Dockerfile python-service/Dockerfile && exit 1 || true

# Show current pins
grep -nE '^\s*FROM\s+' backend/Dockerfile frontend/Dockerfile python-service/Dockerfile
```

---

## 14. Terraform Dependency Scanning

CI scans Terraform providers and modules for known vulnerabilities and policy violations. The scan runs on every pull request that touches `infra/` and on a nightly schedule.

### 14.1 What Is Scanned

- Terraform **providers** locked in `.terraform.lock.hcl` (via `terraform providers lock` and a vulnerability scanner such as `trivy config` / `tfsec`)
- Terraform **modules** referenced in `infra/` (registry and git sources)
- Terraform **configuration** for insecure defaults (public buckets, open security groups, unencrypted volumes)

### 14.2 Security Policy

| Severity | Action |
|---|---|
| `CRITICAL` | CI **fails**; merge blocked; fix or documented exception required |
| `HIGH` | CI **fails**; merge blocked; fix or documented exception required |
| `MEDIUM` | CI warns; tracked as a follow-up issue |
| `LOW` | Reported only |

Exceptions must be recorded in `infra/security-exceptions.md` with an owner and expiry date. Expired exceptions fail CI.

### 14.3 Running the Scan Locally

```bash
cd infra/envs/production
terraform init -backend=false
terraform providers lock -platform=linux_amd64

# Vulnerability and misconfiguration scan
trivy config --severity HIGH,CRITICAL --exit-code 1 .
```

A non-zero exit code means the change violates the security policy and must not be merged.

---

## 15. Canary / Blue-Green Deployment and Rollback Drills

Backend releases use a blue/green traffic switch with a canary stage so that a failing release can be rolled back without downtime.

### 15.1 Deployment Flow

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

### 15.2 Rollback

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

### 15.3 Rollback Drill

The rollback path must be exercised at least once per quarter using a deliberately failing test release:

1. Build a test image that fails its health check (e.g. returns `500` from `/health`).
2. Deploy it through the normal pipeline to a staging (or production canary) target group.
3. Confirm the deployment **does not** complete the traffic switch and that the canary is aborted.
4. Confirm traffic returns to the previous (blue) target group and the service remains healthy.
5. Record the drill date, outcome, and any issues in the release log.

A drill that does not abort cleanly is treated as a release blocker until fixed.

---

## 16. Image and Artifact Retention Policy

Retention keeps registries and workflow artifacts within cost limits while preserving release evidence.

### 16.1 Retention Classes

| Class | Examples | Retention |
|---|---|---|
| Disposable build outputs | PR/preview images, untagged layers, CI artifacts from non-release runs | 14 days |
| Release candidates | Tagged images from `main` that were not promoted | 30 days |
| Signed production releases | Images referenced by a production deployment, signed release artifacts, SBOMs, provenance attestations | Indefinite (never auto-deleted) |

### 16.2 Cleanup Rules

- ECR lifecycle policies delete untagged images after 14 days and non-release tagged images after 30 days.
- GitHub Actions artifacts from non-release workflows expire after 14 days.
- Signed production release artifacts (image digests, SBOMs, signatures, deployment records) are retained indefinitely as audit evidence.

### 16.3 Protection of Deployed Images

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

## References

- [Infra README](../infra/README.md) — Terraform module details
- [Secrets Management](./secrets-management.md) — AWS Secrets Manager setup
- [Configuration Reference](./configuration.md) — All environment variables
- [TLS Setup](./tls-setup.md) — HTTPS and certificate configuration
- [Mainnet Launch Checklist](./mainnet-launch.md) — Pre-launch sign-off checklist
- [Contract Upgrade Guide](./contract-upgrade.md) — Upgrading the Soroban contract
- [Staging Setup](./staging-setup.md) — Staging environment reference
- [Infra Security Exceptions](../infra/security-exceptions.md) — Documented scan exceptions
- [Stellar Documentation](https://developers.stellar.org/)
- [AWS ECS Fargate](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html)
- [AWS Secrets Manager](https://docs.aws.amazon.com/secretsmanager/)
