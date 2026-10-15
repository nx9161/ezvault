// SPDX-License-Identifier: MIT
// Import dialog: Files / Folder / JSON-LD tabs (+ .tpy → wizard).
// Review → per-file sha256 (SubtleCrypto) → HEIC→JPEG in-browser (libheif-js,
// B17) + exifr EXIF → stage (presign batch, or folder-session for folder
// picks — mirrors the dir tree as nested lists and returns per-file grants
// with list_id) → XHR PUT with progress → /complete (per-file listId, F2)
// → job polling (retry/cancel) → ONE compound undo command.
// Design §2.1; architecture §2.11; ADR-2.16.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import { useProject, useJob } from "@/lib/api/hooks";
import { post } from "@/lib/api/client";
import { mutate } from "swr";
import { commandBus } from "@/lib/commands/bus";
import { importUndoCommand, refreshAndBroadcast, type OpContext } from "@/lib/commands/ops";
import { useOpContext } from "@/components/sidebar/Sidebar";
import { Dialog } from "@/components/ui/Dialog";
import {
  ACCEPT_ATTR,
  detectKind,
  needsBrowserConversion,
  needsServerConversion,
  sha256File,
  extractExif,
  formatBytes,
  type ImportKind,
} from "@/lib/import/files";
import { decodeHeicToJpeg } from "@/lib/import/heic";
import {
  presignBatch,
  putWithProgress,
  completeImport,
  folderSession,
  type CompleteFile,
} from "@/lib/import/upload";

type FileStatus =
  | "queued" | "hashing" | "converting" | "uploading" | "completing"
  | "processing" | "done" | "failed" | "skipped";

const STATUS_I18N: Record<FileStatus, "queued" | "hashing" | "convertingHeic" | "uploading" | "processing" | "done" | "failed" | "skipped"> = {
  queued: "queued",
  hashing: "hashing",
  converting: "convertingHeic",
  uploading: "uploading",
  completing: "uploading",
  processing: "processing",
  done: "done",
  failed: "failed",
  skipped: "skipped",
};

interface QueueFile {
  localId: string;
  file: File;
  relativePath?: string;
  kind: ImportKind;
  sha256: string;
  artifact?: Blob; // HEIC→JPEG
  artifactSha256?: string;
  artifactKey?: string;
  key?: string;
  exif?: Record<string, unknown>;
  width?: number;
  height?: number;
  status: FileStatus;
  progress: number;
  error?: string;
}

type Tab = "files" | "folder" | "jsonld";

let localSeq = 0;
const newLocalId = () => `q-${++localSeq}-${Date.now()}`;

function Badge({ kind }: { kind: ImportKind }) {
  const t = useTranslations("import");
  if (needsBrowserConversion(kind))
    return <span className="ez-format-badge">{t("formatBadgeHeic")}</span>;
  if (needsServerConversion(kind))
    return <span className="ez-format-badge">{t("formatBadgeServer")}</span>;
  return null;
}

