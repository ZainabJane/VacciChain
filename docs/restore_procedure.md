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

## Retention and Purge Interaction with Recovery

Automated retention/purge jobs run on a schedule and delete off-chain data that has exceeded its retention period (see the data retention policy for data classes and periods). These jobs must **never** delete records required for recovery or audit.

### Protected Records
The following records are exempt from automated purge and must survive any retention job:
- **Recovery checkpoints**: backup manifests, restore checkpoints, and the metadata needed to identify and validate a backup (e.g. `vaccichain_YYYYMMDD_HHMMSS.db` entries and their checksums).
- **Audit logs**: entries required for compliance and audit trails, which are retained per the audit retention period and are not subject to the standard operational purge.
- **Backup catalog records**: the index of available backups in S3, which is needed to locate a restore point.

Purge jobs must filter these classes out explicitly (by data class / table) rather than relying on age alone, so that a restore point is always available even after a purge cycle.

### Verifying Recovery Records Survive a Purge
Before relying on a backup for recovery, confirm that the retention jobs have not removed the records needed to restore:

1. List the available backups and confirm the expected restore point is still present:
   ```bash
   aws s3 ls s3://<S3_BUCKET_NAME>/
   ```
2. Check the backend logs for the most recent retention/purge run and confirm it reports zero deletions of protected classes (recovery checkpoints, audit logs, backup catalog):
   ```bash
   docker compose logs backend | grep -i purge
   ```
3. Query the backup catalog / checkpoint table to confirm the restore point metadata (timestamp, checksum) is intact:
   ```bash
   docker compose exec backend node -e "/* query checkpoint table and print rows */"
   ```
4. If any protected record is missing, do **not** proceed with the restore using that backup; select an older backup that still has intact checkpoint metadata, or escalate before continuing.

## Troubleshooting
- **Database Locked / Corrupted**: Ensure the backend service is fully stopped before copying the database over. `sql.js` loads the DB entirely into memory, so live replacement will fail or cause corruption when it flushes.
- **Permissions**: Make sure the replacement database file has appropriate permissions so that the node.js backend user can read/write to it. Running the `docker run alpine cp ...` as shown above ensures it runs as root within the volume, which matches the default Docker volume behaviour.
- **Missing Restore Point After Purge**: If the expected backup or its checkpoint metadata is gone, a retention job may have deleted a protected record. Restore from the most recent backup with intact checkpoint metadata and file a bug against the purge job's data-class filters.
