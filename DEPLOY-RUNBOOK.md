# EZVault deploy runbook

One sitting, start to finish, zero cost. Do the steps in order; the B7
smoke test at the end proves the protection gate is actually on.

Prereqs: the repo pushed to GitHub (`nx9161/ezvault`), and accounts on
Neon, Cloudflare, and Vercel (all free tiers).

## 1. Neon — database

1. Create a free Neon project (region closest to you).
2. Copy the Postgres connection string (the pooled one is fine — the
   app uses the HTTP driver).
3. Save it as `DATABASE_URL` for step 4.

## 2. Cloudflare R2 — buckets

1. R2 → create bucket **`ezvault-data`** (live originals, thumbs,
   exports, staging).
2. R2 → create bucket **`ezvault-backups`** (private; monthly backups;
   the `backup-monthly` workflow applies the 365-day lifecycle rule).
3. R2 → Manage API tokens → create a token with Object Read & Write on
   both buckets. Save `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`.
4. **Apply the bucket CORS policy to `ezvault-data`** (canonical copy:
   `scripts/r2-cors.xml`). The browser uploads bytes directly to R2 via
   presigned PUTs, so without CORS every upload fails in the browser with
   "Upload failed (network)" while the server side looks healthy
   (presign succeeds, no bytes ever land — this bit production on
   2026-10-21; a recreated bucket silently loses the policy, so re-apply
   after any bucket rebuild). `ExposeHeaders: ETag` is load-bearing.

   ```bash
   set -a; . ./.env.local; set +a
   MD5=$(openssl md5 -binary scripts/r2-cors.xml | openssl base64)
   # Apply (PutBucketCors):
   curl -X PUT --aws-sigv4 'aws:amz:auto:s3' \
     --user "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY" \
     -H "Content-MD5: $MD5" -H 'Content-Type: application/xml' \
     --data-binary @scripts/r2-cors.xml \
     "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com/$R2_BUCKET_DATA?cors"
   # Verify (GetBucketCors — expect the stored policy back, not
   # NoSuchCORSConfiguration):
   curl --aws-sigv4 'aws:amz:auto:s3' \
     --user "$R2_ACCESS_KEY_ID:$R2_SECRET_ACCESS_KEY" \
     "https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com/$R2_BUCKET_DATA?cors"
   ```

## 3. Apply migrations (in filename order)

```bash
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

Expect: `0001_init.sql` … `0007_cpu_window_active.sql` apply cleanly.
(Re-running is safe — migrations 0006/0007 use `IF NOT EXISTS` /
idempotent DDL patterns.)

## 4. Vercel — project

1. Import the GitHub repo.
2. **Deployment Protection ON:** Project → Settings → Deployment
   Protection → **Standard Protection** on **All Deployments**. This is
   the single-user gate — the app must never be reachable without the
   Vercel login.
3. Environment Variables (Production): paste all 8 names from
   `ENV-INVENTORY.md` (values from steps 1–2; generate `CRON_SECRET`
   with `openssl rand -base64 32` and `MASTER_KEY` with
   `openssl rand -hex 32`).
4. Build command must be **`npm run build`** (Vercel's Next.js default)
   so the `prebuild` gates run: secret scan, codec verification,
   licence check. A build that skips `prebuild` is not a valid deploy.
5. Deploy.

## 5. B7 smoke test (owner-runnable curls)

```bash
APP=https://<your-app>.vercel.app

# 1. Root must NOT serve app HTML unauthenticated — expect a redirect
#    to the Vercel login (302/307). If you get 200 with app HTML,
#    Deployment Protection is OFF: fix it (step 4.2) and redeploy.
curl -sI "$APP" | head -1

# 2. Health: with env configured, expect 200 {"status":"ok",...}.
#    (Pre-env it answers 503 {"status":"not_configured",...} — that is
#    the correct pre-configuration signal, not a failure.)
curl -s "$APP/api/health"

