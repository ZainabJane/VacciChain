# Setting Up Staging Environment on AWS

This guide walks through setting up the staging environment on AWS ECS.

## Prerequisites

- AWS Account with appropriate permissions
- AWS CLI configured
- Docker installed locally
- GitHub repository with deploy-staging.yml workflow
- Terraform >= 1.5 installed locally
- A dedicated staging AWS account (or at minimum a dedicated staging state bucket and IAM boundary) that is separate from production

## Step 0: Configure Terraform Backend (Staging)

Terraform state for staging must live in its own bucket and key, never in the production backend. All values below are explicit per environment; nothing is hardcoded in the Terraform configuration.

### 0.1 Create the staging state bucket

```bash
# Set these explicitly for the staging environment
export TF_ENV=staging
export AWS_ACCOUNT_ID_STAGING=<staging-account-id>
export AWS_REGION_STAGING=<staging-region>
export TF_STATE_BUCKET_STAGING=vaccichain-tfstate-${TF_ENV}-${AWS_ACCOUNT_ID_STAGING}
export TF_STATE_KEY_STAGING=vaccichain/${TF_ENV}/terraform.tfstate

# Create a versioned, encrypted, private state bucket
aws s3api create-bucket \
  --bucket "$TF_STATE_BUCKET_STAGING" \
  --region "$AWS_REGION_STAGING" \
  $( [ "$AWS_REGION_STAGING" != "us-east-1" ] && echo "--create-bucket-configuration LocationConstraint=$AWS_REGION_STAGING" )

aws s3api put-bucket-versioning \
  --bucket "$TF_STATE_BUCKET_STAGING" \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket "$TF_STATE_BUCKET_STAGING" \
  --server-side-encryption-configuration '{
    "Rules": [{
      "ApplyServerSideEncryptionByDefault": {
        "SSEAlgorithm": "aws:kms"
      },
      "BucketKeyEnabled": true
    }]
  }'

aws s3api put-public-access-block \
  --bucket "$TF_STATE_BUCKET_STAGING" \
  --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
```

### 0.2 Provide backend configuration via a per-environment file

Do not commit state credentials or account-specific values. Supply them through a `backend.hcl` file (git-ignored) or `-backend-config` flags:

```bash
# staging/backend.hcl (git-ignored, generated per environment)
cat > staging/backend.hcl << EOF
bucket         = "${TF_STATE_BUCKET_STAGING}"
key            = "${TF_STATE_KEY_STAGING}"
region         = "${AWS_REGION_STAGING}"
encrypt        = true
use_lockfile   = true
EOF

# Initialize with the staging backend explicitly
terraform init -backend-config=staging/backend.hcl -reconfigure
```

State access credentials come from the standard AWS credential chain (OIDC role in CI, SSO/profile locally). Never place access keys in `backend.hcl` or in the Terraform configuration.

### 0.3 Validate staging isolation from production

Run these checks before planning. They fail fast if the staging backend points at production state.

```bash
# Confirm the resolved backend is the staging bucket/key
terraform init -backend-config=staging/backend.hcl -reconfigure -input=false
terraform state pull | jq -r '.backend.config.bucket, .backend.config.key'

# Assert the bucket and key match the staging values
test "$(terraform state pull | jq -r '.backend.config.bucket')" = "$TF_STATE_BUCKET_STAGING" \
  || { echo "ERROR: staging backend bucket mismatch"; exit 1; }
test "$(terraform state pull | jq -r '.backend.config.key')" = "$TF_STATE_KEY_STAGING" \
  || { echo "ERROR: staging backend key mismatch"; exit 1; }

# Confirm the AWS account/region in use is staging, not production
test "$(aws sts get-caller-identity --query Account --output text)" = "$AWS_ACCOUNT_ID_STAGING" \
  || { echo "ERROR: not authenticated to the staging account"; exit 1; }
test "$(aws configure get region)" = "$AWS_REGION_STAGING" \
  || { echo "ERROR: AWS region is not the staging region"; exit 1; }

# A clean staging plan must succeed without touching production state
terraform plan -var-file=staging/staging.tfvars -out=staging.tfplan
```

