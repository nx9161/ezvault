// SPDX-License-Identifier: MIT
// Storage meter dialog: usage breakdown, retention choices (owner-picked,
// per-run — never automatic, ADR-2.8), blocked state, CPU budget banner.
// Meter: SWR 60s (architecture §9).

"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import { useMeter, useCpuBudget } from "@/lib/api/hooks";
import { post } from "@/lib/api/client";
import { Dialog } from "@/components/ui/Dialog";
import { formatBytes } from "@/lib/import/files";

type RetentionMode = "compress" | "flagged-only" | "prune";

export default function StorageDialog({ projectId }: { projectId: string }) {
  const t = useTranslations("meter");
  const ta = useTranslations("app");
  const open = useUiStore((s) => s.retentionOpen);
  const setOpen = useUiStore((s) => s.setRetentionOpen);
  const pushToast = useUiStore((s) => s.pushToast);
  const { data: meter, mutate: mutateMeter } = useMeter(projectId);
  const { data: cpu } = useCpuBudget();
  const [mode, setMode] = useState<RetentionMode>("compress");
  const [running, setRunning] = useState(false);

  // 95% retention offer: client-triggered once per session (policy stays warn).
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    if (meter && meter.pct >= 95 && meter.policy !== "block" && !offered) {
      setOffered(true);
      setOpen(true);
    }
  }, [meter, offered, setOpen]);

  if (!open) return null;

  async function runRetention() {
    setRunning(true);
    try {
      // The landed retention action is compression of eligible originals
      // (keep_original excluded). Selective modes (flagged-only / prune)
      // need backend endpoints — flagged for the backend.
      void mode;
      await post(`/api/projects/${projectId}/storage/compress`, {});
      await mutateMeter();
      pushToast({ message: t("runRetention") });
      setOpen(false);
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "failed", kind: "error" });
    } finally {
      setRunning(false);
    }
  }

  const blocked = meter?.policy === "block";

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
              ["compress", t("optCompress"), t("optCompressHint"), true],
              ["flagged-only", t("optFlagged"), t("optFlaggedHint"), false],
              ["prune", t("optPrune"), t("optPruneHint"), false],
            ] as [RetentionMode, string, string, boolean][]
          ).map(([m, label, hint, available]) => (
            <label key={m} style={{ display: "block", margin: "8px 0", fontSize: 13, opacity: available ? 1 : 0.55 }}>
              <input
                type="radio"
                name="retention-mode"
                checked={mode === m}
                disabled={!available}
                onChange={() => setMode(m)}
              />{" "}
              <strong>{label}</strong>
              {!available ? <span style={{ fontSize: 11 }}> ({t("pendingBackend")})</span> : null}
              <br />
              <span style={{ fontSize: 11, color: "var(--ink-2)", marginLeft: 22 }}>{hint}</span>
            </label>
          ))}
          <button
            type="button"
            className="ez-btn ez-btn--primary"
            disabled={running || blocked || mode !== "compress"}
            onClick={runRetention}
            style={{ marginTop: 8 }}
          >
            {t("runRetention")}
          </button>
        </div>
      ) : null}

      {cpu?.paused ? (
        <div className="ez-banner" data-kind="warn" style={{ borderRadius: 8, marginTop: 8 }}>
          <span>{t("cpuPaused", { date: cpu.resumes ? new Date(cpu.resumes).toLocaleDateString() : "—" })}</span>
        </div>
      ) : null}

      <div style={{ marginTop: 12 }}>
        <button type="button" className="ez-btn ez-btn--sm" onClick={() => { void mutateMeter(); }}>
          {t("refresh")}
        </button>
      </div>
    </Dialog>
  );
}