export default function ImportDialog({ projectId }: { projectId: string }) {
  const t = useTranslations("import");
  const ta = useTranslations("app");
  const open = useUiStore((s) => s.importOpen);
  const setOpen = useUiStore((s) => s.setImportOpen);
  const pendingFiles = useUiStore((s) => s.pendingFiles);
  const setPendingFiles = useUiStore((s) => s.setPendingFiles);
  const pushToast = useUiStore((s) => s.pushToast);
  const setTpyOpen = useUiStore((s) => s.setTpyOpen);
  const ctx = useOpContext(projectId);
  const { data: project } = useProject(projectId);

  const [tab, setTab] = useState<Tab>("files");
  const [queue, setQueue] = useState<QueueFile[]>([]);
  const [running, setRunning] = useState(false);
  const [duplicatePolicy, setDuplicatePolicy] = useState<"skip" | "keep_both" | "ask">(
    (project?.duplicate_policy as "skip" | "keep_both" | "ask") ?? "skip",
  );
  const [jobId, setJobId] = useState<string | null>(null);
  // Folder uploads: the dir → { list_id } mapping minted by folder-session
  // (called in run(), after hashing — the server needs per-file sha256).
  // Shown as a "N folder lists created" note once the run starts.
  const [folderMapping, setFolderMapping] = useState<Record<string, { list_id: string }> | null>(null);
  const [dupeAsk, setDupeAsk] = useState<{
    duplicates: { sha256: string; filename: string; key: string; size: number }[];
    files: CompleteFile[];
    jobId: string;
  } | null>(null);
  const [dupeDecisions, setDupeDecisions] = useState<Record<string, "skip" | "keep_both">>({});
  const [dupeApplyAll, setDupeApplyAll] = useState<"skip" | "keep_both" | "">("");
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const jsonldInputRef = useRef<HTMLInputElement>(null);

  const { data: job } = useJob(running ? jobId : null);

  // Files dropped anywhere on the app land here via the ui store.
  useEffect(() => {
    if (pendingFiles.length > 0 && open) {
      addFiles(pendingFiles.map((f) => ({ file: f })));
      setPendingFiles([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pendingFiles]);

  useEffect(() => {
    if (project?.duplicate_policy) setDuplicatePolicy(project.duplicate_policy);
  }, [project?.duplicate_policy]);

  const patchQueue = useCallback((localId: string, patch: Partial<QueueFile>) => {
    setQueue((q) => q.map((f) => (f.localId === localId ? { ...f, ...patch } : f)));
  }, []);

  function addFiles(entries: { file: File; relativePath?: string }[]) {
    const next: QueueFile[] = [];
    for (const { file, relativePath } of entries) {
      const kind = detectKind(file);
      if (kind === "unknown") continue;
      next.push({
        localId: newLocalId(),
        file,
        relativePath,
        kind,
        sha256: "",
        status: "queued",
        progress: 0,
      });
    }
    setQueue((q) => [...q, ...next]);
  }

  function onFolderPicked(files: FileList | null) {
    if (!files) return;
    const entries = Array.from(files).map((f) => ({
      file: f,
      relativePath: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name,
    }));
    // The nested-list tree is built server-side in run(), after hashing
    // (folder-session needs per-file sha256/size/mimetype) — see step 2.
    addFiles(entries);
    setTab("files");
  }

  async function prepareFile(qf: QueueFile): Promise<QueueFile> {
    const out = { ...qf };
    try {
      patchQueue(qf.localId, { status: "hashing", progress: 0.05 });
      out.sha256 = await sha256File(qf.file, (done, total) =>
        patchQueue(qf.localId, { progress: 0.05 + 0.15 * (done / total) }),
      );
      if (needsBrowserConversion(qf.kind)) {
        patchQueue(qf.localId, { status: "converting", progress: 0.25 });
        const { blob, width, height } = await decodeHeicToJpeg(qf.file);
        out.artifact = blob;
        out.artifactSha256 = await sha256File(blob);
        out.width = width;
        out.height = height;
        out.exif = await extractExif(qf.file);
        patchQueue(qf.localId, { progress: 0.4 });
      } else if (qf.kind === "jpeg" || qf.kind === "png" || qf.kind === "webp" || qf.kind === "tiff") {
        out.exif = await extractExif(qf.file);
      }
      return out;
    } catch (err) {
      const message = err instanceof Error ? err.message : "preparation failed";
      patchQueue(qf.localId, { status: "failed", error: message });
      throw err;
    }
  }

  async function run() {
    if (queue.length === 0 || running) return;
    setRunning(true);
    abortRef.current = new AbortController();
    const signal = abortRef.current.signal;
    try {
      // 1. Hash (+ HEIC convert) every file.
      const prepared: QueueFile[] = [];
      for (const qf of queue) {
        if (signal.aborted) throw new Error("cancelled");
        try {
          prepared.push(await prepareFile(qf));
        } catch {
          /* marked failed already */
        }
      }
      const ready = prepared.filter((f) => f.sha256);
      if (ready.length === 0) {
        setRunning(false);
        return;
      }
      // 2. Stage uploads.
      // Folder batch (every file carries a folder-relative path): register
      // with folder-session — the server mirrors the directory tree as
      // nested lists and returns per-file PUT grants, each carrying the
      // list_id its photo files into. That grant list_id is sent back as
      // per-file listId on /complete (F2 primary path). Plain file batches
      // use the presign endpoint and land in All Items.
      const normSessionPath = (p: string) => p.replace(/\\/g, "/").replace(/^\/+/, "");
      const folderBatch = ready.every((f) => !!f.relativePath);
      const listIdByKey = new Map<string, string | null>();
      const grantBySha = new Map<string, { key: string; url: string }>();
      const grantByPath = new Map<string, { key: string; url: string }>();
      let completeJobId: string;
      if (folderBatch) {
        const sessionFiles = ready.flatMap((f) => {
          const path = normSessionPath(f.relativePath!);
          const main = {
            path,
            mimetype: f.file.type || "application/octet-stream",
            size: f.file.size,
            sha256: f.sha256,
          };
          // Browser-decoded HEIC→JPEG artifacts need their own staged key:
          // register under a collision-proof pseudo-path in the same dir.
          return f.artifact && f.artifactSha256
            ? [main, { path: `${path}.conv.jpg`, mimetype: "image/jpeg", size: f.artifact.size, sha256: f.artifactSha256 }]
            : [main];
        });
        const session = await folderSession(projectId, sessionFiles);
        completeJobId = session.job_id;
        setFolderMapping(session.mapping);
        for (const g of session.grants) {
          const grant = { key: g.key, url: g.url };
          grantByPath.set(g.path, grant);
          listIdByKey.set(g.key, g.list_id);
        }
      } else {
        const presignFiles = ready.flatMap((f) => {
          const base = {
            sha256: f.sha256,
            size: f.file.size,
            mimetype: f.file.type || "application/octet-stream",
            filename: f.file.name,
          };
          return f.artifact && f.artifactSha256
            ? [base, { sha256: f.artifactSha256, size: f.artifact.size, mimetype: "image/jpeg", filename: f.file.name.replace(/\.[^.]+$/, ".jpg") }]
            : [base];
        });
        const { job_id: presignJobId, grants } = await presignBatch(projectId, presignFiles);
        completeJobId = presignJobId;
        for (const u of grants) grantBySha.set(u.sha256.toLowerCase(), { key: u.key, url: u.url });
      }

      // 3. PUT each file. Folder batches resolve grants by session path
      // (identical bytes in different folders keep their own grants);
      // presign batches resolve by sha256 as before.
      for (const f of ready) {
        if (signal.aborted) throw new Error("cancelled");
        const grantFor = (artifact: boolean) => {
          if (folderBatch) {
            return grantByPath.get(normSessionPath(f.relativePath!) + (artifact ? ".conv.jpg" : ""));
          }
          const sha = artifact ? f.artifactSha256! : f.sha256;
          return grantBySha.get(sha.toLowerCase());
        };
        const up = grantFor(false);
        const upArt = f.artifact && f.artifactSha256 ? grantFor(true) : undefined;
        if (!up) throw new Error("staging missing");
        patchQueue(f.localId, { status: "uploading", progress: 0.45 });
        await putWithProgress(up.url, f.file, f.file.type || "application/octet-stream",
          (loaded, total) => patchQueue(f.localId, { progress: 0.45 + 0.35 * (loaded / total) }), signal);
        f.key = up.key;
        if (f.artifact && upArt) {
          await putWithProgress(upArt.url, f.artifact, "image/jpeg",
            (loaded, total) => patchQueue(f.localId, { progress: 0.8 + 0.05 * (loaded / total) }), signal);
          f.artifactKey = upArt.key;
        }
        patchQueue(f.localId, { progress: 0.9 });
      }

      // 4. Complete → job.
      for (const f of ready) patchQueue(f.localId, { status: "completing", progress: 0.95 });
      const completeFiles: CompleteFile[] = ready.flatMap((f) => {
        const main: CompleteFile = {
          key: f.key!,
          sha256: f.sha256,
          size: f.file.size,
          mimetype: f.file.type || "application/octet-stream",
          filename: f.file.name,
          relative_path: f.relativePath,
          // F2 primary path: the folder-session grant's list_id. Absent for
          // plain file batches (land in All Items); conversion artifacts are
          // decode sources, never filed as their own photos.
          listId: listIdByKey.get(f.key!) ?? undefined,
        };
        return f.artifactKey && f.artifactSha256
          ? [main, {
              key: f.artifactKey,
              sha256: f.artifactSha256,
              size: f.artifact!.size,
              mimetype: "image/jpeg",
              filename: f.file.name.replace(/\.[^.]+$/, ".jpg"),
              // links the artifact to the ORIGINAL's staged key (server resolves it)
              conversion_of: f.key!,
            }]
          : [main];
      });
      const exif: Record<string, Record<string, unknown>> = {};
      for (const f of completeFiles) {
        const qf = ready.find((r) => r.key === f.key || r.artifactKey === f.key);
        if (qf?.exif && !f.conversion_of) exif[f.key] = qf.exif;
      }
      const result = await completeImport(projectId, completeJobId, completeFiles, {
        // 'ask' is a client-side two-phase: first pass as 'skip' so the
        // server reports duplicates as rejected (reason 'duplicate_skipped');
        // the dialog below then re-submits the kept subset as 'keep_both'.
        duplicate_policy: duplicatePolicy === "ask" ? "skip" : duplicatePolicy,
        exif: Object.keys(exif).length > 0 ? exif : undefined,
      });
      // Duplicate "ask": the server reports duplicates via `rejected` with a
      // duplicate reason; "import anyway" re-submits those keys as keep_both.
      // Ask protocol (accepted design — QA round 1 adjudication): a stateless
      // API cannot do interactive per-file prompts, so this client two-phase
      // (first pass 'skip', per-file dialog, kept subset as 'keep_both')
      // IS the ask implementation, not a stopgap.
      const dupes = result.rejected.filter((r) => /duplicat/i.test(r.reason));
      if (dupes.length > 0 && duplicatePolicy === "ask") {
        setDupeAsk({
          duplicates: dupes.map((d) => {
            const qf = completeFiles.find((f) => f.key === d.key);
            return {
              sha256: qf?.sha256 ?? d.key,
              filename: qf?.filename ?? d.key,
              key: d.key,
              // F-I: show file size in the duplicate-ask rows.
              size: qf?.size ?? 0,
            };
          }),
          files: completeFiles,
          jobId: completeJobId,
        });
        setDupeDecisions(
          Object.fromEntries(dupes.map((d) => [d.key, "skip" as const])),
        );
        setRunning(false);
        return;
      }
      if (result.rejected.length > 0) {
        pushToast({ message: t("partialToast", { done: result.accepted.length, failed: result.rejected.length }), kind: "error" });
      }
      await startJob(result.job_id, ready);
    } catch (err) {
      if (err instanceof Error && err.message === "cancelled") {
        pushToast({ message: t("cancelJob") });
      } else {
        pushToast({ message: err instanceof Error ? err.message : "import failed", kind: "error" });
      }
      setRunning(false);
    }
  }

  // 5. Poll the job (useJob hook drives the UI); wait for terminal state.
  async function startJob(id: string, ready: QueueFile[]) {
    setJobId(id);
    for (const f of ready) patchQueue(f.localId, { status: "processing", progress: 0.97 });
  }

  async function resolveDuplicates() {
    if (!dupeAsk) return;
    const keepKeys = dupeAsk.duplicates
      .filter((d) => (dupeApplyAll || dupeDecisions[d.key] || "skip") === "keep_both")
      .map((d) => d.key);
    setDupeAsk(null);
    if (keepKeys.length === 0) {
      setRunning(false);
      return;
    }
    setRunning(true);
    try {
      const files = dupeAsk.files.filter((f) => keepKeys.includes(f.key));
      const result = await completeImport(projectId, dupeAsk.jobId, files, {
        duplicate_policy: "keep_both",
      });
      const ready = queue.filter((f) => f.sha256);
      await startJob(result.job_id, ready);
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "import failed", kind: "error" });
      setRunning(false);
    }
  }
  useEffect(() => {
    if (!job || !running) return;
    if (["done", "failed", "cancelled"].includes(job.status)) {
      setRunning(false);
      setQueue((q) =>
        q.map((f) =>
          f.status === "processing" || f.status === "completing"
            ? { ...f, status: job.status === "done" ? "done" : "failed", progress: 1 }
            : f,
        ),
      );
      const doneCount = job.done;
      if (job.status === "done" && doneCount > 0) {
        pushToast({ message: t("doneToast", { count: doneCount }) });
        // ONE compound undo step for the whole import (binding).
        commandBus.push(
          importUndoCommand(ctx, job.id, t("undoImport")),
        );
      } else if (job.status === "failed") {
        pushToast({ message: t("partialToast", { done: job.done, failed: job.failed }), kind: "error" });
      }
      void refreshAndBroadcast(ctx, ["items", "meter", "lists"]);
      void mutate((k) => typeof k === "string" && k.includes(`/api/projects/${projectId}`));
      setJobId(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.status]);

  async function cancelJob() {
    abortRef.current?.abort();
    if (jobId) {
      try {
        await post(`/api/jobs/${jobId}/cancel`, {});
      } catch {
        /* best effort */
      }
    }
    setRunning(false);
  }

  async function retryJob() {
    if (!jobId || !job || job.failed === 0) return;
    try {
      // No body = retry all failed entries for the job.
      await post(`/api/jobs/${jobId}/retry`, {});
      setRunning(true);
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "retry failed", kind: "error" });
    }
  }

  async function importJsonLd(file: File) {
    const text = await file.text();
    let data: unknown;
    try {
      data = cappedParse(text);
    } catch {
      pushToast({ message: "JSON-LD parse failed (depth/width caps)", kind: "error" });
      return;
    }
    try {
      const res = await post<{ job_id: string }>("/api/import/jsonld", {
        project_id: projectId,
        document: data,
        duplicate_policy: duplicatePolicy === "ask" ? "skip" : duplicatePolicy,
      });
      setJobId(res.job_id);
      setRunning(true);
      // D-M11b: stay open and show the job-progress state below (no auto-close).
      pushToast({ message: t("processing") });
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "import failed", kind: "error" });
    }
  }

  if (!open) return null;

  return (
    <Dialog
      title={t("title")}
      // D-M11b: close is always enabled during processing. Known limitation:
      // closing unmounts the dialog and its useJob polling, so the
      // done/failed toast path is lost on manual close — same as file
      // imports today; wave-2 moves job tracking to the ui store.
      onClose={() => setOpen(false)}
      wide
    >
      <div className="ez-tabs" role="tablist" aria-label={t("title")} style={{ marginTop: 0 }} data-tour="import-tabs">
        {(["files", "folder", "jsonld"] as Tab[]).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            className="ez-tab"
            onClick={() => setTab(id)}
          >
            {t(`tab${id[0].toUpperCase()}${id.slice(1)}` as "tabFiles")}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" className="ez-btn ez-btn--sm" onClick={() => { setOpen(false); setTpyOpen(true); }}>
          {t("tabTpy")}
        </button>
      </div>

      {tab === "files" ? (
        <div style={{ margin: "12px 0" }}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={ACCEPT_ATTR}
            style={{ display: "none" }}
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []).map((f) => ({ file: f })));
              e.target.value = "";
            }}
          />
          <button type="button" className="ez-btn" onClick={() => fileInputRef.current?.click()}>
            {t("pickFiles")}
          </button>
        </div>
      ) : null}
      {tab === "folder" ? (
        <div style={{ margin: "12px 0" }}>
          <input
            ref={folderInputRef}
            type="file"
            style={{ display: "none" }}
            {...{ webkitdirectory: "" }}
            onChange={(e) => {
              onFolderPicked(e.target.files);
              e.target.value = "";
            }}
          />
          <button type="button" className="ez-btn" onClick={() => folderInputRef.current?.click()}>
            {t("pickFolder")}
          </button>
          <p className="ez-notice">{t("folderNote")}</p>
        </div>
      ) : null}
      {tab === "jsonld" && !(job && running) ? (
        <div style={{ margin: "12px 0" }}>
          <input
            ref={jsonldInputRef}
            type="file"
            accept=".json,.jsonld"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importJsonLd(f);
              e.target.value = "";
            }}
          />
          <button type="button" className="ez-btn" onClick={() => jsonldInputRef.current?.click()}>
            {t("jsonldPick")}
          </button>
          <p className="ez-notice">{t("jsonldNote")}</p>
        </div>
      ) : null}

      {queue.length > 0 ? (
        <div style={{ margin: "12px 0" }}>
          <h3 style={{ fontSize: 13 }}>{t("reviewTitle", { count: queue.length })}</h3>
          <div style={{ maxHeight: 260, overflowY: "auto" }} data-tour="import-review">
            {queue.map((qf) => (
              <div key={qf.localId} className="ez-file-row">
                <span className="ez-name" title={qf.relativePath ?? qf.file.name}>
                  {qf.relativePath ?? qf.file.name}
                </span>
                <Badge kind={qf.kind} />
                <span style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--font-mono)" }}>
                  {formatBytes(qf.file.size)}
                </span>
                <span className="ez-progress" role="progressbar" aria-valuenow={Math.round(qf.progress * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={qf.file.name}>
                  <span style={{ width: `${Math.round(qf.progress * 100)}%` }} />
                </span>
                <span style={{ fontSize: 11, color: qf.status === "failed" ? "var(--danger)" : "var(--ink-3)", minWidth: 70 }}>
                  {qf.status === "failed" ? (
                    <>
                      {t("failed")}{" "}
                      <button
                        type="button"
                        className="ez-btn ez-btn--sm"
                        onClick={() => {
                          patchQueue(qf.localId, { status: "queued", error: undefined, progress: 0 });
                        }}
                      >
                        {t("retryItem")}
                      </button>
                    </>
                  ) : (
                    t(STATUS_I18N[qf.status])
                  )}
                </span>
              </div>
            ))}
          </div>
          <div style={{ display: "flex", gap: 12, marginTop: 12, flexWrap: "wrap", alignItems: "center" }}>
            <span style={{ fontSize: 11, color: "var(--ink-2)" }}>
              {t("defaultTemplateNote")}
            </span>
            <label style={{ fontSize: 12 }}>
              {t("duplicatePolicy")}{" "}
              <select
                className="ez-select"
                value={duplicatePolicy}
                onChange={(e) => setDuplicatePolicy(e.target.value as typeof duplicatePolicy)}
              >
                <option value="skip">{t("policySkip")}</option>
                <option value="keep_both">{t("policyKeepBoth")}</option>
                <option value="ask">{t("policyAsk")}</option>
              </select>
            </label>
            {folderMapping ? (
              <span style={{ fontSize: 11, color: "var(--ink-2)" }}>
                {t("folderListsNote", { count: Object.keys(folderMapping).length })}
              </span>
            ) : null}
          </div>
        </div>
      ) : (
        <p style={{ color: "var(--ink-2)", fontSize: 13 }}>{t("dropHint")}</p>
      )}

      {job && running ? (
        <div style={{ marginTop: 12 }}>
          <div className="ez-job-row">
            <span className="ez-progress">
              <span style={{ width: `${job.total ? Math.round((job.done / job.total) * 100) : 0}%` }} />
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}>
              {job.done}/{job.total}
              {job.failed > 0 ? ` · ${job.failed} ${t("failed").toLowerCase()}` : ""}
            </span>
            <button type="button" className="ez-btn ez-btn--sm" onClick={cancelJob}>
              {t("cancelJob")}
            </button>
            {job.failed > 0 ? (
              <button type="button" className="ez-btn ez-btn--sm" onClick={retryJob}>
                {t("retryItem")}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {dupeAsk ? (
        <div style={{ marginTop: 12, border: "1px solid var(--warn)", borderRadius: 8, padding: 12 }}>
          <h3 style={{ fontSize: 14, margin: "0 0 4px" }}>{t("duplicateTitle")}</h3>
          <p style={{ fontSize: 12, color: "var(--ink-2)" }}>
            {t("duplicateBody", { count: dupeAsk.duplicates.length })}
          </p>
          <div style={{ margin: "8px 0" }}>
            <label style={{ fontSize: 12 }}>
              {t("duplicateApplyAll")}{" "}
              <select
                className="ez-select"
                value={dupeApplyAll}
                onChange={(e) => setDupeApplyAll(e.target.value as "skip" | "keep_both" | "")}
              >
                <option value="">—</option>
                <option value="skip">{t("policySkip")}</option>
                <option value="keep_both">{t("policyKeepBoth")}</option>
              </select>
            </label>
          </div>
          <div style={{ maxHeight: 180, overflowY: "auto" }}>
            {dupeAsk.duplicates.map((d) => (
              <div key={d.key} className="ez-file-row">
                <span className="ez-name">
                  {d.filename}
                  <span style={{ color: "var(--ink-3)", marginLeft: 8 }}>
                    {formatBytes(d.size)}
                  </span>
                </span>
                <label style={{ fontSize: 12, display: "inline-flex", gap: 4, alignItems: "center" }}>
                  <input
                    type="radio"
                    name={`dupe-${d.key}`}
                    checked={(dupeApplyAll || dupeDecisions[d.key]) === "skip"}
                    onChange={() => {
                      setDupeApplyAll("");
                      setDupeDecisions((p) => ({ ...p, [d.key]: "skip" }));
                    }}
                  />
                  {t("duplicateSkipOne")}
                </label>
                <label style={{ fontSize: 12, display: "inline-flex", gap: 4, alignItems: "center" }}>
                  <input
                    type="radio"
                    name={`dupe-${d.key}`}
                    checked={(dupeApplyAll || dupeDecisions[d.key]) === "keep_both"}
                    onChange={() => {
                      setDupeApplyAll("");
                      setDupeDecisions((p) => ({ ...p, [d.key]: "keep_both" }));
                    }}
                  />
                  {t("duplicateKeepOne")}
                </label>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 8, display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <button type="button" className="ez-btn ez-btn--primary ez-btn--sm" onClick={resolveDuplicates}>
              {ta("apply")}
            </button>
          </div>
        </div>
      ) : null}

      <div className="ez-dialog-foot" style={{ border: 0, padding: "12px 0 0" }}>
        <button type="button" className="ez-btn" onClick={() => setOpen(false)} disabled={running}>
          {ta("close")}
        </button>
        <button
          type="button"
          className="ez-btn ez-btn--primary"
          disabled={running || queue.length === 0}
          onClick={run}
        >
          {t("startImport")}
        </button>
      </div>
    </Dialog>
  );
}

/** B11: depth/width-capped JSON parse for the JSON-LD accept path (client side too). */
function cappedParse(text: string, maxDepth = 64, maxKeys = 200_000): unknown {
  let keyCount = 0;
  const reviver = (_k: string, v: unknown) => {
    if (v && typeof v === "object") {
      keyCount += Array.isArray(v) ? v.length : Object.keys(v).length;
      if (keyCount > maxKeys) throw new Error("too many keys");
    }
    return v;
  };
  // Depth check: iterative scan of bracket nesting.
  let depth = 0;
  let maxSeen = 0;
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "[" || ch === "{") {
      depth += 1;
      if (depth > maxSeen) maxSeen = depth;
      if (maxSeen > maxDepth) throw new Error("too deep");
    } else if (ch === "]" || ch === "}") depth -= 1;
  }
  return JSON.parse(text, reviver);
}
