// SPDX-License-Identifier: MIT
// Canvas-2D photo viewer: two stacked canvases (photo + selection overlay),
// rAF transforms held in a REF (never the store), navigator minimap.
// Edit preview: angle/mirror → canvas transform; brightness/contrast/
// hue/saturation/negative → ctx.filter; sharpen is NOT previewed
// (tolerance contract — bake is the source of truth).
// a11y: role="img" + aria-label, real range input for zoom, selections
// mirrored in the Selections tab list.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import { originalUrl, thumbUrl } from "@/lib/api/hooks";
import { post } from "@/lib/api/client";
import {
  runCommand,
  setEditsOp,
  revertEditsOp,
  type OpContext,
} from "@/lib/commands/ops";
import { DEFAULT_EDITS, editsDirty, adaptSelection, selectionWire, type Photo, type PhotoEdits, type Selection } from "@/lib/api/types";
import { ConfirmDialog } from "@/components/ui/Dialog";
import {
  ZoomInIcon,
  ZoomOutIcon,
  RotateIcon,
  RotateCwIcon,
  SelectionDrawIcon,
} from "@/components/ui/icons";

type FitMode = "fit" | "width" | "one";

interface Transform {
  scale: number;
  tx: number; // photo-center x in css px
  ty: number; // photo-center y in css px
}

/** In-memory original cache for the session (1:1 zoom). */
const originalCache = new Map<string, ImageBitmap>();

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image load failed"));
    img.src = url;
  });
}

async function loadOriginalBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url);
  const blob = await res.blob();
  return createImageBitmap(blob);
}

function colorFilter(e: PhotoEdits): string {
  const parts = [
    `brightness(${(1 + e.brightness / 100).toFixed(3)})`,
    `contrast(${(1 + e.contrast / 100).toFixed(3)})`,
    `saturate(${(1 + e.saturation / 100).toFixed(3)})`,
    `hue-rotate(${e.hue}deg)`,
  ];
  if (e.negative) parts.push("invert(1)");
  return parts.join(" ");
}

