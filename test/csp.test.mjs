// SPDX-License-Identifier: MIT
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildCspHeader } from '../proxy';

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

  it('keeps script-src strict — no unsafe-inline, ever', () => {
    const d = directives(buildCspHeader('abc123'));
    assert.equal(d['script-src'], "'self'");
    // unsafe-inline is allowed ONLY in style-src (TipTap/prose requirement)
    assert.equal(d['style-src'], "'self' 'unsafe-inline'");
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
