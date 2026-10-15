# EZVault operational runbook

Single-user operations for the EZVault deploy. Owner-only; every step
below is destructive where marked.

## "Delete everything" (B26 crypto-shredding path)

This is the binding purge procedure: destroying `MASTER_KEY` renders
every monthly backup permanently unrecoverable (each backup's data key
was wrapped with it — without it the wrapped key cannot be unwrapped and
no `.enc` payload can be decrypted). There is no recovery afterward.

**v1.1 note:** the in-app purge now exists as
`POST /api/admin/delete-everything` — it deletes every object under the
live R2 prefixes (`originals/`, `thumbs/`, `exports/`, `uploads/`,
`tpy-staging/`) and `TRUNCATE`s every app table `CASCADE`. The request
body MUST be exactly `{"confirm":"DELETE"}` (anything else → 400), the
route is rate-limited to 3 attempts with ~1/hour refill, and the response
always discloses the 365-day backup retention (see below). The frontend
button + typed-confirm dialog wire against that endpoint shape.

What the endpoint does NOT do: destroy `MASTER_KEY` or touch the backup
bucket. Backups are retained under the 365-day lifecycle and stay
recoverable until the owner completes Steps 1–3 below — crypto-shredding
stays deliberate and manual. Do not script Steps 1–3 further without a
War Room decision.

### Step 1 — Destroy MASTER_KEY (renders all backups unrecoverable)

1. Vercel dashboard → Project → Settings → Environment Variables →
   delete `MASTER_KEY` → **redeploy** (a redeploy is required for the
   deletion to take effect on new builds).
2. GitHub repo → Settings → Secrets and variables → Actions → delete the
   `MASTER_KEY` secret. Future `backup-monthly` runs will fail at the
   encrypt step until a new key is set — that is expected.

Verification: none of the `backups/key-*.key.enc` objects in the backup
bucket can be unwrapped anymore. (There is no way to prove a negative
for the wrapped keys — this is why the key must be destroyed in BOTH
places, Vercel and GitHub.)

### Step 2 — Delete the live database

Neon dashboard → your project → delete the project (or the branch
holding EZVault data). This drops all metadata: items, photos rows,
notes, tags, lists, jobs, counters.

### Step 3 — Empty the R2 buckets

- Data bucket (`R2_BUCKET_DATA`, default `ezvault-data`): delete all
  objects (originals, thumbs, exports, staging). Cloudflare dashboard →
  R2 → bucket → bulk delete, or `rclone purge`.
- Backup bucket (`R2_BUCKET_BACKUPS`): delete all objects
  (`backups/dump.enc`, JSON-LD `.enc` payloads, `key.enc` files,
  manifests). Belt and suspenders — they are already unrecoverable
  without `MASTER_KEY`, but an empty bucket is unambiguous.

### Step 4 — Cron verifies

The nightly cron (`GET /api/cron/nightly`, guarded by `CRON_SECRET`)
is the standing verifier after a purge:

- Its staging sweep and queue tick run against the live database —
  after Step 2 the database is gone, so the cron run **fails loudly**
  (connection error), which is the expected confirmation that the live
  data is gone.
- Its counter-reconciliation pass (`storage_counters` vs photo byte
  sums) is the drift detector you run BEFORE a purge to confirm the
  backup you are about to keep (if any) matches live state.
- After the purge, revoke the cron schedule itself (Vercel →
  Project → Settings → Cron Jobs, or remove the trigger) so it stops
  alerting.

Order matters: back up anything you want to keep BEFORE Step 1 (a
plaintext export via the app's export routes), because after Step 1
there is no reading the monthly backups back — that is the point.

## Restoring a monthly backup (scratch only, never over live)

1. Download `manifest-<stamp>-<uuid>.json`, `key-<stamp>-<uuid>.key.enc`,
   and the `.enc` payload(s) from the backup bucket.
2. Set `MASTER_KEY` in your shell env (the value from Vercel/GitHub —
   never write it to disk), then unwrap the data key:
   ```bash
   openssl enc -d -aes-256-cbc -pbkdf2 -pass env:MASTER_KEY \
     -in key-<stamp>-<uuid>.key.enc | tr -d '\n' > /tmp/data.key
   ```
3. Decrypt each payload:
   ```bash
   DATA_KEY="$(cat /tmp/data.key)"; export DATA_KEY
   openssl enc -d -aes-256-cbc -pbkdf2 -pass env:DATA_KEY \
     -in ezvault-<stamp>-<uuid>.dump.enc -out restore.dump
   shred -u /tmp/data.key; unset DATA_KEY
   ```
4. Restore to a **scratch** Neon branch and verify row counts against the
   manifest before trusting it. `scripts/restore-scratch.sh` does the
   decrypt (when given the `.enc` payload + `DATA_KEY`), the
   `pg_restore --clean --if-exists`, and the verification in one step —
   it refuses to run without `RESTORE_TARGET_ACK=1` so a live target can
   never be hit by accident:
   ```bash
   # from a decrypted dump:
   SCRATCH_DATABASE_URL="$SCRATCH_DATABASE_URL" RESTORE_TARGET_ACK=1 \
     RESTORE_DUMP=restore.dump scripts/restore-scratch.sh
   # or straight from the encrypted payload (DATA_KEY via env only):
   SCRATCH_DATABASE_URL="$SCRATCH_DATABASE_URL" RESTORE_TARGET_ACK=1 \
     RESTORE_DUMP_ENC=ezvault-<stamp>-<uuid>.dump.enc \
     DATA_KEY="$(cat /tmp/data.key)" scripts/restore-scratch.sh
   shred -u /tmp/data.key
   ```
   The equivalent manual command (if you prefer it) is
   `pg_restore --format=custom --no-owner -d "$SCRATCH_DATABASE_URL" restore.dump`.
