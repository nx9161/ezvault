// SPDX-License-Identifier: MIT
import 'server-only';
import { handle, ok, parseCappedJson, HttpError } from '@/lib/api/route-utils';
import { queryRaw } from '@/lib/db/index';
import { getStorageDriver } from '@/lib/storage/driver';
import { requireRateLimit } from '@/lib/ratelimit';
import { isDeleteEverythingConfirm } from '@/lib/api/admin';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * POST /api/admin/delete-everything — F-F: the binding live-data purge.
 *
 * CONTRACT (for the frontend builder — the button + typed-confirm dialog
 * wire against this shape):
 * - Request body MUST be exactly {confirm:"DELETE"} — any other body
 *   (missing, wrong value, extra keys) → 400. The dialog must make the
 *   user type DELETE verbatim.
 * - On success: 200 with
 *     { deleted: { objects: <n>, tables: <n> },
 *       backups: { retained: true, retention_days: 365, note: <string> } }
 * - 429 when the rate bucket is empty (tight bucket: 3 attempts, ~1/hour
 *   refill). This is the destructive-action guard; the typed confirm is
 *   the user-intent guard.
 *
 * What it does: deletes every object under the live R2 prefixes
 * (originals/, thumbs/, exports/, uploads/, tpy-staging/) and TRUNCATEs
 * every app table CASCADE.
 *
 * What it does NOT do (crypto-shredding stays manual, docs/RUNBOOK.md):
 * the monthly backups in the backup bucket are RETAINED per the 365-day
 * lifecycle and remain recoverable until the owner destroys MASTER_KEY
 * (Vercel env + GitHub secret) — that step is deliberate and manual, and
 * is disclosed in the response's backups.note. The response always
 * carries that disclosure so the UI can show it next to the button.
 */
export const POST = handle(async (req: Request) => {
  // Tightest bucket in the app: this is the nuclear option.
  await requireRateLimit('admin:delete-everything');

  let body: unknown;
  try {
    body = await parseCappedJson(req);
  } catch {
    throw new HttpError(400, 'validation', 'body must be exactly {"confirm":"DELETE"}');
  }
  if (!isDeleteEverythingConfirm(body)) {
    throw new HttpError(400, 'validation', 'body must be exactly {"confirm":"DELETE"}');
  }

  // 1. Live R2 prefixes.
  const storage = await getStorageDriver();
  let objects = 0;
  for (const prefix of ['originals/', 'thumbs/', 'exports/', 'uploads/', 'tpy-staging/']) {
    for (const key of await storage.listKeys(prefix)) {
      await storage.delete(key).catch(() => {});
      objects++;
    }
  }

  // 2. Every app table (fixed allowlist — no user input reaches this SQL).
  const tables = [
    'projects', 'subjects', 'items', 'images', 'photos', 'selections',
    'notes', 'transcriptions', 'templates', 'metadata_values', 'metadata',
    'tags', 'taggings', 'lists', 'list_items', 'trash', 'deleted_photos',
    'import_jobs', 'tpy_import_map', 'storage_counters', 'cpu_budget_windows',
    'compress_log', 'command_log', 'rate_buckets', 'search_documents',
  ];
  await queryRaw(`TRUNCATE ${tables.join(', ')} CASCADE`);

  return ok({
    deleted: { objects, tables: tables.length },
    backups: {
      retained: true,
      retention_days: 365,
      note: 'Monthly backups in the backup bucket are retained under the '
        + '365-day lifecycle and are NOT deleted by this endpoint. They stay '
        + 'recoverable until MASTER_KEY is destroyed (Vercel env + GitHub '
        + 'secret) per docs/RUNBOOK.md — crypto-shredding is deliberate and '
        + 'manual.',
    },
  });
});
