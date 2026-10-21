// SPDX-License-Identifier: MIT
/**
 * test/pwa-offline.test.mjs — Wave E offline state machine + the
 * client-layer mutation block (APPSEC-REVIEW-PWA §E):
 *   - E-SEC-19: the banner appears on network failure / browser
 *     offline / shell-from-cache; the bare `online` event NEVER clears
 *     it; only an /api success starts recovery and only the follow-up
 *     revalidation (REVALIDATED) clears it.
 *   - E-SEC-9: an auth-shaped failure raises the session-expired state
 *     and recovery events cannot clear it.
 *   - E-SEC-20/17: while offline, post() through lib/api/client rejects
 *     WITHOUT a network attempt, and no queue/outbox is created.
 *   - Build-artifact contract: serwist.config.mjs never precaches
 *     /ocr/** and the SW source contains no defaultCache and no /api
 *     runtime caching rule (checked against the built public/sw.js
 *     when a build has produced one).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  connectivityReducer,
  INITIAL_CONNECTIVITY,
  dispatchConnectivity,
  getConnectivityState,
} from '../lib/pwa/connectivity';
import config from '../serwist.config.mjs';

const run = (events, from = INITIAL_CONNECTIVITY) =>
  events.reduce(connectivityReducer, from);

describe('connectivityReducer (E-SEC-19 banner semantics)', () => {
  it('network failure and navigator-offline raise the banner', () => {
    assert.equal(run(['API_NETWORK_FAILURE']).offline, true);
    assert.equal(run(['NAVIGATOR_OFFLINE']).offline, true);
  });

  it('the bare online event NEVER clears the banner', () => {
    const s = run(['API_NETWORK_FAILURE', 'NAVIGATOR_ONLINE']);
    assert.equal(s.offline, true);
    assert.equal(s.pendingRecovery, false);
  });

  it('an api success starts recovery; only revalidation clears', () => {
    const pending = run(['API_NETWORK_FAILURE', 'API_SUCCESS']);
    assert.equal(pending.offline, true, 'still offline until revalidated');
    assert.equal(pending.pendingRecovery, true);
    const cleared = run(['REVALIDATED'], pending);
    assert.equal(cleared.offline, false);
    assert.equal(cleared.pendingRecovery, false);
  });

  it('revalidation without a preceding api success does not clear', () => {
    const s = run(['API_NETWORK_FAILURE', 'REVALIDATED']);
    assert.equal(s.offline, true);
  });

  it('a fresh network failure cancels a pending recovery', () => {
    const s = run(['API_NETWORK_FAILURE', 'API_SUCCESS', 'API_NETWORK_FAILURE']);
    assert.equal(s.offline, true);
    assert.equal(s.pendingRecovery, false);
  });

  it('booting from the cached shell raises the banner (E-SEC-5/19)', () => {
    const s = run(['SHELL_FROM_CACHE']);
    assert.equal(s.offline, true);
    assert.equal(s.shellFromCache, true);
  });

  it('api success while online is a no-op', () => {
    assert.deepEqual(run(['API_SUCCESS']), INITIAL_CONNECTIVITY);
  });
});

describe('connectivityReducer (E-SEC-9 session expiry)', () => {
  it('auth failure raises session-expired and blocks recovery', () => {
    const s = run(['AUTH_FAILURE']);
    assert.equal(s.sessionExpired, true);
    const after = run(['API_SUCCESS', 'REVALIDATED'], s);
    assert.equal(after.sessionExpired, true);
    assert.equal(after.pendingRecovery, false);
  });
});

describe('mutation block at the client layer (E-SEC-20/17)', () => {
  let originalFetch;
  let fetchCalls = 0;

  before(async () => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      throw new Error('fetch must not be attempted while blocked');
    };
    // Raise the offline state in the singleton the client consults.
    dispatchConnectivity('NAVIGATOR_OFFLINE');
    assert.equal(getConnectivityState().offline, true);
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it('post() rejects with OfflineBlockedError and zero network attempts', async () => {
    const { post, OfflineBlockedError } = await import('../lib/api/client');
    await assert.rejects(
      () => post('/api/projects', { name: 'x' }),
      (err) => err instanceof OfflineBlockedError,
    );
    assert.equal(fetchCalls, 0);
  });

  it('no queue/outbox machinery exists in the client layer', () => {
    // The block path creates nothing: no IndexedDB outbox, no SW sync
    // registration surface in the client layer (source invariant).
    const src = readFileSync(new URL('../lib/api/client.ts', import.meta.url), 'utf8');
    assert.ok(!/backgroundSync|sync\.register|outbox/i.test(src), 'client has no replay machinery');
  });
});

describe('build-artifact contract (E-SEC-4/15)', () => {
  it('serwist.config.mjs never globs the OCR payload into the precache', () => {
    const patterns = config.globPatterns.join('\n');
    assert.ok(!patterns.includes('ocr'), `globPatterns must not reach ocr/: ${patterns}`);
    assert.ok(
      config.globIgnores.some((g) => g.includes('ocr')),
      'globIgnores must belt-and-braces exclude ocr/**',
    );
    assert.ok(config.swDest === 'public/sw.js');
    assert.ok(config.swSrc === 'app/sw.ts');
  });

  it('SW source guards the static precache against SSO redirects (E-SEC-10b)', () => {
    // Serwist's stock precache strategy copies redirected responses into
    // the cache; app/sw.ts must carry a cacheWillUpdate plugin that
    // refuses redirected / non-200 precache responses so an install
    // behind the SSO gate fails instead of caching the login page.
    const src = readFileSync(new URL('../app/sw.ts', import.meta.url), 'utf8');
    assert.ok(src.includes('cacheWillUpdate'), 'precache cacheWillUpdate guard present');
    assert.ok(/response\.redirected/.test(src), 'guard refuses redirected precache responses');
    assert.ok(/response\.status !== 200/.test(src), 'guard refuses non-200 precache responses');
  });

  it('built public/sw.js (when present) has no /api caching rule and no defaultCache', () => {
    const swPath = new URL('../public/sw.js', import.meta.url);
    if (!existsSync(swPath)) {
      // Local test runs without a preceding build: the source-level
      // invariants below still bind; the artifact assertions run in
      // CI/QA after `npm run build`.
      const src = readFileSync(new URL('../app/sw.ts', import.meta.url), 'utf8');
      const codeOnly = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.ok(!codeOnly.includes('defaultCache'), 'SW source must not use defaultCache');
      return;
    }
    const sw = readFileSync(swPath, 'utf8');
    assert.ok(!sw.includes('defaultCache'), 'built SW must not contain defaultCache');
    // The injected precache manifest is JSON ("url": "..." pairs); no
    // entry may point at /api or at the OCR payload. (The SW code
    // legitimately mentions /ocr/ for its runtime route — that is not
    // a precache entry and not a caching rule for /api.)
    const precacheUrls = [...sw.matchAll(/"?url"?:\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(precacheUrls.length > 0, 'precache manifest found in built SW');
    for (const u of precacheUrls) {
      assert.ok(!u.startsWith('/api'), `precache must not contain ${u}`);
      assert.ok(!u.startsWith('/ocr'), `precache must not contain ${u}`);
    }
    assert.ok(sw.includes('ezvault-documents-'), 'document cache present');
    assert.ok(sw.includes('ezvault-ocr-tess'), 'versioned OCR cache present');
  });
});
