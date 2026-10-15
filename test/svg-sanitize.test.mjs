// SPDX-License-Identifier: MIT
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSvg } from '../lib/import/svg-sanitize';

const buf = (s) => Buffer.from(s, 'utf8');

describe('sanitizeSvg (B6)', () => {
  it('passes a clean svg through', () => {
    const out = sanitizeSvg(buf('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'));
    assert.match(out.toString('utf8'), /<rect/);
  });
  it('strips script elements and event-handler attributes', () => {
    const out = sanitizeSvg(buf(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect onclick="evil()" width="1"/></svg>',
    )).toString('utf8');
    assert.doesNotMatch(out, /<script/);
    assert.doesNotMatch(out, /onclick/);
    assert.match(out, /<rect/);
  });
  it('strips style elements and javascript: hrefs', () => {
    const out = sanitizeSvg(buf(
      '<svg xmlns="http://www.w3.org/2000/svg"><style>.x{fill:red}</style><a href="javascript:alert(1)"><text>x</text></a></svg>',
    )).toString('utf8');
    assert.doesNotMatch(out, /<style/);
    assert.doesNotMatch(out, /javascript/);
  });
  it('rejects unparseable svg', () => {
    assert.throws(() => sanitizeSvg(buf('<svg><unclosed')), /parse|svg/i);
  });
  it('rejects empty / non-svg input', () => {
    assert.throws(() => sanitizeSvg(buf('')), /svg/i);
    assert.throws(() => sanitizeSvg(buf('<html></html>')), /svg/i);
  });
});
