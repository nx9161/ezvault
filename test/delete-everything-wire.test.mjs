// SPDX-License-Identifier: MIT
/**
 * test/delete-everything-wire.test.mjs — F-F: the typed-confirm contract
 * for POST /api/admin/delete-everything. The body must be exactly
 * {confirm:"DELETE"}; anything else → 400. Pure test (no server-only).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDeleteEverythingConfirm } from '../lib/api/admin.ts';

describe('delete-everything typed confirm (F-F)', () => {
  it('accepts exactly {confirm:"DELETE"}', () => {
    assert.equal(isDeleteEverythingConfirm({ confirm: 'DELETE' }), true);
  });

  const rejects = [
    ['missing body', undefined],
    ['null body', null],
    ['non-object', 'DELETE'],
    ['wrong value', { confirm: 'delete' }],
    ['empty confirm', { confirm: '' }],
    ['extra key', { confirm: 'DELETE', sure: true }],
    ['different key', { really: 'DELETE' }],
    ['empty object', {}],
    ['array body', [{ confirm: 'DELETE' }]],
  ];
  for (const [name, body] of rejects) {
    it(`rejects: ${name}`, () => {
      assert.equal(isDeleteEverythingConfirm(body), false);
    });
  }
});
