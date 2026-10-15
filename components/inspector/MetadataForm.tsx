// SPDX-License-Identifier: MIT
// Template-bound metadata form. Real <label>s, property URIs on hover,
// Rights mandatory (aria-required + inline error), bulk mixed-values mode.
// Design §1.4; undo = before-image snapshots (binding).

"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { useTemplates, useMetadata } from "@/lib/api/hooks";
import { patch, get } from "@/lib/api/client";
import {
  runCommand,
  setMetadataOp,
  bulkMetadataOp,
  type OpContext,
} from "@/lib/commands/ops";
import { ErrorCard, SkeletonRows } from "@/components/ui/Feedback";
import type { MetadataValuesMap, UiTemplate, UiTemplateField } from "@/lib/api/types";
import { adaptMetadataValues } from "@/lib/api/types";

function fieldLabel(field: UiTemplateField, locale: string): string {
  return field.label_i18n?.[locale] ?? field.label;
}

function isRightsField(field: UiTemplateField): boolean {
  return field.property_uri.toLowerCase().includes("rights");
}

function FieldInput({
  field,
  value,
  onChange,
  invalid,
}: {
  field: UiTemplateField;
  value: string;
  onChange: (v: string) => void;
  invalid: boolean;
}) {
  const t = useTranslations("metadata");
  const id = `ez-field-${field.id}`;
  const label = fieldLabel(field, "en");
  const required = isRightsField(field) || field.required;
  const common = {
    id,
    value,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
      onChange(e.target.value),
    "aria-required": required || undefined,
    "aria-invalid": invalid || undefined,
    "aria-describedby": invalid ? `${id}-error` : undefined,
    title: t("propertyUri", { uri: field.property_uri }),
  };
  return (
    <div className="ez-field">
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {field.widget === "textarea" ? (
        <textarea className="ez-textarea" rows={3} {...common} />
      ) : field.widget === "number" ? (
        <input className="ez-input" type="number" {...common} />
      ) : field.widget === "uri" ? (
        <input className="ez-input" type="url" inputMode="url" {...common} />
      ) : field.widget === "date" ? (
        <input
          className="ez-input"
          type="text"
          placeholder="YYYY-MM-DD"
          {...common}
        />
      ) : field.widget === "boolean" ? (
        <input
          id={id}
          className="ez-checkbox"
          type="checkbox"
          checked={value === "true"}
          onChange={(e) => onChange(e.target.checked ? "true" : "false")}
          aria-required={required || undefined}
        />
      ) : (
        <input className="ez-input" type="text" {...common} />
      )}
      <span className="ez-uri" aria-hidden="true">
        {field.property_uri}
      </span>
      {invalid ? (
        <span className="ez-error" id={`${id}-error`} role="alert">
          {t("rightsRequired")}
        </span>
      ) : null}
    </div>
  );
}

interface MetadataFormProps {
  projectId: string;
  subjectId: string;
  templateId: string | null;
  subjectKind: "item" | "photo" | "selection";
  subjectRoute: string; // e.g. `/api/projects/[id]/items/[itemId]` for template PATCH
  bulk?: { subjectIds: string[] };
  hideTemplatePicker?: boolean;
  ctx: OpContext;
}

