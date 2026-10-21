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
  it('detects pdf + jp2000 (Wave B1 rows 7/6b)', () => {
    assert.equal(detectFormat(Buffer.from('%PDF-1.7\n%âãÏÓ')), 'pdf');
    const sigBox = head([0x00, 0x00, 0x00, 0x0c, 0x6a, 0x50, 0x20, 0x20, 0x0d, 0x0a, 0x87, 0x0a]);
    assert.equal(detectFormat(sigBox), 'jp2');
    assert.equal(detectFormat(head([0xff, 0x4f, 0xff, 0x51])), 'jp2'); // raw codestream SOC
    assert.equal(magicMatchesMimetype('application/pdf', Buffer.from('%PDF-1.4')), true);
    assert.equal(magicMatchesMimetype('image/jp2', sigBox), true);
    assert.equal(magicMatchesMimetype('image/jp2', Buffer.from('%PDF-1.4')), false);
    assert.equal(mimetypeForFormat('pdf'), 'application/pdf');
    assert.equal(mimetypeForFormat('jp2'), 'image/jp2');
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
