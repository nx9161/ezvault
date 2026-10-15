// SPDX-License-Identifier: MIT
// F3 (B14 wire contract): renderSnippet must decode the five server-escaped
// entities exactly once before creating React nodes — never double-escaping
// (`R&amp;D` must render as `R&D`), while keeping `<mark>` highlights intact
// and never rendering raw HTML.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { renderSnippet } from '../lib/search-snippet';

function asHtml(snippet) {
  const nodes = renderSnippet(snippet);
  return renderToStaticMarkup(createElement('div', null, ...nodes));
}

describe('renderSnippet entity decoding (F3)', () => {
  it('renders R&amp;D as R&D with the mark intact', () => {
    const out = asHtml('R&amp;D <mark>research</mark> notes');
    // Static markup re-escapes the decoded text — R&D becomes R&amp;D in the
    // HTML, which is what a browser renders as R&D. The <mark> stays real.
    assert.equal(out, '<div>R&amp;D <mark>research</mark> notes</div>');
    assert.match(out, /<mark>research<\/mark>/);
  });

  it('decodes all five wire entities inside and outside marks', () => {
    const out = asHtml('&lt;tag&gt; <mark>don&#39;t &quot;quote&quot;</mark> a&amp;b');
    // React re-escapes `'` as &#x27; (identical character to &#39;).
    assert.equal(
      out,
      '<div>&lt;tag&gt; <mark>don&#x27;t &quot;quote&quot;</mark> a&amp;b</div>',
    );
  });

  it('decodes an entity inside a highlighted segment', () => {
    const out = asHtml('<mark>R&amp;D</mark>');
    assert.equal(out, '<div><mark>R&amp;D</mark></div>');
  });

  it('does not double-decode: &amp;lt; becomes literal text &lt;', () => {
    const out = asHtml('literal &amp;lt;tag&amp;gt;');
    assert.equal(out, '<div>literal &amp;lt;tag&amp;gt;</div>');
    assert.doesNotMatch(out, /<tag>/);
  });

  it('never renders hostile markup outside <mark>', () => {
    const out = asHtml('<script>alert(1)</script><mark>safe</mark>');
    assert.doesNotMatch(out, /<script/);
    assert.match(out, /<mark>safe<\/mark>/);
  });

  it('handles empty input', () => {
    assert.equal(asHtml(''), '<div></div>');
  });
});
