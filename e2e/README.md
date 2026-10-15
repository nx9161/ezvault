# E2E — Playwright (W2-C)

Chromium-only suite. `playwright.config.ts` drives everything.

## Local CI (no live infra)

```bash
npm ci && npm run build
npx playwright install --with-deps chromium   # browsers are NOT installed by postinstall — deliberate
npx playwright test
```

What runs locally: `e2e/auth-gate.spec.ts` → the `/api/health` 503
`not_configured` assertion (the config boots `next start` with no
`DATABASE_URL` on purpose). Everything needing Neon/R2/Vercel **skips**
with reason `OWNER-BLOCKED: live infra` — never faked.

## Live run (post-deploy, owner taps done)

```bash
E2E_LIVE=1 E2E_BASE_URL=https://<preview>.vercel.app E2E_BYPASS=<protection-bypass-secret> \
  E2E_PROJECT_ID=<scratch-project-uuid> npx playwright test
```

- `E2E_BYPASS` is the Vercel protection-bypass secret — Deployment
  Protection stays ON; the header is the official preview-test pattern.
- `E2E_PROJECT_ID` is only needed by `rate-limit.spec.ts` (burst target).
- Restore targets are always scratch projects, never production data.

## Specs

| Spec | What it asserts | Needs |
|---|---|---|
| `auth-gate.spec.ts` | `/api/health` 503 `not_configured` pre-env (runs locally); root 302 behind Vercel Auth; no secret leak in health body | 302: protected preview |
| `rate-limit.spec.ts` | 40-burst on `/api/import/presign` → 429s with `Retry-After`, **zero 500s** (hardening H2) | Neon (durable buckets) |
| `tpy-wizard.spec.ts` | Standard fixture: 3 items / 4 photos, re-run adds nothing; Advanced fixture: 3 missing originals re-link, nothing left missing | Neon + R2 |
| `backup-restore.spec.ts` | JSON-LD export → import into scratch project: item counts match (H7 adjacency) | Neon + R2 |

## Fixtures (`e2e/fixtures/`)

Committed synthetic fixtures — never the owner's real 48-item file:

- `standard.tpy` — 3 items / 4 photos / 1 selection / 2 notes / 3 metadata
  rows (one language-tagged) / 2 tags / 1 list; `application_id=-621960955`,
  `user_version=2112312400`
- `standard-assets.zip` — DEFLATE zip of the 4 photo bytes (matches by basename)
- `advanced.tpy` — 2 items / 3 photos with missing originals (paths point at
  another machine; real md5s in the `checksum` column)
- `advanced-originals/` — the real bytes for the re-link step

Regenerate: `node e2e/fixtures/build-fixtures.mjs` (uses the repo's
`sql.js` + `sharp`; dev-time only, nothing ships).
