// SPDX-License-Identifier: MIT
// Browser-side HEIC/HEIF → full-res JPEG (ADR-2.16, B17).
// Uses libheif-js (LGPL-3.0, honestly declared — see THIRD_PARTY_NOTICES.md),
// NOT heic2any (B17: mislicensed static libheif bundling).
// The ESM bundle inlines its WASM (base64) — no extra public/ asset needed.

interface HeifImage {
  get_width(): number;
  get_height(): number;
  display(
    imageData: ImageData,
    cb: (data: ImageData | null) => void,
  ): void;
}

interface LibHeif {
  HeifDecoder: new () => { decode(data: Uint8Array): HeifImage[] };
}

let libPromise: Promise<LibHeif> | null = null;

async function getLibHeif(): Promise<LibHeif> {
  if (!libPromise) {
    libPromise = (async () => {
      // Dynamic import: the ~1MB decoder loads only when a HEIC is imported.
      const mod = (await import(
        "libheif-js/libheif-wasm/libheif-bundle.mjs"
      )) as unknown as { default: (opts: object) => Promise<LibHeif> };
      return mod.default({});
    })();
  }
  return libPromise;
}

/**
 * Decode the first image of a HEIC/HEIF file to a full-resolution JPEG Blob.
 * Throws on decode failure (caller surfaces per-file retry).
 */
export async function decodeHeicToJpeg(
  file: Blob,
  quality = 0.92,
): Promise<{ blob: Blob; width: number; height: number }> {
  const libheif = await getLibHeif();
  const bytes = new Uint8Array(await file.arrayBuffer());
  const decoder = new libheif.HeifDecoder();
  let images: HeifImage[];
  try {
    images = decoder.decode(bytes);
  } catch (err) {
    throw new Error(
      `HEIC decode failed: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
  if (!images || images.length === 0) {
    throw new Error("HEIC decode failed: no images in container");
  }
  const image = images[0];
  const width = image.get_width();
  const height = image.get_height();
  if (!width || !height || width * height > 100_000_000) {
    throw new Error("HEIC decode failed: implausible dimensions");
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("HEIC decode failed: no 2d context");
  const imageData = ctx.createImageData(width, height);
  await new Promise<void>((resolve, reject) => {
    image.display(imageData, (displayData) => {
      if (!displayData) reject(new Error("HEIC decode failed: no pixels"));
      else resolve();
    });
  });
  ctx.putImageData(imageData, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", quality),
  );
  if (!blob) throw new Error("HEIC decode failed: JPEG encode failed");
  return { blob, width, height };
}
