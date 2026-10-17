# EZVault

A personal, zero-cost cloud photo-research workspace. Import research photos,
organize them into items, annotate regions and notes, describe everything with
metadata templates, and find it all again with full-text search — from any
browser. One user. $0.00 forever.

> EZVault is an independent project. It is not affiliated with, endorsed by, or
> sponsored by the [Tropy project](https://tropy.org) or the [Corporation for
> Digital Scholarship](https://digitalscholar.org). "Tropy" is a registered
> trademark of the Corporation for Digital Scholarship. Any references to Tropy
> in this repository (for example, "imports Tropy .tpy project files" or
> "Tropy-compatible JSON-LD") are descriptive only, to indicate file-format
> interoperability, and do not imply any official connection.

## What it does

- **Import** — multi-file picker, drag-and-drop, and folder upload; iPhone
  HEIC converts in the browser; every format is magic-byte verified.
- **Organize** — items group photos; nested lists; colored tags; trash with
  restore.
- **Annotate** — non-destructive photo edits (rotate, mirror, brightness,
  contrast, hue, saturation, sharpen, invert) with one-click revert; region
  selections with their own metadata and notes; rich-text notes.
- **Describe** — metadata templates bound to URI properties (Dublin Core and
  custom `.ttp` templates), bulk edit.
- **Find** — full-text search across metadata, notes, and tags.
- **Exchange** — Tropy-compatible JSON-LD import/export; direct `.tpy`
  project import (Standard and Advanced).
- **Undo** — session-scoped undo/redo across item, photo, and metadata
  operations.

## The $0 stack

| Layer      | Service                        | Free tier                        |
|------------|--------------------------------|----------------------------------|
| App        | Vercel Hobby                   | 100 GB bandwidth, 1M invocations |
| Photos     | Cloudflare R2                  | 10 GB storage, zero egress fees  |
| Metadata   | Neon Postgres (free tier)      | 1 GB, full-text search           |
| Access     | Vercel Authentication          | Login gate, single user          |

No card on file anywhere. No pay-as-you-go — the app is designed to stay
inside the free tiers by construction (storage meter with warn/ask/refuse
at 80/95/100%).

## Status

Built under a full War Room (Sloane presiding): prompt perfection, research
dossier, PRD, architecture debate with measured benchmarks, and a
security/legal challenge whose 28 findings are the build's definition of
done. v1 = the research-photo core; later waves add transcriptions, OCR,
CSV/archive export, Omeka S, and IIIF.

## Development

```bash
npm install
npm run dev
```

Environment (never committed — see `.env.example`):

- `DATABASE_URL` — Neon Postgres connection string
- `R2_*` — Cloudflare R2 S3-compatible credentials
- `CRON_SECRET` — secret for the nightly maintenance cron
- `MASTER_KEY` — wraps the per-backup data keys for the monthly backup
  workflow (mirrors the Vercel env var of the same name; see below)

## Deploy runbook

Single-user, zero-cost deploy. Do these in order; the smoke test at the
end fails the pipeline if protection is misconfigured (B7).

### 1. Vercel project settings

- **Deployment Protection:** Project → Settings → Deployment Protection →
  **Standard Protection** on **All Deployments**. This is the single-user
  gate — the app must never be reachable without the Vercel login.
- Verify `maxDuration: 300` is honored on the plan (ADR-2.24): import,
  export, `.tpy` runs, and retention routes all declare it.

### 2. Environment variables (all set before the first deploy)

| Variable | Source | Notes |
|---|---|---|
| `DATABASE_URL` | Neon dashboard | HTTP driver connection string |
| `R2_ACCOUNT_ID` | Cloudflare dashboard | also feeds the CSP `img-src`/`connect-src` wildcard (F1) |
| `R2_ACCESS_KEY_ID` | Cloudflare dashboard | R2 API token |
| `R2_SECRET_ACCESS_KEY` | Cloudflare dashboard | R2 API token |
| `R2_BUCKET_DATA` | your choice | default `ezvault-data` |
| `R2_BUCKET_BACKUPS` | your choice | monthly-backup target bucket |
| `CRON_SECRET` | `openssl rand -base64 32` | guards `/api/cron/nightly` |
| `MASTER_KEY` | `openssl rand -hex 32` | **mirror the same value** into the GitHub repo secret `MASTER_KEY` for the backup workflow; it wraps each month's backup data key (B26 crypto-shredding) |

> ⚠️ **Deploying without the R2 vars silently uses the ephemeral local
> filesystem driver** (`lib/storage/driver.ts`). Uploads land on the
> deployment's disk and are **lost on the next redeploy**. R2-less deploys
> are staging/QA only — never production data.

### 3. Apply database migrations (in filename order)

```bash
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -f "$f"; done
```

### 4. Post-deploy smoke test (unauthenticated)

```bash
# Must NOT return 200 app HTML — expect a redirect to the Vercel login.
curl -sI https://<your-app>.vercel.app | head -1
# Pre-env, /api/health must answer 503 with the not-configured message
# (no stack leak); post-env it answers 200.
curl -s https://<your-app>.vercel.app/api/health
```

If the first command returns `200` with app HTML, Deployment Protection is
off — fix it in the dashboard (step 1) and redeploy.

### 5. Backup verification access

Vercel Authentication also gates the app's API surface, so anything that
verifies live backups against the running app (restore spot-checks,
`scripts/backup-jsonld.mjs` runs) must send the
`x-vercel-protection-bypass` header (value: Project → Settings →
Deployment Protection → protection bypass secret) — or use the
`CRON_SECRET`-gated export route instead. The scheduled
`backup-monthly` workflow itself is unaffected (it talks to Neon and the
bucket directly), but it needs the GitHub secrets `DATABASE_URL`,
`MASTER_KEY`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY_ID`,
`BACKUP_S3_SECRET_ACCESS_KEY`, and `BACKUP_BUCKET`.

## Privacy

- **Where your data lives:** photo bytes in your private Cloudflare R2
  bucket; metadata (items, notes, tags, lists) in your Neon Postgres
  database. Nothing is sent to any third party — there is no analytics,
  no telemetry, no external API call in any user path.
- **Nightly cron:** if you schedule `/api/cron/nightly` (Vercel Cron or any
  scheduler), it must send `Authorization: Bearer $CRON_SECRET` — the route
  rejects everything else with 401.
- **Backups:** the monthly `backup-monthly` workflow writes an encrypted
  database dump + JSON-LD export to your private backup bucket. Backups
  are retained for **365 days** (bucket lifecycle), then expire
  automatically. Each backup is encrypted with a fresh per-backup data
  key; the data key is wrapped with `MASTER_KEY`. Destroying `MASTER_KEY`
  (Vercel env + GitHub secret) renders every backup permanently
  unrecoverable — that is the "delete everything" path; see
  `docs/RUNBOOK.md`.
- **Deletion:** trash restore is available until you empty the trash.
  Emptying the trash and the prune retention mode are irreversible
  (R2 objects deleted, audit rows kept in `deleted_photos` only).

## License

MIT — see [LICENSE](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

---

Built by **Naman Parmar** ([nx9161](https://github.com/nx9161)).
