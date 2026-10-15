// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/api/meter.ts — storage meter from transactional DB counters (ADR-2.7).
 * R2 listing is the nightly auditor only; the meter NEVER lists R2.
 *
 * Policy: 80% warn / 95% hard-warn + retention offer / 100% block
 * (presign refuses 507 when blocked).
 */

import { sql } from '../db/index';
import type { StorageMeter, StoragePolicy } from '../types';

export const BYTES_LIMIT = 10 * 1024 * 1024 * 1024; // 10 GB-mo (R2 binds first)

export async function getStorageMeter(projectId: string): Promise<StorageMeter> {
  const rows = await sql()`SELECT bytes_originals, bytes_thumbs, bytes_exports, updated_at
    FROM storage_counters WHERE project_id = ${projectId}`;
  const c = rows[0] ?? { bytes_originals: 0, bytes_thumbs: 0, bytes_exports: 0, updated_at: new Date().toISOString() };
  const originals = Number(c['bytes_originals'] ?? 0);
  const thumbs = Number(c['bytes_thumbs'] ?? 0);
  const exports = Number(c['bytes_exports'] ?? 0);
  const used = originals + thumbs + exports;
  const pct = (used / BYTES_LIMIT) * 100;
  const policy: StoragePolicy = pct >= 100 ? 'block' : pct >= 80 ? 'warn' : 'ok';
  return {
    bytes_used: used,
    bytes_limit: BYTES_LIMIT,
    pct: Math.round(pct * 100) / 100,
    policy,
    breakdown: { originals, thumbs, exports },
    updated_at: (c['updated_at'] as string) ?? new Date().toISOString(),
  };
}

/** True when the project may not stage new bytes (presign must refuse 507). */
export async function isStorageBlocked(projectId: string): Promise<boolean> {
  return (await getStorageMeter(projectId)).policy === 'block';
}
