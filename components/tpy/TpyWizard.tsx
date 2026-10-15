// SPDX-License-Identifier: MIT
// .tpy import wizard (design §2.7, architecture §2.12):
// upload (SQLite magic checked client-side) → analyze → map & conflicts →
// run (50-item txns, resumable) → resolve-missing (Advanced re-link) →
// report + CSV + one-step undo. His DHUM_Project.tpy is Advanced-style —
// the re-link flow is the primary acceptance path.

"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import { useTemplates, useJob } from "@/lib/api/hooks";
import { post } from "@/lib/api/client";
import { commandBus } from "@/lib/commands/bus";
import { importUndoCommand, refreshAndBroadcast, type OpContext } from "@/lib/commands/ops";
import { useOpContext } from "@/components/sidebar/Sidebar";
import { Dialog, ConfirmDialog } from "@/components/ui/Dialog";
import { presignBatch, putWithProgress } from "@/lib/import/upload";

type Step = "upload" | "analyze" | "map" | "run" | "report";

interface AnalyzeReport {
  job_id: string;
  application_id_ok: boolean;
  user_version: number;
  user_version_warning: string | null;
  counts: Record<string, number>;
  template_uris: string[];
  unknown_tables: string[];
}

interface RunReport {
  imported: Record<string, number>;
  expected: Record<string, number>;
  conflicts: number;
  done: boolean;
}

const SQLITE_MAGIC = "SQLite format 3\0";

async function checkSqliteMagic(file: File): Promise<boolean> {
  const head = await file.slice(0, 16).arrayBuffer();
  const text = new TextDecoder().decode(head);
  return text === SQLITE_MAGIC;
}

