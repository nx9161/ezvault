// SPDX-License-Identifier: MIT
// PhotoLightbox — yet-another-react-lightbox wrapper (W2-A).
// The viewing experience: Zoom (pinch/keyboard/wheel), Thumbnails,
// Fullscreen, Captions (EXIF + item title), Download (single photo),
// Counter. The SIX plugins ONLY — no other plugins.
// Slides render via next/image `unoptimized` (presigned R2 URLs cannot go
// through the Next optimizer). Loaded as a lazy chunk via next/dynamic
// (ssr:false) at the viewer path — zero first-load cost.
// Replaces the hand-rolled zoom/gesture code that used to live in
// components/inspector/PhotoViewer.tsx (deleted after this swap).
// The edit surface (edits, rotation, selection drawing) stays in
// PhotoViewer — the lightbox is viewing-only.

"use client";

import { useMemo } from "react";
import Lightbox, {
  type Slide,
  type RenderSlideProps,
} from "yet-another-react-lightbox";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import Thumbnails from "yet-another-react-lightbox/plugins/thumbnails";
import Fullscreen from "yet-another-react-lightbox/plugins/fullscreen";
import Captions from "yet-another-react-lightbox/plugins/captions";
import Download from "yet-another-react-lightbox/plugins/download";
import Counter from "yet-another-react-lightbox/plugins/counter";
import "yet-another-react-lightbox/styles.css";
import Image from "next/image";
import { originalUrl, thumbUrl } from "@/lib/api/hooks";
import type { Photo } from "@/lib/api/types";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function formatExposure(v: unknown): string | undefined {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return undefined;
  if (v >= 1) return `${v}s`;
  return `1/${Math.round(1 / v)}s`;
}

function formatExifDate(v: unknown): string | undefined {
  const s = str(v);
  if (!s) return undefined;
  // EXIF "2024:05:01 12:00:00" or ISO "2024-05-01T12:00:00".
  const date = s.slice(0, 10);
  return /^\d{4}:\d{2}:\d{2}$/.test(date)
    ? date.replace(/:/g, "-")
    : /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date
      : undefined;
}

/** "Canon EOS R5 · 2024-05-01 · f/2.8 · 1/250s · ISO 100" — omit unknowns. */
function exifLine(photo: Photo): string | undefined {
  const exif = photo.exif ?? {};
  const parts: string[] = [];
  const make = str(exif.Make);
  const model = str(exif.Model);
  if (make || model) {
    const cam =
      make && model && model.startsWith(make)
        ? model
        : [make, model].filter(Boolean).join(" ");
    if (cam) parts.push(cam);
  }
  const date = formatExifDate(exif.DateTimeOriginal ?? exif.CreateDate);
  if (date) parts.push(date);
  const f = exif.FNumber;
  if (typeof f === "number" && Number.isFinite(f) && f > 0) {
    parts.push(`f/${Number(f.toFixed(1))}`);
  }
  const exp = formatExposure(exif.ExposureTime);
  if (exp) parts.push(exp);
  const iso = exif.ISO;
  if (typeof iso === "number" && Number.isFinite(iso) && iso > 0) {
    parts.push(`ISO ${iso}`);
  }
  return parts.length ? parts.join(" · ") : undefined;
}

function captionTitle(photo: Photo, itemTitle: string): string {
  return itemTitle || photo.filename;
}

/** next/image slide render — unoptimized: presigned R2 URLs. */
function LightboxImage({ slide, rect }: RenderSlideProps) {
  const s = slide as Slide & { src: string; alt?: string };
  return (
    <div
      style={{
        position: "relative",
        width: rect.width,
        height: rect.height,
      }}
    >
      <Image
        src={s.src}
        alt={s.alt ?? ""}
        fill
        unoptimized
        draggable={false}
        sizes="100vw"
        style={{ objectFit: "contain" }}
      />
    </div>
  );
}

export interface PhotoLightboxProps {
  projectId: string;
  photos: Photo[];
  /** Controlled slide index. */
  index: number;
  /** Item title for captions (falls back to filename). */
  itemTitle: string;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}

export default function PhotoLightbox({
  projectId,
  photos,
  index,
  itemTitle,
  onIndexChange,
  onClose,
}: PhotoLightboxProps) {
  const slides: Slide[] = useMemo(
    () =>
      photos.map((p) => ({
        src: originalUrl(projectId, p.id),
        thumbnail: thumbUrl(projectId, p.id),
        alt: p.filename,
        title: captionTitle(p, itemTitle),
        description: exifLine(p),
      })),
    [photos, projectId, itemTitle],
  );

  if (slides.length === 0) return null;

  return (
    <Lightbox
      open
      close={onClose}
      index={Math.min(Math.max(index, 0), slides.length - 1)}
      slides={slides}
      plugins={[Zoom, Thumbnails, Fullscreen, Captions, Download, Counter]}
      controller={{ closeOnEscape: true, closeOnBackdropClick: true }}
      render={{ slide: LightboxImage }}
      captions={{ showToggle: true }}
      thumbnails={{ position: "bottom", width: 96, height: 72, gap: 8 }}
      zoom={{ maxZoomPixelRatio: 4, zoomInMultiplier: 2, keyboardMoveDistance: 48 }}
      on={{ view: ({ index: i }) => onIndexChange(i) }}
    />
  );
}
