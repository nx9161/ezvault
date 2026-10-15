// SPDX-License-Identifier: MIT
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isClientOpId, resolveClientOpId } from '../lib/api/idempotency-wire';

const GOOD = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
const GOOD_UPPER = 'F47AC10B-58CC-4372-A567-0E02B2C3D479';

describe('clientOpId wire format (A4)', () => {
  it('accepts canonical UUIDs (either case)', () => {
    assert.equal(isClientOpId(GOOD), true);
    assert.equal(isClientOpId(GOOD_UPPER), true);
  });

  it('rejects malformed op ids', () => {
    for (const bad of ['', 'not-a-uuid', 'f47ac10b58cc4372a5670e02b2c3d479',
      'f47ac10b-58cc-4372-a567-0e02b2c3d47', // too short
      'f47ac10b-58cc-4372-a567-0e02b2c3d4790', // too long
      'g47ac10b-58cc-4372-a567-0e02b2c3d479', // non-hex
      null, undefined, 42, {}, [GOOD]]) {
      assert.equal(isClientOpId(bad), false, `should reject: ${JSON.stringify(bad)}`);
    }
  });

  it('prefers body.clientOpId over the x-client-op-id header', () => {
    const req = new Request('https://x.test/', { headers: { 'x-client-op-id': GOOD_UPPER } });
    assert.equal(resolveClientOpId(req, { clientOpId: GOOD }), GOOD);
  });

  it('falls back to the x-client-op-id header when the body has none', () => {
    const req = new Request('https://x.test/', { headers: { 'x-client-op-id': GOOD } });
    assert.equal(resolveClientOpId(req, {}), GOOD);
    assert.equal(resolveClientOpId(req, null), GOOD);
    assert.equal(resolveClientOpId(req, { clientOpId: '' }), GOOD);
  });

  it('returns null when neither body nor header carries an op id', () => {
    const req = new Request('https://x.test/');
    assert.equal(resolveClientOpId(req, {}), null);
    assert.equal(resolveClientOpId(req, null), null);
  });

  it('ignores non-string body values (validation is the server gate)', () => {
    const req = new Request('https://x.test/', { headers: { 'x-client-op-id': GOOD } });
    assert.equal(resolveClientOpId(req, { clientOpId: 42 }), GOOD);
  });
});
