// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/cpu-budget.ts — rolling 30-day CPU guard (phase2 §8, ADR-2.23).
 *
 * - Per-invocation `process.cpuUsage()` deltas are charged post-commit via
 *   chargeCpu() (to the rolling window AND import_jobs.cpu_seconds) — never
 *   in the photo-finalize transaction (that double-charged the job row).
 * - Threshold 80% (11,520 s of the 14,400 s cap) → window paused = TRUE;
 *   queued/running jobs flip to paused_cpu; guard-checked routes answer
 *   503 + Retry-After + resume date.
 * - Uploads are NEVER gated (presigned PUTs cost ~zero CPU).
 * - Resume is lazy: the window rolls on any guard check + the nightly cron
 *   ticks it and flips paused_cpu jobs back to queued.
 */

import { sql } from './db/index';
import { HttpError } from './api/route-utils';

export const CPU_CAP_S = 14400; // 4 CPU-hours / 30d (Vercel Hobby mirror)
export const CPU_GUARD_S = 11520; // 80% pause threshold

export interface CpuWindow {
  id: string;
  window_start: string;
  window_end: string;
  cpu_seconds: number;
  paused: boolean;
}

/** Fetch the active window, rolling it lazily when expired/missing.
 *
 * A5: the old SELECT-then-INSERT raced — two concurrent first-calls could
 * both insert a window. Now exactly one row carries active = true (partial
 * unique index, migration 0007). This function (1) deactivates expired
 * active windows (idempotent, safe to race), then (2) INSERTs the fresh
 * window only when no unexpired active window exists, with
 * ON CONFLICT (active) WHERE active DO UPDATE converging concurrent
 * first-calls on the single winner's row (RETURNING yields it).
 */
export async function currentWindow(): Promise<CpuWindow> {
  await sql()`UPDATE cpu_budget_windows SET active = false WHERE active AND window_end <= now()`;
  const rows = await sql()`
    WITH latest AS (
      SELECT id, window_start, window_end, cpu_seconds, paused
      FROM cpu_budget_windows WHERE active LIMIT 1
    ),
    ins AS (
      INSERT INTO cpu_budget_windows (window_start, window_end, cpu_seconds, paused, active)
      SELECT now(), now() + interval '30 days', 0, false, true
      WHERE NOT EXISTS (SELECT 1 FROM latest WHERE window_end > now())
      ON CONFLICT (active) WHERE active DO UPDATE SET active = EXCLUDED.active
      RETURNING id, window_start, window_end, cpu_seconds, paused
    )
    SELECT id, window_start, window_end, cpu_seconds, paused FROM ins
    UNION ALL
    SELECT id, window_start, window_end, cpu_seconds, paused FROM latest
    WHERE NOT EXISTS (SELECT 1 FROM ins)`;
  const w = rows[0] as unknown as CpuWindow | undefined;
  if (!w) throw new Error('cpu_budget_windows: no active window row');
  return { ...w, cpu_seconds: Number(w.cpu_seconds) };
}

export class CpuPausedError extends HttpError {
  constructor(public resumes: string) {
    super(503, 'cpu_paused', 'CPU budget paused — processing resumes at window roll');
    (this as unknown as { retryAfterSec: number }).retryAfterSec = Math.max(
      1,
      Math.ceil((new Date(resumes).getTime() - Date.now()) / 1000),
    );
  }
}

/**
 * Guard checked BEFORE CPU-heavy work (process, bake, compress, tpy analyze/run).
 * Uploads never call this.
 */
export async function checkCpuGuard(): Promise<CpuWindow> {
  const w = await currentWindow();
  if (w.paused) throw new CpuPausedError(new Date(w.window_end).toISOString());
  if (w.cpu_seconds >= CPU_GUARD_S) {
    await sql()`UPDATE cpu_budget_windows SET paused = true WHERE id = ${w.id}`;
    // Flip queued/running jobs to paused_cpu (uploads keep working).
    await sql()`UPDATE import_jobs SET status = 'paused_cpu', updated_at = now()
                WHERE status IN ('queued','running')`;
    throw new CpuPausedError(new Date(w.window_end).toISOString());
  }
  return w;
}

/**
 * Charge CPU seconds to the active window (and optionally a job). Auto-pauses
 * at the guard threshold. Single statements — call AFTER the work commits.
 */
export async function chargeCpu(seconds: number, jobId?: string): Promise<void> {
  if (!(seconds > 0)) return;
  const w = await currentWindow();
  await sql()`
    UPDATE cpu_budget_windows
    SET cpu_seconds = cpu_seconds + ${seconds},
        paused = (cpu_seconds + ${seconds} >= ${CPU_GUARD_S})
    WHERE id = ${w.id}`;
  if (jobId) {
    await sql()`UPDATE import_jobs
                SET cpu_seconds = cpu_seconds + ${seconds}, updated_at = now()
                WHERE id = ${jobId}`;
  }
}

/** GET /api/cpu-budget payload. */
export async function getCpuBudget(): Promise<{
  used_s: number;
  cap_s: number;
  guard_s: number;
  paused: boolean;
  resumes: string | null;
}> {
  const w = await currentWindow();
  const paused = w.paused || w.cpu_seconds >= CPU_GUARD_S;
  return {
    used_s: Math.round(w.cpu_seconds * 100) / 100,
    cap_s: CPU_CAP_S,
    guard_s: CPU_GUARD_S,
    paused,
    resumes: paused ? new Date(w.window_end).toISOString() : null,
  };
}