If any check fails, stop and correct the backend configuration before proceeding.

## Step 1: Create IAM Roles

### ECS Task Execution Role

```bash
# Create trust policy
cat > trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Service": "ecs-tasks.amazonaws.com"
      },
      "Action": "sts:AssumeRole"
    }
  ]
}
EOF

# Create role
aws iam create-role \
  --role-name ecsTaskExecutionRole \
  --assume-role-policy-document file://trust-policy.json

# Attach policy
aws iam attach-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy

# Add Secrets Manager permissions
aws iam put-role-policy \
  --role-name ecsTaskExecutionRole \
  --policy-name SecretsManagerAccess \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret"
        ],
        "Resource": "arn:aws:secretsmanager:*:*:secret:vaccichain/staging/*"
      }
    ]
  }'
```

### ECS Task Role

```bash
# Create task role
aws iam create-role \
  --role-name vaccichain-staging-task-role \
  --assume-role-policy-document file://trust-policy.json

# Add permissions for backend to access Secrets Manager
aws iam put-role-policy \
  --role-name vaccichain-staging-task-role \
  --policy-name BackendPermissions \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "secretsmanager:GetSecretValue"
        ],
        "Resource": "arn:aws:secretsmanager:*:*:secret:vaccichain/staging/*"
      }
    ]
  }'
```

## Step 2: Create ECR Repositories

```bash
# Create repositories
aws ecr create-repository --repository-name vaccichain-backend
aws ecr create-repository --repository-name vaccichain-frontend
aws ecr create-repository --repository-name vaccichain-python

# Enable image scanning
for repo in vaccichain-backend vaccichain-frontend vaccichain-python; do
  aws ecr put-image-scanning-configuration \
    --repository-name $repo \
    --image-scanning-configuration scanOnPush=true
done
```

## Step 3: Create Secrets in Secrets Manager

```bash
# Create staging secrets
aws secretsmanager create-secret \
  --name vaccichain/staging/stellar \
  --secret-string '{
    "VACCINATIONS_CONTRACT_ID": "C...",
    "ADMIN_SECRET_KEY": "S...",
    "ADMIN_PUBLIC_KEY": "G...",
    "SEP10_SERVER_KEY": "S...",
    "ISSUER_SECRET_KEY": "S...",
    "JWT_SECRET": "your-jwt-secret-min-32-chars"
  }'
```

## Step 4: Create ECS Cluster

```bash
# Create cluster
aws ecs create-cluster --cluster-name vaccichain-staging

# Create CloudWatch log group
aws logs create-log-group --log-group-name /ecs/vaccichain-staging
```

## Step 5: Register Task Definition

```bash
# Substitute the staging account ID and region from the environment variables
# defined in Step 0 (never hardcode production values here)
sed -i "s/ACCOUNT_ID/${AWS_ACCOUNT_ID_STAGING}/g" staging/task-definition-backend.json
sed -i "s/REGION/${AWS_REGION_STAGING}/g" staging/task-definition-backend.json

# Register task definition
aws ecs register-task-definition \
  --cli-input-json file://staging/task-definition-backend.json
```

## Step 6: Create ECS Service

```bash
# Create service
aws ecs create-service \
  --cluster vaccichain-staging \
  --service-name vaccichain-staging \
  --task-definition vaccichain-staging:1 \
  --desired-count 1 \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=ENABLED}" \
  --load-balancers targetGroupArn=arn:aws:elasticloadbalancing:...,containerName=frontend,containerPort=80
```

## Step 7: Configure GitHub Environments and Secrets

Staging and production must be isolated. Do **not** use repository-level secrets for
deployment credentials — use two separate GitHub Environments (`staging` and
`production`) with their own scoped secrets, so a staging run can never reach
mainnet resources.

### Create the environments

