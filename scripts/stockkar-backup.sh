#!/usr/bin/env bash
set -euo pipefail

DATA_DIR="${STOCKKAR_DATA_DIR:-/home/ubuntu/stockkar-data}"
BACKUP_DIR="${STOCKKAR_BACKUP_DIR:-/home/ubuntu/stockkar-backups}"
BACKUP_BUCKET="${STOCKKAR_BACKUP_BUCKET:?STOCKKAR_BACKUP_BUCKET is required}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARCHIVE="$BACKUP_DIR/stockkar-data-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"
tar -czf "$ARCHIVE" -C "$DATA_DIR" .
aws s3 cp "$ARCHIVE" "s3://$BACKUP_BUCKET/backups/$(basename "$ARCHIVE")" --only-show-errors

# S3 lifecycle retains external backups. Keep only three local recovery copies.
ls -1t "$BACKUP_DIR"/stockkar-data-*.tar.gz 2>/dev/null | tail -n +4 | xargs -r rm -f
