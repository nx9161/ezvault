// SPDX-License-Identifier: MIT
// Project settings dialog: name, default template, duplicate policy,
// notes export format. Design §1.1 (project menu).

"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { startTour } from "@/lib/tour/launcher";
import { useUiStore } from "@/lib/store/ui";
import { useProject, useTemplates, key } from "@/lib/api/hooks";
import { patch, del } from "@/lib/api/client";
import { mutate } from "swr";
import { useRouter } from "next/navigation";
import { Dialog, ConfirmDialog } from "@/components/ui/Dialog";
import { ErrorCard } from "@/components/ui/Feedback";

export default function SettingsDialog({ projectId }: { projectId: string }) {
  const t = useTranslations("settings");
  const ta = useTranslations("app");
  const ti = useTranslations("import");
  const ts = useTranslations("shortcuts");
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const pushToast = useUiStore((s) => s.pushToast);
  const router = useRouter();
  const { data: project, error, mutate: mutateProject } = useProject(projectId);
  const { data: templates } = useTemplates(projectId);

  const [name, setName] = useState("");
  const [defaultTemplate, setDefaultTemplate] = useState("");
  const [duplicatePolicy, setDuplicatePolicy] = useState("skip");
  const [notesFormat, setNotesFormat] = useState("html");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (project) {
      setName(project.name);
      setDefaultTemplate(project.default_template_id ?? "");
      setDuplicatePolicy(project.duplicate_policy);
      setNotesFormat(project.notes_export_format);
    }
  }, [project]);

  if (!open) return null;

  async function save() {
    setSaving(true);
    try {
      await patch(`/api/projects/${projectId}`, {
        name: name.trim(),
        default_template_id: defaultTemplate || null,
        duplicate_policy: duplicatePolicy,
        notes_export_format: notesFormat,
      });
      await mutateProject();
      pushToast({ message: t("saved") });
      setOpen(false);
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "save failed", kind: "error" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      title={t("title")}
      onClose={() => setOpen(false)}
      footer={
        <>
          <button type="button" className="ez-btn ez-btn--danger" onClick={() => setConfirmDelete(true)}>
            {t("deleteProject")}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="ez-btn" onClick={() => setOpen(false)}>
            {ta("cancel")}
          </button>
          <button type="button" className="ez-btn ez-btn--primary" disabled={saving || !name.trim()} onClick={save}>
            {t("save")}
          </button>
        </>
      }
    >
      {error ? (
        <ErrorCard what={t("title")} onRetry={() => mutateProject()} />
      ) : !project ? (
        <p>{ta("loading")}</p>
      ) : (
        <>
          <div className="ez-field">
            <label htmlFor="ez-settings-name">{t("name")}</label>
            <input
              id="ez-settings-name"
              className="ez-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="ez-field">
            <label htmlFor="ez-settings-template">{t("defaultTemplate")}</label>
            <select
              id="ez-settings-template"
              className="ez-select"
              value={defaultTemplate}
              onChange={(e) => setDefaultTemplate(e.target.value)}
            >
              <option value="">—</option>
              {(templates ?? []).map((tp) => (
                <option key={tp.id} value={tp.id}>
                  {tp.name}
                </option>
              ))}
            </select>
          </div>
          <div className="ez-field">
            <label htmlFor="ez-settings-dupe">{t("duplicatePolicy")}</label>
            <select
              id="ez-settings-dupe"
              className="ez-select"
              value={duplicatePolicy}
              onChange={(e) => setDuplicatePolicy(e.target.value)}
            >
              <option value="skip">{ti("policySkip")}</option>
              <option value="keep_both">{ti("policyKeepBoth")}</option>
              <option value="ask">{ti("policyAsk")}</option>
            </select>
          </div>
          <div className="ez-field">
            <label htmlFor="ez-settings-notes">{t("notesFormat")}</label>
            <select
              id="ez-settings-notes"
              className="ez-select"
              value={notesFormat}
              onChange={(e) => setNotesFormat(e.target.value)}
            >
              <option value="html">{t("notesHtml")}</option>
              <option value="markdown">{t("notesMarkdown")}</option>
            </select>
          </div>
          <div className="ez-field">
            <span className="ez-field-label">{t("help")}</span>
            <button
              type="button"
              className="ez-btn ez-btn--sm"
              onClick={() => {
                setOpen(false);
                startTour();
              }}
            >
              {ts("takeTour")}
            </button>
          </div>
        </>
      )}
      {confirmDelete ? (
        <ConfirmDialog
          title={t("deleteProject")}
          body={t("deleteConfirm", { name: project?.name ?? "" })}
          confirmLabel={t("deleteProject")}
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            setConfirmDelete(false);
            await del(`/api/projects/${projectId}`);
            await mutate(key.projects);
            setOpen(false);
            router.push("/");
          }}
        />
      ) : null}
    </Dialog>
  );
}
