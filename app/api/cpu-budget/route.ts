// SPDX-License-Identifier: MIT
import { handle, ok } from '@/lib/api/route-utils';
import { getCpuBudget } from '@/lib/cpu-budget';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** GET /api/cpu-budget — current CPU window state (§8). */
export const GET = handle(async () => {
  return ok(await getCpuBudget());
});
