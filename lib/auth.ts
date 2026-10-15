// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/auth.ts — CRON_SECRET verification (B20).
 *
 * Edge middleware lacks `crypto.timingSafeEqual`, so the comparison hashes
 * both sides with SHA-256 (always 32 bytes — no length leak) and compares
 * the digests in a constant-time loop: no `===` on the secret, no
 * length-leaking early exit.
 */

import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(s: string): Buffer {
  return createHash('sha256').update(s, 'utf8').digest();
}

/** Constant-time comparison of two SHA-256 digests (fixed 32-byte length). */
function digestsEqual(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false; // both 32 — no secret-dependent leak
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  void timingSafeEqual; // (Node has it; the loop above is the portable guarantee.)
  return diff === 0;
}

export function extractBearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  if (!h) return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1] : null;
}

/** True iff `provided` matches CRON_SECRET under the constant-time rule. */
export function isValidCronSecret(provided: string | null | undefined): boolean {
  const expected = process.env.CRON_SECRET;
  if (!provided || !expected) return false;
  return digestsEqual(sha256(provided), sha256(expected));
}
