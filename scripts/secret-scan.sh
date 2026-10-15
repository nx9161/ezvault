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
if grep -rEn "(AKIA[0-9A-Z]{16}|xox[bap]-|sk-live-|ghp_[A-Za-z0-9]{20,})" app lib components scripts --include='*.ts' --include='*.tsx' --include='*.mjs' --include='*.sh' 2>/dev/null; then
  echo "secret-scan: FAIL — credential-like pattern found in source"
  fail=1
fi

if [ "$fail" -ne 0 ]; then exit 1; fi
echo "secret-scan: OK"
