// SPDX-License-Identifier: MIT
// Browser-side file preparation: SHA-256 (SubtleCrypto), format detection,
// EXIF (exifr). HEIC/HEIF decode lives in ./heic.ts (libheif-js, B17).

export type ImportKind =
  | "jpeg" | "png" | "gif" | "webp" | "tiff"
  | "heic" | "heif" | "avif" | "jp2" | "pdf" | "svg" | "unknown";

const EXT_KIND: Record<string, ImportKind> = {
  jpg: "jpeg", jpeg: "jpeg", png: "png", gif: "gif", webp: "webp",
  tif: "tiff", tiff: "tiff", heic: "heic", heif: "heif", avif: "avif",
  jp2: "jp2", j2k: "jp2", jpx: "jp2", pdf: "pdf", svg: "svg",
};

/** v1 accepted formats (architecture §2.11 — 10 formats). */
export const ACCEPTED_EXTENSIONS = Object.keys(EXT_KIND);
export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.map((e) => `.${e}`).join(",");

export function detectKind(file: File): ImportKind {
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  if (EXT_KIND[ext]) return EXT_KIND[ext];
  const mt = file.type.toLowerCase();
  if (mt.includes("heic")) return "heic";
  if (mt.includes("heif")) return "heif";
  if (mt.includes("avif")) return "avif";
  if (mt.includes("jpeg") || mt.includes("jpg")) return "jpeg";
  if (mt.includes("png")) return "png";
  if (mt.includes("gif")) return "gif";
  if (mt.includes("webp")) return "webp";
  if (mt.includes("tiff")) return "tiff";
  if (mt.includes("pdf")) return "pdf";
  if (mt.includes("svg")) return "svg";
  if (mt.includes("jp2") || mt.includes("jpeg2000")) return "jp2";
  return "unknown";
}

export function needsBrowserConversion(kind: ImportKind): boolean {
  // ADR-2.16: HEIC/HEIF decode in-browser (server sharp can't do HEVC).
  return kind === "heic" || kind === "heif";
}

export function needsServerConversion(kind: ImportKind): boolean {
  // AVIF/JP2K/PDF/SVG: accepted, converted server-side (design §2.1).
  return kind === "avif" || kind === "jp2" || kind === "pdf" || kind === "svg";
}

/**
 * Canonical mimetype for a detected kind. Browsers report an empty
 * `file.type` for .jp2 (and occasionally .pdf/.tiff) files; presign signs
 * the Content-Type, so the client must claim the real type — derived
 * from the extension — instead of application/octet-stream.
 */
export function mimetypeForKind(kind: ImportKind): string {
  switch (kind) {
    case "jpeg": return "image/jpeg";
    case "png": return "image/png";
    case "gif": return "image/gif";
    case "webp": return "image/webp";
    case "tiff": return "image/tiff";
    case "heic": return "image/heic";
    case "heif": return "image/heif";
    case "avif": return "image/avif";
    case "jp2": return "image/jp2";
    case "pdf": return "application/pdf";
    case "svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

/** SHA-256 of a File/Blob via SubtleCrypto, streaming in 8MB chunks. */
export async function sha256File(
  blob: Blob,
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const CHUNK = 8 * 1024 * 1024;
  const total = blob.size;
  // Incremental hashing isn't exposed by SubtleCrypto; read the whole blob
  // once (bounded by MAX_PHOTO_BYTES server-side, 200MB — acceptable in v1).
  const buf = await blob.arrayBuffer();
  onProgress?.(total, total);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** EXIF for client-decoded HEIC (architecture §9 — server can't reach it). */
export async function extractExif(blob: Blob): Promise<Record<string, unknown>> {
  try {
    const exifr = (await import("exifr")).default;
    const data = await exifr.parse(blob, {
      pick: ["Make", "Model", "DateTimeOriginal", "CreateDate", "GPSLatitude", "GPSLongitude", "Orientation", "ImageWidth", "ImageHeight", "ExposureTime", "FNumber", "ISO"],
    });
    return (data ?? {}) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function formatBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
