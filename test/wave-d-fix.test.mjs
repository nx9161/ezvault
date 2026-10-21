// SPDX-License-Identifier: MIT
/**
 * test/wave-d-fix.test.mjs — Wave D QA-BLOCK fixes (QA-REPORT-PARITY-D).
 *
 *   B1 — token subset-denial is GLOBAL: the guard (lib/token-guard.ts,
 *   wired into proxy.ts before every handler) denies a presented `ezv_`
 *   bearer on every (method, path) outside the documented subset. The
 *   negative-space test walks the REAL route tree and asserts every
 *   exported route method is either in the subset or token-denied.
 *   B2 — fetch-guard IPv6: mapped/NAT64/6to4 embedded IPv4 unwrapped and
 *   range-checked in the canonical hex forms WHATWG URL produces;
 *   198.18/15 + documentation ranges rejected; byte cap streaming.
 *   B2-R — IPv4-translated ::ffff:0:0:0/96 (re-gate round 2) plus the
 *   full embedded-IPv4 scheme matrix: translated, compatible ::/96,
 *   NAT64 /48 in both embeddings, Teredo client (XOR-decoded), ISATAP.
 *   Findings 3/4/6 — Omeka sync-row persistence ordering + fetch
 *   hygiene (https/loopback, timeout, byte cap); IIIF failed/duplicate
 *   canvas cleanup + skipped counting (source invariants — the import
 *   pipeline needs a live DB, like the other wire tests).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NextRequest } from 'next/server';
import { proxy } from '../proxy';
import { TOKEN_SUBSET, tokenSubsetAllows, tokenGuardDenies, presentedApiToken } from '../lib/token-guard';
import { API_TOKEN_PREFIX } from '../lib/token-core';
import { assertPublicHttpsUrl, guardedFetchBytes, isPrivateIpv6, SsrfError } from '../lib/fetch-guard';
import { OmekaClient, OmekaError, normalizeOmekaBaseUrl } from '../lib/omeka/client';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const TOKEN = `Bearer ${API_TOKEN_PREFIX}${'A'.repeat(43)}`;

// ---------------------------------------------------------------- B1 guard

describe('B1: global token subset guard (unit)', () => {
  it('presented-token → POST /api/admin/delete-everything is denied', () => {
    assert.equal(tokenGuardDenies({ method: 'POST', pathname: '/api/admin/delete-everything', authorization: TOKEN }), true);
    assert.equal(tokenSubsetAllows('POST', '/api/admin/delete-everything'), false);
  });

  it('presented-token → project exports (zip/csv/jsonld) are denied', () => {
    for (const fmt of ['zip', 'csv', 'jsonld']) {
      assert.equal(
        tokenGuardDenies({ method: 'GET', pathname: `/api/projects/p1/export/${fmt}`, authorization: TOKEN }),
        true, fmt,
      );
    }
  });

  it('presented-token → POST trash/empty is denied', () => {
    assert.equal(tokenGuardDenies({ method: 'POST', pathname: '/api/projects/p1/trash/empty', authorization: TOKEN }), true);
  });

  it('presented-token → project DELETE is denied (undocumented method inside a documented file)', () => {
    assert.equal(tokenGuardDenies({ method: 'DELETE', pathname: '/api/projects/p1', authorization: TOKEN }), true);
    assert.equal(tokenGuardDenies({ method: 'PATCH', pathname: '/api/projects/p1', authorization: TOKEN }), true);
    assert.equal(tokenGuardDenies({ method: 'POST', pathname: '/api/projects', authorization: TOKEN }), true);
    assert.equal(tokenGuardDenies({ method: 'DELETE', pathname: '/api/projects/p1/notes/n1', authorization: TOKEN }), true);
    assert.equal(tokenGuardDenies({ method: 'DELETE', pathname: '/api/projects/p1/items/i1', authorization: TOKEN }), true);
  });

  it('all 12 documented subset (method, path) pairs pass the guard', () => {
    const documented = [
      ['GET', '/api/projects'],
      ['GET', '/api/projects/p1'],
      ['GET', '/api/projects/p1/items'],
      ['GET', '/api/projects/p1/items/i1'],
      ['GET', '/api/projects/p1/items/i1/photos'],
      ['GET', '/api/projects/p1/photos/ph1'],
      ['GET', '/api/projects/p1/photos/ph1/notes'],
      ['GET', '/api/projects/p1/selections/s1/notes'],
      ['GET', '/api/projects/p1/notes/n1'],
      ['POST', '/api/projects/p1/photos/ph1/notes'],
      ['POST', '/api/projects/p1/selections/s1/notes'],
      ['PATCH', '/api/projects/p1/notes/n1'],
    ];
    assert.equal(TOKEN_SUBSET.length, documented.length);
    for (const [method, pathname] of documented) {
      assert.equal(tokenGuardDenies({ method, pathname, authorization: TOKEN }), false, `${method} ${pathname}`);
    }
  });

  it('no bearer and non-token bearers (cron secret) are completely unaffected', () => {
    const path = '/api/admin/delete-everything';
    assert.equal(tokenGuardDenies({ method: 'POST', pathname: path, authorization: null }), false);
    assert.equal(tokenGuardDenies({ method: 'POST', pathname: path, authorization: undefined }), false);
    assert.equal(tokenGuardDenies({ method: 'POST', pathname: path, authorization: 'Bearer the-cron-secret' }), false);
    assert.equal(tokenGuardDenies({ method: 'GET', pathname: '/api/cron/nightly', authorization: 'Bearer the-cron-secret' }), false);
    assert.equal(presentedApiToken('Bearer the-cron-secret'), null);
    assert.equal(presentedApiToken(TOKEN), TOKEN.slice('Bearer '.length));
  });

  it('the guard only applies to /api paths', () => {
    assert.equal(tokenGuardDenies({ method: 'GET', pathname: '/projects/p1', authorization: TOKEN }), false);
    assert.equal(tokenGuardDenies({ method: 'GET', pathname: '/', authorization: TOKEN }), false);
  });

  it('guard prefix agrees with lib/token-core API_TOKEN_PREFIX (single spelling)', () => {
    assert.equal(API_TOKEN_PREFIX, 'ezv_');
    assert.ok(presentedApiToken(`Bearer ${API_TOKEN_PREFIX}x`) !== null);
  });
});

describe('B1: global token subset guard (through proxy.ts)', () => {
  const call = (pathname, method, authorization) =>
    proxy(new NextRequest(`https://ez.example.org${pathname}`, {
      method,
      headers: authorization ? { authorization } : {},
    }));

  it('proxy 403s a presented token on delete-everything, export, trash/empty, project DELETE', async () => {
    for (const [method, path] of [
      ['POST', '/api/admin/delete-everything'],
      ['GET', '/api/projects/p1/export/zip'],
      ['POST', '/api/projects/p1/trash/empty'],
      ['DELETE', '/api/projects/p1'],
      ['POST', '/api/api-tokens'],
    ]) {
      const res = call(path, method, TOKEN);
      assert.equal(res.status, 403, `${method} ${path}`);
      const body = await res.json();
      assert.equal(body.error.code, 'forbidden');
    }
  });

  it('proxy passes subset requests through to the handlers (scope checks live there)', () => {
    for (const [method, path] of [
      ['GET', '/api/projects'],
      ['GET', '/api/projects/p1/items'],
      ['POST', '/api/projects/p1/photos/ph1/notes'],
      ['PATCH', '/api/projects/p1/notes/n1'],
    ]) {
      assert.equal(call(path, method, TOKEN).status, 200, `${method} ${path}`);
    }
  });

  it('proxy leaves human (no-bearer) and cron-secret requests untouched', () => {
    assert.equal(call('/api/admin/delete-everything', 'POST', null).status, 200);
    assert.equal(call('/api/cron/nightly', 'GET', 'Bearer the-cron-secret').status, 200);
  });

  it('subset handlers keep their semantics: enforceTokenScope still gates validity/scope', () => {
    const auth = read('lib/token-auth.ts');
    assert.match(auth, /API token has been revoked/);
    assert.match(auth, /API token has expired/);
    assert.match(auth, /lacks the '\$\{needed\}' scope/);
    // proxy wires the guard before handlers.
    const proxySrc = read('proxy.ts');
    assert.match(proxySrc, /tokenGuardDenies/);
    assert.ok(proxySrc.indexOf('tokenGuardDenies') < proxySrc.indexOf('originAllowed(req)'),
      'guard must run before the CSRF/handler path');
  });
});

describe('B1: negative space — route tree walk', () => {
  const apiRoot = new URL('../app/api', import.meta.url).pathname;
  const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

  function routeFiles(dir) {
    const out = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...routeFiles(p));
      else if (name === 'route.ts') out.push(p);
    }
    return out;
  }
  function templateFor(file) {
    const rel = file.slice(apiRoot.length).split('/').filter(Boolean);
    rel.pop(); // route.ts
    return ['api', ...rel.map((s) => (/^\[.*\]$/.test(s) ? ':seg' : s))];
  }
  function methodsFor(src) {
    const out = new Set();
    for (const m of src.matchAll(/export const (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g)) out.add(m[1]);
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const name of m[1].split(',').map((s) => s.trim())) {
        if (METHODS.includes(name)) out.add(name);
      }
    }
    return [...out];
  }

  it('every exported /api route (method, path) is in the subset or token-denied by the guard', () => {
    const files = routeFiles(apiRoot);
    assert.ok(files.length >= 79, `expected the full route tree, got ${files.length} files`);
    let checked = 0;
    for (const file of files) {
      const segs = templateFor(file);
      const pathname = '/' + segs.join('/');
      for (const method of methodsFor(readFileSync(file, 'utf8'))) {
        checked++;
        const inSubset = tokenSubsetAllows(method, pathname);
        const denied = tokenGuardDenies({ method, pathname, authorization: TOKEN });
        assert.ok(inSubset !== denied,
          `${method} ${pathname} must be exactly one of subset/guard-denied (subset=${inSubset}, denied=${denied})`);
        assert.ok(inSubset || denied, `${method} ${pathname} is reachable with a presented token`);
      }
    }
    assert.ok(checked >= 100, `expected 100+ exported route methods, got ${checked}`);
  });

  it('the allowlist has no phantom entries: every subset pair is a real exported route', () => {
    const exported = new Set();
    for (const file of routeFiles(apiRoot)) {
      const pathname = '/' + templateFor(file).join('/');
      for (const method of methodsFor(readFileSync(file, 'utf8'))) exported.add(`${method} ${pathname}`);
    }
    for (const r of TOKEN_SUBSET) {
      assert.ok(exported.has(`${r.method} /${r.segments.join('/')}`), `phantom subset entry: ${r.method} /${r.segments.join('/')}`);
    }
  });
});

// ---------------------------------------------------------------- B2 fetch-guard

describe('B2: fetch-guard IPv6 embedded-IPv4 bypass', () => {
  it('rejects IPv4-mapped IPv6 in canonical hex form (QA probes)', () => {
    for (const bad of [
      'https://[::ffff:127.0.0.1]/x', // canonicalizes to [::ffff:7f00:1]
      'https://[::ffff:7f00:1]/x',
      'https://[0:0:0:0:0:ffff:127.0.0.1]/x',
      'https://[::ffff:0a00:1]/x', // 10.0.0.1
      'https://[::ffff:169.254.169.254]/latest/meta-data/',
      'https://[::ffff:a9fe:a9fe]/x', // 169.254.169.254
      'https://[::ffff:c0a8:101]/x', // 192.168.1.1
    ]) {
      assert.throws(() => assertPublicHttpsUrl(bad), SsrfError, bad);
    }
  });

  it('rejects NAT64-embedded private IPv4 (64:ff9b::/96 and 64:ff9b:1::/48)', () => {
    for (const bad of [
      'https://[64:ff9b::a9fe:a9fe]/x',
      'https://[64:ff9b::7f00:1]/x',
      'https://[64:ff9b::a00:1]/x',
      'https://[64:ff9b:1::a9fe:a9fe]/x',
      'https://[64:ff9b:1:a9fe:a9fe::]/x',
    ]) {
      assert.throws(() => assertPublicHttpsUrl(bad), SsrfError, bad);
    }
  });

  it('rejects 6to4 2002::/16 with a private embedded IPv4', () => {
    assert.throws(() => assertPublicHttpsUrl('https://[2002:7f00:1::]/x'), SsrfError);
    assert.throws(() => assertPublicHttpsUrl('https://[2002:a9fe:a9fe::]/x'), SsrfError);
    assert.throws(() => assertPublicHttpsUrl('https://[2002:0a00:0001::]/x'), SsrfError);
  });

  it('rejects benchmarking 198.18.0.0/15 and the documentation ranges', () => {
    for (const bad of [
      'https://198.18.0.1/x', 'https://198.19.255.254/x',
      'https://192.0.2.9/x', 'https://198.51.100.7/x', 'https://203.0.113.9/x',
    ]) {
      assert.throws(() => assertPublicHttpsUrl(bad), SsrfError, bad);
    }
  });

  it('regression: every previously-caught form is still rejected', () => {
    for (const bad of [
      'http://iiif.example.org/manifest.json',
      'https://127.0.0.1/x', 'https://127.5.6.7/x', 'https://0x7f.1/x', 'https://2130706433/x',
      'https://169.254.169.254/latest/meta-data/', 'https://10.0.0.5/x', 'https://172.16.4.4/x',
      'https://192.168.1.10/x', 'https://100.64.0.1/x', 'https://localhost/x', 'https://foo.localhost/x',
      'https://[::1]/x', 'https://[::]/x', 'https://[fe80::1]/x', 'https://[fd00::1]/x', 'https://[fc00::1]/x',
      'https://user:pass@iiif.example.org/x',
    ]) {
      assert.throws(() => assertPublicHttpsUrl(bad), SsrfError, bad);
    }
  });

  it('public embedded forms and public IPv6 stay allowed', () => {
    for (const good of [
      'https://iiif.example.org/m.json',
      'https://8.8.8.8/x',
      'https://[2606:4700:4700::1111]/x',
      'https://[::ffff:8.8.8.8]/x',
      'https://[::ffff:808:808]/x',
      'https://[64:ff9b::808:808]/x',
      'https://[2002:808:808::]/x',
      'https://198.17.0.1/x', // just outside 198.18/15
      'https://198.20.0.1/x',
    ]) {
      assertPublicHttpsUrl(good);
    }
    assert.equal(isPrivateIpv6('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateIpv6('::ffff:7f00:1'), true);
    assert.equal(isPrivateIpv6('::ffff:808:808'), false);
  });

  it('byte cap is streaming-enforced: the read aborts past the cap', async () => {
    let pulls = 0;
    const stream = new ReadableStream({
      pull(controller) {
        pulls++;
        if (pulls > 50) { controller.close(); return; }
        controller.enqueue(new Uint8Array(10).fill(65));
      },
    });
    const fetchImpl = async () => new Response(stream, { status: 200 });
    await assert.rejects(
      () => guardedFetchBytes('https://iiif.example.org/big', { fetchImpl, maxBytes: 25 }),
      SsrfError,
    );
    assert.ok(pulls <= 6, `reader must abort early — pulled ${pulls} chunks for a 25-byte cap`);
  });

  it('streamed body under the cap is returned whole', async () => {
    const fetchImpl = async () => new Response('hello world', { status: 200 });
    const out = await guardedFetchBytes('https://iiif.example.org/x', { fetchImpl, maxBytes: 100 });
    assert.equal(out.bytes.toString('utf8'), 'hello world');
  });
});

// ------------------------------------------------------- B2-R (re-gate round 2)

describe('B2-R: IPv4-translated ::ffff:0:0:0/96 + embedded-IPv4 scheme matrix', () => {
  it('rejects IPv4-translated ::ffff:0:0:0/96 in every QA spelling (B2-R blockers)', () => {
    for (const bad of [
      'https://[::ffff:0:7f00:1]/x', // 127.0.0.1, canonical hex
      'https://[::ffff:0:a9fe:a9fe]/x', // 169.254.169.254 (cloud metadata)
      'https://[::ffff:0:127.0.0.1]/x', // dotted tail
      'https://[::ffff:0:169.254.169.254]/x', // dotted tail
      'https://[::FFFF:0:7F00:1]/x', // mixed case
      'https://[::ffff:0000:7f00:0001]/x', // leading-zero groups
      'https://[0:0:0:0:ffff:0:7f00:1]/x', // uncompressed
      'https://[::ffff:0:a00:1]/x', // 10.0.0.1
      'https://[::ffff:0:c0a8:101]/x', // 192.168.1.1
    ]) {
      assert.throws(() => assertPublicHttpsUrl(bad), SsrfError, bad);
    }
    assert.equal(isPrivateIpv6('::ffff:0:127.0.0.1'), true);
    assert.equal(isPrivateIpv6('::ffff:0:7f00:1'), true);
  });

  it('control: public IPv4-translated ::ffff:0:808:808 (8.8.8.8) stays allowed', () => {
    assertPublicHttpsUrl('https://[::ffff:0:808:808]/x');
    assertPublicHttpsUrl('https://[::ffff:0:8.8.8.8]/x');
    assert.equal(isPrivateIpv6('::ffff:0:808:808'), false);
  });

  it('scheme matrix — one private + one public probe per embedded-IPv4 scheme', () => {
    const matrix = [
      // [scheme, private-spelling (reject), public-spelling (allow)]
      ['IPv4-mapped ::ffff:0:0/96', 'https://[::ffff:7f00:1]/x', 'https://[::ffff:808:808]/x'],
      ['IPv4-translated ::ffff:0:0:0/96', 'https://[::ffff:0:7f00:1]/x', 'https://[::ffff:0:808:808]/x'],
      ['IPv4-compatible ::/96', 'https://[::7f00:1]/x', null], // no public member: ::/96 is the whole deprecated block
      ['NAT64 well-known 64:ff9b::/96', 'https://[64:ff9b::7f00:1]/x', 'https://[64:ff9b::808:808]/x'],
      ['NAT64 local 64:ff9b:1::/48 contiguous', 'https://[64:ff9b:1:a9fe:a9fe::]/x', 'https://[64:ff9b:1:808:808::]/x'],
      ['NAT64 local /48 RFC 6052 u-octet split', 'https://[64:ff9b:1:c633:0064:0000::]/x', 'https://[64:ff9b:1:0808:0008:0800::]/x'],
      ['6to4 2002::/16', 'https://[2002:7f00:1::]/x', 'https://[2002:808:808::]/x'],
      ['Teredo 2001::/32 server', 'https://[2001:0:7f00:1::]/x', 'https://[2001:0:808:808::]/x'],
      ['Teredo client (XOR-obfuscated)', 'https://[2001:0:808:808:0:0:80ff:fffe]/x', 'https://[2001:0:808:808:0:0:f7f7:f7f7]/x'],
      ['ISATAP IID 0000:5efe:<IPv4>', 'https://[2606:4700:4700::5efe:7f00:1]/x', 'https://[2606:4700:4700::5efe:808:808]/x'],
    ];
    for (const [scheme, bad, good] of matrix) {
      assert.throws(() => assertPublicHttpsUrl(bad), SsrfError, `${scheme}: ${bad} must be rejected`);
      if (good) assertPublicHttpsUrl(good); // throws if the public member is rejected
    }
  });

  it('IPv4-compatible ::/96 is dead via the leading-zeros branch (named lock)', () => {
    // Why it dies: expanded groups [0,0,0,0,0,0,hi,lo] hit the g5===0
    // branch, which runs the embedded IPv4 through the full range
    // checks; ::1 dies the same way (embedded 0.0.0.1, "this network").
    assert.throws(() => assertPublicHttpsUrl('https://[0:0:0:0:0:0:7f00:1]/x'), SsrfError);
    assert.throws(() => assertPublicHttpsUrl('https://[::7f00:1]/x'), SsrfError);
    assert.throws(() => assertPublicHttpsUrl('https://[::127.0.0.1]/x'), SsrfError);
    assert.equal(isPrivateIpv6('0:0:0:0:0:0:7f00:1'), true);
  });

  it('Teredo client address is XOR-decoded before checking (raw bits are meaningless)', () => {
    // 127.0.0.1 XOR ffffffff = 80ff:fffe — a raw-bits check would miss it.
    assert.equal(isPrivateIpv6('2001:0:808:808:0:0:80ff:fffe'), true);
    // 8.8.8.8 XOR ffffffff = f7f7:f7f7 — raw bits sit in reserved 240/4,
    // so a raw-bits check would false-flag this public client.
    assert.equal(isPrivateIpv6('2001:0:808:808:0:0:f7f7:f7f7'), false);
    // QA control: zero client field carries no client target.
    assert.equal(isPrivateIpv6('2001:0:808:808::'), false);
  });

  it('ISATAP: embedded IPv4 in the IID is checked on any prefix', () => {
    assert.equal(isPrivateIpv6('2606:4700:4700:0:0:5efe:7f00:1'), true);
    assert.equal(isPrivateIpv6('2606:4700:4700::5efe:a9fe:a9fe'), true);
    assert.equal(isPrivateIpv6('2606:4700:4700::5efe:127.0.0.1'), true);
    assert.equal(isPrivateIpv6('2606:4700:4700::5efe:808:808'), false);
  });

  it('NAT64 /48: both the contiguous and u-octet-split embeddings are checked', () => {
    assert.equal(isPrivateIpv6('64:ff9b:1:a9fe:a9fe::'), true); // contiguous 169.254.169.254
    assert.equal(isPrivateIpv6('64:ff9b:1:c633:0064:0000::'), true); // split 198.51.100.0 (documentation)
    assert.equal(isPrivateIpv6('64:ff9b:1:0808:0008:0800::'), false); // split 8.8.8.8, public
  });
});

// ---------------------------------------------------------------- Omeka findings

describe('Omeka findings: fetch hygiene + sync persistence', () => {
  const settings = { baseUrl: 'https://omeka.example.org', keyIdentity: 'id-123', keyCredential: 'cred-456' };

  it('http base URL to a non-loopback host is refused; loopback http is the documented exception', () => {
    assert.throws(() => normalizeOmekaBaseUrl('http://omeka.example.org'), OmekaError);
    assert.throws(() => normalizeOmekaBaseUrl('http://192.168.1.5/omeka'), OmekaError);
    assert.equal(normalizeOmekaBaseUrl('http://localhost:8080/omeka/'), 'http://localhost:8080/omeka');
    assert.equal(normalizeOmekaBaseUrl('http://127.0.0.1:8080'), 'http://127.0.0.1:8080');
    assert.equal(normalizeOmekaBaseUrl('https://omeka.example.org/s/'), 'https://omeka.example.org/s');
  });

  it('requests time out via AbortController instead of hanging', async () => {
    const hungFetch = (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      setTimeout(() => reject(new Error('test fetch was never aborted')), 5000);
    });
    const client = new OmekaClient(settings, hungFetch, { timeoutMs: 25 });
    await assert.rejects(() => client.createItem({}), (err) => {
      assert.ok(err instanceof OmekaError);
      assert.match(err.message, /timed out/);
      return true;
    });
  });

  it('response byte cap is enforced on Omeka responses', async () => {
    const bigFetch = async () => new Response(JSON.stringify({ 'o:id': 1, pad: 'x'.repeat(500) }), { status: 201 });
    const client = new OmekaClient(settings, bigFetch, { maxResponseBytes: 32 });
    await assert.rejects(() => client.createItem({}), (err) => {
      assert.ok(err instanceof OmekaError);
      assert.match(err.message, /byte cap/);
      return true;
    });
  });

  it('normal requests still flow through the timed/capped path', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ 'o:id': 42 }), { status: 201, headers: { 'content-type': 'application/json' } });
    const client = new OmekaClient(settings, fetchImpl);
    const out = await client.createItem({});
    assert.equal(out.id, 42);
  });

  it('sync row is persisted immediately after create, before media attach; media failure = warning on the row', () => {
    const svc = read('lib/omeka/service.ts');
    const createIdx = svc.indexOf('omeka.createItem(payload)');
    const persistIdx = svc.indexOf('recordSync(projectId, itemId, remoteId', createIdx);
    const mediaIdx = svc.indexOf('createMediaForItem', createIdx);
    assert.ok(createIdx > 0 && persistIdx > createIdx, 'recordSync must follow create');
    assert.ok(persistIdx < mediaIdx, 'recordSync must run BEFORE media attach');
    assert.match(svc, /mediaError \? 'warning' : 'ok'/);
    assert.match(svc, /media attach failed for photo/);
  });
});

// ---------------------------------------------------------------- IIIF finding

describe('IIIF finding: failed/duplicate harvest cleanup + skipped counting', () => {
  it('pre-created item is deleted on failure and on duplicate; duplicates count as skipped', () => {
    const imp = read('lib/iiif/import.ts');
    assert.match(imp, /DELETE FROM subjects WHERE id = \$1/);
    assert.match(imp, /itemCommitted = true/);
    const dupBranch = imp.slice(imp.indexOf("dedupe === 'skipped_duplicate'"), imp.indexOf("dedupe === 'skipped_duplicate'") + 900);
    assert.match(dupBranch, /cleanupItem\(\)/);
    assert.match(dupBranch, /skipped\+\+/);
    assert.ok(!/imported\+\+/.test(dupBranch), 'duplicate branch must not count as imported');
    const catchBranch = imp.slice(imp.indexOf('} catch (err) {', imp.indexOf('for (const entry of plan)')));
    assert.match(catchBranch, /cleanupItem\(\)/);
    assert.match(imp, /imported, skipped, failed, results/);
    assert.match(imp, /skipped: number/);
  });
});
