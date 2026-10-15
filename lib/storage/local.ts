// SPDX-License-Identifier: MIT
import 'server-only';

/**
 * lib/storage/local.ts — filesystem StorageDriver for local dev/QA.
 *
 * Selected automatically when no R2 env vars are present. "Presigned" URLs
 * point at the in-app `/api/storage/local/*` routes, which verify an
 * HMAC-SHA256 token (key + expiry + operation) before touching disk.
 *
 * Root: $EZVAULT_LOCAL_STORAGE_DIR, default `<cwd>/.local-storage`
 * (gitignored — never committed). Set LOCAL_STORAGE_SECRET for stable
 * presigned URLs across restarts; otherwise a per-process secret is used.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { StorageDriver, HeadInfo, PresignGetOptions } from './driver';

const PUT_TTL_SEC = 15 * 60;
const GET_TTL_SEC = 5 * 60;

function rootDir(): string {
  return resolve(process.env.EZVAULT_LOCAL_STORAGE_DIR || join(process.cwd(), '.local-storage'));
}

export function localSecret(): string {
  if (process.env.LOCAL_STORAGE_SECRET) return process.env.LOCAL_STORAGE_SECRET;
  const g = globalThis as { __ezvaultLocalSecret?: string };
  if (!g.__ezvaultLocalSecret) {
    g.__ezvaultLocalSecret = `ephemeral-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
  return g.__ezvaultLocalSecret;
}

/** Reject path traversal; keys are always relative posix-style paths. */
export function assertSafeKey(key: string): void {
  if (!key || key.startsWith('/') || key.includes('..') || key.includes('\\')) {
    throw new Error(`unsafe storage key: ${key}`);
  }
}

export function signToken(op: 'put' | 'get', key: string, exp: number, extra = ''): string {
  return createHmac('sha256', localSecret()).update(`${op}:${key}:${exp}:${extra}`).digest('hex');
}

export function verifyToken(
  op: 'put' | 'get',
  key: string,
  exp: number,
  sig: string,
  extra = '',
): boolean {
  if (!Number.isFinite(exp) || Date.now() > exp * 1000) return false;
  const expected = signToken(op, key, exp, extra);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(sig, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Absolute disk path for a storage key. */
export function diskPath(key: string): string {
  assertSafeKey(key);
  const root = rootDir();
  const abs = resolve(root, ...key.split('/'));
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`unsafe storage key: ${key}`);
  return abs;
}

export class LocalStorageDriver implements StorageDriver {
  readonly name = 'local' as const;

  private baseUrl(): string {
    // In-app route base for presigned URLs; relative keeps it host-agnostic.
    return '/api/storage/local';
  }

  async presignPut(key: string, contentType: string, ttlSec = PUT_TTL_SEC): Promise<string> {
    assertSafeKey(key);
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const sig = signToken('put', key, exp, contentType);
    return `${this.baseUrl()}/put?key=${encodeURIComponent(key)}&exp=${exp}&ct=${encodeURIComponent(contentType)}&sig=${sig}`;
  }

  async presignGet(key: string, opts: PresignGetOptions = {}): Promise<string> {
    assertSafeKey(key);
    const exp = Math.floor(Date.now() / 1000) + (opts.ttlSec ?? GET_TTL_SEC);
    const extra = `${opts.disposition ?? ''}:${opts.contentType ?? ''}:${opts.filename ?? ''}`;
    const sig = signToken('get', key, exp, extra);
    const q = new URLSearchParams({
      key,
      exp: String(exp),
      disp: opts.disposition ?? '',
      ct: opts.contentType ?? '',
      fn: opts.filename ?? '',
      sig,
    });
    return `${this.baseUrl()}/get?${q.toString()}`;
  }

  async head(key: string): Promise<HeadInfo | null> {
    try {
      const st = await fs.stat(diskPath(key));
      return { size: st.size, lastModified: st.mtime.toISOString() };
    } catch {
      return null;
    }
  }

  async getRange(key: string, start: number, end: number): Promise<Buffer> {
    const fh = await fs.open(diskPath(key), 'r');
    try {
      const len = end - start + 1;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, start);
      return buf.subarray(0, bytesRead);
    } finally {
      await fh.close();
    }
  }

  async getBytes(key: string): Promise<Buffer> {
    const { readFile } = await import('node:fs/promises');
    return readFile(diskPath(key));
  }

  async putBytes(
    key: string,
    body: Buffer,
    opts: { contentType?: string; metadata?: Record<string, string> } = {},
  ): Promise<void> {
    const p = diskPath(key);
    await fs.mkdir(join(p, '..'), { recursive: true });
    await fs.writeFile(p, body);
    if (opts.metadata) {
      await fs.writeFile(p + '.meta.json', JSON.stringify({ contentType: opts.contentType, metadata: opts.metadata }));
    }
  }

  async copy(srcKey: string, destKey: string): Promise<void> {
    const dest = diskPath(destKey);
    await fs.mkdir(join(dest, '..'), { recursive: true });
    await fs.copyFile(diskPath(srcKey), dest);
  }

  async delete(key: string): Promise<void> {
    try {
      await fs.unlink(diskPath(key));
    } catch { /* missing = deleted */ }
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (const k of keys) await this.delete(k);
  }

  async listKeys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, rel: string) => {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.endsWith('.meta.json')) continue;
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(join(dir, e.name), r);
        else if (r.startsWith(prefix)) out.push(r);
      }
    };
    await walk(rootDir(), '');
    return out;
  }
}
