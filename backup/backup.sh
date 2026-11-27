#!/bin/sh
set -e

# Default variables
DB_FILE=${DB_FILE_PATH:-"/data/vaccichain.db"}
BACKUP_DIR="/tmp/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="${BACKUP_DIR}/vaccichain_${TIMESTAMP}.db"
S3_BUCKET=${S3_BUCKET_NAME:-""}
RETENTION_DAYS=${RETENTION_DAYS:-30}
METRICS_FILE=${BACKUP_METRICS_FILE:-"/var/lib/node_exporter/textfile/backup.prom"}
S3_KEY="vaccichain_${TIMESTAMP}.db"

START_EPOCH=$(date +%s)

# Emit Prometheus metrics to the node_exporter textfile collector.
# Usage: emit_metrics <success 0|1> <integrity_ok 0|1> <size_bytes> <age_seconds>
emit_metrics() {
  _success=$1
  _integrity=$2
  _size=$3
  _age=$4
  _duration=$(( $(date +%s) - START_EPOCH ))

  _metrics_dir=$(dirname "$METRICS_FILE")
  mkdir -p "$_metrics_dir" 2>/dev/null || true

  # Write atomically so node_exporter never reads a partial file.
  _tmp_metrics="${METRICS_FILE}.$$"
  {
    echo "# HELP backup_success Whether the last backup job succeeded (1=success, 0=failure)."
    echo "# TYPE backup_success gauge"
    echo "backup_success ${_success}"
    echo "# HELP backup_duration_seconds Duration of the last backup job in seconds."
    echo "# TYPE backup_duration_seconds gauge"
    echo "backup_duration_seconds ${_duration}"
    echo "# HELP backup_size_bytes Size of the last backup archive in bytes."
    echo "# TYPE backup_size_bytes gauge"
    echo "backup_size_bytes ${_size}"
    echo "# HELP backup_age_seconds Age of the most recent successful backup in seconds."
    echo "# TYPE backup_age_seconds gauge"
    echo "backup_age_seconds ${_age}"
    echo "# HELP backup_integrity_ok Whether the last backup archive passed integrity checks (1=ok, 0=invalid)."
    echo "# TYPE backup_integrity_ok gauge"
    echo "backup_integrity_ok ${_integrity}"
  } > "$_tmp_metrics" && mv "$_tmp_metrics" "$METRICS_FILE" || \
    echo "Warning: could not write metrics file $METRICS_FILE"
}

# Fail the job: emit failure metrics and exit non-zero.
fail_backup() {
  echo "Error: $1"
  emit_metrics 0 0 0 0
  exit 1
}

echo "Starting backup process at $(date)..."

if [ -z "$S3_BUCKET" ]; then
  fail_backup "S3_BUCKET_NAME is not set."
fi

if [ ! -f "$DB_FILE" ]; then
  fail_backup "Database file $DB_FILE not found."
fi

mkdir -p "$BACKUP_DIR"

# 1. Create a copy of the database
echo "Creating backup of $DB_FILE..."
cp "$DB_FILE" "$BACKUP_FILE"

# 1a. Validate archive integrity
echo "Validating backup integrity..."
SOURCE_SIZE=$(wc -c < "$DB_FILE" | tr -d ' ')
BACKUP_SIZE=$(wc -c < "$BACKUP_FILE" | tr -d ' ')

if [ "$SOURCE_SIZE" != "$BACKUP_SIZE" ]; then
  fail_backup "Size mismatch: source=$SOURCE_SIZE backup=$BACKUP_SIZE"
fi

if [ "$BACKUP_SIZE" -eq 0 ]; then
  fail_backup "Backup file is empty."
fi

# Verify the copy is readable and structurally sound.
if command -v sqlite3 >/dev/null 2>&1; then
  INTEGRITY_RESULT=$(sqlite3 "$BACKUP_FILE" "PRAGMA integrity_check;" 2>&1) || \
    fail_backup "sqlite3 failed to read backup: $INTEGRITY_RESULT"
  if [ "$INTEGRITY_RESULT" != "ok" ]; then
    fail_backup "sqlite3 integrity_check failed: $INTEGRITY_RESULT"
  fi
  echo "sqlite3 integrity_check: ok"
else
  # Fallback: ensure the file is readable and has a valid SQLite header.
  if ! head -c 16 "$BACKUP_FILE" | grep -q "SQLite format 3"; then
    fail_backup "Backup does not have a valid SQLite header."
  fi
  echo "sqlite3 not available; verified SQLite header instead."
fi

