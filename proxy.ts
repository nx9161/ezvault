// SPDX-License-Identifier: MIT
/**
 * proxy.ts — Next 16 middleware (renamed from middleware.ts per Next 16;
 * middleware.ts is deprecated and is NOT shipped — CONTRACT.md records the
 * rename).
 *
 * Edge duties (stateless, durable-free):
 *   0. GLOBAL developer-token subset guard (Wave D fix B1): a presented
 *      `ezv_` bearer on any /api route outside the documented subset
 *      (lib/token-guard.ts) is denied 403 BEFORE anything else runs —
 *      a scoped token can never ride the human path on an unwired route.
 *   1. CSRF: Origin/Referer allowlist check on mutating routes (POST/PUT/
 *      PATCH/DELETE) — defense-in-depth; route handlers re-check.
 *   2. Strict Content-Security-Policy: executable inline code is admitted
 *      only when Next.js stamps it with the per-request nonce generated
 *      here (no 'unsafe-inline' in script-src).
 *   3. Security headers (HSTS, X-Frame-Options, etc.).
 *   4. Best-effort in-memory token bucket as the OUTER rate-limit layer
 *      (durable Neon rate_buckets enforce inside the route handlers —
 *      lib/ratelimit.ts — which is the binding layer, B16).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { tokenGuardDenies } from './lib/token-guard';

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

/**
 * Generate a fresh 128-bit CSP nonce for one request. The value is exposed
 * to the app through the x-nonce request header; the root layout reads it
 * for its one hand-written inline script, while Next.js uses the same
 * request CSP to stamp its framework/RSC bootstrap scripts.
 */
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * Build the Content-Security-Policy header value.
 *
 * The R2 host is read from env at request time (the presigned URLs the R2
 * driver mints live on https://<accountId>.r2.cloudflarestorage.com — F1):
 * upload PUTs and the 302-redirected viewer fetches/images would otherwise
 * be connect-src/img-src blocked in production. When R2 env is absent
 * (local dev -> the local driver serves same-origin), no R2 host is added
 * and local behavior is unchanged. A supplied nonce admits only Next's
 * nonce-stamped bootstrap/theme scripts; 'unsafe-inline' is never used.
 */
export function buildCspHeader(
  r2AccountId?: string | null,
  nonce?: string | null,
): string {
  const r2Hosts = r2AccountId ? ['https://*.r2.cloudflarestorage.com'] : [];
  const imgSrc = ["'self'", 'blob:', 'data:', ...r2Hosts].join(' ');
  const connectSrc = ["'self'", ...r2Hosts].join(' ');
  const scriptSrc = nonce
    ? `'self' 'nonce-${nonce}' 'strict-dynamic'`
    : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'", // TipTap/prose needs inline styles
    `img-src ${imgSrc}`,
    `connect-src ${connectSrc}`,
    "font-src 'self' data:",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export function proxy(req: NextRequest): NextResponse {
  const { pathname } = req.nextUrl;

  // B1 global token guard — runs BEFORE handlers (and before CSRF/rate
  // layers) on every /api route: a presented EZVault developer token
  // outside the documented subset is a 403, full stop. No-bearer human
  // requests and non-token bearers (cron secret) pass through untouched.
  if (
    pathname.startsWith('/api/') &&
    tokenGuardDenies({ method: req.method, pathname, authorization: req.headers.get('authorization') })
  ) {
    return NextResponse.json(
      {
        error: {
          code: 'forbidden',
          message: 'API tokens are restricted to the documented developer-API subset (DEVELOPER-API.md)',
        },
      },
      { status: 403 },
    );
  }

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

  const nonce = generateNonce();
  const csp = buildCspHeader(process.env.R2_ACCOUNT_ID, nonce);

  // Next.js looks for the request CSP + x-nonce while rendering and
  // stamps its inline RSC/hydration scripts (and only those) with this
  // request's nonce. The matching response CSP is set below.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });

  // Wave E (E-SEC-7): the service worker script itself is never cached
  // and always revalidated, so a new deployment's SW is detected
  // within one navigation. This header complement for /sw.js is the
  // ONLY proxy change Wave E makes (E-SEC-26).
  if (pathname === '/sw.js') {
    res.headers.set('Cache-Control', 'no-cache, max-age=0, must-revalidate');
  }

  // Strict CSP with a fresh per-request nonce. R2 host derived from
  // env at request time (F1). (Vercel Authentication challenge pages are
  // platform-hosted and unaffected.)
  res.headers.set('Content-Security-Policy', csp);
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
