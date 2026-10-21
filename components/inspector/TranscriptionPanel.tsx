// SPDX-License-Identifier: MIT
// Wave C (rows 13/14): transcription panel for the selected photo —
// manual editor, ALTO import/export, plain-text export, and Run OCR
// (Tesseract.js, dynamic-imported on first use ONLY — nothing OCR
// related is in this component's static import graph).

"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useTranscriptions, thumbUrl } from "@/lib/api/hooks";
import { post, patch, del } from "@/lib/api/client";
import { useUiStore } from "@/lib/store/ui";
import type { Photo, Transcription } from "@/lib/api/types";

const OCR_LANGS = ["eng", "deu", "fra", "spa", "ita", "por", "nld", "chi_sim", "jpn", "hin"];

function sourceLabel(t: (k: string, v?: Record<string, string>) => string, tr: Transcription): string {
  const src = typeof tr.config?.['source'] === 'string' ? (tr.config['source'] as string) : 'manual';
  if (src === 'alto') return t("sourceAlto");
  if (src === 'ocr') {
    const engine = typeof tr.config?.['engine'] === 'string' ? (tr.config['engine'] as string) : 'ocr';
    return t("sourceOcr", { engine });
  }
  return t("sourceManual");
}

export default function TranscriptionPanel({
  projectId,
  photo,
}: {
  projectId: string;
  photo: Photo;
}) {
  const t = useTranslations("transcription");
  const pushToast = useUiStore((s) => s.pushToast);
  const { data, mutate } = useTranscriptions(projectId, photo.id);
  const items = data?.items ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [lang, setLang] = useState("eng");
  const [ocrPct, setOcrPct] = useState<number | null>(null);

  const active = items.find((i) => i.id === selectedId) ?? items[0] ?? null;

  // Keep the editor in sync with the selected transcription (but never
  // clobber an in-progress OCR/save cycle — those set the draft directly).
  useEffect(() => {
    setDraft(active?.text ?? "");
    setConfirmDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, photo.id]);

  async function save() {
    setSaving(true);
    try {
      if (active) {
        await patch(`/api/projects/${projectId}/transcriptions/${active.id}`, { text: draft });
      } else {
        const created = await post<Transcription>(
          `/api/projects/${projectId}/photos/${photo.id}/transcriptions`,
          { text: draft },
        );
        setSelectedId(created.id);
      }
      await mutate();
      pushToast({ message: t("saved"), kind: "info" });
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "save failed", kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!active) return;
    try {
      await del(`/api/projects/${projectId}/transcriptions/${active.id}`);
      setSelectedId(null);
      setConfirmDelete(false);
      await mutate();
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "delete failed", kind: "error" });
    }
  }

  async function onAltoFile(file: File) {
    setImporting(true);
    try {
      const xml = await file.text();
      const created = await post<Transcription>(
        `/api/projects/${projectId}/photos/${photo.id}/transcriptions/alto`,
        { xml },
      );
      setSelectedId(created.id);
      await mutate();
      pushToast({ message: t("saved"), kind: "info" });
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "ALTO import failed", kind: "error" });
    } finally {
      setImporting(false);
    }
  }

  async function runOcr() {
    setOcrPct(0);
    try {
      // Image source: the stored thumbnail (WebP, <=1600px) — always a
      // raster tesseract can read, unlike PDF/SVG originals. Words are
      // scaled from thumb space into photo pixel space before saving.
      const imgRes = await fetch(thumbUrl(projectId, photo.id));
      if (!imgRes.ok) throw new Error("could not load the photo image for OCR");
      const imgBlob = await imgRes.blob();
      const bmp = await createImageBitmap(imgBlob);
      const sx = photo.width / bmp.width;
      const sy = photo.height / bmp.height;
      bmp.close();

      // Dynamic import on first use only: tesseract.js + its worker
      // assets stay out of First Load JS (INTEGRATION-DECISIONS #9).
      await import("@/lib/ocr/tesseract-engine");
      const { getOcrEngine, transcriptionPayloadFromOcr } = await import("@/lib/ocr/adapter");
      const engine = getOcrEngine("tesseract");
      if (!engine) throw new Error("OCR engine failed to register");
      const result = await engine.recognize(imgBlob, {
        lang,
        onProgress: (p) => {
          if (p.status === "recognizing text") setOcrPct(Math.round(p.progress * 100));
        },
      });
      const scaled = {
        text: result.text,
        words: result.words.map((w) => ({
          ...w,
          x: w.x * sx,
          y: w.y * sy,
          w: w.w * sx,
          h: w.h * sy,
        })),
      };
      const payload = transcriptionPayloadFromOcr(scaled, {
        engine: engine.id,
        version: engine.version,
        lang,
        pageWidth: photo.width,
        pageHeight: photo.height,
      });
      const created = await post<Transcription>(
        `/api/projects/${projectId}/photos/${photo.id}/transcriptions`,
        payload,
      );
      setSelectedId(created.id);
      await mutate();
      pushToast({ message: t("ocrDone"), kind: "info" });
    } catch (err) {
      // Honest failure: no transcription is created on error.
      pushToast({
        message: t("ocrFailed", { message: err instanceof Error ? err.message : "unknown error" }),
        kind: "error",
      });
    } finally {
      setOcrPct(null);
    }
  }

  return (
    <section aria-label={t("panelTitle")} style={{ marginTop: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <h3 style={{ fontSize: 13, margin: 0 }}>{t("panelTitle")}</h3>
        <span style={{ flex: 1 }} />
        {items.length > 1 ? (
          <select
            className="ez-select"
            value={active?.id ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
            aria-label={t("panelTitle")}
          >
            {items.map((tr, i) => (
              <option key={tr.id} value={tr.id}>
                {i + 1} · {sourceLabel(t as never, tr)}
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className="ez-btn ez-btn--sm"
          onClick={() => {
            setSelectedId(null);
            setDraft("");
          }}
        >
          +
        </button>
      </div>

      {active ? (
        <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "6px 0" }}>
          {sourceLabel(t as never, active)} · {t("status", { status: active.status })}
          {active.words.length > 0 ? <> · {t("wordsNote", { count: active.words.length })}</> : null}
        </p>
      ) : (
        <p style={{ fontSize: 12, color: "var(--ink-2)", margin: "6px 0" }}>{t("empty")}</p>
      )}

      <label style={{ display: "block", fontSize: 12, marginBottom: 4 }} htmlFor="ez-transcription-text">
        {t("textLabel")}
      </label>
      <textarea
        id="ez-transcription-text"
        className="ez-input"
        style={{ width: "100%", minHeight: 120, fontFamily: "var(--font-mono)", fontSize: 12 }}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t("textPlaceholder")}
      />

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8, alignItems: "center" }}>
        <button type="button" className="ez-btn ez-btn--sm" onClick={() => void save()} disabled={saving}>
          {saving ? t("saving") : t("save")}
        </button>
        <button
          type="button"
          className="ez-btn ez-btn--sm"
          onClick={() => fileRef.current?.click()}
          disabled={importing}
        >
          {importing ? t("importing") : t("importAlto")}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".xml,application/xml,text/xml"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void onAltoFile(f);
          }}
        />
        {active?.alto_r2_key ? (
          <a className="ez-btn ez-btn--sm" href={`/api/projects/${projectId}/transcriptions/${active.id}/alto`}>
            {t("downloadAlto")}
          </a>
        ) : null}
        {active ? (
          <a className="ez-btn ez-btn--sm" href={`/api/projects/${projectId}/transcriptions/${active.id}/text`}>
            {t("downloadText")}
          </a>
        ) : null}
        {active ? (
          confirmDelete ? (
            <>
              <span style={{ fontSize: 11 }}>{t("deleteConfirm")}</span>
              <button type="button" className="ez-btn ez-btn--sm" onClick={() => void remove()}>
                {t("delete")}
              </button>
              <button type="button" className="ez-btn ez-btn--sm" onClick={() => setConfirmDelete(false)}>
                ✕
              </button>
            </>
          ) : (
            <button type="button" className="ez-btn ez-btn--sm" onClick={() => setConfirmDelete(true)}>
              {t("delete")}
            </button>
          )
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 10 }}>
        <label style={{ fontSize: 12 }} htmlFor="ez-ocr-lang">
          {t("ocrLang")}
        </label>
        <select
          id="ez-ocr-lang"
          className="ez-select"
          value={lang}
          onChange={(e) => setLang(e.target.value)}
        >
          {OCR_LANGS.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="ez-btn ez-btn--sm"
          onClick={() => void runOcr()}
          disabled={ocrPct !== null}
        >
          {ocrPct !== null ? t("ocrRunning", { pct: ocrPct }) : t("runOcr")}
        </button>
      </div>
    </section>
  );
}
