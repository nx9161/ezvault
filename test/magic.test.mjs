// SPDX-License-Identifier: MIT
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectFormat, detectFromBytes, magicMatchesMimetype, mimetypeForFormat } from '../lib/import/magic';

const head = (bytes) => Buffer.from(bytes);

describe('magic bytes (B1)', () => {
  it('detects jpeg/png/gif/webp/tiff', () => {
    assert.equal(detectFormat(head([0xff, 0xd8, 0xff, 0xe0])), 'jpg');
    assert.equal(detectFormat(head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'png');
    assert.equal(detectFormat(head([...Buffer.from('GIF89a')])) , 'gif');
    assert.equal(detectFormat(head([...Buffer.from('RIFF....WEBP')])), 'webp');
    assert.equal(detectFormat(head([0x49, 0x49, 0x2a, 0x00])), 'tiff');
  });
  it('detects ISO BMFF brands (heic/heif/avif), rejects unknown BMFF', () => {
    const ftyp = (brand) => head([0, 0, 0, 20, ...Buffer.from('ftyp'), ...Buffer.from(brand), 0, 0, 0, 0]);
    assert.equal(detectFormat(ftyp('heic')), 'heic');
    assert.equal(detectFormat(ftyp('heix')), 'heic');
    assert.equal(detectFormat(ftyp('mif1')), 'heif');
    assert.equal(detectFormat(ftyp('avif')), 'avif');
    assert.equal(detectFormat(ftyp('isom')), null); // video mp4 — rejected
  });
  it('detects svg text', () => {
    assert.equal(detectFormat(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')), 'svg');
    assert.equal(detectFormat(Buffer.from('not an image at all')), null);
  });
  it('magicMatchesMimetype agrees bytes with claim', () => {
    const jpg = head([0xff, 0xd8, 0xff, 0xe0]);
    assert.equal(magicMatchesMimetype('image/jpeg', jpg), true);
    assert.equal(magicMatchesMimetype('image/png', jpg), false);
    assert.equal(magicMatchesMimetype('application/pdf', jpg), false);
    assert.equal(magicMatchesMimetype('image/heic', jpg), false);
  });
  it('detectFromBytes is the detectFormat alias', () => {
    assert.equal(detectFromBytes, detectFormat);
  });
  it('mimetypeForFormat round-trips', () => {
    assert.equal(mimetypeForFormat('jpg'), 'image/jpeg');
    assert.equal(mimetypeForFormat('avif'), 'image/avif');
    assert.equal(mimetypeForFormat('svg'), 'image/svg+xml');
  });
});
