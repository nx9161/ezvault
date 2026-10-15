// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/api/idempotency.ts — server side of the A4 clientOpId contract.
 *
 * The canonical exactly-once gate is claimOp() (lib/db/index.ts):
 *   INSERT INTO command_log (project_id, op_id, kind, payload)
 *   ... ON CONFLICT (op_id) DO NOTHING
 * called BEFORE any side effect on every create-path. The wire format and
 * the client/server rules are documented in ./idempotency-wire.ts (pure
 * module — the contract the frontend builder codes against).
 */

import { sql, claimOp } from '../db/index';
import { HttpError } from './route-utils';
import { isClientOpId, resolveClientOpId } from './idempotency-wire';

export { resolveClientOpId };

/**
 * Validate + claim a clientOpId. Returns { replayed: false } when this call
 * won the claim (caller must proceed with the mutation) or
 * { replayed: true } when the op was already claimed (caller must return the
 * prior outcome, not re-execute). Malformed op ids are a 400.
 */
export async function claimClientOpId(
  projectId: string,
  opId: string,
  kind: string,
  payload: unknown,
): Promise<{ replayed: boolean }> {
  if (!isClientOpId(opId)) {
    throw new HttpError(400, 'validation', 'invalid clientOpId (must be UUID)');
  }
  const claim = await claimOp(projectId, opId, kind, payload);
  return { replayed: claim.replayed };
}

/**
 * Bounded wait for the first attempt's outcome row to become visible.
 * The claim row is written BEFORE side effects, so a fast retry can arrive
 * while attempt #1 is still committing — poll briefly before giving up.
 */
async function awaitPriorResult<T>(find: () => Promise<T | null>): Promise<T | null> {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await find();
      if (r !== null && r !== undefined) return r;
    } catch {
      /* transient — keep polling */
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  return null;
}

export interface IdempotentCreateOpts<T> {
  projectId: string;
  /** Resolved via resolveClientOpId(); null/undefined = no idempotency requested. */
  opId: string | null | undefined;
  kind: string;
  /** Minimal claim payload (request summary — never secrets, never blobs). */
  payload: unknown;
  /** Performs the mutation; returns the outcome to send to the client. */
  create: () => Promise<T>;
  /** Re-reads the first attempt's outcome for a replay. */
  findPrior: () => Promise<T | null>;
  /** Serializable outcome stashed at command_log.payload.result for replays. */
  toStash?: (result: T) => unknown;
}

export interface IdempotentCreateResult<T> {
  result: T | null;
  replayed: boolean;
  clientOpId: string | null;
}

/**
 * Run a create-path with exactly-once semantics. When opId is null the
 * mutation runs unguarded (back-compat for callers that send no op id).
 */
export async function idempotentCreate<T>(
  opts: IdempotentCreateOpts<T>,
): Promise<IdempotentCreateResult<T>> {
  const { projectId, opId, kind, payload, create, findPrior, toStash } = opts;
  if (!opId) {
    return { result: await create(), replayed: false, clientOpId: null };
  }
  const { replayed } = await claimClientOpId(projectId, opId, kind, payload);
  if (replayed) {
    const prior = await awaitPriorResult(findPrior);
    return { result: prior, replayed: true, clientOpId: opId };
  }
  const result = await create();
  // Best-effort: stash the outcome for future replays. Never fails the
  // request — without the stash a later replay simply reports result: null.
  try {
    const stash = toStash ? toStash(result) : result;
    await sql()`UPDATE command_log
                SET payload = jsonb_set(payload, '{result}', ${JSON.stringify(stash)}::jsonb)
                WHERE op_id = ${opId}`;
  } catch (err) {
    console.error('idempotency: result stash failed for op', opId, err);
  }
  return { result, replayed: false, clientOpId: opId };
}

/**
 * Read the stashed outcome for an op id (helper for findPrior
 * implementations). Returns null when nothing was stashed.
 */
export async function readStashedResult<T>(opId: string): Promise<T | null> {
  const rows = await sql()`SELECT payload->'result' AS result FROM command_log WHERE op_id = ${opId} LIMIT 1`;
  const r = rows[0]?.['result'] as T | null | undefined;
  return r ?? null;
}