```bash
# Create both environments (requires the gh CLI authenticated with admin rights)
gh api --method PUT repos/your-org/VacciChain/environments/staging
gh api --method PUT repos/your-org/VacciChain/environments/production
```

### Staging environment secrets

```bash
# AWS role for GitHub Actions (staging account/role only)
gh secret set AWS_ROLE_TO_ASSUME_STAGING --env staging --body "arn:aws:iam::123456789012:role/GitHubActionsRoleStaging"

# AWS region
gh secret set AWS_REGION --env staging --body "us-east-1"

# Staging-only Stellar/mainnet guard values (testnet contract, testnet issuer)
gh secret set STELLAR_NETWORK --env staging --body "testnet"
```

### Production environment secrets

```bash
# Production uses a *different* role scoped to the production account
gh secret set AWS_ROLE_TO_ASSUME_PRODUCTION --env production --body "arn:aws:iam::987654321098:role/GitHubActionsRoleProduction"

gh secret set AWS_REGION --env production --body "us-east-1"

# Production-only mainnet values
gh secret set STELLAR_NETWORK --env production --body "mainnet"
```

### Require reviewers for production

Production deployments must be deliberately approved. Configure required reviewers
(and optionally a wait timer) on the `production` environment:

```bash
# Require at least one reviewer from the release team before a production job runs
gh api --method PUT repos/your-org/VacciChain/environments/production \
  -f 'reviewers[][type]=User' \
  -f 'reviewers[][id]=<GITHUB_USER_ID>' \
  -f 'deployment_branch_policy[protected_branches]=true' \
  -f 'deployment_branch_policy[custom_branch_policies]=false'

# Optional: 10-minute wait timer as a second safety gate
gh api --method PUT repos/your-org/VacciChain/environments/production \
  -F 'wait_timer=10'
```

The `deployment_branch_policy` above restricts the `production` environment to
protected branches only, so a production job cannot be triggered from an
arbitrary branch.

### Policy guard: block unapproved production deploys

Add a guard job (or reusable workflow) that runs before any production deploy and
fails unless the event and branch are explicitly approved. Example
`.github/workflows/deploy-production.yml` guard:

```yaml
jobs:
  production-guard:
    runs-on: ubuntu-latest
    steps:
      - name: Enforce production deploy policy
        run: |
          set -euo pipefail
          # Only allow manual dispatch or a push to main
          if [[ "${{ github.event_name }}" != "workflow_dispatch" && \
                "${{ github.event_name }}" != "push" ]]; then
            echo "::error::Production deploys are only allowed via workflow_dispatch or push to main (got ${{ github.event_name }})"
            exit 1
          fi
          if [[ "${{ github.ref }}" != "refs/heads/main" ]]; then
            echo "::error::Production deploys are only allowed from refs/heads/main (got ${{ github.ref }})"
            exit 1
          fi
          # Staging must never target mainnet
          if [[ "${{ secrets.STELLAR_NETWORK }}" == "mainnet" && "${{ github.ref }}" != "refs/heads/main" ]]; then
            echo "::error::Mainnet resources are only reachable from the production environment on main"
            exit 1
          fi

  deploy-production:
    needs: production-guard
    runs-on: ubuntu-latest
    environment: production   # required reviewers + protected-branch policy apply here
    steps:
      - uses: actions/checkout@v4
      - name: Deploy
        run: ./scripts/deploy-production.sh
```

Because the `deploy-production` job declares `environment: production`, GitHub
will not start it until the required reviewers approve, and the environment's
branch policy will reject any ref other than a protected branch. The guard job
adds an explicit event/branch check so unapproved events fail fast.

## Step 8: Create GitHub Actions Role

