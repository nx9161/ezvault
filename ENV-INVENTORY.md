# EZVault environment inventory

Names only — never values. Copy each value from its source into the
target; values are never committed (see `.env.example` for the local
template, and `scripts/secret-scan.sh` which fails the build on leaks).

| Name | Purpose | Required? | Where set |
|---|---|---|---|
| `DATABASE_URL` | Neon Postgres connection string (the app uses the HTTP driver) | **Required** | Neon dashboard → Vercel → Environment Variables (Production). Also a GitHub repo secret for the `backup-monthly` workflow. |
| `R2_ACCOUNT_ID` | Cloudflare account ID — builds the R2 S3 endpoint and feeds the CSP `img-src`/`connect-src` wildcard | **Required** for production | Cloudflare dashboard → Vercel env |
| `R2_ACCESS_KEY_ID` | R2 API token, access-key half | **Required** for production | Cloudflare R2 → API tokens → Vercel env |
| `R2_SECRET_ACCESS_KEY` | R2 API token, secret half | **Required** for production | Cloudflare R2 → API tokens → Vercel env |
| `R2_BUCKET_DATA` | Live data bucket (`originals/`, `thumbs/`, `exports/`, `uploads/`, `tpy-staging/`). Default `ezvault-data` if unset | **Required** for production | Create the bucket in Cloudflare R2 → Vercel env |
| `R2_BUCKET_BACKUPS` | Monthly-backup target bucket (private, 365-day lifecycle) | Required for backups; app runs without it | Create the bucket in Cloudflare R2 → Vercel env, and as `BACKUP_BUCKET` GitHub secret for the `backup-monthly` workflow |
| `CRON_SECRET` | Bearer secret guarding `GET /api/cron/nightly` (constant-time compare; the route 401s without it) | **Required** for the nightly cron | Generate with `openssl rand -base64 32` → Vercel env, and as a GitHub secret for the `nightly-cron` caller workflow |
| `MASTER_KEY` | Wraps each monthly backup's per-backup data key (B26 crypto-shredding). Destroying it (Vercel env + GitHub secret) renders every backup permanently unrecoverable — that is the "delete everything" path for backups, and it stays manual | Required for backups | Generate with `openssl rand -hex 32` → Vercel env **and** mirror the same value into the GitHub repo secret `MASTER_KEY` for the `backup-monthly` workflow |

Notes:

- Deploying without the four `R2_*` data vars silently falls back to the
  ephemeral local filesystem driver — uploads are lost on the next
  redeploy. R2-less deploys are staging/QA only, never production data.
- The monthly `backup-monthly` workflow additionally needs the GitHub
  secrets `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY_ID`,
  `BACKUP_S3_SECRET_ACCESS_KEY`, and `BACKUP_BUCKET` (S3-compatible
  upload credentials for the backup bucket) — those are workflow
  plumbing, not app env vars, so they are not in the table above.
- The `nightly-cron` caller workflow additionally needs `APP_URL` and
  `VERCEL_BYPASS` (Deployment Protection bypass secret) as GitHub
  secrets — same reason.
