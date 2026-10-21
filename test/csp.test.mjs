// SPDX-License-Identifier: MIT
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { buildCspHeader, generateNonce, proxy } from '../proxy';

const R2 = 'https://*.r2.cloudflarestorage.com';

function directives(header) {
  const out = {};
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split(/\s+/);
    out[name] = rest.join(' ');
  }
  return out;
}

describe('buildCspHeader (F1)', () => {
  it('adds the R2 wildcard to connect-src and img-src when an account id is set', () => {
    const d = directives(buildCspHeader('abc123'));
    assert.ok(d['connect-src'].split(' ').includes(R2), `connect-src: ${d['connect-src']}`);
    assert.ok(d['img-src'].split(' ').includes(R2), `img-src: ${d['img-src']}`);
  });

  it('keeps blob: and data: in img-src with R2 present', () => {
    const d = directives(buildCspHeader('abc123'));
    const srcs = d['img-src'].split(' ');
    assert.ok(srcs.includes('blob:'), 'blob: kept');
    assert.ok(srcs.includes('data:'), 'data: kept');
    assert.ok(srcs.includes("'self'"), "'self' kept");
  });

  it('adds nothing when R2 env is absent (local dev — same-origin driver)', () => {
    for (const absent of [undefined, null, '']) {
      const d = directives(buildCspHeader(absent));
      assert.ok(!d['connect-src'].includes('r2.cloudflarestorage.com'), 'no R2 in connect-src');
      assert.ok(!d['img-src'].includes('r2.cloudflarestorage.com'), 'no R2 in img-src');
      assert.equal(d['connect-src'], "'self'");
      assert.equal(d['img-src'], "'self' blob: data:");
    }
  });

  it('keeps the no-nonce builder fallback self-only (no unsafe-inline)', () => {
    const d = directives(buildCspHeader('abc123'));
    assert.equal(d['script-src'], "'self'");
    // unsafe-inline is allowed ONLY in style-src (TipTap/prose requirement)
    assert.equal(d['style-src'], "'self' 'unsafe-inline'");
  });

  it('adds the per-request nonce + strict-dynamic when a nonce is supplied', () => {
    const nonce = 'testNonce1234567890AB==';
    const d = directives(buildCspHeader('abc123', nonce));
    assert.equal(d['script-src'], `'self' 'nonce-${nonce}' 'strict-dynamic'`);
    assert.ok(!d['script-src'].includes("'unsafe-inline'"));
  });

  it('generates distinct 128-bit base64 nonces', () => {
    const a = generateNonce();
    const b = generateNonce();
    assert.match(a, /^[A-Za-z0-9+/]{22}==$/);
    assert.match(b, /^[A-Za-z0-9+/]{22}==$/);
    assert.notEqual(a, b);
  });

  it('proxy forwards the same nonce + CSP to Next and returns that CSP', () => {
    const res = proxy(new NextRequest('https://ez.example.org/'));
    const csp = res.headers.get('content-security-policy');
    const d = directives(csp);
    const match = d['script-src'].match(/'nonce-([^']+)'/);
    assert.ok(match, `script-src must carry a nonce: ${d['script-src']}`);
    assert.equal(d['script-src'], `'self' 'nonce-${match[1]}' 'strict-dynamic'`);
    assert.equal(res.headers.get('x-middleware-request-x-nonce'), match[1]);
    assert.equal(res.headers.get('x-middleware-request-content-security-policy'), csp);
  });

  it('retains the remaining hardening directives unchanged', () => {
    const d = directives(buildCspHeader('abc123'));
    assert.equal(d['default-src'], "'self'");
    assert.equal(d['frame-ancestors'], "'none'");
    assert.equal(d['object-src'], "'none'");
    assert.equal(d['base-uri'], "'self'");
    assert.equal(d['font-src'], "'self' data:");
  });
});