export default function PhotoViewer({
  projectId,
  photo,
  selections,
  activeSelectionId,
  onSelectSelection,
  onSelectionsChanged,
  ctx,
}: {
  projectId: string;
  photo: Photo;
  selections: Selection[];
  activeSelectionId: string | null;
  onSelectSelection: (id: string | null) => void;
  onSelectionsChanged: () => void;
  ctx: OpContext;
}) {
  const t = useTranslations("viewer");
  const ts = useTranslations("selections");
  const frameRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const navRef = useRef<HTMLCanvasElement>(null);

  const [frameSize, setFrameSize] = useState({ w: 0, h: 0 });
  const [fitMode, setFitMode] = useState<FitMode>("fit");
  const [zoomPct, setZoomPct] = useState(100);
  const [drawing, setDrawing] = useState(false);
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const [edits, setEdits] = useState<PhotoEdits>({ ...DEFAULT_EDITS, ...(photo.edits ?? {}) });
  const gestureBefore = useRef<PhotoEdits | null>(null);
  /** last server-known edits (gesture diffing must not mutate the SWR object) */
  const serverEdits = useRef<PhotoEdits>({ ...DEFAULT_EDITS, ...(photo.edits ?? {}) });

  const transform = useRef<Transform>({ scale: 1, tx: 0, ty: 0 });
  const imgRef = useRef<{ thumb?: HTMLImageElement; orig?: ImageBitmap }>({});
  const drawQueued = useRef(false);
  const drawRect = useRef<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const panRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);
  const photoIdRef = useRef(photo.id);
  const setViewerZoom = useUiStore((s) => s.setViewerZoom);

  const rotated = edits.angle % 180 !== 0;
  const pw = rotated ? photo.height : photo.width;
  const ph = rotated ? photo.width : photo.height;

  // --- image loading ---
  useEffect(() => {
    photoIdRef.current = photo.id;
    setLoadError(false);
    const initial = { ...DEFAULT_EDITS, ...(photo.edits ?? {}) };
    setEdits(initial);
    serverEdits.current = initial;
    imgRef.current = {};
    let cancelled = false;
    loadImage(thumbUrl(projectId, photo.id))
      .then((img) => {
        if (cancelled) return;
        imgRef.current.thumb = img;
        applyFit("fit");
        requestDraw();
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photo.id]);

  // --- frame measurement ---
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setFrameSize({ w: Math.max(1, r.width), h: Math.max(1, r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fitScale = useCallback(
    (mode: FitMode): number => {
      const { w, h } = frameSize;
      if (w === 0 || h === 0 || pw === 0) return 1;
      if (mode === "one") return 1;
      if (mode === "width") return w / pw;
      return Math.min(w / pw, h / ph);
    },
    [frameSize, pw, ph],
  );

  const applyFit = useCallback(
    (mode: FitMode) => {
      const s = fitScale(mode);
      transform.current = {
        scale: s,
        tx: frameSize.w / 2,
        ty: frameSize.h / 2,
      };
      setFitMode(mode);
      const pct = Math.round(s * 100);
      setZoomPct(pct);
      setViewerZoom(pct);
      requestDraw();
    },
    [fitScale, frameSize, setViewerZoom],
  );

  // Re-fit when the frame resizes (keeps photo centered).
  useEffect(() => {
    if (frameSize.w > 0 && imgRef.current.thumb) applyFit(fitMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frameSize.w, frameSize.h]);

  // --- drawing ---
  const requestDraw = useCallback(() => {
    if (drawQueued.current) return;
    drawQueued.current = true;
    requestAnimationFrame(() => {
      drawQueued.current = false;
      drawAll();
    });
  }, []);

  function photoToScreen(x: number, y: number): [number, number] {
    const tr = transform.current;
    const rad = (edits.angle * Math.PI) / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    // Photo coords are in unrotated space; rotate around center.
    const cx = x - photo.width / 2;
    const cy = y - photo.height / 2;
    let rx = cx * cos - cy * sin;
    let ry = cx * sin + cy * cos;
    if (edits.mirror) rx = -rx;
    return [tr.tx + rx * tr.scale, tr.ty + ry * tr.scale];
  }

  function screenToPhoto(sx: number, sy: number): [number, number] {
    const tr = transform.current;
    const rad = (-edits.angle * Math.PI) / 180;
    let rx = (sx - tr.tx) / tr.scale;
    let ry = (sy - tr.ty) / tr.scale;
    if (edits.mirror) rx = -rx;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const cx = rx * cos - ry * sin;
    const cy = rx * sin + ry * cos;
    return [cx + photo.width / 2, cy + photo.height / 2];
  }

  function drawAll() {
    const base = baseRef.current;
    const overlay = overlayRef.current;
    const frame = frameRef.current;
    if (!base || !overlay || !frame) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const { w: cw, h: ch } = frameSize;
    if (cw === 0) return;
    for (const c of [base, overlay]) {
      c.width = Math.round(cw * dpr);
      c.height = Math.round(ch * dpr);
    }

    const bctx = base.getContext("2d");
    const octx = overlay.getContext("2d");
    if (!bctx || !octx) return;

    // Base photo.
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.fillStyle = "#0d0b08";
    bctx.fillRect(0, 0, cw, ch);
    const src = imgRef.current.orig ?? imgRef.current.thumb;
    const tr = transform.current;
    if (src) {
      bctx.save();
      bctx.translate(tr.tx, tr.ty);
      const rad = (edits.angle * Math.PI) / 180;
      bctx.rotate(rad);
      bctx.scale(edits.mirror ? -tr.scale : tr.scale, tr.scale);
      bctx.filter = colorFilter(edits);
      const sw = src instanceof ImageBitmap ? src.width : (src as HTMLImageElement).naturalWidth;
      const sh = src instanceof ImageBitmap ? src.height : (src as HTMLImageElement).naturalHeight;
      bctx.drawImage(src, -sw / 2, -sh / 2, sw, sh);
      bctx.restore();
      bctx.filter = "none";
    }

    // Overlay: selection rects + in-progress draw rect.
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.clearRect(0, 0, cw, ch);
    for (const sel of selections) {
      const [x0, y0] = photoToScreen(sel.x, sel.y);
      const [x1, y1] = photoToScreen(sel.x + sel.w, sel.y + sel.h);
      const rx = Math.min(x0, x1);
      const ry = Math.min(y0, y1);
      const rw = Math.abs(x1 - x0);
      const rh = Math.abs(y1 - y0);
      const active = sel.id === activeSelectionId;
      octx.strokeStyle = active ? "#E08A3C" : "rgba(224,138,60,.55)";
      octx.lineWidth = active ? 2.5 : 1.5;
      octx.setLineDash(active ? [] : [5, 4]);
      octx.strokeRect(rx, ry, rw, rh);
      octx.setLineDash([]);
      if (active) {
        octx.fillStyle = "#E08A3C";
        octx.font = "11px system-ui";
        octx.fillText(sel.name, rx + 4, ry - 6 > 8 ? ry - 6 : ry + 14);
      }
    }
    if (drawRect.current) {
      const { x0, y0, x1, y1 } = drawRect.current;
      const [sx0, sy0] = photoToScreen(x0, y0);
      const [sx1, sy1] = photoToScreen(x1, y1);
      octx.strokeStyle = "#E08A3C";
      octx.lineWidth = 2;
      octx.setLineDash([6, 4]);
      octx.strokeRect(Math.min(sx0, sx1), Math.min(sy0, sy1), Math.abs(sx1 - sx0), Math.abs(sy1 - sy0));
      octx.setLineDash([]);
    }

    // Navigator minimap when zoomed past fit.
    const nav = navRef.current;
    if (nav) {
      const fs = fitScale("fit");
      if (tr.scale > fs * 1.05 && imgRef.current.thumb) {
        nav.style.display = "block";
        const nw = 132;
        const nh = Math.round((nw * ch) / cw);
        nav.width = nw;
        nav.height = nh;
        const nctx = nav.getContext("2d");
        if (nctx) {
          nctx.fillStyle = "#000";
          nctx.fillRect(0, 0, nw, nh);
          nctx.drawImage(imgRef.current.thumb, 0, 0, nw, nh);
          // Viewport rect: map the visible screen corners back to photo
          // space, then into minimap space.
          const [pvx, pvy] = screenToPhoto(0, 0);
          const [pvx2, pvy2] = screenToPhoto(cw, ch);
          nctx.strokeStyle = "#E08A3C";
          nctx.lineWidth = 1.5;
          nctx.strokeRect(
            (pvx / photo.width) * nw,
            (pvy / photo.height) * nh,
            ((pvx2 - pvx) / photo.width) * nw,
            ((pvy2 - pvy) / photo.height) * nh,
          );
        }
      } else {
        nav.style.display = "none";
      }
    }
  }

  useEffect(() => {
    requestDraw();
  }, [requestDraw, selections, activeSelectionId, edits, frameSize, fitMode, zoomPct]);

  // --- edits: commit on gesture end (one undo command per gesture) ---
  async function commitEdits(next: PhotoEdits) {
    const before = { ...serverEdits.current };
    if (JSON.stringify(before) === JSON.stringify(next)) return;
    const ok = await runCommand(ctx, setEditsOp(ctx, photo.id, before, next), ["photos", "items"]);
    if (ok) {
      serverEdits.current = { ...next };
    } else {
      setEdits(before);
    }
  }

  function beginGesture() {
    gestureBefore.current = { ...edits };
  }
  function endGesture() {
    const before = gestureBefore.current;
    gestureBefore.current = null;
    if (before) commitEdits({ ...edits });
  }

  function setEdit<K extends keyof PhotoEdits>(k: K, v: PhotoEdits[K]) {
    setEdits((prev) => ({ ...prev, [k]: v }));
  }

  function rotateStep(dir: 1 | -1) {
    // R = primary rotate key: 90° CCW per press (design §5 as amended).
    const next = { ...edits, angle: (edits.angle + dir * 90 + 360) % 360 };
    setEdits(next);
    commitEdits(next);
  }

  // --- zoom / pan ---
  function zoomAt(cx: number, cy: number, factor: number) {
    const tr = transform.current;
    const next = Math.min(8, Math.max(0.05, tr.scale * factor));
    const k = next / tr.scale;
    tr.scale = next;
    tr.tx = cx - (cx - tr.tx) * k;
    tr.ty = cy - (cy - tr.ty) * k;
    setFitMode("fit");
    const pct = Math.round(next * 100);
    setZoomPct(pct);
    setViewerZoom(pct);
    requestDraw();
  }

  function panBy(dx: number, dy: number) {
    transform.current.tx += dx;
    transform.current.ty += dy;
    requestDraw();
  }

  async function goOneToOne() {
    if (!originalCache.has(photo.id)) {
      try {
        const bmp = await loadOriginalBitmap(originalUrl(projectId, photo.id));
        originalCache.set(photo.id, bmp);
      } catch {
        /* fall back to thumb */
      }
    }
    const bmp = originalCache.get(photo.id);
    if (bmp) imgRef.current.orig = bmp;
    applyFit("one");
  }

  // --- pointer interactions ---
  function onOverlayPointerDown(e: React.PointerEvent) {
    const rect = overlayRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (drawing) {
      const [px, py] = screenToPhoto(sx, sy);
      drawRect.current = { x0: px, y0: py, x1: px, y1: py };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    panRef.current = { sx: e.clientX, sy: e.clientY, tx: transform.current.tx, ty: transform.current.ty };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onOverlayPointerMove(e: React.PointerEvent) {
    const rect = overlayRef.current!.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    if (drawing && drawRect.current) {
      const [px, py] = screenToPhoto(sx, sy);
      drawRect.current = { ...drawRect.current, x1: px, y1: py };
      requestDraw();
      return;
    }
    if (panRef.current) {
      const dx = e.clientX - panRef.current.sx;
      const dy = e.clientY - panRef.current.sy;
      transform.current.tx = panRef.current.tx + dx;
      transform.current.ty = panRef.current.ty + dy;
      requestDraw();
    }
  }

  async function onOverlayPointerUp(e: React.PointerEvent) {
    if (drawing && drawRect.current) {
      const { x0, y0, x1, y1 } = drawRect.current;
      drawRect.current = null;
      const x = Math.round(Math.min(x0, x1));
      const y = Math.round(Math.min(y0, y1));
      const w = Math.round(Math.abs(x1 - x0));
      const h = Math.round(Math.abs(y1 - y0));
      setDrawing(false);
      if (w >= 8 && h >= 8) {
        const n = selections.length + 1;
        const created = await post(
          `/api/projects/${projectId}/photos/${photo.id}/selections`,
          selectionWire({ name: ts("newSelection", { n }), x, y, w, h }),
        );
        onSelectSelection(adaptSelection(created as never).id);
        onSelectionsChanged();
      } else {
        requestDraw();
      }
      return;
    }
    panRef.current = null;
  }

  function onWheel(e: React.WheelEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const rect = overlayRef.current!.getBoundingClientRect();
      zoomAt(e.clientX - rect.left, e.clientY - rect.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    } else {
      e.preventDefault();
      panBy(-e.deltaX, -e.deltaY);
    }
  }

  function onViewerKeyDown(e: React.KeyboardEvent) {
    const tag = (e.target as HTMLElement).tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    if (e.key === "Escape" && drawing) {
      e.stopPropagation();
      setDrawing(false);
      drawRect.current = null;
      requestDraw();
      return;
    }
    if (drawing) return;
    if ((e.ctrlKey || e.metaKey) && e.code === "Space") {
      e.preventDefault();
      rotateStep(-1);
    } else if (e.key === "r" || e.key === "R") {
      rotateStep(-1);
    } else if (e.key === "s" || e.key === "S") {
      setDrawing(true);
    } else if (e.key === "0") {
      applyFit("fit");
    } else if (e.key === "1") {
      goOneToOne();
    } else if (e.key.startsWith("Arrow")) {
      const step = 48;
      if (e.key === "ArrowLeft") panBy(step, 0);
      else if (e.key === "ArrowRight") panBy(-step, 0);
      else if (e.key === "ArrowUp") panBy(0, step);
      else if (e.key === "ArrowDown") panBy(0, -step);
      e.preventDefault();
    }
  }

  const ariaLabel = t("ariaLabel", {
    filename: photo.filename,
    width: photo.width,
    height: photo.height,
    zoom: zoomPct,
  });

  return (
    <div>
      <div className="ez-viewer-toolbar" role="toolbar" aria-label="viewer">
        <button type="button" className="ez-icon-btn" onClick={() => {
          const r = overlayRef.current!.getBoundingClientRect();
          zoomAt(r.width / 2, r.height / 2, 1.25);
        }} aria-label={t("zoomIn")} title={t("zoomIn")}><ZoomInIcon size={15} /></button>
        <button type="button" className="ez-icon-btn" onClick={() => {
          const r = overlayRef.current!.getBoundingClientRect();
          zoomAt(r.width / 2, r.height / 2, 1 / 1.25);
        }} aria-label={t("zoomOut")} title={t("zoomOut")}><ZoomOutIcon size={15} /></button>
        <input
          type="range"
          className="ez-range"
          style={{ width: 110 }}
          min={5}
          max={800}
          value={zoomPct}
          onChange={(e) => {
            const pct = Number(e.target.value);
            const r = overlayRef.current!.getBoundingClientRect();
            const tr = transform.current;
            const next = pct / 100;
            const k = next / tr.scale;
            tr.scale = next;
            tr.tx = r.width / 2 - (r.width / 2 - tr.tx) * k;
            tr.ty = r.height / 2 - (r.height / 2 - tr.ty) * k;
            setZoomPct(pct);
            setViewerZoom(pct);
            requestDraw();
          }}
          aria-label={t("zoomLevel", { pct: zoomPct })}
          aria-valuetext={t("zoomLevel", { pct: zoomPct })}
        />
        <button type="button" className="ez-btn ez-btn--sm" onClick={() => applyFit("fit")} title={t("fitWindowHint")}>
          {t("fitWindow")}
        </button>
        <button type="button" className="ez-btn ez-btn--sm" onClick={() => applyFit("width")}>
          {t("fitWidth")}
        </button>
        <button type="button" className="ez-btn ez-btn--sm" onClick={goOneToOne} title={t("oneToOneHint")}>
          {t("oneToOne")}
        </button>
        <span className="ez-spacer" />
        <button
          type="button"
          className="ez-icon-btn"
          onClick={() => rotateStep(-1)}
          aria-label={t("rotate")}
          title={`${t("rotate")} (${t("rotateHint")})`}
        >
          <RotateIcon size={15} />
        </button>
        <button
          type="button"
          className="ez-icon-btn"
          aria-pressed={drawing}
          onClick={() => setDrawing((d) => !d)}
          aria-label={drawing ? t("cancelDraw") : t("drawSelection")}
          title={`${t("drawSelection")} (${t("drawSelectionHint")})`}
        >
          <SelectionDrawIcon size={15} />
        </button>
      </div>

      <div
        ref={frameRef}
        className="ez-viewer-frame"
        role="img"
        aria-label={loadError ? t("photoError") : ariaLabel}
        tabIndex={0}
        onKeyDown={onViewerKeyDown}
        style={{ height: 380 }}
      >
        {loadError ? (
          <div className="ez-state" role="alert">
            <p>{t("photoError")}</p>
          </div>
        ) : (
          <>
            <canvas ref={baseRef} style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
            <canvas
              ref={overlayRef}
              className="ez-viewer-overlay"
              data-drawing={drawing || undefined}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
              onPointerDown={onOverlayPointerDown}
              onPointerMove={onOverlayPointerMove}
              onPointerUp={onOverlayPointerUp}
              onWheel={onWheel}
            />
            <canvas ref={navRef} className="ez-navigator" style={{ display: "none", width: 132 }} />
          </>
        )}
      </div>
      {drawing ? <div className="ez-draw-hint" role="status">{t("drawHint")}</div> : null}

      <details className="ez-edit-panel">
        <summary>{t("editPanel")}</summary>
        <div className="ez-edit-body">
          <div className="ez-toggle-row">
            <span style={{ width: 110 }}>{t("rotation")}</span>
            <button type="button" className="ez-btn ez-btn--sm" onClick={() => rotateStep(-1)} aria-label={t("rotateCcw")}><RotateIcon size={13} /> 90°</button>
            <button type="button" className="ez-btn ez-btn--sm" onClick={() => rotateStep(1)} aria-label={t("rotateCw")}><RotateCwIcon size={13} /> 90°</button>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{edits.angle}°</span>
          </div>
          <label className="ez-toggle-row">
            <input
              type="checkbox"
              checked={edits.mirror}
              onChange={(e) => {
                const next = { ...edits, mirror: e.target.checked };
                setEdits(next);
                commitEdits(next);
              }}
            />
            {t("mirror")}
          </label>
          <label className="ez-toggle-row">
            <input
              type="checkbox"
              checked={edits.negative}
              onChange={(e) => {
                const next = { ...edits, negative: e.target.checked };
                setEdits(next);
                commitEdits(next);
              }}
            />
            {t("negative")}
          </label>
          {(
            [
              ["brightness", t("brightness"), -100, 100],
              ["contrast", t("contrast"), -100, 100],
              ["saturation", t("saturation"), -100, 100],
              ["hue", t("hue"), -180, 180],
              ["sharpen", t("sharpen"), 0, 100],
            ] as const
          ).map(([k, label, min, max]) => (
            <div className="ez-slider-row" key={k}>
              <label htmlFor={`ez-edit-${k}`}>{label}</label>
              <input
                id={`ez-edit-${k}`}
                type="range"
                className="ez-range"
                min={min}
                max={max}
                value={edits[k]}
                onPointerDown={beginGesture}
                onChange={(e) => setEdit(k, Number(e.target.value))}
                onPointerUp={endGesture}
                onBlur={endGesture}
              />
              <output>{edits[k]}</output>
            </div>
          ))}
          {editsDirty(edits) ? (
            <div>
              <div className="ez-chip-row" aria-label={t("editsApplied")}>
                {edits.angle !== 0 ? <span className="ez-chip"><RotateIcon size={12} /> {edits.angle}°</span> : null}
                {edits.mirror ? <span className="ez-chip">{t("chipMirrored")}</span> : null}
                {edits.negative ? <span className="ez-chip">{t("chipNegative")}</span> : null}
                {edits.brightness !== 0 ? <span className="ez-chip">B {edits.brightness}</span> : null}
                {edits.contrast !== 0 ? <span className="ez-chip">C {edits.contrast}</span> : null}
                {edits.saturation !== 0 ? <span className="ez-chip">S {edits.saturation}</span> : null}
                {edits.hue !== 0 ? <span className="ez-chip">H {edits.hue}</span> : null}
                {edits.sharpen !== 0 ? <span className="ez-chip">{t("chipSharpen")} {edits.sharpen}</span> : null}
              </div>
              <button
                type="button"
                className="ez-btn ez-btn--sm"
                onClick={() => {
                  const changed = [
                    edits.angle !== 0, edits.mirror, edits.negative,
                    edits.brightness !== 0, edits.contrast !== 0,
                    edits.saturation !== 0, edits.hue !== 0, edits.sharpen !== 0,
                  ].filter(Boolean).length;
                  if (changed > 3) setConfirmRevert(true);
                  else doRevert();
                }}
              >
                {t("revert")}
              </button>
            </div>
          ) : null}
          <p className="ez-notice">{t("previewNotice")}</p>
        </div>
      </details>
      {confirmRevert ? (
        <ConfirmDialog
          title={t("revertConfirmTitle")}
          body={t("revertConfirmBody")}
          confirmLabel={t("revert")}
          onCancel={() => setConfirmRevert(false)}
          onConfirm={async () => {
            setConfirmRevert(false);
            await doRevert();
          }}
        />
      ) : null}
    </div>
  );

  async function doRevert() {
    const before = { ...serverEdits.current };
    const ok = await runCommand(ctx, revertEditsOp(ctx, photo.id, before), ["photos", "items"]);
    if (ok) {
      serverEdits.current = { ...DEFAULT_EDITS };
      setEdits({ ...DEFAULT_EDITS });
    }
  }
}