export default function TpyWizard({ projectId }: { projectId: string }) {
  const t = useTranslations("tpy");
  const ta = useTranslations("app");
  const open = useUiStore((s) => s.tpyOpen);
  const setOpen = useUiStore((s) => s.setTpyOpen);
  const pushToast = useUiStore((s) => s.pushToast);
  const ctx: OpContext = useOpContext(projectId);
  const { data: templates } = useTemplates(projectId);

  const [step, setStep] = useState<Step>("upload");
  const [tpyFile, setTpyFile] = useState<File | null>(null);
  const [assetsFile, setAssetsFile] = useState<File | null>(null);
  // D-M6: explicit project-kind choice before the pickers.
  const [projectKind, setProjectKind] = useState<"standard" | "advanced" | null>(null);
  const kindStandardRef = useRef<HTMLButtonElement>(null);
  const kindAdvancedRef = useRef<HTMLButtonElement>(null);
  function kindCardKeys(e: React.KeyboardEvent) {
    if (
      e.key === "ArrowRight" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowLeft" ||
      e.key === "ArrowUp"
    ) {
      e.preventDefault();
      const isStandard = e.currentTarget === kindStandardRef.current;
      (isStandard ? kindAdvancedRef : kindStandardRef).current?.focus();
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      (e.currentTarget as HTMLButtonElement).click();
    }
  }
  const [magicOk, setMagicOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  // F-D: determinate staging-upload progress (null when not uploading).
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [stagingJobId, setStagingJobId] = useState<string | null>(null);
  const [report, setReport] = useState<AnalyzeReport | null>(null);
  const [templateMap, setTemplateMap] = useState<Record<string, string>>({});
  const [conflictPolicy, setConflictPolicy] = useState<"skip" | "copy">("skip");
  const [runJobId, setRunJobId] = useState<string | null>(null);
  // F-D: run-step cancel state.
  const [cancelling, setCancelling] = useState(false);
  const [cancelledNote, setCancelledNote] = useState(false);
  const [runReport, setRunReport] = useState<RunReport | null>(null);
  const [missing, setMissing] = useState<{ filename: string; photo_subject_id: string }[]>([]);
  const [confirmUndo, setConfirmUndo] = useState(false);
  const tpyInputRef = useRef<HTMLInputElement>(null);
  const assetsInputRef = useRef<HTMLInputElement>(null);
  const relinkInputRef = useRef<HTMLInputElement>(null);

  const { data: runJob } = useJob(step === "run" ? runJobId : null);

  if (!open) return null;
  const steps: Step[] = ["upload", "analyze", "map", "run", "report"];
  const stepIdx = steps.indexOf(step);

  async function pickTpy(file: File) {
    setTpyFile(file);
    setMagicOk(await checkSqliteMagic(file));
  }

  async function doUploadAndAnalyze() {
    if (!tpyFile || magicOk === false) return;
    setBusy(true);
    setStep("analyze");
    try {
      setProgress(t("analyzing"));
      // 1. Presign staging PUTs (canonical TpyPresign shape).
      const presigned = await post<{
        job_id: string;
        tpy_grant: { url: string; key: string };
        assets_grant?: { url: string; key: string };
      }>("/api/import/tpy/presign", {
        project_id: projectId,
        with_assets: !!assetsFile,
      });
      setStagingJobId(presigned.job_id);
      // F-D: wire the upload byte progress into a determinate bar.
      const tpySize = tpyFile.size;
      const zipSize = assetsFile?.size ?? 0;
      const totalBytes = tpySize + zipSize;
      let tpyLoaded = 0;
      let zipLoaded = 0;
      const reportUpload = () => {
        if (totalBytes > 0) setUploadPct(Math.round(((tpyLoaded + zipLoaded) / totalBytes) * 100));
      };
      setUploadPct(0);
      await putWithProgress(
        presigned.tpy_grant.url,
        tpyFile,
        "application/x-sqlite3",
        (loaded) => {
          tpyLoaded = loaded;
          reportUpload();
        },
      );
      if (assetsFile && presigned.assets_grant) {
        await putWithProgress(
          presigned.assets_grant.url,
          assetsFile,
          assetsFile.type || "application/octet-stream",
          (loaded) => {
            zipLoaded = loaded;
            reportUpload();
          },
        );
      }
      setUploadPct(null);
      // 2. Register the staged files, then analyze (server-side single pass).
      await post("/api/import/tpy/upload-complete", {
        job_id: presigned.job_id,
        project_id: projectId,
        staged_key: presigned.tpy_grant.key,
        assets_zip_key: presigned.assets_grant?.key,
      });
      const analysis = await post<AnalyzeReport>("/api/import/tpy/analyze", {
        job_id: presigned.job_id,
      });
      setReport(analysis);
      const initialMap: Record<string, string> = {};
      for (const uri of analysis.template_uris) {
        initialMap[uri] = "__create__";
      }
      setTemplateMap(initialMap);
      setStep("map");
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "analyze failed", kind: "error" });
      setStep("upload");
    } finally {
      setBusy(false);
    }
  }

  // F-D: safe cancel — the backend marks the job cancelled and deletes
  // staged files (POST /api/jobs/[jobId]/cancel); the useJob poll then
  // carries the terminal state into the report step.
  async function cancelRun() {
    if (!runJobId || cancelling) return;
    setCancelling(true);
    try {
      await post(`/api/jobs/${runJobId}/cancel`);
      setCancelledNote(true);
    } catch {
      /* the poll will surface the true state */
    } finally {
      setCancelling(false);
    }
  }

  async function doRun() {
    if (!stagingJobId || !report) return;
    setBusy(true);
    setStep("run");
    try {
      const template_map: Record<string, "use_existing" | "create_new"> = {};
      for (const [uri, target] of Object.entries(templateMap)) {
        template_map[uri] = target === "__create__" ? "create_new" : "use_existing";
      }
      const rep = await post<RunReport & { job_id: string }>("/api/import/tpy/run", {
        job_id: stagingJobId,
        project_id: projectId,
        mode: projectKind ?? (assetsFile ? "standard" : "advanced"),
        duplicate_policy: conflictPolicy === "skip" ? "skip" : conflictPolicy === "copy" ? "keep_both" : "skip",
        template_map,
      });
      setRunJobId(rep.job_id);
      // TpyRunResponse carries imported/expected/conflicts — that IS the report.
      setRunReport(rep);
      // Progress is mirrored by the useJob polling hook; the terminal
      // transition to "report" happens in the effect below.
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "import failed", kind: "error" });
      setStep("map");
    } finally {
      setBusy(false);
    }
  }

  // Terminal run-job → report step (effect, never during render).
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (step !== "run" || !runJob || !["done", "failed", "cancelled"].includes(runJob.status)) return;
    if (reportedRef.current === runJob.id) return;
    reportedRef.current = runJob.id;
    (async () => {
      // Missing originals (advanced mode) surface on the job's report payload.
      const jobRep = (runJob.report ?? {}) as {
        missing_originals?: { filename: string; photo_subject_id: string }[];
      };
      setMissing(
        (jobRep.missing_originals ?? []).map((m) => ({
          filename: m.filename,
          photo_subject_id: m.photo_subject_id,
        })),
      );
      setStep("report");
      commandBus.push(importUndoCommand(ctx, runJob.id, t("undoTpy")));
      void refreshAndBroadcast(ctx, ["items", "lists", "tags", "meter"]);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, runJob?.status]);

  /**
   * Advanced re-link: stage the picked originals via the normal presign flow,
   * match by filename against the missing list, then resolve-missing with
   * explicit staged_key → photo_subject_id links.
   */
  async function relink(files: FileList | null) {
    if (!files || !runJobId) return;
    setBusy(true);
    try {
      const picked = Array.from(files);
      const { grants } = await presignBatch(
        projectId,
        picked.map((f) => ({
          sha256: "relink",
          size: f.size,
          mimetype: f.type || "application/octet-stream",
          filename: f.name,
        })),
      );
      const links: { staged_key: string; photo_subject_id: string }[] = [];
      for (const g of grants) {
        // PresignGrant carries no filename — match grants to files by order.
        const f = picked[grants.indexOf(g)];
        if (!f) continue;
        await putWithProgress(g.url, f, f.type || "application/octet-stream", () => {});
        const miss = missing.find((m) => m.filename === f.name);
        if (miss) links.push({ staged_key: g.key, photo_subject_id: miss.photo_subject_id });
      }
      if (links.length === 0) {
        pushToast({ message: t("relinkNoMatch"), kind: "error" });
        return;
      }
      const res = await post<{ matched: number; still_missing: { filename: string; photo_subject_id: string }[] }>(
        "/api/import/tpy/resolve-missing",
        { job_id: runJobId, project_id: projectId, links },
      );
      setMissing(res.still_missing ?? []);
      pushToast({ message: t("relinkMatched", { count: res.matched }) });
      void refreshAndBroadcast(ctx, ["items"]);
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "re-link failed", kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("title")} onClose={() => setOpen(false)} wide>
      <div className="ez-steps" aria-label="progress">
        {steps.map((s) => (
          <div
            key={s}
            className="ez-step"
            data-active={s === step || undefined}
            data-done={steps.indexOf(s) < stepIdx || undefined}
            aria-current={s === step ? "step" : undefined}
          >
            {t(`step${s[0].toUpperCase()}${s.slice(1)}` as "stepUpload")}
          </div>
        ))}
      </div>

      {step === "upload" ? (
        <div data-tour="tpy-upload">
          <p className="ez-notice">{t("tpyHint")}</p>
          <p className="ez-notice">{t("mobileWarning")}</p>
          {projectKind === null ? (
            <div className="ez-kind-cards" role="radiogroup" aria-label={t("kindGroupLabel")}>
              <button
                type="button"
                role="radio"
                aria-checked={false}
                className="ez-kind-card"
                ref={kindStandardRef}
                onClick={() => setProjectKind("standard")}
                onKeyDown={kindCardKeys}
              >
                <strong>{t("kindStandardTitle")}</strong>
                <span>{t("kindStandardBody")}</span>
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={false}
                className="ez-kind-card"
                ref={kindAdvancedRef}
                onClick={() => setProjectKind("advanced")}
                onKeyDown={kindCardKeys}
              >
                <strong>{t("kindAdvancedTitle")}</strong>
                <span>{t("kindAdvancedBody")}</span>
              </button>
            </div>
          ) : (
            <>
              <div className="ez-kind-chosen">
                <span>
                  {projectKind === "standard" ? t("kindStandardTitle") : t("kindAdvancedTitle")}
                </span>
                <button
                  type="button"
                  className="ez-btn ez-btn--sm ez-btn--ghost"
                  onClick={() => {
                    setProjectKind(null);
                    setAssetsFile(null);
                  }}
                >
                  {t("kindChange")}
                </button>
              </div>
              {projectKind === "advanced" ? (
                <p className="ez-notice">{t("relinkBody")}</p>
              ) : null}
            </>
          )}
          {projectKind !== null ? (
          <>
          <div style={{ display: "flex", gap: 8, margin: "12px 0", flexWrap: "wrap" }}>
            <input
              ref={tpyInputRef}
              type="file"
              accept=".tpy"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void pickTpy(f);
                e.target.value = "";
              }}
            />
            <button type="button" className="ez-btn" onClick={() => tpyInputRef.current?.click()}>
              {t("pickTpy")}
            </button>
            <input
              ref={assetsInputRef}
              type="file"
              accept=".zip"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setAssetsFile(f);
                e.target.value = "";
              }}
            />
            {projectKind === "standard" ? (
              <button type="button" className="ez-btn" onClick={() => assetsInputRef.current?.click()}>
                {t("assetsLabel")}
              </button>
            ) : null}
          </div>
          {tpyFile ? (
            <p style={{ fontSize: 13 }}>
              <span style={{ fontFamily: "var(--font-mono)" }}>{tpyFile.name}</span>{" "}
              {magicOk === false ? (
                <span style={{ color: "var(--danger)" }} role="alert">{t("invalidTpy")}</span>
              ) : magicOk ? (
                <span style={{ color: "var(--ok)" }}>✓</span>
              ) : null}
              {assetsFile ? <span> + {assetsFile.name}</span> : null}
            </p>
          ) : (
            <p
              className="ez-dropzone"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const files = Array.from(e.dataTransfer.files);
                const tpy = files.find((x) => x.name.endsWith(".tpy"));
                if (tpy) void pickTpy(tpy);
                // Standard-mode zip drops route to the assets picker.
                if (projectKind === "standard") {
                  const zip = files.find((x) => x.name.endsWith(".zip"));
                  if (zip) setAssetsFile(zip);
                }
              }}
            >
              {t("dropTpy")}
            </p>
          )}
          <div className="ez-dialog-foot" style={{ border: 0, padding: "12px 0 0" }}>
            <button
              type="button"
              className="ez-btn ez-btn--primary"
              disabled={
                !tpyFile ||
                magicOk === false ||
                busy ||
                (projectKind === "standard" && !assetsFile)
              }
              onClick={doUploadAndAnalyze}
            >
              {ta("next")}
            </button>
          </div>
          </>
          ) : null}
        </div>
      ) : null}

      {step === "analyze" ? (
        <div className="ez-state" style={{ height: "auto" }} data-tour="tpy-analyze">
          {uploadPct !== null ? (
            <div className="ez-job-row">
              <span className="ez-progress">
                <span style={{ width: `${uploadPct}%` }} />
              </span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {t("uploadingPct", { pct: uploadPct })}
              </span>
            </div>
          ) : (
            <p>{progress || t("analyzing")}</p>
          )}
        </div>
      ) : null}

      {step === "map" && report ? (
        <div data-tour="tpy-map">
          {report.application_id_ok ? null : (
            <div className="ez-banner" data-kind="warn" style={{ borderRadius: 8 }}>
              <span>{t("notTpyAppId")}</span>
            </div>
          )}
          {report.user_version_warning ? (
            <p className="ez-notice" role="note">{report.user_version_warning}</p>
          ) : null}
          <p style={{ fontSize: 13 }}>
            {t("countsLine", {
              items: report.counts.items ?? 0,
              photos: report.counts.photos ?? 0,
              selections: report.counts.selections ?? 0,
              notes: report.counts.notes ?? 0,
            })}{" "}
            <span style={{ color: "var(--ink-3)" }}>(user_version {report.user_version})</span>
          </p>
          <h4 style={{ fontSize: 13 }}>{t("mapTitle")}</h4>
          {report.template_uris.map((uri) => (
            <div className="ez-file-row" key={uri}>
              <span className="ez-name" title={uri} style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>{uri}</span>
              <select
                className="ez-select"
                value={templateMap[uri] ?? "__create__"}
                onChange={(e) => setTemplateMap((p) => ({ ...p, [uri]: e.target.value }))}
                aria-label={uri}
              >
                <option value="__create__">{t("mapCreate")}</option>
                {(templates ?? []).map((et) => (
                  <option key={et.id} value={et.id}>
                    {t("mapExisting")}: {et.name}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className="ez-field" style={{ marginTop: 12 }}>
            <label htmlFor="ez-tpy-conflict">{t("conflicts")}</label>
            <select
              id="ez-tpy-conflict"
              className="ez-select"
              value={conflictPolicy}
              onChange={(e) => setConflictPolicy(e.target.value as typeof conflictPolicy)}
            >
              <option value="skip">{t("conflictSkip")}</option>
              <option value="copy">{t("conflictCopy")}</option>
            </select>
          </div>
          {report.unknown_tables.length > 0 ? (
            <p className="ez-notice">
              {t("unknownTables")}: {report.unknown_tables.join(", ")}
            </p>
          ) : null}
          <div className="ez-dialog-foot" style={{ border: 0, padding: "12px 0 0" }}>
            <button type="button" className="ez-btn" onClick={() => setStep("upload")}>{ta("back")}</button>
            <button type="button" className="ez-btn ez-btn--primary" disabled={busy} onClick={doRun}>
              {t("runImport")}
            </button>
          </div>
        </div>
      ) : null}

      {step === "run" ? (
        <div data-tour="tpy-run">
          <div className="ez-job-row">
            <span className="ez-progress">
              <span style={{ width: runJob && runJob.total ? `${Math.round((runJob.done / runJob.total) * 100)}%` : "0%" }} />
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {runJob ? t("importing", { done: runJob.done, total: runJob.total }) : t("analyzing")}
            </span>
            <span className="ez-spacer" />
            <button
              type="button"
              className="ez-btn ez-btn--sm"
              disabled={cancelling || !runJobId || (runJob?.status !== "running" && runJob?.status !== "queued")}
              onClick={cancelRun}
            >
              {t("cancelRun")}
            </button>
          </div>
          {cancelledNote ? <p className="ez-notice">{t("cancelledNote")}</p> : null}
          <p className="ez-notice">{t("tpyHint")}</p>
        </div>
      ) : null}

      {step === "report" ? (
        <div data-tour="tpy-report">
          <h3 style={{ fontSize: 16 }}>{t("reportTitle")}</h3>
          {/* A6: render the job's failure reason verbatim when the run failed. */}
          {runJob?.status === "failed" && runJob.error ? (
            <div className="ez-banner" data-kind="danger" role="alert" style={{ borderRadius: 8, margin: "8px 0" }}>
              <span>
                <strong>{t("runFailedTitle")}</strong>
                <br />
                {runJob.error}
              </span>
            </div>
          ) : null}
          {runReport ? (
            <>
              <p style={{ fontSize: 13 }}>
                {t("reportLine", {
                  imported: runReport.imported.items ?? 0,
                  skipped: runReport.conflicts,
                  merged: 0,
                })}
              </p>
              <ul style={{ fontSize: 12, color: "var(--ink-2)" }}>
                {Object.entries(runReport.imported).map(([k, v]) => (
                  <li key={k}>
                    {k}: {v} / {runReport.expected[k] ?? "?"}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {missing.length > 0 ? (
            <div style={{ border: "1px solid var(--warn)", borderRadius: 8, padding: 12, marginTop: 8 }}>
              <h4 style={{ fontSize: 13, margin: "0 0 4px" }}>{t("relinkTitle")} ({missing.length})</h4>
              <p style={{ fontSize: 12, color: "var(--ink-2)" }}>{t("relinkBody")}</p>
              <input
                ref={relinkInputRef}
                type="file"
                multiple
                style={{ display: "none" }}
                onChange={(e) => {
                  void relink(e.target.files);
                  e.target.value = "";
                }}
              />
              <button type="button" className="ez-btn ez-btn--sm" disabled={busy} onClick={() => relinkInputRef.current?.click()}>
                {t("relinkPick")}
              </button>
              <ul className="ez-mono-list">
                {missing.slice(0, 50).map((m) => (
                  <li key={m.filename}>{m.filename}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
            {runJobId ? (
              <button
                type="button"
                className="ez-btn"
                onClick={() => {
                  window.location.href = `/api/import/tpy/report/${runJobId}`;
                }}
              >
                {t("downloadReport")}
              </button>
            ) : null}
            <button type="button" className="ez-btn ez-btn--danger" onClick={() => setConfirmUndo(true)}>
              {t("undoTpy")}
            </button>
            <span style={{ flex: 1 }} />
            <button type="button" className="ez-btn ez-btn--primary" onClick={() => { setOpen(false); setStep("upload"); }}>
              {ta("done")}
            </button>
          </div>
        </div>
      ) : null}

      {confirmUndo ? (
        <ConfirmDialog
          title={t("undoTpy")}
          body={t("undoTpyConfirm")}
          confirmLabel={t("undoTpy")}
          danger
          onCancel={() => setConfirmUndo(false)}
          onConfirm={async () => {
            setConfirmUndo(false);
            if (runJobId) {
              const { undoLast } = await import("@/lib/commands/ops");
              await undoLast(ctx, ["items", "lists", "tags", "meter"]);
            }
            setOpen(false);
            setStep("upload");
          }}
        />
      ) : null}
    </Dialog>
  );
}
