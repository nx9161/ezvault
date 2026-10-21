// SPDX-License-Identifier: MIT
/**
 * test/pwa-routing.test.mjs — Wave E service-worker routing policy
 * (APPSEC-REVIEW-PWA). lib/pwa/routing.ts is the pure module app/sw.ts
 * imports, so these tables ARE the SW's route-table decisions:
 *   - E-SEC-16 exclusion table (evaluated first): /api/**, cross-origin
 *     presigned R2, /_vercel/**, /sw.js, non-GET/HEAD, Range — bypass;
 *     lookalikes (/apiary, /api%2f.., uppercase) are NOT api paths.
 *   - E-SEC-4: OCR assets cache-first only from the exact allowlist,
 *     and never with a query string.
 *   - E-SEC-6/25: the cache.put guard refuses every auth-shaped /
 *     incomplete / wrong-type response class.
 *   - E-SEC-9: auth-shaped API failure detection.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRequest,
  isApiPath,
  isShellPath,
  shellPathFor,
  isCacheableResponse,
  isAuthShapedFailure,
  OCR_ASSET_PATHS,
  PROJECT_SHELL_PATH,
} from '../lib/pwa/routing';

const ORIGIN = 'https://ezvault.example';
const facts = (url, extra = {}) => ({
  url,
  origin: ORIGIN,
  method: 'GET',
  mode: 'cors',
  hasRange: false,
  ...extra,
});

describe('classifyRequest — E-SEC-16 exclusion table (bypass first)', () => {
  const bypassCases = [
    ['api projects list', `${ORIGIN}/api/projects`],
    ['api health', `${ORIGIN}/api/health`],
    ['api cron', `${ORIGIN}/api/cron/nightly`],
    ['api photo file route', `${ORIGIN}/api/projects/p1/photos/ph1/file`],
    ['api export zip', `${ORIGIN}/api/projects/p1/export/zip`],
    ['api storage local driver', `${ORIGIN}/api/storage/local/get?k=x`],
    ['bare /api', `${ORIGIN}/api`],
    ['vercel platform path', `${ORIGIN}/_vercel/insights/view`],
    ['the SW script itself', `${ORIGIN}/sw.js`],
    ['cross-origin R2 presigned', 'https://acct.r2.cloudflarestorage.com/originals/a.jpg?X-Amz-Signature=abc'],
    ['cross-origin anything', 'https://example.com/api/projects'],
  ];
  for (const [name, url] of bypassCases) {
    it(`bypasses ${name}`, () => {
      assert.equal(classifyRequest(facts(url)), 'bypass');
    });
  }

  it('bypasses every non-GET/HEAD method, even same-origin (E-SEC-17)', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      assert.equal(
        classifyRequest(facts(`${ORIGIN}/api/projects`, { method })),
        'bypass',
      );
      assert.equal(
        classifyRequest(facts(`${ORIGIN}/_next/static/chunks/a.js`, { method })),
        'bypass',
      );
    }
  });

  it('bypasses Range requests (E-SEC-23)', () => {
    assert.equal(
      classifyRequest(facts(`${ORIGIN}/media/clip.mp4`, { hasRange: true })),
      'bypass',
    );
    assert.equal(
      classifyRequest(facts(`${ORIGIN}/ocr/worker.min.js`, { hasRange: true })),
      'bypass',
    );
  });

  it('bypasses unparseable URLs', () => {
    assert.equal(classifyRequest(facts(':::not a url')), 'bypass');
  });
});

describe('classifyRequest — lookalikes are NOT api paths (E-SEC-16)', () => {
  it('/apiary is a normal app path', () => {
    assert.equal(isApiPath('/apiary'), false);
    assert.equal(
      classifyRequest(facts(`${ORIGIN}/apiary`, { mode: 'navigate' })),
      'navigation',
    );
  });
  it('/api%2f.. is not an api path', () => {
    assert.equal(isApiPath('/api%2f..'), false);
  });
  it('uppercase /API is not an api path (routes are case-sensitive)', () => {
    assert.equal(isApiPath('/API/projects'), false);
    assert.equal(isApiPath('/Api/health'), false);
  });
  it('exact api segments are api paths', () => {
    assert.equal(isApiPath('/api'), true);
    assert.equal(isApiPath('/api/'), true);
    assert.equal(isApiPath('/api/projects'), true);
  });
});

describe('classifyRequest — navigations, OCR, static', () => {
  it('document navigations are network-first class', () => {
    assert.equal(classifyRequest(facts(`${ORIGIN}/`, { mode: 'navigate' })), 'navigation');
    assert.equal(classifyRequest(facts(`${ORIGIN}/abc-project-id`, { mode: 'navigate' })), 'navigation');
  });
  it('OCR allowlist assets are ocr class; query strings bypass (E-SEC-4/15)', () => {
    for (const p of OCR_ASSET_PATHS) {
      assert.equal(classifyRequest(facts(`${ORIGIN}${p}`)), 'ocr', p);
      assert.equal(classifyRequest(facts(`${ORIGIN}${p}?x=poison`)), 'bypass', `${p}?x=poison`);
    }
  });
  it('non-allowlisted /ocr paths are not ocr class', () => {
    assert.equal(classifyRequest(facts(`${ORIGIN}/ocr/evil.js`)), 'static');
    assert.equal(classifyRequest(facts(`${ORIGIN}/ocr/lang/deu.traineddata.gz`)), 'static');
  });
  it('static assets fall to the precache route class', () => {
    assert.equal(classifyRequest(facts(`${ORIGIN}/_next/static/chunks/a.js`)), 'static');
    assert.equal(classifyRequest(facts(`${ORIGIN}/icons/icon-192.png`)), 'static');
    assert.equal(classifyRequest(facts(`${ORIGIN}/manifest.webmanifest`)), 'static');
    assert.equal(classifyRequest(facts(`${ORIGIN}/favicon.ico`)), 'static');
  });
});

describe('shell paths (E-SEC-5)', () => {
  it('home and single-segment project routes are shells', () => {
    assert.equal(isShellPath('/'), true);
    assert.equal(isShellPath('/some-project-id'), true);
    assert.equal(isShellPath('/apiary'), true);
  });
  it('reserved and multi-segment paths are not shells', () => {
    for (const p of ['/api/projects', '/ocr/worker.min.js', '/_next/static/a.js', '/_vercel/x', '/icons/icon-192.png', '/sw.js', '/manifest.webmanifest', '/favicon.ico', '/a/b']) {
      assert.equal(isShellPath(p), false, p);
    }
  });
  it('shellPathFor maps projects to the representative shell document', () => {
    assert.equal(shellPathFor('/'), '/');
    assert.equal(shellPathFor('/my-project'), PROJECT_SHELL_PATH);
    assert.equal(shellPathFor('/a/b'), null);
  });
});

describe('isCacheableResponse — the E-SEC-6/25 put guard', () => {
  const make = ({ status = 200, type = 'basic', redirected = false, headers = {} } = {}) => ({
    status,
    type,
    redirected,
    header: (name) => headers[name] ?? null,
  });
  const html = { 'content-type': 'text/html; charset=utf-8' };

  it('accepts a clean 200 HTML document', () => {
    assert.equal(isCacheableResponse(make({ headers: html }), 'document'), true);
  });
  it('refuses non-200 statuses', () => {
    for (const status of [201, 204, 301, 302, 401, 403, 404, 500, 206]) {
      assert.equal(isCacheableResponse(make({ status, headers: html }), 'document'), false, String(status));
    }
  });
  it('refuses redirected responses (SSO bounce)', () => {
    assert.equal(isCacheableResponse(make({ redirected: true, headers: html }), 'document'), false);
  });
  it('refuses opaque / opaqueredirect / cors types', () => {
    for (const type of ['opaque', 'opaqueredirect', 'cors', 'error']) {
      assert.equal(isCacheableResponse(make({ type, headers: html }), 'document'), false, type);
    }
  });
  it('refuses Set-Cookie and attachment dispositions', () => {
    assert.equal(
      isCacheableResponse(make({ headers: { ...html, 'set-cookie': 'a=b' } }), 'document'),
      false,
    );
    assert.equal(
      isCacheableResponse(make({ headers: { ...html, 'content-disposition': 'attachment; filename="x.zip"' } }), 'document'),
      false,
    );
  });
  it('refuses Vary: *', () => {
    assert.equal(isCacheableResponse(make({ headers: { ...html, vary: '*' } }), 'document'), false);
    assert.equal(isCacheableResponse(make({ headers: { ...html, vary: 'Accept-Encoding, *' } }), 'document'), false);
    assert.equal(isCacheableResponse(make({ headers: { ...html, vary: 'Accept-Encoding' } }), 'document'), true);
  });
  it('enforces the per-class content-type allowlist', () => {
    assert.equal(isCacheableResponse(make({ headers: { 'content-type': 'application/json' } }), 'document'), false);
    assert.equal(isCacheableResponse(make({ headers: { 'content-type': 'application/wasm' } }), 'ocr'), true);
    assert.equal(isCacheableResponse(make({ headers: { 'content-type': 'application/gzip' } }), 'ocr'), true);
    assert.equal(isCacheableResponse(make({ headers: { 'content-type': 'text/javascript' } }), 'ocr'), true);
    assert.equal(isCacheableResponse(make({ headers: { 'content-type': 'text/html' } }), 'ocr'), false);
    assert.equal(isCacheableResponse(make({ headers: { 'content-type': 'text/css' } }), 'static'), true);
    assert.equal(isCacheableResponse(make({ headers: { 'content-type': 'image/png' } }), 'static'), true);
    assert.equal(isCacheableResponse(make({ headers: {} }), 'static'), false);
  });
});

describe('isAuthShapedFailure (E-SEC-9)', () => {
  const base = { status: 200, contentType: 'application/json', redirected: false, responseUrl: `${ORIGIN}/api/projects`, origin: ORIGIN };
  it('plain JSON 200/4xx-business responses are not auth-shaped', () => {
    assert.equal(isAuthShapedFailure(base), false);
    assert.equal(isAuthShapedFailure({ ...base, status: 404 }), false);
    assert.equal(isAuthShapedFailure({ ...base, status: 429 }), false);
    assert.equal(isAuthShapedFailure({ ...base, status: 500 }), false);
  });
  it('401 and 403 are auth-shaped', () => {
    assert.equal(isAuthShapedFailure({ ...base, status: 401 }), true);
    assert.equal(isAuthShapedFailure({ ...base, status: 403 }), true);
  });
  it('HTML on an API call is auth-shaped (platform gate)', () => {
    assert.equal(isAuthShapedFailure({ ...base, contentType: 'text/html; charset=utf-8' }), true);
  });
  it('a redirect landing off-origin is auth-shaped', () => {
    assert.equal(
      isAuthShapedFailure({ ...base, redirected: true, responseUrl: 'https://vercel.com/sso/login' }),
      true,
    );
    assert.equal(
      isAuthShapedFailure({ ...base, redirected: true, responseUrl: `${ORIGIN}/api/projects` }),
      false,
    );
  });
});
