// SPDX-License-Identifier: MIT
// Storage meter dialog: usage breakdown, retention choices (owner-picked,
// per-run — never automatic, ADR-2.8), blocked state, CPU budget banner.
// Meter: SWR 60s (architecture §9).
//
// Retention wires the three radios to POST /api/projects/[id]/storage/compress
// with { mode, photoIds? }: 'flagged-only' compresses only the photos the
// owner ticked in the picker below; 'prune' deletes regenerable previews and
// needs an explicit irreversible confirm. A 503 'cpu_paused' response shows
// the existing budget banner copy (the run is refused, not failed).

"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import { useMeter, useCpuBudget } from "@/lib/api/hooks";
import { ApiError, get, newClientOpId, post } from "@/lib/api/client";
import { Dialog, ConfirmDialog } from "@/components/ui/Dialog";
import { formatBytes } from "@/lib/import/files";
import type { RetentionMode, StorageCompressRequest } from "@/lib/types";

interface WireItem {
  subject_id: string;
  photo_count: number;
}

interface WirePhoto {
  subject_id: string;
  original_filename: string;
  mimetype: string;
  size_bytes: number;
  keep_original: boolean;
  missing_original: boolean;
}

interface PickablePhoto {
  id: string;
  filename: string;
  size: number;
}

/** Cap the picker fan-out: items first, photos per item, total photos. */
const PICKER_ITEM_LIMIT = 100;
const PICKER_PHOTO_LIMIT = 200;

