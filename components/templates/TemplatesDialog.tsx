// SPDX-License-Identifier: MIT
// Template manager: list, rename, delete (blocked if in use), import/export
// .ttp, add fields. Template definitions round-trip via .ttp (ADR-2.12).

"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import { useTemplates, key } from "@/lib/api/hooks";
import { post, patch, del } from "@/lib/api/client";
import { mutate } from "swr";
import { Dialog, ConfirmDialog } from "@/components/ui/Dialog";
import { ErrorCard } from "@/components/ui/Feedback";
import { ExportIcon, NoteIcon, TrashIcon } from "@/components/ui/icons";
import type { UiTemplate, UiTemplateField, FieldWidget } from "@/lib/api/types";

function TemplateRow({
  projectId,
  template,
}: {
  projectId: string;
  template: UiTemplate;
}) {
  const t = useTranslations("templates");
  const ta = useTranslations("app");
  const pushToast = useUiStore((s) => s.pushToast);
  const [expanded, setExpanded] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(template.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newField, setNewField] = useState({ label: "", property_uri: "", widget: "text" as FieldWidget });

  async function refresh() {
    await mutate(key.templates(projectId));
  }

  async function commitRename() {
    setRenaming(false);
    const next = name.trim();
    if (next && next !== template.name) {
      await patch(`/api/projects/${projectId}/templates/${template.id}`, { name: next });
      await refresh();
    } else setName(template.name);
  }

  const WIDGET_DATATYPE: Record<FieldWidget, string> = {
    text: "http://www.w3.org/2001/XMLSchema#string",
    textarea: "http://www.w3.org/1999/02/22-rdf-syntax-ns#HTML",
    date: "http://www.w3.org/2001/XMLSchema#date",
    number: "http://www.w3.org/2001/XMLSchema#decimal",
    uri: "http://www.w3.org/2001/XMLSchema#anyURI",
    boolean: "http://www.w3.org/2001/XMLSchema#boolean",
  };

  async function addField() {
    if (!newField.label.trim() || !newField.property_uri.trim()) return;
    const field = {
      label: newField.label.trim(),
      property_uri: newField.property_uri.trim(),
      datatype: WIDGET_DATATYPE[newField.widget],
    };
    await patch(`/api/projects/${projectId}/templates/${template.id}`, {
      fields: [...template.fields.map(({ property_uri, label, label_i18n, required }) => ({ property_uri, label, label_i18n, required })), field],
    });
    setNewField({ label: "", property_uri: "", widget: "text" });
    await refresh();
  }

  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: 8, marginBottom: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 12px" }}>
        <button
          type="button"
          className="ez-btn ez-btn--ghost ez-btn--sm"
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          style={{ fontWeight: 600, flex: 1, textAlign: "left", justifyContent: "flex-start" }}
        >
          {expanded ? "▾" : "▸"} {template.name}
          <span style={{ fontWeight: 400, color: "var(--ink-3)", fontSize: 11, marginLeft: 8 }}>
            {template.fields.length} fields
          </span>
        </button>
        <button
          type="button"
          className="ez-icon-btn"
          title={t("exportTtp")}
          aria-label={t("exportTtp")}
          onClick={() => {
            window.location.href = `/api/projects/${projectId}/templates/${template.id}/export`;
          }}
        >
          <ExportIcon size={15} />
        </button>
        <button
          type="button"
          className="ez-icon-btn"
          title={ta("rename")}
          aria-label={ta("rename")}
          onClick={() => setRenaming(true)}
        >
          <NoteIcon size={15} />
        </button>
        <button
          type="button"
          className="ez-icon-btn"
          title={t("delete")}
          aria-label={t("delete")}
          onClick={() => setConfirmDelete(true)}
        >
          <TrashIcon size={15} />
        </button>
      </div>
      {renaming ? (
        <div className="ez-inline-form" style={{ padding: "0 12px 10px" }}>
          <input className="ez-input" value={name} onChange={(e) => setName(e.target.value)} aria-label={t("name")} autoFocus />
          <button type="button" className="ez-btn ez-btn--sm ez-btn--primary" onClick={commitRename}>
            {ta("save")}
          </button>
        </div>
      ) : null}
      {expanded ? (
        <div style={{ padding: "0 12px 12px" }}>
          {template.fields.map((f: UiTemplateField) => (
            <div key={f.id} className="ez-file-row">
              <span style={{ flex: 1, fontSize: 12 }}>
                <strong>{f.label_i18n?.en ?? f.label}</strong>{" "}
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink-3)", fontSize: 11 }}>{f.property_uri}</span>
              </span>
              <span className="ez-format-badge">{f.widget}</span>
            </div>
          ))}
          <div className="ez-inline-form">
            <input
              className="ez-input"
              placeholder={t("fieldLabel")}
              value={newField.label}
              onChange={(e) => setNewField((p) => ({ ...p, label: e.target.value }))}
              aria-label={t("fieldLabel")}
            />
            <input
              className="ez-input"
              placeholder={t("propertyUri")}
              value={newField.property_uri}
              onChange={(e) => setNewField((p) => ({ ...p, property_uri: e.target.value }))}
              aria-label={t("propertyUri")}
              style={{ fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
            <select
              className="ez-select"
              value={newField.widget}
              onChange={(e) => setNewField((p) => ({ ...p, widget: e.target.value as FieldWidget }))}
              aria-label={t("fieldType")}
            >
              {(Object.keys(WIDGET_DATATYPE) as FieldWidget[]).map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
            <button type="button" className="ez-btn ez-btn--sm" onClick={addField}>
              {t("addField")}
            </button>
          </div>
        </div>
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          title={t("delete")}
          body={template.name}
          confirmLabel={t("delete")}
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            setConfirmDelete(false);
            try {
              await del(`/api/projects/${projectId}/templates/${template.id}`);
              await refresh();
            } catch {
              pushToast({ message: t("deleteBlocked"), kind: "error" });
            }
          }}
        />
      ) : null}
    </div>
  );
}

