#!/bin/sh

echo "Setting up test environment..."

# Setup mock AWS CLI
mkdir -p /tmp/mock_bin
cat << 'EOF' > /tmp/mock_bin/aws
#!/bin/sh
if [ "$1" = "s3" ] && [ "$2" = "cp" ]; then
  # Simulate upload failure when MOCK_CP_FAIL is set
  if [ -n "$MOCK_CP_FAIL" ]; then
    echo "Mock upload failure for $3" >&2
    exit 1
  fi
  echo "Mock upload $3 to $4"
  echo "$4" >> /tmp/mock_s3_uploads.txt
elif [ "$1" = "s3" ] && [ "$2" = "ls" ]; then
  # Return some fake files
  echo "2023-01-01 12:00:00 1234 vaccichain_20200101_000000.db"
  echo "2023-01-01 12:00:00 1234 vaccichain_20230101_000000.db"
  echo "2023-01-01 12:00:00 1234 vaccichain_20990101_000000.db"
elif [ "$1" = "s3" ] && [ "$2" = "rm" ]; then
  echo "Mock delete $3"
  echo "$3" >> /tmp/mock_s3_deletes.txt
fi
EOF
chmod +x /tmp/mock_bin/aws

# Ensure we use our mock `aws`
export PATH="/tmp/mock_bin:$PATH"

# Set necessary environment variables
export S3_BUCKET_NAME="my-test-bucket"
export RETENTION_DAYS=30
export BACKUP_METRICS_FILE="/tmp/backup_metrics.prom"

# Create dummy DB file
mkdir -p /tmp/data
touch /tmp/data/vaccichain.db
export DB_FILE_PATH="/tmp/data/vaccichain.db"

echo "Running backup.sh..."
# Run the script
./backup.sh
BACKUP_EXIT=$?

echo "Asserting backup succeeded..."
if [ "$BACKUP_EXIT" -ne 0 ]; then
  echo "❌ Test failed: backup.sh exited non-zero on success path ($BACKUP_EXIT)."
  exit 1
else
  echo "✅ Backup completed successfully."
fi

echo "Asserting integrity validation ran..."
if grep -q "vaccichain_" /tmp/mock_s3_uploads.txt; then
  echo "✅ Backup archive was uploaded for integrity validation."
else
  echo "❌ Test failed: no backup archive uploaded."
  exit 1
fi

echo "Asserting success metrics emitted..."
if [ -f "$BACKUP_METRICS_FILE" ] && grep -q "backup_success=1" "$BACKUP_METRICS_FILE"; then
  echo "✅ Success metric backup_success=1 emitted."
else
  echo "❌ Test failed: success metric not emitted."
  exit 1
fi

# Verify
echo "Asserting deletions..."
if grep -q "vaccichain_20200101_000000.db" /tmp/mock_s3_deletes.txt && grep -q "vaccichain_20230101_000000.db" /tmp/mock_s3_deletes.txt; then
  echo "✅ Old files deleted successfully."
else
  echo "❌ Test failed: old files were not deleted."
  exit 1
fi

if grep -q "vaccichain_20990101_000000.db" /tmp/mock_s3_deletes.txt; then
  echo "❌ Test failed: new file was deleted incorrectly."
  exit 1
else
  echo "✅ New file correctly retained."
fi

echo "Testing failure path: upload failure..."
rm -f /tmp/mock_s3_uploads.txt "$BACKUP_METRICS_FILE"
export MOCK_CP_FAIL=1
./backup.sh
FAIL_EXIT=$?
unset MOCK_CP_FAIL

if [ "$FAIL_EXIT" -eq 0 ]; then
  echo "❌ Test failed: backup.sh exited zero on upload failure."
  exit 1
else
  echo "✅ Backup exited non-zero on upload failure."
fi

if [ -f "$BACKUP_METRICS_FILE" ] && grep -q "backup_success=0" "$BACKUP_METRICS_FILE"; then
  echo "✅ Failure metric backup_success=0 emitted."
else
  echo "❌ Test failed: failure metric not emitted."
  exit 1
fi

echo "Testing failure path: integrity validation failure..."
rm -f /tmp/mock_s3_uploads.txt "$BACKUP_METRICS_FILE"
# Corrupt the DB file so checksum/readability validation fails
echo "corrupt" > /tmp/data/vaccichain.db
export MOCK_INTEGRITY_FAIL=1
./backup.sh
INTEGRITY_EXIT=$?
unset MOCK_INTEGRITY_FAIL

if [ "$INTEGRITY_EXIT" -eq 0 ]; then
  echo "❌ Test failed: backup.sh exited zero on integrity validation failure."
  exit 1
else
  echo "✅ Backup exited non-zero on integrity validation failure."
fi

if [ -f "$BACKUP_METRICS_FILE" ] && grep -q "backup_success=0" "$BACKUP_METRICS_FILE"; then
  echo "✅ Integrity failure metric backup_success=0 emitted."
else
  echo "❌ Test failed: integrity failure metric not emitted."
  exit 1
fi

# Cleanup
rm -rf /tmp/mock_bin /tmp/data /tmp/mock_s3_deletes.txt /tmp/mock_s3_uploads.txt "$BACKUP_METRICS_FILE"
echo "✅ All tests passed successfully!"
