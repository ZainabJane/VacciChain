# Analytics Database Restore Procedure

This document outlines the procedure to restore the analytics database (SQLite) from an S3 backup. The backup system automatically creates daily copies of the database to S3.

## Prerequisites
- Access to the S3 bucket where backups are stored (`S3_BUCKET_NAME`).
- AWS CLI installed locally, or access to the AWS Console.
- Access to the server running the Docker containers.

## Step-by-Step Restore Guide

### 1. Identify the Backup File
First, locate the desired backup file in S3. The files are named with timestamps: `vaccichain_YYYYMMDD_HHMMSS.db`.
If using the AWS CLI:
```bash
aws s3 ls s3://<S3_BUCKET_NAME>/
```
Identify the file you want to restore (e.g., `vaccichain_20231027_000000.db`).

### 2. Download the Backup
Download the selected backup to your server:
```bash
aws s3 cp s3://<S3_BUCKET_NAME>/vaccichain_20231027_000000.db ./vaccichain.db
```

### 3. Stop the Backend Service
Before replacing the database, you must stop the `backend` service to prevent any in-memory state from overwriting the restored file.
```bash
docker compose stop backend
```

### 4. Replace the Database File
Docker volumes in this project are typically stored in the local filesystem, or managed directly by Docker.
You can replace the file within the volume using a temporary container. Run the following command from the root of your VacciChain directory:

```bash
docker run --rm -v vaccichain_db:/data -v $(pwd):/backup alpine cp /backup/vaccichain.db /data/vaccichain.db
```
*(Note: Ensure that the downloaded `vaccichain.db` is in the directory where you run this command).*

### 5. Restart the Backend Service
Once the file is replaced, restart the backend service:
```bash
docker compose start backend
```

### 6. Verify the Restore
You can verify the restore by checking the logs of the `backend` container or by accessing the analytics API endpoints to confirm the data reflects the restored backup state.
```bash
docker compose logs -f backend
```
And then checking:
`curl http://localhost:8001/analytics/rates`

## Troubleshooting
- **Database Locked / Corrupted**: Ensure the backend service is fully stopped before copying the database over. `sql.js` loads the DB entirely into memory, so live replacement will fail or cause corruption when it flushes.
- **Permissions**: Make sure the replacement database file has appropriate permissions so that the node.js backend user can read/write to it. Running the `docker run alpine cp ...` as shown above ensures it runs as root within the volume, which matches the default Docker volume behaviour.

## Terraform State Recovery Procedure

Terraform remote state is stored in an encrypted, versioned S3 bucket with a DynamoDB table providing state locking. This section documents how to recover from state loss, corruption, or a stale lock.

### Prerequisites
- AWS CLI installed and authenticated with permissions to read/write the state bucket and the lock table.
- The names of the state bucket (`TF_STATE_BUCKET`) and lock table (`TF_LOCK_TABLE`), as configured in the backend block.
- Access to the Terraform working directory and the ability to run `terraform init`.

### 1. Restore State from S3 Versioning
The state bucket has versioning enabled, so every write of `terraform.tfstate` is preserved as a new object version. To roll back to a previous version:

1. List the available versions of the state object:
   ```bash
   aws s3api list-object-versions \
     --bucket <TF_STATE_BUCKET> \
     --prefix terraform.tfstate \
     --query 'Versions[*].[VersionId,LastModified,IsLatest]' \
     --output table
   ```
2. Identify the `VersionId` of the last known-good state (the version immediately before the corruption or bad apply).
3. Download that version and inspect it before restoring:
   ```bash
   aws s3api get-object \
     --bucket <TF_STATE_BUCKET> \
     --key terraform.tfstate \
     --version-id <VERSION_ID> \
     ./terraform.tfstate.recovered
   ```
4. Copy the recovered file back as the current state object:
   ```bash
   aws s3 cp ./terraform.tfstate.recovered \
     s3://<TF_STATE_BUCKET>/terraform.tfstate
   ```
   This creates a new object version, so the previous (corrupt) state remains recoverable.

### 2. Recover from a Stale Lock in DynamoDB
If a `terraform apply` or `plan` is interrupted, the lock entry in DynamoDB may remain, causing `Error acquiring the state lock`. Only clear a lock after confirming no Terraform process is actively running.

1. Inspect the lock entry:
   ```bash
   aws dynamodb get-item \
     --table-name <TF_LOCK_TABLE> \
     --key '{"LockID": {"S": "<TF_STATE_BUCKET>/terraform.tfstate"}}'
   ```
2. Verify the `Info` field (who holds the lock, when it was created) to confirm it is stale.
3. Remove the stale lock entry:
   ```bash
   aws dynamodb delete-item \
     --table-name <TF_LOCK_TABLE> \
     --key '{"LockID": {"S": "<TF_STATE_BUCKET>/terraform.tfstate"}}'
   ```
   Alternatively, if the original process is still reachable, use `terraform force-unlock <LOCK_ID>` with the ID reported in the error message.

### 3. Verify State Integrity After Restore
After restoring state, confirm it matches the real infrastructure before making any changes:

1. Re-initialize the backend to pick up the restored state:
   ```bash
   terraform init -reconfigure
   ```
2. Validate the state file is well-formed and consistent:
   ```bash
   terraform validate
   terraform state list
   ```
3. Run a plan with no changes expected. A clean plan (no unexpected creates/destroys) confirms the restored state matches reality:
   ```bash
   terraform plan -detailed-exitcode
   ```
   Exit code `0` means no changes; `2` means drift was detected and must be reviewed before applying.
4. Optionally, compare resource counts against the pre-incident inventory to confirm nothing is missing.

### 4. Testing the Recovery Process
Recovery procedures must be exercised regularly (at least quarterly) so they are known to work:

1. In a non-production environment, make a trivial change and apply it to create a new state version.
2. Simulate corruption by restoring an older state version using the steps in section 1.
3. Confirm `terraform plan` reports the expected drift, then re-apply to reconcile.
4. Simulate a stale lock by manually inserting a lock item into the DynamoDB table, then follow section 2 to clear it.
5. Record the results (date, environment, outcome, issues found) and update this document if any step needs correction.
