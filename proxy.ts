// SPDX-License-Identifier: MIT
/**
 * proxy.ts — Next 16 middleware (renamed from middleware.ts per Next 16;
 * middleware.ts is deprecated and is NOT shipped — CONTRACT.md records the
 * rename).
 *
 * Edge duties (stateless, durable-free):
 *   1. CSRF: Origin/Referer allowlist check on mutating routes (POST/PUT/
 *      PATCH/DELETE) — defense-in-depth; route handlers re-check.
 *   2. Strict Content-Security-Policy with ZERO inline scripts (no
 *      'unsafe-inline' in script-src).
 *   3. Security headers (HSTS, X-Frame-Options, etc.).
 *   4. Best-effort in-memory token bucket as the OUTER rate-limit layer
 *      (durable Neon rate_buckets enforce inside the route handlers —
 *      lib/ratelimit.ts — which is the binding layer, B16).
 */
import { NextResponse, type NextRequest } from 'next/server';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// Same-origin enforcement: the app is single-user; mutating calls must come
// from our own deployment host (or localhost in dev).
function originAllowed(req: NextRequest): boolean {
  const origin = req.headers.get('origin');
  const referer = req.headers.get('referer');
  const host = req.headers.get('host') ?? '';
  const check = (v: string | null): boolean => {
    if (!v) return false;
    try {
      return new URL(v).host === host;
    } catch {
      return false;
    }
  };
  if (!origin && !referer) return true; // same-origin navigations / curl have neither
  return check(origin) || check(referer);
}

// Best-effort in-memory token bucket (outer layer; resets on deploy).
const BUCKET_SIZE = 600; // per minute per ip+route-class
const buckets = new Map<string, { tokens: number; resetAt: number }>();
function tokenBucketOk(key: string): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { tokens: BUCKET_SIZE, resetAt: now + 60_000 };
    buckets.set(key, b);
  }
  if (b.tokens <= 0) return false;
  b.tokens -= 1;
  return true;
}

export function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // CSRF on mutating routes only (GET navigations and the local-driver
  // presigned URLs must not be blocked by missing Origin headers).
  if (MUTATING.has(req.method)) {
    if (!originAllowed(req)) {
      return NextResponse.json(
        { error: { code: 'csrf', message: 'cross-origin mutation rejected' } },
        { status: 403 },
      );
    }
    // Outer token bucket: per IP, separately for /api/import/* + /export/*
    // (the expensive paths) vs everything else.
    const expensive = pathname.startsWith('/api/import/') || pathname.includes('/export/');
    const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
    if (!tokenBucketOk(`${ip}:${expensive ? 'exp' : 'std'}`)) {
      return NextResponse.json(
        { error: { code: 'rate_limited', message: 'slow down' } },
        { status: 429, headers: { 'Retry-After': '60' } },
      );
    }
  }

  const res = NextResponse.next();

  // Strict CSP — zero inline scripts. (Vercel Authentication challenge
  // pages are platform-hosted and unaffected.)
  res.headers.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'", // no unsafe-inline, ever
      "style-src 'self' 'unsafe-inline'", // TipTap/prose needs inline styles
      "img-src 'self' blob: data:",
      "connect-src 'self'",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "base-uri 'self'",
      'upgrade-insecure-requests',
    ].join('; '),
  );
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.headers.set(
    'Strict-Transport-Security',
    'max-age=63072000; includeSubDomains; preload',
  );
  return res;
}

export const config = {
  matcher: ['/api/:path*', '/((?!_next/static|_next/image|favicon.ico).*)'],
};
