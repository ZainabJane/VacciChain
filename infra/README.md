# VacciChain Infrastructure (Terraform)

Terraform modules for deploying VacciChain to AWS ECS Fargate.

## Structure

```
infra/
├── modules/
│   ├── vpc/      — VPC, subnets, NAT gateways
│   ├── ecs/      — ECS cluster, Fargate services, ALB, EFS
│   └── secrets/  — AWS Secrets Manager entries
└── envs/
    ├── staging/      — staging environment
    └── production/   — production environment
```

## Prerequisites

- [Terraform](https://developer.hashicorp.com/terraform/install) >= 1.6
- AWS credentials configured (`aws configure` or environment variables)
- AWS CLI v2 (for the bootstrap script below)

### Bootstrap (once per AWS account/region)

State buckets, lock tables, and KMS keys are **not** hardcoded. Each
environment has its own backend config file:

```
infra/envs/staging/backend.hcl
infra/envs/production/backend.hcl
```

Each file declares `bucket`, `key`, `region`, `dynamodb_table`, and
`kms_key_id` for that environment. Copy the matching `backend.hcl.example`
and fill in real values (never commit credentials or secret values):

```bash
cp infra/envs/staging/backend.hcl.example infra/envs/staging/backend.hcl
cp infra/envs/production/backend.hcl.example infra/envs/production/backend.hcl
```

Then create the prerequisites for the target environment (idempotent):

```bash
# Usage: ./infra/scripts/bootstrap.sh <env> <aws-account-id> <region>
./infra/scripts/bootstrap.sh staging 111122223333 us-east-1
./infra/scripts/bootstrap.sh production 111122223333 us-east-1
```

The script creates the versioned, encrypted S3 state bucket, the DynamoDB
lock table, and the KMS key referenced by that environment's
`backend.hcl`. It refuses to run if the bucket already belongs to a
different account. Validate the config before planning:

```bash
cd infra/envs/staging
terraform init -backend-config=backend.hcl -reconfigure
terraform validate
```

## Deploy staging

```bash
cd infra/envs/staging
terraform init -backend-config=backend.hcl
terraform plan \
  -var="aws_account_id=<STAGING_ACCOUNT_ID>" \
  -var="aws_region=us-east-1" \
  -var="backend_image=<ECR_URI>/vaccichain-backend:latest" \
  -var="frontend_image=<ECR_URI>/vaccichain-frontend:latest" \
  -var="analytics_image=<ECR_URI>/vaccichain-analytics:latest"
terraform apply
```

Staging uses its own state bucket and account; a staging plan never
references production state.

## Deploy production

```bash
cd infra/envs/production
terraform init -backend-config=backend.hcl
terraform plan \
  -var="aws_account_id=<PRODUCTION_ACCOUNT_ID>" \
  -var="aws_region=us-east-1" \
  -var="backend_image=<ECR_URI>/vaccichain-backend:<TAG>" \
  -var="frontend_image=<ECR_URI>/vaccichain-frontend:<TAG>" \
  -var="analytics_image=<ECR_URI>/vaccichain-analytics:<TAG>"
terraform apply
```

## Network egress

ECS tasks run in private subnets with no public IPs. Outbound traffic
leaves only through NAT gateways. The allow-list (see
`modules/vpc/egress.tf`) is:

| Destination | Port | Purpose |
|---|---|---|
| Stellar Horizon / RPC endpoints | 443 | Chain polling |
| Internal ALB / service DNS | 443 | Service-to-service APIs |
| ECR, S3, CloudWatch Logs, Secrets Manager (via VPC endpoints) | 443 | Pull images, logs, secrets |
| DNS resolver | 53 | Name resolution |

All other egress is denied by the security group egress rules; tasks
cannot reach administrative or unrelated public endpoints. Update the
`egress_allowlist` variable per environment when providers change.

## Autoscaling

Per-service autoscaling is configured in `modules/ecs/autoscaling.tf`:

| Service | Metric | Min | Max | Scale-out cooldown | Scale-in cooldown |
|---|---|---|---|---|---|
| backend | ALB requests/target (target 70%) | 1 | 4 | 60s | 300s |
| frontend | ALB requests/target (target 70%) | 1 | 4 | 60s | 300s |
| analytics | CPU utilization (target 70%) | 1 | 2 | 120s | 600s |

CloudWatch alarms fire when any service stays at max capacity or when
CPU/memory exceeds 85% for 10 minutes. Maximum counts are capped to
protect shared persistence (see below) and to bound cost.

## Persistence and write safety

The backend uses SQLite on EFS. SQLite does not support safe concurrent
writers across tasks, so the backend service is constrained to a
**single writer** (`desired_count = 1`, autoscaling max = 1 for the
writer task). The analytics service is read-only against the index and
may scale independently. Do not raise the backend max above 1 until a
networked database replaces SQLite. EFS access points and the task
replacement lifecycle are covered by the failure/recovery tests in
`infra/tests/`.

## Secrets

After `terraform apply`, populate secrets in AWS Secrets Manager:

```bash
for SECRET in JWT_SECRET ADMIN_SECRET_KEY SEP10_SERVER_KEY ISSUER_SECRET_KEY VACCINATIONS_CONTRACT_ID; do
  aws secretsmanager put-secret-value \
    --secret-id "vaccichain-staging/${SECRET}" \
    --secret-string "<value>"
done
```

## Tear down

```bash
terraform destroy
```
