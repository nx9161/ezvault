// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/db — Neon Postgres access via @neondatabase/serverless HTTP driver.
 *
 * ADR-2.17: HTTP driver only — no pooler, no direct TCP (matches Neon
 * scale-to-zero; single user).
 *
 * TRANSACTION MODEL (verified against @neondatabase/serverless 1.0.2 AND
 * 1.2.0): the HTTP client's `transaction()` is NON-INTERACTIVE — it accepts
 * an array of queries (or a non-async function returning an array), submitted
 * as one atomic batch. There is NO await-between-statements over HTTP.
 * (Phase-2 build-verification item #5: resolved — interactive HTTP
 * transactions do not exist in any released driver version.)
 *
 * Adaptation (binding):
 *   1. Read-modify-write that must be atomic is expressed as a SINGLE SQL
 *      statement with CTEs (SELECT ... FOR UPDATE inside the CTE), e.g.
 *      rate_buckets consume, storage_counters increment, projects.rev bump.
 *   2. `tx()` runs a batch of queries as one non-interactive transaction.
 *      Reads that inform the writes happen before the batch (single-user
 *      model: the race window is accepted and documented).
 *   3. Lock order (binding, ADR-2.7): storage_counters -> photos -> import_jobs.
 */

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and add your Neon connection string.',
    );
  }
  return url;
}

let rawCached: NeonQueryFunction<false, false> | null = null;

/** Raw driver (transactions, .query(), .unsafe()). Internal to this module. */
function rawSql(): NeonQueryFunction<false, false> {
  if (!rawCached) rawCached = neon(databaseUrl());
  return rawCached;
}

/** Typed tagged-template: `await sql()`SELECT ...`` -> Record<string, unknown>[]. */
export type SqlTag = (
  strings: TemplateStringsArray,
  ...params: unknown[]
) => Promise<Record<string, unknown>[]>;

let cached: SqlTag | null = null;

/** The shared Neon HTTP query function (tagged-template, typed rows). */
export function sql(): SqlTag {
  if (!cached) {
    const raw = rawSql();
    cached = (strings, ...params) =>
      raw(strings, ...params) as unknown as Promise<Record<string, unknown>[]>;
  }
  return cached;
}

/**
 * Parameterized raw query for dynamically-built SQL (filters/sorts).
 * Always pass user input as params ($1, $2…), never interpolate.
 */
export async function queryRaw<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const rows = await rawSql().query(text, params);
  return rows as unknown as T[];
}

/** A single query inside a tx() batch. */
export type TxQuery = {
  text: string;
  params?: unknown[];
};

/**
 * Run a batch of queries as ONE non-interactive Postgres transaction.
 * Queries execute in array order; any failure rolls everything back.
 *
 * NOTE: no application logic can run between the queries (driver limit).
 * When a write depends on a read, fold the read into the statement with a
 * CTE (see bumpCounters / consumeBucket for the pattern).
 */
export async function tx<T = unknown>(
  build: (q: (text: string, params?: unknown[]) => TxQuery) => TxQuery[],
  opts?: { isolationLevel?: 'Serializable' | 'RepeatableRead' | 'ReadCommitted' },
): Promise<T[]> {
  const s = rawSql();
  const q = (text: string, params?: unknown[]): TxQuery => ({ text, params });
  const queries = build(q).map((item) => s.query(item.text, item.params ?? []));
  const results = (await s.transaction(queries, opts ? { isolationLevel: opts.isolationLevel } : undefined)) as T[][];
  return results as T[];
}

/**
 * Atomically bump projects.rev and return the new value — single statement,
 * safe to append to any transaction batch.
 */
export function bumpRevQuery(projectId: string): TxQuery {
  return {
    text: `UPDATE projects SET rev = rev + 1, updated_at = now() WHERE id = $1 RETURNING rev`,
    params: [projectId],
  };
}

/** Read the current rev (cheap cross-tab staleness check). */
export async function getRev(projectId: string): Promise<number | null> {
  const rows = await sql()`SELECT rev FROM projects WHERE id = ${projectId}`;
  return rows.length ? Number(rows[0]['rev']) : null;
}

/** Fetch a project row or null. */
export async function getProject(projectId: string): Promise<Record<string, unknown> | null> {
  const rows = await sql()`SELECT * FROM projects WHERE id = ${projectId}`;
  return rows.length ? rows[0] : null;
}

/**
 * Atomically increment storage_counters. The counters row is created
 * lazily if missing; the increment applies on top of any existing row.
 *
 * MUST stay a SINGLE statement: every query this app sends goes through
 * the Neon HTTP driver as a prepared statement, and Postgres rejects
 * multi-command prepared statements ("cannot insert multiple commands
 * into a prepared statement"). The previous two-statement form
 * (INSERT ... ON CONFLICT DO NOTHING; WITH locked AS (... FOR UPDATE)
 * UPDATE ...) crashed every transaction batch that included it —
 * /api/import/process died on it 2026-10-21, wedging the owner's import.
 * The upsert form preserves the semantics: one atomic statement, and
 * ON CONFLICT DO UPDATE takes the counters-row lock, keeping the
 * counters-first lock order inside tx() batches.
 */
export function bumpCountersQuery(
  projectId: string,
  delta: { originals?: number; thumbs?: number; exports?: number },
): TxQuery {
  return {
    text: `
      INSERT INTO storage_counters (project_id, bytes_originals, bytes_thumbs, bytes_exports, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (project_id) DO UPDATE SET
        bytes_originals = storage_counters.bytes_originals + EXCLUDED.bytes_originals,
        bytes_thumbs    = storage_counters.bytes_thumbs + EXCLUDED.bytes_thumbs,
        bytes_exports   = storage_counters.bytes_exports + EXCLUDED.bytes_exports,
        updated_at = now()`,
    params: [
      projectId,
      delta.originals ?? 0,
      delta.thumbs ?? 0,
      delta.exports ?? 0,
    ],
  };
}

/**
 * Idempotent clientOpId claim. Inserts into command_log; returns the log id,
 * or null when the op_id was already seen (caller must treat as replay and
 * return the stored payload's outcome).
 */
export async function claimOp(
  projectId: string,
  opId: string,
  kind: string,
  payload: unknown,
  jobId?: string,
): Promise<{ id: string; replayed: boolean }> {
  const rows = await sql()`
    INSERT INTO command_log (project_id, op_id, kind, payload, job_id)
    VALUES (${projectId}, ${opId}, ${kind}, ${JSON.stringify(payload ?? {})}::jsonb, ${jobId ?? null})
    ON CONFLICT (op_id) DO NOTHING
    RETURNING id`;
  if (rows.length) return { id: rows[0]['id'] as string, replayed: false };
  return { id: '', replayed: true };
}

/** Mark a claimed op as undone (for compound undo bookkeeping). */
export async function markUndone(opId: string): Promise<void> {
  await sql()`UPDATE command_log SET undone_at = now() WHERE op_id = ${opId}`;
}