# 3. Health detail must never leak a stack trace or secret.
curl -s "$APP/api/health" | grep -oi "stack\|secret\|key" || echo "clean"
```

## 6. Nightly cron wiring

`vercel.json` declares the canonical schedule — daily `0 8 * * *` UTC →
`/api/cron/nightly` — but read this wrinkle before relying on it:

> **Vercel Cron cannot send custom headers.** The nightly route requires
> `Authorization: Bearer $CRON_SECRET` and 401s without it, so a
> Vercel-Cron-fired call fails closed. The binding trigger is the
> `.github/workflows/nightly-cron.yml` workflow, which calls the route
> with the Bearer header (plus the Deployment Protection bypass
> header). Set its repo secrets: `APP_URL`, `CRON_SECRET`,
> `VERCEL_BYPASS` (Project → Settings → Deployment Protection →
> protection bypass secret).

Owner decision (not implemented): if you would rather have Vercel Cron
call the route directly, the alternative is accepting the secret as a
query parameter — that widens the secret's exposure surface (URLs are
logged), so it stays your call.

## 7. Backup-access procedure

Vercel Authentication gates the app's API surface too, so anything that
verifies live backups against the running app must authenticate twice:

- `x-vercel-protection-bypass: <bypass secret>` (Project → Settings →
  Deployment Protection), **and**
- `Authorization: Bearer $CRON_SECRET` for the cron-gated routes.

The scheduled `backup-monthly` workflow is unaffected (it talks to Neon
and the bucket directly), but it needs the GitHub secrets
`DATABASE_URL`, `MASTER_KEY`, `BACKUP_S3_ENDPOINT`,
`BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY`, and
`BACKUP_BUCKET`.

Restoring is documented in `docs/RUNBOOK.md` (scratch database only,
never over live). "Delete everything" (live purge endpoint + manual
MASTER_KEY destruction for backups) is also in `docs/RUNBOOK.md`.

## 8. Post-deploy verifications (Wave 2 W2-E — owner-blocked)

Everything in this section requires the live infrastructure from §§1–4
(Neon project, both R2 buckets, Vercel project with Authentication on
All Deployments). Until those taps land, each item stays **OWNER-BLOCKED**
— nothing here is silently dropped; run each one as soon as its
prerequisite is live, and flip its line to `DONE (date)` when it passes.

| ID | Verification | Prerequisite tap |
|----|--------------|------------------|
| H1 | **CSP vs real R2 host** — load the app against the real `*.r2.dev`/custom R2 host and confirm no CSP violations block image/asset fetches (browser console clean, thumbnails render). | R2 buckets |
| H2 | **Rate-limit concurrency** — burst concurrent requests at a rate-limited route and confirm 429s are returned correctly without the limiter collapsing under concurrency. | Vercel project |
| H4 | **Presigned round-trips** — full upload→download cycle against the real bucket through presigned URLs (PUT then GET), confirming credentials scope and CORS. | R2 buckets |
| H5 | **302/cache-control at edge** — verify asset redirects return 302 (not cached 200s) and `Cache-Control` headers are correct at the Vercel edge. | Vercel project |
| H8 | **`maxDuration: 300` honored** — trigger a long-running route (import worker) and confirm the platform honors the 300s `maxDuration` rather than killing the function early. | Vercel project |
| H9 | **Neon transactions under load** — concurrent transactional writes (e.g. import batches) against the live Neon project; confirm no serialization anomalies or connection-pool exhaustion. | Neon project |
| H6 | **`.tpy` 48/48 e2e in preview** — import the 48-item DHUM `.tpy` fixture end-to-end in the preview deployment and confirm 48/48 items land with photos, metadata, and tags intact. | Vercel project + R2 buckets |
| H7 | **First backup run + restore spot check** — run the `backup-monthly` workflow once for real, then restore a spot-check subset to a scratch database (per `docs/RUNBOOK.md`) and confirm byte-identical blobs. | R2 buckets + Neon project |

Also live from Wave 1 carry-over: the A1 FTS warm p95<500ms **re-verify
against production** (Dossier H3) — the migration header documents the
PGlite harness number (139ms scope=all); the harness is not a production
SLA. Run the same 200-query warm measurement against the live route and
confirm p95 stays under 500ms.