```bash
# Create trust policy for GitHub
cat > github-trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::${AWS_ACCOUNT_ID_STAGING}:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:your-org/VacciChain:*"
        }
      }
    }
  ]
}
EOF

# Create role
aws iam create-role \
  --role-name GitHubActionsRole \
  --assume-role-policy-document file://github-trust-policy.json

# Add permissions
aws iam put-role-policy \
  --role-name GitHubActionsRole \
  --policy-name ECSDeployment \
  --policy-document '{
    "Version": "2012-10-17",
    "Statement": [
      {
        "Effect": "Allow",
        "Action": [
          "ecr:GetAuthorizationToken",
          "ecr:BatchGetImage",
          "ecr:GetDownloadUrlForLayer",
          "ecr:PutImage",
          "ecr:InitiateLayerUpload",
          "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload"
        ],
        "Resource": "*"
      },
      {
        "Effect": "Allow",
        "Action": [
          "ecs:UpdateService",
          "ecs:DescribeServices",
          "ecs:DescribeTaskDefinition",
          "ecs:DescribeTasks",
          "ecs:ListTasks",
          "ecs:RegisterTaskDefinition"
        ],
        "Resource": "*"
      },
      {
        "Effect": "Allow",
        "Action": [
          "s3:ListBucket",
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ],
        "Resource": [
          "arn:aws:s3:::${TF_STATE_BUCKET_STAGING}",
          "arn:aws:s3:::${TF_STATE_BUCKET_STAGING}/${TF_STATE_KEY_STAGING}*"
        ]
      }
    ]
  }'
```

The S3 permissions are scoped to the staging state bucket only, so CI cannot read or modify production state.

## Step 9: Set Up Load Balancer (Optional)

```bash
# Create Application Load Balancer
aws elbv2 create-load-balancer \
  --name vaccichain-staging-alb \
  --subnets subnet-xxx subnet-yyy \
  --security-groups sg-xxx

# Create target group
aws elbv2 create-target-group \
  --name vaccichain-staging-tg \
  --protocol HTTP \
  --port 80 \
  --vpc-id vpc-xxx \
  --target-type ip

# Create listener
aws elbv2 create-listener \
  --load-balancer-arn arn:aws:elasticloadbalancing:... \
  --protocol HTTP \
  --port 80 \
  --default-actions Type=forward,TargetGroupArn=arn:aws:elasticloadbalancing:...
```

## Step 10: Test Deployment

```bash
# Trigger deployment
gh workflow run deploy-staging.yml

# Monitor deployment
gh run list --workflow=deploy-staging.yml

# Check service status
aws ecs describe-services \
  --cluster vaccichain-staging \
  --services vaccichain-staging
```

## Verification

```bash
# Get service URL
aws elbv2 describe-load-balancers \
  --names vaccichain-staging-alb \
  --query 'LoadBalancers[0].DNSName'

# Test health endpoint
curl http://<ALB-DNS>/health

# View logs
aws logs tail /ecs/vaccichain-staging --follow
```

## Cleanup

To remove staging environment:

```bash
# Delete service
aws ecs delete-service \
  --cluster vaccichain-staging \
  --service vaccichain-staging \
  --force

# Delete cluster
aws ecs delete-cluster --cluster vaccichain-staging

# Delete ECR repositories
for repo in vaccichain-backend vaccichain-frontend vaccichain-python; do
  aws ecr delete-repository --repository-name $repo --force
done

# Delete secrets
aws secretsmanager delete-secret \
  --secret-id vaccichain/staging/stellar \
  --force-delete-without-recovery

# Delete IAM roles
aws iam delete-role-policy --role-name ecsTaskExecutionRole --policy-name SecretsManagerAccess
aws iam detach-role-policy --role-name ecsTaskExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam delete-role --role-name ecsTaskExecutionRole
aws iam delete-role-policy --role-name vaccichain-staging-task-role --policy-name BackendPermissions
aws iam delete-role --role-name vaccichain-staging-task-role
```

## References

- [AWS ECS Getting Started](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/getting-started.html)
- [GitHub Actions OIDC](https://docs.github.com/en/actions/deployment/security-hardening-your-deployments/about-security-hardening-with-openid-connect)
- [Terraform S3 Backend](https://developer.hashicorp.com/terraform/language/backend/s3)
- [Terraform Backend Configuration](https://developer.hashicorp.com/terraform/language/backend#partial-configuration)