export default function TemplatesDialog({ projectId }: { projectId: string }) {
  const t = useTranslations("templates");
  const ta = useTranslations("app");
  const open = useUiStore((s) => s.templatesOpen);
  const setOpen = useUiStore((s) => s.setTemplatesOpen);
  const pushToast = useUiStore((s) => s.pushToast);
  const { data, error, mutate: mutateTemplates } = useTemplates(projectId);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const ttpInputRef = useRef<HTMLInputElement>(null);

  if (!open) return null;

  async function createTemplate() {
    const trimmed = name.trim();
    if (!trimmed) return;
    await post(`/api/projects/${projectId}/templates`, { name: trimmed, fields: [] });
    setCreating(false);
    setName("");
    await mutateTemplates();
  }

  async function importTtp(file: File) {
    const text = await file.text();
    try {
      await post(`/api/projects/${projectId}/templates/import`, { ttp: text, filename: file.name });
      await mutateTemplates();
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : "import failed", kind: "error" });
    }
  }

  return (
    <Dialog
      title={t("title")}
      onClose={() => setOpen(false)}
      footer={
        <>
          <input
            ref={ttpInputRef}
            type="file"
            accept=".ttp"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importTtp(f);
              e.target.value = "";
            }}
          />
          <button type="button" className="ez-btn" onClick={() => ttpInputRef.current?.click()}>
            {t("importTtp")}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="ez-btn ez-btn--primary" onClick={() => setCreating(true)}>
            {t("new")}
          </button>
        </>
      }
    >
      {error ? (
        <ErrorCard what={t("title")} onRetry={() => mutateTemplates()} />
      ) : !data ? (
        <p>{ta("loading")}</p>
      ) : data.length === 0 ? (
        <p style={{ color: "var(--ink-2)" }}>{t("empty")}</p>
      ) : (
        data.map((tp) => <TemplateRow key={tp.id} projectId={projectId} template={tp} />)
      )}
      {creating ? (
        <div className="ez-inline-form" style={{ marginTop: 12 }}>
          <input
            className="ez-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("name")}
            aria-label={t("new")}
            autoFocus
          />
          <button type="button" className="ez-btn ez-btn--sm ez-btn--primary" onClick={createTemplate}>
            {ta("save")}
          </button>
        </div>
      ) : null}
    </Dialog>
  );
}