export default function StorageDialog({ projectId }: { projectId: string }) {
  const t = useTranslations("meter");
  const ta = useTranslations("app");
  const open = useUiStore((s) => s.retentionOpen);
  const setOpen = useUiStore((s) => s.setRetentionOpen);
  const pushToast = useUiStore((s) => s.pushToast);
  const { data: meter, mutate: mutateMeter } = useMeter(projectId);
  const { data: cpu, mutate: mutateCpu } = useCpuBudget();
  const [mode, setMode] = useState<RetentionMode>("compress");
  const [running, setRunning] = useState(false);
  const [confirmPrune, setConfirmPrune] = useState(false);
  const [pausedNotice, setPausedNotice] = useState(false);

  // Flagged-only photo picker state (null = not loaded yet).
  const [photos, setPhotos] = useState<PickablePhoto[] | null>(null);
  const [photosLoading, setPhotosLoading] = useState(false);
  const [photosTruncated, setPhotosTruncated] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // 95% retention offer: client-triggered once per session (policy stays warn).
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    if (meter && meter.pct >= 95 && meter.policy !== "block" && !offered) {
      setOffered(true);
      setOpen(true);
    }
  }, [meter, offered, setOpen]);

  // Fresh picker each time the dialog opens.
  useEffect(() => {
    if (open) {
      setMode("compress");
      setPhotos(null);
      setPhotosLoading(false);
      setPhotosTruncated(false);
      setSelected(new Set());
      setConfirmPrune(false);
      setPausedNotice(false);
    }
  }, [open ]);

  // Lazily load compressible photos when flagged-only is picked.
  useEffect(() => {
    if (!open || mode !== "flagged-only" || photos !== null || photosLoading) return;
    let cancelled = false;
    (async () => {
      setPhotosLoading(true);
      try {
        const itemsRes = await get<{ items: WireItem[]; total: number }>(
          `/api/projects/${projectId}/items?limit=${PICKER_ITEM_LIMIT}`,
        );
        const withPhotos = (itemsRes.items ?? []).filter((i) => (i.photo_count ?? 0) > 0);
        const lists = await Promise.all(
          withPhotos.map((i) =>
            get<{ items: WirePhoto[] }>(
              `/api/projects/${projectId}/items/${i.subject_id}/photos?limit=${PICKER_ITEM_LIMIT}`,
            ).catch(() => ({ items: [] as WirePhoto[] })),
          ),
        );
        const all: PickablePhoto[] = [];
        let truncated = false;
        outer: for (const l of lists) {
          for (const p of l.items ?? []) {
            // Mirror the server's eligibility: keep_original and missing
            // originals are never compressed, already-WebP has no savings.
            if (p.keep_original || p.missing_original || p.mimetype === "image/webp") continue;
            all.push({ id: p.subject_id, filename: p.original_filename, size: p.size_bytes });
            if (all.length >= PICKER_PHOTO_LIMIT) {
              truncated = true;
              break outer;
            }
          }
        }
        if (!cancelled) {
          setPhotos(all);
          setPhotosTruncated(truncated);
          setSelected(new Set(all.map((p) => p.id)));
        }
      } catch {
        if (!cancelled) setPhotos([]);
      } finally {
        if (!cancelled) setPhotosLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, mode, photos, photosLoading, projectId]);

  async function executeRetention() {
    setRunning(true);
    try {
      const body: StorageCompressRequest =
        mode === "flagged-only" ? { mode, photoIds: [...selected] } : { mode };
      await post(`/api/projects/${projectId}/storage/compress`, body, { opId: newClientOpId() });
      await mutateMeter();
      pushToast({ message: t("retentionDone") });
      setOpen(false);
    } catch (err) {
      if (err instanceof ApiError && err.status === 503) {
        // CPU budget paused: the run is refused, not failed. Refresh the
        // budget so the banner reflects it, and surface the banner copy.
        void mutateCpu();
        setPausedNotice(true);
        pushToast({
          message: t("cpuPaused", {
            date: cpu?.resumes ? new Date(cpu.resumes).toLocaleDateString() : "—",
          }),
          kind: "error",
        });
      } else {
        pushToast({ message: err instanceof Error ? err.message : "failed", kind: "error" });
      }
    } finally {
      setRunning(false);
    }
  }

  async function runRetention() {
    if (mode === "prune") {
      // Prune deletes data — explicit irreversible confirm first.
      setConfirmPrune(true);
      return;
    }
    await executeRetention();
  }

  function togglePhoto(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (!open) return null;

  const blocked = meter?.policy === "block";
  const flaggedReady = mode !== "flagged-only" || (!photosLoading && selected.size > 0);
  const pausedDate = cpu?.resumes ? new Date(cpu.resumes).toLocaleDateString() : "—";

  return (
    <Dialog title={t("storage")} onClose={() => setOpen(false)}>
      {meter ? (
        <>
          <p style={{ fontFamily: "var(--font-mono)", fontSize: 14 }}>
            {t("ofLimit", { used: formatBytes(meter.bytes_used), limit: formatBytes(meter.bytes_limit) })}
            {" "}({Math.round(meter.pct)}%)
          </p>
          <div className="ez-progress" style={{ height: 10 }} role="progressbar" aria-valuenow={Math.round(meter.pct)} aria-valuemin={0} aria-valuemax={100} aria-label={t("storage")}>
            <span style={{ width: `${Math.min(100, meter.pct)}%` }} />
          </div>
          {meter.breakdown ? (
            <ul style={{ fontSize: 12, color: "var(--ink-2)" }}>
              <li>Originals: {formatBytes(meter.breakdown.originals)}</li>
              <li>Previews: {formatBytes(meter.breakdown.thumbs)}</li>
              <li>Exports: {formatBytes(meter.breakdown.exports)}</li>
            </ul>
          ) : null}
        </>
      ) : (
        <p>{ta("loading")}</p>
      )}

      {blocked ? (
        <div className="ez-banner" data-kind="danger" style={{ borderRadius: 8 }}>
          <span>
            <strong>{t("blockedTitle")}</strong>
            <br />
            {t("blockedBody")}
          </span>
        </div>
      ) : null}

      {meter && meter.pct >= 80 && !blocked ? (
        <div className="ez-banner" data-kind="warn" style={{ borderRadius: 8, marginTop: 8 }}>
          <span>{meter.pct >= 95 ? t("warn95Body", { pct: Math.round(meter.pct) }) : t("warn80", { pct: Math.round(meter.pct) })}</span>
        </div>
      ) : null}

      {meter && meter.pct >= 95 ? (
        <div style={{ marginTop: 12 }}>
          <h3 style={{ fontSize: 14 }}>{t("warn95Title")}</h3>
          {(
            [
              ["compress", t("optCompress"), t("optCompressHint")],
              ["flagged-only", t("optFlagged"), t("optFlaggedHint")],
              ["prune", t("optPrune"), t("optPruneHint")],
            ] as [RetentionMode, string, string][]
          ).map(([m, label, hint]) => (
            <label key={m} style={{ display: "block", margin: "8px 0", fontSize: 13 }}>
              <input
                type="radio"
                name="retention-mode"
                checked={mode === m}
                onChange={() => setMode(m)}
              />{" "}
              <strong>{label}</strong>
              <br />
              <span style={{ fontSize: 11, color: "var(--ink-2)", marginLeft: 22 }}>{hint}</span>
            </label>
          ))}

          {mode === "flagged-only" ? (
            <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 8, marginTop: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <strong style={{ fontSize: 13 }}>
                  {t("flaggedPickTitle")} ({selected.size})
                </strong>
                <span>
                  <button
                    type="button"
                    className="ez-btn ez-btn--sm"
                    disabled={!photos?.length}
                    onClick={() => setSelected(new Set((photos ?? []).map((p) => p.id)))}
                  >
                    {t("selectAll")}
                  </button>{" "}
                  <button
                    type="button"
                    className="ez-btn ez-btn--sm"
                    disabled={selected.size === 0}
                    onClick={() => setSelected(new Set())}
                  >
                    {ta("clear")}
                  </button>
                </span>
              </div>
              {photosLoading ? (
                <p style={{ fontSize: 12 }}>{ta("loading")}</p>
              ) : photos && photos.length > 0 ? (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: 180, overflowY: "auto", fontSize: 12 }}>
                  {photos.map((p) => (
                    <li key={p.id}>
                      <label style={{ display: "flex", gap: 6, alignItems: "center", padding: "2px 0" }}>
                        <input
                          type="checkbox"
                          checked={selected.has(p.id)}
                          onChange={() => togglePhoto(p.id)}
                        />
                        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>
                          {p.filename}
                        </span>
                        <span style={{ color: "var(--ink-2)", whiteSpace: "nowrap" }}>{formatBytes(p.size)}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={{ fontSize: 12 }}>{t("flaggedEmpty")}</p>
              )}
              {photosTruncated ? (
                <p style={{ fontSize: 11, color: "var(--ink-2)" }}>{t("flaggedTruncated")}</p>
              ) : null}
            </div>
          ) : null}

          <button
            type="button"
            className="ez-btn ez-btn--primary"
            disabled={running || blocked || !flaggedReady}
            onClick={runRetention}
            style={{ marginTop: 8 }}
          >
            {t("runRetention")}
          </button>
        </div>
      ) : null}

      {cpu?.paused || pausedNotice ? (
        <div className="ez-banner" data-kind="warn" style={{ borderRadius: 8, marginTop: 8 }}>
          <span>{t("cpuPaused", { date: pausedDate })}</span>
        </div>
      ) : null}

      {confirmPrune ? (
        <ConfirmDialog
          title={t("pruneConfirmTitle")}
          body={t("pruneConfirmBody")}
          confirmLabel={t("optPrune")}
          danger
          onCancel={() => setConfirmPrune(false)}
          onConfirm={async () => {
            setConfirmPrune(false);
            await executeRetention();
          }}
        />
      ) : null}

      <div style={{ marginTop: 12 }}>
        <button type="button" className="ez-btn ez-btn--sm" onClick={() => { void mutateMeter(); }}>
          {t("refresh")}
        </button>
      </div>
    </Dialog>
  );
}
