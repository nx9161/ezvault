// SPDX-License-Identifier: MIT
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { strictDocumentLoader, TROPY_CONTEXT_URL } from '../lib/import/jsonld-context';

describe('strictDocumentLoader (B10)', () => {
  it('serves the inline allowlisted tropy.org context', async () => {
    const doc = await strictDocumentLoader(TROPY_CONTEXT_URL);
    assert.ok(doc.document, 'context document returned');
  });
  it('rejects ALL remote contexts', async () => {
    await assert.rejects(() => strictDocumentLoader('https://schema.org/'), /remote context|rejected/i);
    await assert.rejects(() => strictDocumentLoader('https://evil.example/ctx.jsonld'), /remote context|rejected/i);
  });
  it('rejects non-allowlisted tropy.org paths', async () => {
    await assert.rejects(() => strictDocumentLoader('https://tropy.org/v1/other#'), /remote context|rejected/i);
  });
});
