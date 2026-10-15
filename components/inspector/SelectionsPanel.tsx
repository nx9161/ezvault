// SPDX-License-Identifier: MIT
// Selections tab: the screen-reader mirror of the viewer overlay (design §5).
// Create/rename/rect-edit/delete; own template + notes; export with bake.

"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useSelections, useTemplates } from "@/lib/api/hooks";
import {
  runCommand,
  updateSelectionOp,
  deleteSelectionOp,
  type OpContext,
} from "@/lib/commands/ops";
import { useOpContext } from "@/components/sidebar/Sidebar";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ErrorCard, SkeletonRows } from "@/components/ui/Feedback";
import type { Selection } from "@/lib/api/types";

function SelectionCard({
  projectId,
  selection,
  active,
  onActivate,
  onChanged,
  ctx,
}: {
  projectId: string;
  selection: Selection;
  active: boolean;
  onActivate: () => void;
  onChanged: () => void;
  ctx: OpContext;
}) {
  const t = useTranslations("selections");
  const { data: templates } = useTemplates(projectId);
  const [editingName, setEditingName] = useState(false);
  const [name, setName] = useState(selection.name);
  const [rect, setRect] = useState({ x: selection.x, y: selection.y, w: selection.w, h: selection.h });
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function commitName() {
    setEditingName(false);
    const next = name.trim();
    if (next && next !== selection.name) {
      await runCommand(ctx, updateSelectionOp(ctx, selection, { name: next }, t("rename")), ["selections"]);
      onChanged();
    } else {
      setName(selection.name);
    }
  }

  async function commitRect() {
    const before = { x: selection.x, y: selection.y, w: selection.w, h: selection.h };
    const after = {
      x: Math.max(0, Math.round(rect.x)),
      y: Math.max(0, Math.round(rect.y)),
      w: Math.max(1, Math.round(rect.w)),
      h: Math.max(1, Math.round(rect.h)),
    };
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    await runCommand(ctx, updateSelectionOp(ctx, selection, after, t("region")), ["selections"]);
    onChanged();
  }

  return (
    <div
      className="ez-sel-card"
      data-active={active || undefined}
      role="option"
      aria-selected={active}
      tabIndex={0}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter") onActivate();
      }}
      aria-label={`${selection.name} — ${t("region")} ${selection.x},${selection.y} ${selection.w}×${selection.h}`}
    >
      <div className="ez-sel-card-head">
        {editingName ? (
          <input
            className="ez-input"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") {
                setName(selection.name);
                setEditingName(false);
              }
              e.stopPropagation();
            }}
            onClick={(e) => e.stopPropagation()}
            aria-label={t("rename")}
            style={{ flex: 1 }}
          />
        ) : (
          <strong
            onDoubleClick={(e) => {
              e.stopPropagation();
              setEditingName(true);
            }}
            title={t("rename")}
            style={{ cursor: "text" }}
          >
            {selection.name}
          </strong>
        )}
        {selection.note_count > 0 ? (
          <span className="ez-mini-badge" aria-label={t("notesCount", { count: selection.note_count })}>
            ✎{selection.note_count}
          </span>
        ) : null}
        <button
          type="button"
          className="ez-icon-btn"
          onClick={(e) => {
            e.stopPropagation();
            window.location.href = `/api/projects/${projectId}/selections/${selection.id}/export?format=png`;
          }}
          aria-label={t("export")}
          title={t("export")}
        >
          ⤓
        </button>
        <button
          type="button"
          className="ez-icon-btn"
          onClick={(e) => {
            e.stopPropagation();
            setConfirmDelete(true);
          }}
          aria-label={t("deleteSelection")}
          title={t("deleteSelection")}
        >
          🗑
        </button>
      </div>
      <div className="ez-rect-grid" onClick={(e) => e.stopPropagation()}>
        {(
          [
            ["x", t("x")],
            ["y", t("y")],
            ["w", t("width")],
            ["h", t("height")],
          ] as const
        ).map(([k, label]) => (
          <div className="ez-field" key={k}>
            <label htmlFor={`ez-sel-${selection.id}-${k}`}>{label}</label>
            <input
              id={`ez-sel-${selection.id}-${k}`}
              className="ez-input"
              type="number"
              min={k === "w" || k === "h" ? 1 : 0}
              value={rect[k]}
              onChange={(e) => setRect((p) => ({ ...p, [k]: Number(e.target.value) }))}
              onBlur={commitRect}
            />
          </div>
        ))}
      </div>
      {templates ? (
        <div className="ez-field" onClick={(e) => e.stopPropagation()} style={{ marginTop: 8, marginBottom: 0 }}>
          <label htmlFor={`ez-sel-tpl-${selection.id}`}>{t("template")}</label>
          <select
            id={`ez-sel-tpl-${selection.id}`}
            className="ez-select"
            value={selection.template_id ?? ""}
            onChange={async (e) => {
              await runCommand(
                ctx,
                updateSelectionOp(ctx, selection, { template_id: e.target.value || null }, t("template")),
                ["selections"],
              );
              onChanged();
            }}
          >
            <option value="">—</option>
            {templates.map((tp) => (
              <option key={tp.id} value={tp.id}>
                {tp.name}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          title={t("deleteConfirmTitle")}
          body={t("deleteConfirmBody", { name: selection.name })}
          confirmLabel={t("deleteSelection")}
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            setConfirmDelete(false);
            await runCommand(ctx, deleteSelectionOp(ctx, selection), ["selections"]);
            onChanged();
          }}
        />
      ) : null}
    </div>
  );
}

export default function SelectionsPanel({
  projectId,
  photoId,
  activeSelectionId,
  onSelectSelection,
}: {
  projectId: string;
  photoId: string | null;
  activeSelectionId: string | null;
  onSelectSelection: (id: string | null) => void;
}) {
  const t = useTranslations("selections");
  const ctx = useOpContext(projectId);
  const { data, error, isLoading, mutate } = useSelections(projectId, photoId);

  if (isLoading) return <SkeletonRows rows={3} />;
  if (error) return <ErrorCard what="selections" onRetry={() => mutate()} />;
  const selections = data?.items ?? [];
  if (selections.length === 0) {
    return (
      <div className="ez-state" style={{ height: "auto", padding: "24px 0" }}>
        <p>{t("empty")}</p>
      </div>
    );
  }
  return (
    <div role="listbox" aria-label={t("region")}>
      {selections.map((s) => (
        <SelectionCard
          key={s.id}
          projectId={projectId}
          selection={s}
          active={s.id === activeSelectionId}
          onActivate={() => onSelectSelection(s.id === activeSelectionId ? null : s.id)}
          onChanged={() => mutate()}
          ctx={ctx}
        />
      ))}
    </div>
  );
}
