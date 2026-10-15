// SPDX-License-Identifier: MIT
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedLinkUrl, sanitizeNoteHtml, sanitizeTiptapDoc } from '../lib/notes/sanitize';

describe('isAllowedLinkUrl (B13)', () => {
  it('allows http/https/mailto/tel', () => {
    assert.equal(isAllowedLinkUrl('https://example.com/x'), true);
    assert.equal(isAllowedLinkUrl('http://example.com'), true);
    assert.equal(isAllowedLinkUrl('mailto:a@b.com'), true);
    assert.equal(isAllowedLinkUrl('tel:+15551234567'), true);
  });
  it('rejects dangerous protocols and obfuscation', () => {
    assert.equal(isAllowedLinkUrl('javascript:alert(1)'), false);
    assert.equal(isAllowedLinkUrl('JaVaScRiPt:alert(1)'), false);
    assert.equal(isAllowedLinkUrl('data:text/html,<h1>x</h1>'), false);
    assert.equal(isAllowedLinkUrl('vbscript:msgbox(1)'), false);
    assert.equal(isAllowedLinkUrl('file:///etc/passwd'), false);
    assert.equal(isAllowedLinkUrl('java\tscript:alert(1)'), false);
    assert.equal(isAllowedLinkUrl('not a url'), false);
    assert.equal(isAllowedLinkUrl(''), false);
    assert.equal(isAllowedLinkUrl(null), false);
  });
});

describe('sanitizeNoteHtml (B13)', () => {
  it('strips script tags but keeps text', () => {
    const out = sanitizeNoteHtml('<p>hi</p><script>alert(1)</script>');
    assert.match(out, /hi/);
    assert.doesNotMatch(out, /<script/);
  });
  it('unwraps disallowed link hrefs, keeping the text', () => {
    const out = sanitizeNoteHtml('<p><a href="javascript:alert(1)">click</a></p>');
    assert.match(out, /click/);
    assert.doesNotMatch(out, /javascript/);
  });
  it('keeps allowed links intact', () => {
    const out = sanitizeNoteHtml('<p><a href="https://example.com">go</a></p>');
    assert.match(out, /href="https:\/\/example\.com"/);
  });
  it('strips event handler attributes', () => {
    const out = sanitizeNoteHtml('<p onclick="evil()">x</p>');
    assert.doesNotMatch(out, /onclick/);
    assert.match(out, /x/);
  });
});

describe('sanitizeTiptapDoc (B13)', () => {
  it('strips link marks with disallowed hrefs (text kept)', () => {
    const doc = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'click',
          marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
        }],
      }],
    };
    const r = sanitizeTiptapDoc(doc);
    assert.equal(r.stripped, 1);
    assert.equal(r.doc.content[0].content[0].text, 'click');
    assert.ok(!r.doc.content[0].content[0].marks || r.doc.content[0].content[0].marks.length === 0);
  });
  it('keeps allowed link marks', () => {
    const doc = {
      type: 'doc',
      content: [{
        type: 'paragraph',
        content: [{
          type: 'text',
          text: 'go',
          marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
        }],
      }],
    };
    const r = sanitizeTiptapDoc(doc);
    assert.equal(r.stripped, 0);
    assert.equal(r.doc.content[0].content[0].marks[0].attrs.href, 'https://example.com');
  });
});
