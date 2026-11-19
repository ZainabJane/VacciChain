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
- An S3 bucket named `vaccichain-tfstate` for remote state (create once):
  ```bash
  aws s3api create-bucket --bucket vaccichain-tfstate --region us-east-1
  aws s3api put-bucket-versioning --bucket vaccichain-tfstate \
    --versioning-configuration Status=Enabled
  aws s3api put-bucket-encryption --bucket vaccichain-tfstate \
    --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"aws:kms"}}]}'
  aws s3api put-public-access-block --bucket vaccichain-tfstate \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  ```
- A DynamoDB table for state locking (create once):
  ```bash
  aws dynamodb create-table \
    --table-name vaccichain-tfstate-lock \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST
  ```

## Remote state backend

Each environment uses an S3 backend with encryption, versioning and DynamoDB
locking. The backend block in `envs/<env>/backend.tf` looks like:

```hcl
terraform {
  backend "s3" {
    bucket         = "vaccichain-tfstate"
    key            = "envs/<env>/terraform.tfstate"
    region         = "us-east-1"
    encrypt        = true
    kms_key_id     = "alias/vaccichain-tfstate"
    dynamodb_table = "vaccichain-tfstate-lock"
  }
}
```

- **Encryption** — state is encrypted at rest with SSE-KMS (`encrypt = true`).
- **Versioning** — every state write creates a new S3 object version, enabling
  rollback after corruption or accidental deletion.
- **Locking** — DynamoDB (`vaccichain-tfstate-lock`) prevents concurrent writes;
  `terraform plan`/`apply` acquire and release the lock automatically.

### Least-privilege IAM

The CI/CD role and human operators should be granted only the permissions the
backend needs. Example policy (scope `Resource` ARNs to the state bucket and
lock table):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketVersioning"],
      "Resource": "arn:aws:s3:::vaccichain-tfstate"
    },
    {
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::vaccichain-tfstate/envs/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:*:table/vaccichain-tfstate-lock"
    },
    {
      "Effect": "Allow",
      "Action": ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      "Resource": "<kms-key-arn>"
    }
  ]
}
```

Do not grant `s3:*` or `dynamodb:*` on `*`; the state bucket must never be
public and should deny non-TLS access via a bucket policy.

## State recovery

If state is lost or corrupted, restore a previous S3 object version. This
procedure is exercised in the staging environment as part of the release
checklist.

1. **Stop concurrent runs.** Ensure no `terraform apply` is in flight, then
   clear any stale lock (only after confirming no run is active):
   ```bash
   terraform force-unlock <LOCK_ID>
   ```
2. **List available state versions:**
   ```bash
   aws s3api list-object-versions \
     --bucket vaccichain-tfstate \
     --prefix envs/staging/terraform.tfstate \
     --query 'Versions[].{VersionId:VersionId,LastModified:LastModified,IsLatest:IsLatest}' \
     --output table
   ```
3. **Restore a known-good version** (copy it back as the current object):
   ```bash
   aws s3api copy-object \
     --bucket vaccichain-tfstate \
     --key envs/staging/terraform.tfstate \
     --copy-source "vaccichain-tfstate/envs/staging/terraform.tfstate?versionId=<VERSION_ID>" \
     --server-side-encryption aws:kms
   ```
4. **Verify** the restored state matches reality before applying:
   ```bash
   cd infra/envs/staging
   terraform init -reconfigure
   terraform state list
   terraform plan   # expect no unexpected destroys
   ```
5. **Recover from total loss** (no usable version): re-import resources with
   `terraform import` or recreate the environment from scratch, then commit the
   recovered state via a normal `terraform apply`.

### Verifying lock table integrity

```bash
# Confirm the table exists and is ACTIVE
aws dynamodb describe-table --table-name vaccichain-tfstate-lock \
  --query 'Table.TableStatus'

# Inspect any outstanding locks (should be empty when idle)
aws dynamodb scan --table-name vaccichain-tfstate-lock \
  --query 'Items[].LockID'
```

## Deploy staging

```bash
cd infra/envs/staging
terraform init
terraform plan \
  -var="backend_image=<ECR_URI>/vaccichain-backend:latest" \
  -var="frontend_image=<ECR_URI>/vaccichain-frontend:latest" \
  -var="analytics_image=<ECR_URI>/vaccichain-analytics:latest"
terraform apply
```

## Deploy production

```bash
cd infra/envs/production
terraform init
terraform plan \
  -var="backend_image=<ECR_URI>/vaccichain-backend:<TAG>" \
  -var="frontend_image=<ECR_URI>/vaccichain-frontend:<TAG>" \
  -var="analytics_image=<ECR_URI>/vaccichain-analytics:<TAG>"
terraform apply
```

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
