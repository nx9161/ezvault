// SPDX-License-Identifier: MIT
/**
 * test/date-validation.test.mjs — SHOULD-30: metadata date-field validation.
 * Pure-function contract for isValidPartialDate() in lib/validation.ts
 * (YYYY, YYYY-MM, or calendar-valid YYYY-MM-DD; empty = optional field).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isValidPartialDate } from '../lib/validation.ts';

describe('isValidPartialDate', () => {
  it('accepts empty (optional field)', () => {
    assert.equal(isValidPartialDate(''), true);
    assert.equal(isValidPartialDate('   '), true);
  });

  it('accepts a bare year', () => {
    assert.equal(isValidPartialDate('2024'), true);
    assert.equal(isValidPartialDate('1899'), true);
  });

  it('accepts year-month', () => {
    assert.equal(isValidPartialDate('2024-02'), true);
    assert.equal(isValidPartialDate('2024-12'), true);
  });

  it('accepts calendar-valid full dates', () => {
    assert.equal(isValidPartialDate('2024-02-29'), true); // leap day
    assert.equal(isValidPartialDate('2023-02-28'), true);
    assert.equal(isValidPartialDate('2024-04-30'), true);
    assert.equal(isValidPartialDate('1945-05-08'), true);
  });

  it('rejects impossible calendar dates', () => {
    assert.equal(isValidPartialDate('2023-02-29'), false); // not a leap year
    assert.equal(isValidPartialDate('2024-04-31'), false);
    assert.equal(isValidPartialDate('2024-13-01'), false);
    assert.equal(isValidPartialDate('2024-00-10'), false);
    assert.equal(isValidPartialDate('2024-01-00'), false);
    assert.equal(isValidPartialDate('2024-01-32'), false);
  });

  it('rejects malformed shapes', () => {
    assert.equal(isValidPartialDate('24-01-01'), false);
    assert.equal(isValidPartialDate('2024/01/01'), false);
    assert.equal(isValidPartialDate('2024-1-1'), false);
    assert.equal(isValidPartialDate('January 2024'), false);
    assert.equal(isValidPartialDate('2024-01-01T00:00'), false);
    assert.equal(isValidPartialDate('2024-01-01 '), true); // surrounding space trimmed
  });
});
