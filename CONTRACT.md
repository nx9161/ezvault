# EZVault build contract — Phase 4 (War Room agreed)

Two builders work in parallel. The API surface in
`~/workspace/virtual-office/repo/memory/wings/projects/tropy-cloud/phase2-architecture.md`
§2 is the contract between them — neither changes a route's method, path, or
request/response shape without updating this file AND notifying the other
builder via the coordinator.

## Directory ownership (no overlaps)

**Lead Backend Dev owns:**
- `app/api/**` (every route handler; ALL `runtime='nodejs'`)
- `lib/db/**` (Neon HTTP driver wrapper; MUST `import 'server-only'`)
- `lib/storage/**` (S3-API StorageDriver: R2 now, B2 fallback later)
- `lib/import/**` (upload pipeline, .tpy wizard via sql.js, JSON-LD accept, vocab N3)
- `lib/export/**` (JSON-LD emit — shared module also used by the backup workflow; CSV report + csv-sanitize)
- `lib/notes/sanitize.ts` (THE shared sanitizer — backend writes it first; frontend consumes it; B13)
- `lib/search/**` (query building; snippet sentinel logic lives in the route)
- `lib/ratelimit.ts`, `lib/cpu-budget.ts`, `lib/auth.ts` (CRON_SECRET compare)
- `db/migrations/**` (numbered SQL; the DDL from architecture §3 + FTS triggers §4)
- `middleware.ts` (CSRF origin check on mutating routes; strict CSP; security headers)
- `scripts/**` (`secret-scan.sh`, `verify-codecs.mjs`, `check-licences.mjs`)
- `.env.example`, `.github/workflows/backup-monthly.yml`

**Lead Frontend Dev owns:**
- `app/**` EXCEPT `app/api/**` (pages, layouts; ONE client `<WorkspaceClient>`)
- `components/**`, `lib/store/**` (Zustand), `lib/commands/**` (undo),
  `lib/viewer/**` (Canvas-2D), `messages/**` (next-intl EN)
- `app/globals.css` (design tokens from phase1-design §3 — already seeded; extend, don't restyle)
- `public/**` (static assets; original artwork only)

## Shared handoff order

1. Backend writes `lib/notes/sanitize.ts` + `lib/types.ts` FIRST and pushes.
2. Frontend consumes them; never forks its own copy.

## Binding rules (from the War Room — non-negotiable)

- Clean-room: ZERO Tropy code, icons, copy, or artwork. All UI copy is original.
- SPDX headers on every source file: `// SPDX-License-Identifier: MIT`
- No secrets in code, ever. `.env.example` placeholders only.
- `npm run build` green + `tsc` clean at every push.
- Conventional commits; push to `main` as features land (owner's standing order).
- This Next.js version has breaking changes — read `node_modules/next/dist/docs/`
  before writing any code (per the scaffold's agent rules).
