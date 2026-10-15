#!/usr/bin/env bash
# SPDX-License-Identifier: MIT
# secret-scan.sh — fail the build if secret-looking values or env files are committed.
set -euo pipefail

fail=0

# 1. No .env files (other than .env.example) may be tracked or present in a committable state.
if git ls-files | grep -E '(^|/)\.env(\.|$)' | grep -v '^\.env\.example$' | grep -v '^.env.example$' ; then
  echo "secret-scan: FAIL — .env files tracked (only .env.example is allowed)"
  fail=1
fi
for f in .env .env.local .env.production .env.development; do
  if [ -f "$f" ]; then
    echo "secret-scan: FAIL — $f present in repo root"
    fail=1
  fi
done

# 2. .gitignore must cover env files and backups.
for rule in '.env*' 'backups/'; do
  if ! grep -qF "$rule" .gitignore; then
    echo "secret-scan: FAIL — .gitignore missing rule: $rule"
    fail=1
  fi
done

# 3. No process.env interpolation in client-boundary files (checked by tsc/eslint later;
#    here: crude scan for NEXT_PUBLIC_ secrets).
if grep -rn "NEXT_PUBLIC_.*\(KEY\|SECRET\|TOKEN\|PASSWORD\)" app components lib --include='*.ts' --include='*.tsx' 2>/dev/null | grep -v node_modules; then
  echo "secret-scan: FAIL — NEXT_PUBLIC_ secret-looking variable referenced"
  fail=1
fi

# 4. No high-entropy long strings that look like pasted credentials in source.
# (excludes this script itself — its pattern literal is the detector, not a secret)
if grep -rEn "(AKIA[0-9A-Z]{16}|xox[bap]-|sk-live-|ghp_[A-Za-z0-9]{20,})" app lib components scripts --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.sh' --exclude='secret-scan.sh' 2>/dev/null; then
  echo "secret-scan: FAIL — credential-like pattern found in source"
  fail=1
fi

# 5. B19: lib/db MUST import 'server-only' first (database access is
#    server-only by construction) and must never reach client bundles.
if ! grep -q "^import 'server-only';" lib/db/index.ts; then
  echo "secret-scan: FAIL — lib/db/index.ts does not start with import 'server-only'"
  fail=1
fi
# Any lib/ module (outside lib/db/) that imports lib/db directly must itself
# be server-only. app/api/** route handlers are server-only by Next
# construction (never shipped to clients), so they are exempt.
for f in $(grep -rln "lib/db/index\.js\|@/lib/db" lib --include='*.ts' --include='*.tsx' 2>/dev/null); do
  case "$f" in
    lib/db/*) continue ;;
  esac
  if ! grep -q "import 'server-only'" "$f"; then
    echo "secret-scan: FAIL — $f imports lib/db but has no import 'server-only'"
    fail=1
  fi
done

# 6. B19: no raw process.env in client-boundary files. lib/db/index.ts is the
#    only source of DATABASE_URL; storage drivers read their env via
#    lib/storage/env.ts (server-only). components/ + app/page-level client
#    files must not touch process.env at all.
if grep -rn "process\.env" components/ lib/store/ lib/commands/ lib/viewer/ messages/ --include='*.ts' --include='*.tsx' 2>/dev/null; then
  echo "secret-scan: FAIL — process.env in client-boundary files"
  fail=1
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "secret-scan: OK"
