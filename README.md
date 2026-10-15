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

## License

MIT — see [LICENSE](LICENSE). Third-party notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
