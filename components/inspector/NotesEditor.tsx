// SPDX-License-Identifier: MIT
// TipTap v3 notes editor (StarterKit + underline/superscript/subscript/link).
// Loaded via next/dynamic({ ssr: false }). Autosave: onUpdate → 1.5s debounce
// → PATCH; keepalive flush on unmount / visibilitychange=hidden /
// beforeunload. Notes undo = coalesced sessions (blur/tab-switch/30s idle).
// B13: Link.configure({ isAllowedUri }) + rel=noopener noreferrer target=_blank;
// .tpy JSON states pass through mapTropyNoteState BEFORE setContent.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Underline from "@tiptap/extension-underline";
import Superscript from "@tiptap/extension-superscript";
import Subscript from "@tiptap/extension-subscript";
import Link from "@tiptap/extension-link";
import { patch } from "@/lib/api/client";
import { isAllowedUri, tiptapLinkOptions } from "@/lib/link-policy";
import { LinkIcon } from "@/components/ui/icons";
import { mapTropyNoteState } from "@/lib/notes/tropy-schema-map";
import { commandBus, type Command } from "@/lib/commands/bus";
import { newClientOpId } from "@/lib/api/client";
import { useUiStore } from "@/lib/store/ui";
import { useDomainStore } from "@/lib/store/domain";
import { LineNumbers, VerticalWriting } from "./note-extensions";
import { SkeletonRows } from "@/components/ui/Feedback";
import type { Note } from "@/lib/api/types";

type SaveState = "saved" | "saving" | "failed";

const AUTOSAVE_MS = 1500;
const SESSION_IDLE_MS = 30_000;

