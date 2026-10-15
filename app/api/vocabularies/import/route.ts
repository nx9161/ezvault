// SPDX-License-Identifier: MIT
import { handle, ok, parseCappedJson, apiError } from '@/lib/api/route-utils';
import { importVocabulary } from '@/lib/import/vocab';
import { requireRateLimit } from '@/lib/ratelimit';

export const runtime = 'nodejs';
export const maxDuration = 300;

/** Import .ttl/.n3 (B12: 50k triple cap, streaming parser; B11-capped body). */
export const POST = handle(async (req: Request) => {
  await requireRateLimit('vocabularies:import');
  const body = await parseCappedJson<{ source?: string; format?: 'turtle' | 'n3' }>(req);
  const source = body.source ?? '';
  if (!source.trim()) return apiError('validation', 'source (Turtle/N3 text) is required', 400);
  if (body.format && !['turtle', 'n3'].includes(body.format)) {
    return apiError('validation', 'format must be turtle|n3', 400);
  }
  const result = await importVocabulary(source, body.format ?? 'turtle');
  return ok(result, 201);
});
