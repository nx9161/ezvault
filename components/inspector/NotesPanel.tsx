// SPDX-License-Identifier: MIT
// Notes panel: note tabs, per-note editor (dynamic, ssr:false), language,
// vertical-writing + line-number toggles. Design §1.4 / §2.3.

"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useNotes } from "@/lib/api/hooks";
import { post, patch, del } from "@/lib/api/client";
import { useOpContext } from "@/components/sidebar/Sidebar";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ErrorCard, SkeletonRows } from "@/components/ui/Feedback";
import type { Note } from "@/lib/api/types";

const NotesEditor = dynamic(() => import("./NotesEditor"), {
  ssr: false,
  loading: () => <SkeletonRows rows={4} />,
});

const EMPTY_DOC = { type: "doc", content: [{ type: "paragraph" }] };

export default function NotesPanel({
  projectId,
  photoId,
  selectionId,
}: {
  projectId: string;
  photoId: string | null;
  selectionId: string | null;
}) {
  const t = useTranslations("notes");
  const ctx = useOpContext(projectId);
  const subjectId = selectionId ?? photoId;
  const kind = selectionId ? "selection" as const : "photo" as const;
  const { data, error, isLoading, mutate } = useNotes(projectId, subjectId, kind);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [vertical, setVertical] = useState(false);
  const [lineNumbers, setLineNumbers] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Note | null>(null);

  const notes = data?.items ?? [];
  useEffect(() => {
    if (!activeId && notes.length > 0) setActiveId(notes[0].id);
    if (activeId && !notes.some((n) => n.id === activeId)) {
      setActiveId(notes[0]?.id ?? null);
    }
  }, [notes, activeId]);

  const active = notes.find((n) => n.id === activeId) ?? null;

  async function createNote() {
    const url = selectionId
      ? `/api/projects/${projectId}/selections/${selectionId}/notes`
      : `/api/projects/${projectId}/photos/${photoId}/notes`;
    const created = await post<Note>(url, { state: EMPTY_DOC, language: "en" });
    await mutate();
    setActiveId(created.id);
  }

  async function setLanguage(lang: string) {
    if (!active) return;
    await patch(`/api/projects/${projectId}/notes/${active.id}`, { language: lang });
    await mutate();
    void ctx;
  }

  if (isLoading) return <SkeletonRows rows={4} />;
  if (error) return <ErrorCard what="notes" onRetry={() => mutate()} />;

  return (
    <div>
      <div className="ez-note-tabs" role="tablist" aria-label="notes">
        {notes.map((n, i) => (
          <button
            key={n.id}
            type="button"
            role="tab"
            aria-selected={n.id === activeId}
            className="ez-note-tab"
            onClick={() => setActiveId(n.id)}
          >
            {t("noteTab", { n: i + 1 })}
          </button>
        ))}
        <button
          type="button"
          className="ez-note-tab ez-note-add"
          onClick={createNote}
          aria-label={t("newNote")}
        >
          + {t("newNote")}
        </button>
        <span style={{ flex: 1 }} />
        {active ? (
          <button
            type="button"
            className="ez-btn ez-btn--sm ez-btn--ghost"
            onClick={() => setConfirmDelete(active)}
          >
            {t("deleteNote")}
          </button>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 12, marginBottom: 8, fontSize: 12 }}>
        <label className="ez-check-label">
          <input
            type="checkbox"
            checked={vertical}
            onChange={(e) => setVertical(e.target.checked)}
          />
          {t("verticalWriting")}
        </label>
        <label className="ez-check-label">
          <input
            type="checkbox"
            checked={lineNumbers}
            onChange={(e) => setLineNumbers(e.target.checked)}
          />
          {t("lineNumbers")}
        </label>
      </div>
      {active ? (
        <NotesEditor
          key={`${active.id}-${lineNumbers ? "ln" : "noln"}`}
          projectId={projectId}
          note={active}
          vertical={vertical}
          lineNumbers={lineNumbers}
          onLanguageChange={setLanguage}
        />
      ) : (
        <div className="ez-state" style={{ height: "auto", padding: "24px 0" }}>
          <p>{t("empty")}</p>
        </div>
      )}
      {confirmDelete ? (
        <ConfirmDialog
          title={t("deleteNote")}
          body={t("deleteNoteConfirm")}
          confirmLabel={t("deleteNote")}
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => {
            const n = confirmDelete;
            setConfirmDelete(null);
            await del(`/api/projects/${projectId}/notes/${n.id}`);
            setActiveId(null);
            await mutate();
          }}
        />
      ) : null}
    </div>
  );
}
