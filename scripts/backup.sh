#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_DIR="$ROOT_DIR/backups"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"

if [ -d "$ROOT_DIR/uploads" ]; then
  tar -czf "$BACKUP_DIR/uploads-$TIMESTAMP.tar.gz" -C "$ROOT_DIR" uploads
fi

if command -v docker >/dev/null 2>&1; then
  docker exec axel-messenger-postgres pg_dump -U messenger messenger > "$BACKUP_DIR/db-$TIMESTAMP.sql"
fi

echo "Backup created in $BACKUP_DIR"
