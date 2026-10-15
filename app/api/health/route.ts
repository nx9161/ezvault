// SPDX-License-Identifier: MIT
import { handle, ok } from '@/lib/api/route-utils';

export const runtime = 'nodejs';
export const maxDuration = 300;

interface CodecStatus {
  name: string;
  status: 'ok' | 'missing' | 'error';
  detail?: string;
}

async function probeCodecs(): Promise<CodecStatus[]> {
  const results: CodecStatus[] = [];
  // sharp / libvips (thumb pipeline, B22 LGPL-2.1 dynamic link).
  try {
    const sharp = (await import('sharp')).default;
    const fmt = sharp.format;
    results.push({ name: 'sharp/libvips', status: 'ok', detail: `formats: ${Object.keys(fmt).length}` });
  } catch (err) {
    results.push({ name: 'sharp/libvips', status: 'error', detail: String(err).slice(0, 200) });
  }
  // sql.js WASM (vendored, .tpy wizard).
  try {
    await import('@/lib/import/tpy').then((m) => m.TPY_APPLICATION_ID);
    results.push({ name: 'sql.js', status: 'ok', detail: 'vendored WASM' });
  } catch (err) {
    results.push({ name: 'sql.js', status: 'error', detail: String(err).slice(0, 200) });
  }
  // jsonld expansion.
  try {
    await import('jsonld');
    results.push({ name: 'jsonld', status: 'ok' });
  } catch (err) {
    results.push({ name: 'jsonld', status: 'error', detail: String(err).slice(0, 200) });
  }
  return results;
}

/**
 * GET /api/health — neon / r2 / queue / codec status.
 * 200 when the service can serve; 503 when a hard dependency is down.
 */
export const GET = handle(async () => {
  const checks: Record<string, { status: string; detail?: string }> = {};

  // Neon (hard dependency).
  try {
    const { sql } = await import('@/lib/db/index');
    const r = await sql()`SELECT 1 AS ok`;
    checks['neon'] = r.length ? { status: 'ok' } : { status: 'error', detail: 'empty result' };
  } catch (err) {
    checks['neon'] = { status: 'error', detail: String(err).slice(0, 200) };
  }

  // R2 / storage driver (hard dependency for media; local driver counts as ok).
  try {
    const { getStorageDriver } = await import('@/lib/storage/driver');
    const storage = await getStorageDriver();
    checks['storage'] = { status: 'ok', detail: storage.name };
  } catch (err) {
    checks['storage'] = { status: 'error', detail: String(err).slice(0, 200) };
  }

  // Queue (import_jobs reachable when DB is up).
  try {
    const { sql } = await import('@/lib/db/index');
    const r = await sql()`SELECT COUNT(*)::int AS c FROM import_jobs`;
    checks['queue'] = { status: 'ok', detail: `${r[0]['c']} jobs` };
  } catch (err) {
    checks['queue'] = { status: 'error', detail: String(err).slice(0, 200) };
  }

  // Codecs.
  const codecs = await probeCodecs();
  checks['codecs'] = {
    status: codecs.every((c) => c.status === 'ok') ? 'ok' : 'degraded',
    detail: codecs.map((c) => `${c.name}:${c.status}`).join(','),
  };

  const degraded = Object.values(checks).some((c) => c.status === 'error');
  const payload = { status: degraded ? 'degraded' : 'ok', checks, at: new Date().toISOString() };
  return new Response(JSON.stringify(payload), {
    status: degraded ? 503 : 200,
    headers: { 'Content-Type': 'application/json' },
  });
});
