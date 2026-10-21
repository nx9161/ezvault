// SPDX-License-Identifier: MIT
// CSV metadata import (parity row 23): pick a .csv whose header row names
// property URIs, choose the template the new items get, run the import,
// and read the honest per-row report (imported / failed + row errors).

"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { mutate } from "swr";
import { useUiStore } from "@/lib/store/ui";
import { useTemplates } from "@/lib/api/hooks";
import { post } from "@/lib/api/client";
import { Dialog } from "@/components/ui/Dialog";

interface CsvImportReport {
  imported: number;
  failed: number;
  errors: { row: number; message: string }[];
}

export default function CsvImportDialog({ projectId }: { projectId: string }) {
  const t = useTranslations("csvImport");
  const ta = useTranslations("app");
  const open = useUiStore((s) => s.csvImportOpen);
  const setOpen = useUiStore((s) => s.setCsvImportOpen);
  const pushToast = useUiStore((s) => s.pushToast);
  const { data: templatesData } = useTemplates(open ? projectId : null);
  const templates = templatesData ?? [];
  const [templateId, setTemplateId] = useState("");
  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<CsvImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  if (!open) return null;
  const effectiveTemplateId = templateId || templates[0]?.id || "";

  async function onPickFile(file: File | null) {
    if (!file) return;
    setFileName(file.name);
    setReport(null);
    setCsvText(await file.text());
  }

  async function runImport() {
    if (!csvText || !effectiveTemplateId) return;
    setBusy(true);
    try {
      const result = await post<CsvImportReport>(
        `/api/projects/${projectId}/import/csv`,
        { csv: csvText, template_id: effectiveTemplateId },
      );
      setReport(result);
      await mutate((k) => typeof k === "string" && k.startsWith(`/api/projects/${projectId}/items`));
      if (result.failed === 0) {
        pushToast({ message: t("doneToast", { count: result.imported }), kind: "info" });
      }
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : t("failedToast"), kind: "error" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t("title")} onClose={() => setOpen(false)} wide>
      <p style={{ fontSize: 13, color: "var(--ink-2)", marginTop: 0 }}>{t("body")}</p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: "none" }}
          onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
        />
        <button type="button" className="ez-btn" onClick={() => fileRef.current?.click()}>
          {t("pickFile")}
        </button>
        {fileName ? <span style={{ fontSize: 12 }}>{fileName}</span> : null}
      </div>
      <label style={{ display: "block", fontSize: 12, marginTop: 16, color: "var(--ink-2)" }}>
        {t("template")}
        <select
          className="ez-select"
          style={{ display: "block", marginTop: 4 }}
          value={effectiveTemplateId}
          onChange={(e) => setTemplateId(e.target.value)}
        >
          {templates.map((tpl) => (
            <option key={tpl.id} value={tpl.id}>
              {tpl.name}
            </option>
          ))}
        </select>
      </label>
      {templates.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--danger)" }}>{t("noTemplates")}</p>
      ) : null}
      <div style={{ marginTop: 16, display: "flex", gap: 8 }}>
        <button
          type="button"
          className="ez-btn ez-btn--primary"
          disabled={busy || !csvText || !effectiveTemplateId}
          onClick={() => void runImport()}
        >
          {busy ? t("importing") : t("runImport")}
        </button>
        <button type="button" className="ez-btn" onClick={() => setOpen(false)}>
          {ta("close")}
        </button>
      </div>
      {report ? (
        <div style={{ marginTop: 16 }}>
          <p style={{ fontSize: 13, margin: "0 0 8px" }}>
            {t("reportLine", { imported: report.imported, failed: report.failed })}
          </p>
          {report.errors.length ? (
            <ul style={{ fontSize: 12, color: "var(--ink-2)", margin: 0, paddingLeft: 18, maxHeight: 160, overflow: "auto" }}>
              {report.errors.map((e, i) => (
                <li key={i}>
                  {t("rowError", { row: e.row })}: {e.message}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
