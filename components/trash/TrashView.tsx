// SPDX-License-Identifier: MIT
// Trash: reason-badged list, restore / restore-all, irreversible empty.
// Design §2.6.

"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import { useTrash } from "@/lib/api/hooks";
import { runCommand, restoreTrashOp, emptyTrashOp } from "@/lib/commands/ops";
import { useOpContext } from "@/components/sidebar/Sidebar";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ErrorCard, SkeletonRows } from "@/components/ui/Feedback";

export default function TrashView({ projectId }: { projectId: string }) {
  const t = useTranslations("trash");
  const ta = useTranslations("app");
  const kindLabel = (kind: string) =>
    ta(kind === "photo" ? "kindPhoto" : kind === "selection" ? "kindSelection" : "kindItem");
  const ctx = useOpContext(projectId);
  const { data, error, isLoading, mutate } = useTrash(projectId);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const pushToast = useUiStore((s) => s.pushToast);

  const entries = data?.items ?? [];

  async function restore(ids: string[]) {
    if (ids.length === 0) return;
    await runCommand(ctx, restoreTrashOp(ctx, ids), ["trash", "items", "meter"]);
    setSelected([]);
  }

  return (
    <section className="ez-center" aria-label={t("title")}>
      <div className="ez-center-head">
        <nav className="ez-breadcrumb" aria-label="breadcrumb">
          <strong>{t("title")}</strong>
          <span aria-hidden="true">·</span>
          <span>{entries.length}</span>
        </nav>
        <span className="ez-spacer" />
        {selected.length > 0 ? (
          <button type="button" className="ez-btn ez-btn--sm" onClick={() => restore(selected)}>
            {t("restore")} ({selected.length})
          </button>
        ) : null}
        <button
          type="button"
          className="ez-btn ez-btn--sm"
          disabled={entries.length === 0}
          onClick={async () => {
            const ids = entries.map((e) => e.subject_id);
            await runCommand(ctx, restoreTrashOp(ctx, ids), ["trash", "items", "meter"]);
          }}
        >
          {t("restoreAll")}
        </button>
        <button
          type="button"
          className="ez-btn ez-btn--sm ez-btn--danger"
          disabled={entries.length === 0}
          onClick={() => setConfirmEmpty(true)}
        >
          {t("empty")}
        </button>
      </div>
      <div className="ez-grid-scroll">
        {isLoading ? (
          <SkeletonRows rows={6} />
        ) : error ? (
          <ErrorCard what={t("title")} onRetry={() => mutate()} />
        ) : entries.length === 0 ? (
          <div className="ez-state">
            <p>{t("emptyState")}</p>
          </div>
        ) : (
          entries.map((e) => (
            <div key={e.subject_id} className="ez-trash-row">
              <input
                type="checkbox"
                checked={selected.includes(e.subject_id)}
                onChange={() =>
                  setSelected((s) =>
                    s.includes(e.subject_id)
                      ? s.filter((x) => x !== e.subject_id)
                      : [...s, e.subject_id],
                  )
                }
                aria-label={e.label}
              />
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {e.label}
                </strong>
                <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
                  {t("deletedOn", {
                    date: new Date(e.deleted_at).toLocaleDateString(),
                  })}{" · "}{kindLabel(e.subject_kind)}
                </span>
              </span>
              <span className="ez-reason-badge" data-reason={e.reason}>
                {t(`reason${e.reason[0].toUpperCase()}${e.reason.slice(1)}` as "reasonUser")}
              </span>
              <button
                type="button"
                className="ez-btn ez-btn--sm"
                onClick={() => restore([e.subject_id])}
              >
                {t("restore")}
              </button>
            </div>
          ))
        )}
      </div>
      {confirmEmpty ? (
        <ConfirmDialog
          title={t("emptyConfirmTitle")}
          body={t("emptyConfirmBody", { count: entries.length })}
          confirmLabel={t("empty")}
          danger
          onCancel={() => setConfirmEmpty(false)}
          onConfirm={async () => {
            setConfirmEmpty(false);
            await runCommand(ctx, emptyTrashOp(ctx), ["trash", "meter"]);
            pushToast({ message: t("emptyState") });
          }}
        />
      ) : null}
    </section>
  );
}
