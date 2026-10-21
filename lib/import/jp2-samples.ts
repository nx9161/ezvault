// SPDX-License-Identifier: MIT
/**
 * lib/import/jp2-samples.ts — pure sample-format conversion for the
 * OpenJPEG decode path (Wave B1, row 6b). No `server-only`, no I/O —
 * unit-testable anywhere (the relink-wire.ts pattern).
 *
 * The decoder (lib/import/render.ts) hands over interleaved samples in
 * the codestream's native depth: 8-bit unsigned passes through; 9–16-bit
 * samples are little-endian 16-bit words scaled down by (bits-8); signed
 * samples are offset to unsigned first; sub-8-bit samples scale up.
 */
export function jp2SamplesTo8Bit(raw: Uint8Array, bitsPerSample: number, isSigned: boolean): Uint8Array {
  if (bitsPerSample === 8 && !isSigned) return raw;
  if (bitsPerSample < 1 || bitsPerSample > 16) {
    throw new Error(`unsupported JP2000 bit depth: ${bitsPerSample}`);
  }
  if (bitsPerSample < 8) {
    // Sub-8-bit samples are stored one per byte: scale up to full range.
    const scale = 255 / ((1 << bitsPerSample) - 1);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = Math.round(raw[i] * scale);
    return out;
  }
  const count = Math.floor(raw.byteLength / 2);
  const out = new Uint8Array(count);
  const shift = bitsPerSample - 8;
  if (isSigned) {
    const offset = 1 << (bitsPerSample - 1);
    const view = new Int16Array(raw.buffer, raw.byteOffset, count);
    for (let i = 0; i < view.length; i++) {
      const v = (view[i] + offset) >> shift;
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  } else {
    const words = new Uint16Array(raw.buffer, raw.byteOffset, count);
    for (let i = 0; i < words.length; i++) out[i] = words[i] >> shift;
  }
  return out;
}
