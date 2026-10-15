// SPDX-License-Identifier: MIT
import { handle, ok, apiError } from '@/lib/api/route-utils';
import { sql } from '@/lib/db/index';
import { getStorageDriver } from '@/lib/storage/driver';
import { createHash, timingSafeEqual } from 'node:crypto';

export const runtime = 'nodejs';
export const maxDuration = 300;

/**
 * GET /api/cron/nightly — B20: gated by CRON_SECRET compared via a SHA-256
 * digest constant-time loop (never a raw string ===). Duties:
 *   1. staging sweep (uploads/ older than 24h; tpy-staging of done/cancelled
 *      jobs older than 7 days),
 *   2. counter reconciliation — drift >1% vs the DB byte sums logs an
 *      alert; NEVER auto-corrects (ADR-2.7),
 *   3. queue tick — 'running' jobs idle >24h are marked failed,
 *   4. export expiry — exports/ staging objects older than 7 days deleted,
 *   5. CPU window roll + resume paused_cpu jobs into queued once a fresh,
 *      unpaused window exists.
 */
export const GET = handle(async (req: Request) => {
  const secret = process.env['CRON_SECRET'];
  // F-B3: generic message — never reveal whether the secret is configured
  // to unauthenticated callers.
  if (!secret) return apiError('server_error', 'service unavailable', 500);
  const auth = req.headers.get('authorization') ?? '';
  const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  // B20: constant-time compare over digests (length-safe).
  const want = createHash('sha256').update(secret, 'utf8').digest();
  const got = createHash('sha256').update(provided, 'utf8').digest();
  if (!provided || !timingSafeEqual(want, got)) {
    return apiError('unauthorized', 'bad cron secret', 401);
  }

  const storage = await getStorageDriver();
  const report: Record<string, unknown> = {};
  const now = Date.now();

  // 1. Staging sweep.
  let stagedDeleted = 0;
  for (const prefix of ['uploads/']) {
    for (const key of await storage.listKeys(prefix)) {
      const head = await storage.head(key).catch(() => null);
      const mtime = head?.lastModified ? Date.parse(head.lastModified) : 0;
      if (mtime && now - mtime > 24 * 3600 * 1000) {
        await storage.delete(key).catch(() => {});
        stagedDeleted++;
      }
    }
  }
  const oldJobs = await sql()`SELECT id FROM import_jobs
    WHERE kind = 'tpy' AND status IN ('done','cancelled') AND updated_at < now() - interval '7 days'`;
  for (const j of oldJobs) {
    for (const key of await storage.listKeys(`tpy-staging/${j['id']}/`)) {
      await storage.delete(key).catch(() => {});
      stagedDeleted++;
    }
  }
  report['staged_deleted'] = stagedDeleted;

  // 2. Counter reconciliation — alert only, never auto-correct.
  const driftAlerts: string[] = [];
  const projects = await sql()`SELECT id FROM projects`;
  for (const p of projects) {
    const pid = p['id'] as string;
    const actual = await sql()`SELECT COALESCE(SUM(size_bytes),0)::bigint AS bytes
      FROM photos ph JOIN subjects s ON s.id = ph.subject_id
      WHERE s.project_id = ${pid} AND ph.missing_original = false`;
    const counter = await sql()`SELECT bytes_originals FROM storage_counters WHERE project_id = ${pid}`;
    const expectedBytes = Number(actual[0]['bytes'] ?? 0);
    const countedBytes = Number(counter[0]?.['bytes_originals'] ?? 0);
    const base = Math.max(expectedBytes, 1);
    const drift = Math.abs(countedBytes - expectedBytes) / base;
    if (drift > 0.01) {
      const msg = `storage counter drift for project ${pid}: counted=${countedBytes} actual=${expectedBytes} drift=${(drift * 100).toFixed(2)}%`;
      console.error('cron:nightly counter-drift ALERT:', msg);
      driftAlerts.push(msg);
    }
  }
  report['counter_drift_alerts'] = driftAlerts;

  // 3. Queue tick: idle running jobs -> failed.
  const stale = await sql()`UPDATE import_jobs
    SET status = 'failed', error = 'idle timeout: no client progress for 24h', updated_at = now()
    WHERE status = 'running' AND updated_at < now() - interval '24 hours'
    RETURNING id`;
  report['queue_tick_failed'] = stale.length;

  // 4. Export expiry (7-day lifecycle, server-enforced).
  let exportsDeleted = 0;
  for (const key of await storage.listKeys('exports/')) {
    const head = await storage.head(key).catch(() => null);
    const mtime = head?.lastModified ? Date.parse(head.lastModified) : 0;
    if (mtime && now - mtime > 7 * 24 * 3600 * 1000) {
      await storage.delete(key).catch(() => {});
      exportsDeleted++;
    }
  }
  report['exports_deleted'] = exportsDeleted;

  // 5. CPU window roll + resume. currentWindow() rolls the 30-day window
  // lazily when expired; jobs parked in paused_cpu by the guard resume only
  // once a fresh, unpaused window exists (arch §10 — previously unbuilt).
  const { currentWindow } = await import('@/lib/cpu-budget');
  const w = await currentWindow();
  if (!w.paused) {
    const resumed = await sql()`UPDATE import_jobs
      SET status = 'queued', updated_at = now()
      WHERE status = 'paused_cpu' RETURNING id`;
    report['cpu_resumed'] = resumed.length;
  } else {
    report['cpu_resumed'] = 0;
  }

  return ok({ ok: true, at: new Date().toISOString(), ...report });
});
