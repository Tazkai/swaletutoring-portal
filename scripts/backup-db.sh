#!/usr/bin/env bash
# Consistent SQLite snapshot for restic. Run at 02:45, before the 03:00 restic job.
# restic copying the live database file can capture a torn, unrestorable copy;
# `.backup` takes a consistent snapshot even while the app is writing.
set -euo pipefail

DB=${DB_PATH:-/srv/portal/data/portal.db}
DIR=/srv/portal/backup
OUT="$DIR/portal-$(date +%F).db"

sqlite3 "$DB" ".backup '$OUT.tmp'"
# Refuse to keep a snapshot that fails SQLite's own check.
if [ "$(sqlite3 "$OUT.tmp" 'PRAGMA integrity_check;')" != "ok" ]; then
  echo "backup-db: integrity check FAILED for $OUT.tmp" >&2
  exit 1
fi
mv "$OUT.tmp" "$OUT"
chmod 640 "$OUT"
find "$DIR" -name 'portal-*.db' -mtime +14 -delete
