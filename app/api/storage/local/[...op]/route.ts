// SPDX-License-Identifier: MIT
import { handle, apiError } from '@/lib/api/route-utils';
import { verifyToken } from '@/lib/storage/local';

export const runtime = 'nodejs';
export const maxDuration = 300;

type Ctx = { params: Promise<{ op: string[] }> };

/**
 * Local-driver presigned-URL endpoint (dev/QA only — active when no R2 env
 * is configured). Every op verifies the HMAC token before touching disk;
 * the key space is constrained to the storage layout (no '..').
 */
export const GET = handle(async (req: Request, ctx: Ctx) => {
  const { op } = await ctx.params;
  const action = op[0];
  const url = new URL(req.url);
  const key = url.searchParams.get('key') ?? '';
  const exp = Number(url.searchParams.get('exp') ?? '0');
  const sig = url.searchParams.get('sig') ?? '';

  if (!key || key.includes('..') || key.startsWith('/') || !/^[\w./+-]+$/.test(key)) {
    return apiError('validation', 'invalid key', 400);
  }

  if (action === 'get') {
    const disp = url.searchParams.get('disp') ?? '';
    const ct = url.searchParams.get('ct') ?? '';
    const fn = url.searchParams.get('fn') ?? '';
    if (!verifyToken('get', key, exp, sig, `${disp}:${ct}:${fn}`)) {
      return apiError('unauthorized', 'bad or expired token', 401);
    }
    const { LocalStorageDriver } = await import('@/lib/storage/local');
    const driver = new LocalStorageDriver();
    let bytes: Uint8Array;
    try {
      bytes = await driver.getBytes(key);
    } catch {
      return apiError('not_found', 'object not found', 404);
    }
    const headers: Record<string, string> = {
      'Content-Type': ct || 'application/octet-stream',
      'Cache-Control': 'private, max-age=240',
    };
    if (disp === 'attachment') {
      headers['Content-Disposition'] = `attachment; filename="${fn.replace(/"/g, '') || key.split('/').pop()}"`;
    } else {
      headers['Content-Disposition'] = 'inline';
    }
    return new Response(Buffer.from(bytes), { headers });
  }

  return apiError('not_found', 'unknown local storage op', 404);
});

export const PUT = handle(async (req: Request, ctx: Ctx) => {
  const { op } = await ctx.params;
  if (op[0] !== 'put') return apiError('not_found', 'unknown local storage op', 404);
  const url = new URL(req.url);
  const key = url.searchParams.get('key') ?? '';
  const exp = Number(url.searchParams.get('exp') ?? '0');
  const sig = url.searchParams.get('sig') ?? '';
  const contentType = url.searchParams.get('ct') ?? 'application/octet-stream';

  if (!key || key.includes('..') || key.startsWith('/') || !/^[\w./+-]+$/.test(key)) {
    return apiError('validation', 'invalid key', 400);
  }
  if (!verifyToken('put', key, exp, sig, contentType)) {
    return apiError('unauthorized', 'bad or expired token', 401);
  }
  const reqCt = req.headers.get('content-type')?.split(';')[0]?.trim() ?? '';
  if (reqCt !== contentType) {
    return apiError('validation', 'Content-Type must match the signed type', 400);
  }
  const bytes = Buffer.from(await req.arrayBuffer());
  if (bytes.length > 200 * 1024 * 1024) return apiError('too_large', 'per-photo cap is 200MB', 413);
  const { LocalStorageDriver } = await import('@/lib/storage/local');
  const driver = new LocalStorageDriver();
  await driver.putBytes(key, bytes, { contentType });
  return new Response(JSON.stringify({ ok: true, key }), {
    headers: { 'Content-Type': 'application/json' },
  });
});