export default function MetadataForm({
  projectId,
  subjectId,
  templateId,
  subjectKind,
  subjectRoute,
  bulk,
  hideTemplatePicker,
  ctx,
}: MetadataFormProps) {
  const t = useTranslations("metadata");
  const { data: templates, error: templatesError } = useTemplates(projectId);
  const single = useMetadata(projectId, bulk ? null : subjectId);

  const [templateSel, setTemplateSel] = useState<string>(templateId ?? "");
  const [values, setValues] = useState<MetadataValuesMap>({});
  const [bulkChecked, setBulkChecked] = useState<Record<string, boolean>>({});
  const [bulkValues, setBulkValues] = useState<Record<string, string[]>>({});
  const [rightsError, setRightsError] = useState(false);
  const [saving, setSaving] = useState(false);

  const template: UiTemplate | undefined = useMemo(() => {
    if (!templates) return undefined;
    return (
      templates.find((x) => x.id === (templateSel || templateId)) ??
      templates.find((x) => x.id === templateId) ??
      templates[0]
    );
  }, [templates, templateSel, templateId]);

  // Single-subject: seed from server values.
  useEffect(() => {
    if (!bulk && single.data) setValues({ ...single.data });
  }, [bulk, single.data]);

  // Bulk: fetch every subject once, compute per-field value sets.
  useEffect(() => {
    if (!bulk) return;
    let cancelled = false;
    (async () => {
      const all: MetadataValuesMap[] = [];
      for (const sid of bulk.subjectIds) {
        try {
          const v = await get<{ values: { property_uri: string; text: string }[] }>(
            `/api/projects/${projectId}/subjects/${sid}/metadata`,
          );
          all.push(adaptMetadataValues(v.values));
        } catch {
          all.push({});
        }
      }
      if (cancelled) return;
      const uris = new Set<string>();
      all.forEach((v) => Object.keys(v).forEach((k) => uris.add(k)));
      const grouped: Record<string, string[]> = {};
      for (const uri of uris) {
        grouped[uri] = all.map((v) => v[uri] ?? "");
      }
      setBulkValues(grouped);
    })();
    return () => {
      cancelled = true;
    };
  }, [bulk, projectId]);

  async function applyTemplate(id: string) {
    setTemplateSel(id);
    // Persist the template choice on the subject (per-kind route).
    await patch(subjectRoute, { template_id: id || null });
    const { refreshAndBroadcast } = await import("@/lib/commands/ops");
    await refreshAndBroadcast(ctx, ["items", "metadata"]);
  }

  function validate(vals: MetadataValuesMap): boolean {
    if (!template) return true;
    const rightsField = template.fields.find(isRightsField);
    if (rightsField && !(vals[rightsField.property_uri] ?? "").trim()) {
      setRightsError(true);
      return false;
    }
    setRightsError(false);
    return true;
  }

  async function saveSingle() {
    if (!validate(values)) return;
    setSaving(true);
    try {
      const before: MetadataValuesMap = single.data ?? {};
      await runCommand(ctx, setMetadataOp(ctx, subjectId, before, { ...values }), ["metadata", "items", "search"]);
    } finally {
      setSaving(false);
    }
  }

  async function applyBulk() {
    if (!template || !bulk) return;
    const toApply: MetadataValuesMap = {};
    for (const f of template.fields) {
      if (bulkChecked[f.property_uri]) toApply[f.property_uri] = values[f.property_uri] ?? "";
    }
    // Rights validation runs per item server-side; list failures via toast.
    setSaving(true);
    try {
      await runCommand(ctx, bulkMetadataOp(ctx, bulk.subjectIds, toApply), ["metadata", "items", "search"]);
      setBulkChecked({});
    } finally {
      setSaving(false);
    }
  }

  if (templatesError) return <ErrorCard what={t("template")} />;
  if (!templates) return <SkeletonRows rows={5} />;
  if (!template) return <p style={{ color: "var(--ink-2)", fontSize: 13 }}>{t("noTemplate")}</p>;

  const knownUris = new Set(template.fields.map((f) => f.property_uri));
  const otherEntries = bulk
    ? []
    : Object.entries(values).filter(([uri]) => !knownUris.has(uri));

  return (
    <div>
      {hideTemplatePicker ? null : (
        <div className="ez-field">
          <label htmlFor="ez-template-select">{t("template")}</label>
          <select
            id="ez-template-select"
            className="ez-select"
            value={template.id}
            onChange={(e) => applyTemplate(e.target.value)}
          >
            {templates.map((tp) => (
              <option key={tp.id} value={tp.id}>
                {tp.name}
              </option>
            ))}
          </select>
        </div>
      )}

      {bulk ? (
        <p className="ez-notice" role="note">
          {t("bulkSummary", { count: bulk.subjectIds.length })}
        </p>
      ) : null}

      {template.fields.map((field) => {
        const uri = field.property_uri;
        const mixed =
          bulk && bulkValues[uri] && new Set(bulkValues[uri]).size > 1;
        const singleValue = bulk
          ? (mixed ? "" : (bulkValues[uri]?.[0] ?? ""))
          : (values[uri] ?? "");
        return (
          <div key={field.id} className={bulk ? "ez-bulk-row" : undefined}>
            <FieldInput
              field={field}
              value={bulk ? (values[uri] ?? "") : singleValue}
              onChange={(v) => setValues((prev) => ({ ...prev, [uri]: v }))}
              invalid={rightsError && isRightsField(field)}
            />
            {bulk ? (
              <label className="ez-apply-check" style={{ display: "flex", gap: 4, alignItems: "center", fontSize: 11 }}>
                <input
                  type="checkbox"
                  checked={!!bulkChecked[uri]}
                  onChange={(e) =>
                    setBulkChecked((p) => ({ ...p, [uri]: e.target.checked }))
                  }
                  aria-label={t("applyToAll", { count: bulk.subjectIds.length })}
                />
                {mixed ? <span className="ez-mixed">{t("mixed")}</span> : null}
              </label>
            ) : mixed ? null : null}
          </div>
        );
      })}

      {otherEntries.length > 0 ? (
        <details className="ez-collapsible">
          <summary>
            {t("unmapped")} ({otherEntries.length})
          </summary>
          <div style={{ padding: "0 12px 12px" }}>
            {otherEntries.map(([uri, v]) => (
              <div className="ez-field" key={uri}>
                <label>{uri}</label>
                <input
                  className="ez-input"
                  value={v}
                  onChange={(e) => setValues((prev) => ({ ...prev, [uri]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        </details>
      ) : null}

      <div style={{ marginTop: 12 }}>
        {bulk ? (
          <button
            type="button"
            className="ez-btn ez-btn--primary"
            disabled={saving || Object.keys(bulkChecked).filter((k) => bulkChecked[k]).length === 0}
            onClick={applyBulk}
          >
            {t("applyToAll", { count: bulk.subjectIds.length })}
          </button>
        ) : (
          <button
            type="button"
            className="ez-btn ez-btn--primary"
            disabled={saving}
            onClick={saveSingle}
          >
            {t("save")}
          </button>
        )}
      </div>
    </div>
  );
}
