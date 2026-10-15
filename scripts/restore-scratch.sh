#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# scripts/restore-scratch.sh — restore a monthly backup to a SCRATCH database
# and verify it. Locally testable. NEVER point SCRATCH_DATABASE_URL at live:
# the restore uses --clean and will drop the target's tables.
#
# Usage:
#   SCRATCH_DATABASE_URL=postgres://... RESTORE_TARGET_ACK=1 \
#     RESTORE_DUMP=/path/to/restore.dump scripts/restore-scratch.sh
#   # or straight from an encrypted payload (same openssl flags as
#   # docs/RUNBOOK.md "Restoring a monthly backup"; DATA_KEY via env only,
#   # never written to disk; the temp plaintext is shredded on exit):
#   SCRATCH_DATABASE_URL=postgres://... RESTORE_TARGET_ACK=1 \
#     RESTORE_DUMP_ENC=/path/to/ezvault-<stamp>-<uuid>.dump.enc \
#     DATA_KEY=<64-hex> scripts/restore-scratch.sh
#
# Steps: 1) optional decrypt 2) pg_restore --clean --if-exists to scratch
#        3) verify: dump holds 20+ tables (same bar as backup-monthly.yml),
#           core tables readable with row counts on the scratch target.
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage:
  SCRATCH_DATABASE_URL=<url> RESTORE_TARGET_ACK=1 RESTORE_DUMP=<file> scripts/restore-scratch.sh
  SCRATCH_DATABASE_URL=<url> RESTORE_TARGET_ACK=1 RESTORE_DUMP_ENC=<file.enc> DATA_KEY=<hex> scripts/restore-scratch.sh

env:
  SCRATCH_DATABASE_URL  scratch postgres URL (NEVER live — the restore drops target tables)
  RESTORE_TARGET_ACK    must be "1": confirms the target is a scratch database
  RESTORE_DUMP          decrypted custom-format dump (from RUNBOOK step 3), OR
  RESTORE_DUMP_ENC      encrypted .dump.enc payload + DATA_KEY (per-backup data key, env only)
EOF
  exit 2
}

[[ "${SCRATCH_DATABASE_URL:-}" ]] || { echo "restore-scratch: SCRATCH_DATABASE_URL is required" >&2; usage; }
[[ "${RESTORE_TARGET_ACK:-}" == "1" ]] || {
  echo "restore-scratch: refusing without RESTORE_TARGET_ACK=1 (confirm the target is a scratch database, never live)" >&2
  exit 2
}

for tool in pg_restore psql openssl; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "restore-scratch: required tool '$tool' not found (postgresql-client + openssl)" >&2
    exit 2
  }
done

DUMP="${RESTORE_DUMP:-}"
CLEANUP_TMP=""
if [[ -z "$DUMP" ]]; then
  [[ "${RESTORE_DUMP_ENC:-}" ]] || { echo "restore-scratch: set RESTORE_DUMP or RESTORE_DUMP_ENC" >&2; usage; }
  [[ "${DATA_KEY:-}" ]] || { echo "restore-scratch: DATA_KEY is required to decrypt RESTORE_DUMP_ENC" >&2; usage; }
  [[ -f "$RESTORE_DUMP_ENC" ]] || { echo "restore-scratch: not found: $RESTORE_DUMP_ENC" >&2; exit 2; }
  DUMP="$(mktemp /tmp/ezvault-restore-XXXXXX.dump)"
  CLEANUP_TMP="$DUMP"
  trap 'shred -u "$CLEANUP_TMP" 2>/dev/null || rm -f "$CLEANUP_TMP"' EXIT
  # Same flags as docs/RUNBOOK.md step 3 (matches backup-monthly.yml's encrypt).
  openssl enc -d -aes-256-cbc -pbkdf2 -pass env:DATA_KEY -in "$RESTORE_DUMP_ENC" -out "$DUMP"
  echo "restore-scratch: decrypted payload to a temp file (shredded on exit)" >&2
else
  [[ -f "$DUMP" ]] || { echo "restore-scratch: not found: $DUMP" >&2; exit 2; }
fi

echo "restore-scratch: restoring to scratch target (--clean --if-exists)…" >&2
pg_restore --format=custom --no-owner --clean --if-exists -d "$SCRATCH_DATABASE_URL" "$DUMP"

tables="$(pg_restore --list "$DUMP" | grep -c '^;.* TABLE ' || true)"
echo "restore-scratch: dump contains $tables table entries" >&2
if [[ "$tables" -lt 20 ]]; then
  echo "restore-scratch: FAIL — expected 20+ table entries (backup-monthly.yml bar)" >&2
  exit 1
fi

echo "restore-scratch: core table row counts on the scratch target:" >&2
psql "$SCRATCH_DATABASE_URL" -X -q -c \
  "SELECT 'subjects' AS t, COUNT(*)::int AS c FROM subjects UNION ALL SELECT 'photos', COUNT(*) FROM photos UNION ALL SELECT 'notes', COUNT(*) FROM notes UNION ALL SELECT 'import_jobs', COUNT(*) FROM import_jobs ORDER BY t;"

echo "restore-scratch: OK" >&2