export default function NotesEditor({
  projectId,
  note,
  vertical,
  lineNumbers,
  onLanguageChange,
}: {
  projectId: string;
  note: Note;
  vertical: boolean;
  lineNumbers: boolean;
  onLanguageChange: (lang: string) => void;
}) {
  const t = useTranslations("notes");
  const ta = useTranslations("app");
  const pushToast = useUiStore((s) => s.pushToast);
  const setDirty = useDomainStore((s) => s.setDirty);

  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionBefore = useRef<unknown>(note.state);
  const sessionDirty = useRef(false);
  const editorState = useRef<{ json: unknown } | null>(null);

  const noteUrl = `/api/projects/${projectId}/notes/${note.id}`;

  const flushSave = useCallback(
    async (keepalive = false) => {
      const json = editorState.current?.json;
      if (json == null || !sessionDirty.current) return;
      setSaveState("saving");
      try {
        await patch(
          noteUrl,
          { state: json },
          keepalive ? { keepalive: true } : undefined,
        );
        sessionDirty.current = false;
        setSaveState("saved");
        setSavedAt(new Date().toLocaleTimeString());
        setDirty(false);
      } catch {
        if (!keepalive) setSaveState("failed");
      }
    },
    [noteUrl, setDirty],
  );

  // Coalesced undo session: push ONE command covering the whole session.
  const closeSession = useCallback(() => {
    if (!sessionDirty.current && idleTimer.current === null) return;
    const before = sessionBefore.current;
    const after = editorState.current?.json;
    if (after == null || JSON.stringify(before) === JSON.stringify(after)) {
      sessionBefore.current = after ?? before;
      return;
    }
    // Per-command op_id: the do() carries the command's own id; undo is a
    // distinct logical operation with its own key.
    const opId = newClientOpId();
    const cmd: Command = {
      id: opId,
      label: "Edit note",
      scope: "notes",
      at: Date.now(),
      do: async () => {
        await patch(noteUrl, { state: after }, { opId });
      },
      undo: async () => {
        await patch(noteUrl, { state: before }, { opId: newClientOpId() });
      },
    };
    sessionBefore.current = after;
    sessionDirty.current = false;
    // execute() runs do() (idempotent re-apply) then pushes — undo restores `before`.
    void commandBus.execute(cmd).catch(() => {
      commandBus.dropTop("note session failed");
    });
  }, [noteUrl]);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      Superscript,
      Subscript,
      Link.configure({ ...tiptapLinkOptions(), openOnClick: false }),
      LineNumbers.configure({}),
      VerticalWriting,
    ],
    content: (() => {
      try {
        return mapTropyNoteState(note.state, isAllowedUri).doc as object;
      } catch {
        return { type: "doc", content: [{ type: "paragraph" }] };
      }
    })(),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-label": t("noteTab", { n: 1 }),
        role: "textbox",
        "aria-multiline": "true",
      },
    },
    onUpdate: ({ editor: ed }) => {
      editorState.current = { json: ed.getJSON() };
      sessionDirty.current = true;
      setDirty(true);
      setSaveState("saving");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => void flushSave(false), AUTOSAVE_MS);
      // 30s idle → close the undo session.
      if (idleTimer.current) clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => {
        void flushSave(false);
        closeSession();
        idleTimer.current = null;
      }, SESSION_IDLE_MS);
    },
  });

  // Vertical writing = rendering-only toggle (architecture §9).
  useEffect(() => {
    const dom = editor?.view.dom;
    if (dom) dom.setAttribute("data-vertical", vertical ? "true" : "false");
  }, [editor, vertical]);

  // Line numbers toggle = recreate the editor (extension list is static).
  // Handled by the parent via key={...}.

  // Flush on unmount (tab switch) + keepalive on page hide.
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        void flushSave(true);
        closeSession();
      }
    };
    const onUnload = () => {
      void flushSave(true);
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (idleTimer.current) clearTimeout(idleTimer.current);
      void flushSave(true);
      closeSession();
      setDirty(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!editor) return <SkeletonRows rows={4} />;
  const ed = editor;

  const toggleMark = (mark: string) => () => {
    const chain = ed.chain().focus();
    if (mark === "bold") chain.toggleBold().run();
    else if (mark === "italic") chain.toggleItalic().run();
    else if (mark === "underline") chain.toggleUnderline().run();
    else if (mark === "strike") chain.toggleStrike().run();
    else if (mark === "superscript") chain.toggleSuperscript().run();
    else if (mark === "subscript") chain.toggleSubscript().run();
  };

  // D-M8b: link URL popover replaces window.prompt.
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkPrev, setLinkPrev] = useState<string | undefined>(undefined);
  const linkBtnRef = useRef<HTMLButtonElement>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);

  function openLinkPopover() {
    setLinkPrev(ed.getAttributes("link").href as string | undefined);
    setLinkOpen(true);
  }
  useEffect(() => {
    if (linkOpen) linkInputRef.current?.select();
  }, [linkOpen]);
  function closeLinkPopover() {
    setLinkOpen(false);
    linkBtnRef.current?.focus();
  }
  function applyLink() {
    const url = linkInputRef.current?.value.trim() ?? "";
    if (!isAllowedUri(url)) {
      pushToast({ message: t("linkBlocked"), kind: "error" });
      return;
    }
    ed.chain().focus().setLink({ href: url }).run();
    setLinkOpen(false);
    linkBtnRef.current?.focus();
  }
  function removeLink() {
    ed.chain().focus().unsetLink().run();
    setLinkOpen(false);
    linkBtnRef.current?.focus();
  }

  const btn = (label: React.ReactNode, active: boolean, onClick: () => void, title: string) => (
    <button
      key={typeof label === "string" ? label : title}
      type="button"
      className="ez-icon-btn"
      data-active={active || undefined}
      onClick={onClick}
      title={title}
      aria-pressed={active}
    >
      {label}
    </button>
  );

  return (
    <div>
      <div className="ez-editor-toolbar" role="toolbar" aria-label="formatting">
        {btn("B", ed.isActive("bold"), toggleMark("bold"), t("bold"))}
        {btn("I", ed.isActive("italic"), toggleMark("italic"), t("italic"))}
        {btn("U", ed.isActive("underline"), toggleMark("underline"), t("underline"))}
        {btn("S", ed.isActive("strike"), toggleMark("strike"), t("strike"))}
        {btn("x²", ed.isActive("superscript"), toggleMark("superscript"), t("superscript"))}
        {btn("x₂", ed.isActive("subscript"), toggleMark("subscript"), t("subscript"))}
        {btn("❝", ed.isActive("blockquote"), () => ed.chain().focus().toggleBlockquote().run(), t("blockquote"))}
        {btn("•", ed.isActive("bulletList"), () => ed.chain().focus().toggleBulletList().run(), t("bulletList"))}
        {btn("1.", ed.isActive("orderedList"), () => ed.chain().focus().toggleOrderedList().run(), t("orderedList"))}
        <button
          ref={linkBtnRef}
          type="button"
          className="ez-icon-btn"
          data-active={ed.isActive("link") || undefined}
          onClick={openLinkPopover}
          title={t("link")}
          aria-pressed={ed.isActive("link")}
          aria-haspopup="dialog"
          aria-expanded={linkOpen}
        >
          <LinkIcon size={15} />
        </button>
        {linkOpen ? (
          <div className="ez-link-pop" role="dialog" aria-label={t("link")}>
            <input
              ref={linkInputRef}
              className="ez-input"
              defaultValue={linkPrev ?? "https://"}
              aria-label={t("linkUrl")}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyLink();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  closeLinkPopover();
                }
              }}
            />
            <div className="ez-link-pop-actions">
              {linkPrev ? (
                <button type="button" className="ez-btn ez-btn--sm" onClick={removeLink}>
                  {t("unlink")}
                </button>
              ) : null}
              <span style={{ flex: 1 }} />
              <button type="button" className="ez-btn ez-btn--sm" onClick={closeLinkPopover}>
                {ta("cancel")}
              </button>
              <button type="button" className="ez-btn ez-btn--sm ez-btn--primary" onClick={applyLink}>
                {t("linkApply")}
              </button>
            </div>
          </div>
        ) : null}
        <span style={{ flex: 1 }} />
        <label style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11 }}>
          {t("language")}
          <select
            className="ez-select"
            style={{ padding: "2px 6px", fontSize: 11 }}
            value={note.language ?? "en"}
            onChange={(e) => onLanguageChange(e.target.value)}
            aria-label={t("language")}
          >
            {["en", "de", "fr", "es", "it", "pt", "nl", "ja", "zh", "ko", "hi", "ar", "und"].map((l) => (
              <option key={l} value={l}>
                {l}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className={`ez-editor-wrap${lineNumbers ? " ez-linenumbers" : ""}`}>
        <EditorContent editor={editor} />
      </div>
      <div className="ez-note-status" data-state={saveState === "failed" ? "failed" : undefined} role="status">
        {saveState === "saving" ? (
          <span>{t("saving")}</span>
        ) : saveState === "failed" ? (
          <>
            <span>{t("saveFailed")}</span>
            <button type="button" className="ez-btn ez-btn--sm" onClick={() => flushSave(false)}>
              {t("retrySave")}
            </button>
          </>
        ) : (
          <span>{savedAt ? t("saved", { time: savedAt }) : t("saved", { time: "—" })}</span>
        )}
      </div>
    </div>
  );
}