# Compute SHA-256 checksum of the backup.
if command -v sha256sum >/dev/null 2>&1; then
  BACKUP_SHA256=$(sha256sum "$BACKUP_FILE" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then
  BACKUP_SHA256=$(shasum -a 256 "$BACKUP_FILE" | awk '{print $1}')
else
  fail_backup "No SHA-256 utility (sha256sum/shasum) available."
fi
echo "Backup SHA-256: $BACKUP_SHA256"

# 2. Upload to S3 with server-side encryption
echo "Uploading $BACKUP_FILE to s3://$S3_BUCKET/$S3_KEY..."
if ! aws s3 cp "$BACKUP_FILE" "s3://$S3_BUCKET/$S3_KEY" --sse AES256; then
  fail_backup "S3 upload failed."
fi

# 2a. Confirm the upload succeeded and encryption is applied
echo "Verifying uploaded object..."
if ! aws s3api head-object --bucket "$S3_BUCKET" --key "$S3_KEY" >/dev/null 2>&1; then
  fail_backup "Uploaded object s3://$S3_BUCKET/$S3_KEY not found."
fi

REMOTE_SIZE=$(aws s3api head-object --bucket "$S3_BUCKET" --key "$S3_KEY" \
  --query 'ContentLength' --output text 2>/dev/null || echo "")
if [ -n "$REMOTE_SIZE" ] && [ "$REMOTE_SIZE" != "None" ] && [ "$REMOTE_SIZE" != "$BACKUP_SIZE" ]; then
  fail_backup "Remote size mismatch: local=$BACKUP_SIZE remote=$REMOTE_SIZE"
fi

REMOTE_SSE=$(aws s3api head-object --bucket "$S3_BUCKET" --key "$S3_KEY" \
  --query 'ServerSideEncryption' --output text 2>/dev/null || echo "")
if [ "$REMOTE_SSE" != "AES256" ]; then
  fail_backup "Server-side encryption not applied (got: ${REMOTE_SSE:-none})."
fi
echo "Upload verified: size=$BACKUP_SIZE encryption=$REMOTE_SSE"

# 3. Clean up old backups on S3 (Retention policy)
# Calculate the cutoff date. We use GNU/Alpine date manipulation.
if date --help 2>&1 | grep -q "BusyBox"; then
  # Alpine/BusyBox date
  CUTOFF_DATE=$(date -d "@$(($(date +%s) - $RETENTION_DAYS * 86400))" +%Y%m%d_%H%M%S)
elif date --help 2>&1 | grep -q "GNU"; then
  # GNU date
  CUTOFF_DATE=$(date -d "${RETENTION_DAYS} days ago" +%Y%m%d_%H%M%S)
else
  # Fallback for BSD/macOS (not expected in Alpine Docker, but good practice)
  CUTOFF_DATE=$(date -v-${RETENTION_DAYS}d +%Y%m%d_%H%M%S)
fi

echo "Cleaning up backups older than $RETENTION_DAYS days (before vaccichain_${CUTOFF_DATE}.db)..."

# List files in S3 bucket and delete those older than CUTOFF_DATE
# Note: we disable set -e here because if grep finds nothing it will exit with 1
set +e
BACKUP_FILES=$(aws s3 ls "s3://$S3_BUCKET/" | awk '{print $4}' | grep '^vaccichain_.*\.db$')
set -e

if [ -n "$BACKUP_FILES" ]; then
  echo "$BACKUP_FILES" | while read -r filename; do
    # Extract timestamp from filename (vaccichain_YYYYMMDD_HHMMSS.db)
    file_timestamp=$(echo "$filename" | sed -E 's/^vaccichain_([0-9]{8}_[0-9]{6})\.db$/\1/')
    
    if [ "$file_timestamp" \< "$CUTOFF_DATE" ]; then
      echo "Deleting old backup: $filename"
      aws s3 rm "s3://$S3_BUCKET/$filename"
    fi
  done
else
  echo "No existing backups found to clean up."
fi

# 3a. Verify retention cleanup ran and the current backup is still present
echo "Verifying retention state..."
set +e
REMAINING_FILES=$(aws s3 ls "s3://$S3_BUCKET/" | awk '{print $4}' | grep '^vaccichain_.*\.db$')
set -e

if ! echo "$REMAINING_FILES" | grep -qx "$S3_KEY"; then
  fail_backup "Current backup $S3_KEY missing after retention cleanup."
fi

# Ensure no backups older than the cutoff remain.
if [ -n "$REMAINING_FILES" ]; then
  for filename in $REMAINING_FILES; do
    file_timestamp=$(echo "$filename" | sed -E 's/^vaccichain_([0-9]{8}_[0-9]{6})\.db$/\1/')
    if [ "$file_timestamp" \< "$CUTOFF_DATE" ]; then
      fail_backup "Retention cleanup failed: $filename is older than cutoff $CUTOFF_DATE."
    fi
  done
fi
echo "Retention verified."

# Clean up local temp file
rm "$BACKUP_FILE"

# Emit success metrics (age of the fresh backup is 0 seconds)
emit_metrics 1 1 "$BACKUP_SIZE" 0
echo "Backup process completed successfully."
