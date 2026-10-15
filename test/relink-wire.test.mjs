// SPDX-License-Identifier: MIT
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchRelinkFiles, normalizeSha256 } from '../lib/import/relink-wire.ts';

const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const H3 = 'c'.repeat(64);

function missingRow(id, filename, checksum_sha256 = '') {
  return { photo_subject_id: id, filename, checksum_sha256, tpy_checksum_md5: null };
}

describe('normalizeSha256 (W2-D)', () => {
  it('accepts 64-hex digests, case-insensitive, trims whitespace', () => {
    assert.equal(normalizeSha256(H1), H1);
    assert.equal(normalizeSha256(H1.toUpperCase()), H1);
    assert.equal(normalizeSha256('  ' + H1 + '\n'), H1);
  });

  it('rejects the old "relink" placeholder and other non-digests', () => {
    for (const bad of ['relink', '', 'xyz', H1.slice(0, 63), H1 + 'a', null, undefined, 42, {}, [H1]]) {
      assert.equal(normalizeSha256(bad), null, `should reject: ${JSON.stringify(bad)}`);
    }
  });
});

describe('matchRelinkFiles — checksum leg (W2-D)', () => {
  it('matches by checksum when the missing original recorded one', () => {
    const plan = matchRelinkFiles(
      [{ staged_key: 'k1', filename: 'renamed.jpg', sha256: H1 }],
      [missingRow('p1', 'original-name.jpg', H1)],
    );
    assert.deepEqual(plan.matches, [{ file_index: 0, photo_subject_id: 'p1', method: 'checksum' }]);
    assert.deepEqual(plan.unmatched, []);
    assert.deepEqual(plan.still_missing, []);
  });

  it('prefers checksum over filename when both could match', () => {
    const plan = matchRelinkFiles(
      [{ staged_key: 'k1', filename: 'a.jpg', sha256: H1 }],
      [missingRow('p1', 'a.jpg', H2), missingRow('p2', 'other.jpg', H1)],
    );
    assert.deepEqual(plan.matches, [{ file_index: 0, photo_subject_id: 'p2', method: 'checksum' }]);
    assert.deepEqual(plan.still_missing, [{ filename: 'a.jpg', photo_subject_id: 'p1' }]);
  });

  it('never checksum-matches a missing original with an empty recorded checksum', () => {
    // Advanced-mode .tpy imports record checksum_sha256='' — the checksum
    // leg must not match them; the filename fallback carries the load.
    const plan = matchRelinkFiles(
      [{ staged_key: 'k1', filename: 'scan.jpg', sha256: H1 }],
      [missingRow('p1', 'scan.jpg', ''), missingRow('p2', 'scan.jpg', null)],
    );
    assert.equal(plan.matches[0].method, 'filename');
    assert.equal(plan.matches[0].photo_subject_id, 'p1');
  });

  it('skips the checksum leg for invalid claims but still tries filename', () => {
    const plan = matchRelinkFiles(
      [{ staged_key: 'k1', filename: 'scan.jpg', sha256: 'relink' }],
      [missingRow('p1', 'scan.jpg', H1)],
    );
    assert.deepEqual(plan.matches, [{ file_index: 0, photo_subject_id: 'p1', method: 'filename' }]);
  });
});

describe('matchRelinkFiles — filename fallback (W2-D)', () => {
  it('matches case-insensitively', () => {
    const plan = matchRelinkFiles(
      [{ staged_key: 'k1', filename: 'IMG_001.JPG', sha256: H3 }],
      [missingRow('p1', 'img_001.jpg')],
    );
    assert.deepEqual(plan.matches, [{ file_index: 0, photo_subject_id: 'p1', method: 'filename' }]);
  });

  it('compares basenames (tpy paths may carry directories)', () => {
    const plan = matchRelinkFiles(
      [{ staged_key: 'k1', filename: 'photo.jpg' }],
      [missingRow('p1', 'C:\\Users\\naman\\Photos\\photo.jpg')],
    );
    assert.deepEqual(plan.matches, [{ file_index: 0, photo_subject_id: 'p1', method: 'filename' }]);
  });

  it('does not match when basenames differ', () => {
    const plan = matchRelinkFiles(
      [{ staged_key: 'k1', filename: 'other.jpg', sha256: H3 }],
      [missingRow('p1', 'photo.jpg')],
    );
    assert.deepEqual(plan.matches, []);
    assert.deepEqual(plan.unmatched, [0]);
    assert.deepEqual(plan.still_missing, [{ filename: 'photo.jpg', photo_subject_id: 'p1' }]);
  });
});

describe('matchRelinkFiles — consumption + determinism (W2-D)', () => {
  it('consumes each missing original at most once (first file wins)', () => {
    const plan = matchRelinkFiles(
      [
        { staged_key: 'k1', filename: 'a.jpg', sha256: H1 },
        { staged_key: 'k2', filename: 'a.jpg', sha256: H1 },
      ],
      [missingRow('p1', 'a.jpg', H1)],
    );
    assert.deepEqual(plan.matches, [{ file_index: 0, photo_subject_id: 'p1', method: 'checksum' }]);
    assert.deepEqual(plan.unmatched, [1]);
    assert.deepEqual(plan.still_missing, []);
  });

  it('handles empty inputs', () => {
    assert.deepEqual(matchRelinkFiles([], []), { matches: [], unmatched: [], still_missing: [] });
    assert.deepEqual(matchRelinkFiles([], [missingRow('p1', 'a.jpg')]).still_missing,
      [{ filename: 'a.jpg', photo_subject_id: 'p1' }]);
  });

  it('matches multiple files independently in order', () => {
    const plan = matchRelinkFiles(
      [
        { staged_key: 'k1', filename: 'a.jpg', sha256: H1 },
        { staged_key: 'k2', filename: 'b.jpg' },
      ],
      [missingRow('p2', 'b.jpg'), missingRow('p1', 'x.jpg', H1)],
    );
    assert.deepEqual(plan.matches, [
      { file_index: 0, photo_subject_id: 'p1', method: 'checksum' },
      { file_index: 1, photo_subject_id: 'p2', method: 'filename' },
    ]);
    assert.deepEqual(plan.unmatched, []);
    assert.deepEqual(plan.still_missing, []);
  });
});
