// SPDX-License-Identifier: MIT
/**
 * test/zip-stream.test.mjs — row 24: the streaming ZIP writer produces a
 * standards-readable archive (verified with fflate's independent reader),
 * stored media entries stream in bounded chunks, text entries deflate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { createZipStream, storageChunks, bytesChunks, zipSegment } from '../lib/export/zip-stream.ts';

async function collect(stream) {
  const parts = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}

describe('createZipStream (row 24)', () => {
  it('writes stored + deflated entries that unzip back to the source bytes', async () => {
    const media = new Uint8Array(100_000);
    for (let i = 0; i < media.length; i++) media[i] = i % 251;
    async function* mediaChunks() {
      yield media.subarray(0, 30_000);
      yield media.subarray(30_000, 65_000);
      yield media.subarray(65_000);
    }
    const zip = await collect(createZipStream([
      { name: 'Item--abcd1234/photo.jpg', compress: false, chunks: mediaChunks },
      { name: 'metadata.json', compress: true, chunks: bytesChunks(new TextEncoder().encode('{"ok":true}')) },
      { name: 'empty.bin', compress: false, chunks: bytesChunks(new Uint8Array(0)) },
    ]));
    const out = unzipSync(new Uint8Array(zip));
    assert.deepEqual(Object.keys(out).sort(), ['Item--abcd1234/photo.jpg', 'empty.bin', 'metadata.json']);
    assert.deepEqual(Buffer.from(out['Item--abcd1234/photo.jpg']), Buffer.from(media));
    assert.equal(strFromU8(out['metadata.json']), '{"ok":true}');
    assert.equal(out['empty.bin'].length, 0);
  });

  it('propagates a source error instead of silently truncating', async () => {
    async function* bad() {
      yield new Uint8Array([1, 2, 3]);
      throw new Error('storage went away');
    }
    await assert.rejects(() => collect(createZipStream([
      { name: 'x.bin', compress: false, chunks: bad },
    ])));
  });
});

describe('storageChunks', () => {
  it('reads via inclusive ranges and reassembles the object', async () => {
    const data = Buffer.alloc(10, 7);
    const calls = [];
    const fakeStorage = {
      async getRange(key, start, end) {
        calls.push([start, end]);
        return data.subarray(start, end + 1);
      },
    };
    const parts = [];
    for await (const c of storageChunks(fakeStorage, 'k', 10, 4)) parts.push(Buffer.from(c));
    assert.deepEqual(calls, [[0, 3], [4, 7], [8, 9]]);
    assert.deepEqual(Buffer.concat(parts), data);
  });
});

describe('zipSegment', () => {
  it('strips path separators and dangerous characters', () => {
    assert.equal(zipSegment('a/b\\c:d*e?f"g<h>i|j.jpg'), 'a_b_c_d_e_f_g_h_i_j.jpg');
    assert.equal(zipSegment('..hidden'), '_hidden');
    assert.equal(zipSegment('   '), 'untitled');
    assert.equal(zipSegment('normal name.tif'), 'normal name.tif');
  });
});
