// SPDX-License-Identifier: MIT
// Global keyboard map (design §5). Single-key shortcuts are inert while
// typing (inputs, textareas, selects, contenteditable, TipTap).

"use client";

import { useEffect } from "react";
import { useUiStore } from "@/lib/store/ui";
import { useDomainStore } from "@/lib/store/domain";
import { commandBus } from "@/lib/commands/bus";
import { undoLast, redoLast, trashSubjectsOp, type OpContext } from "@/lib/commands/ops";
import { post } from "@/lib/api/client";
import { mutate } from "swr";
import { key } from "@/lib/api/hooks";

function isTypingTarget(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    t.isContentEditable ||
    !!t.closest?.(".ProseMirror")
  );
}

export function useGlobalShortcuts(projectId: string, ctx: OpContext) {
  useEffect(() => {
    async function onKeyDown(e: KeyboardEvent) {
      const mod = e.ctrlKey || e.metaKey;
      const typing = isTypingTarget(e.target);
      const ui = useUiStore.getState();

      // --- `?` overlay (works everywhere except while typing) ---
      if (!typing && !mod && e.key === "?") {
        e.preventDefault();
        ui.setShortcutsOpen(!ui.shortcutsOpen);
        return;
      }
      // --- Escape: close topmost dialog/drawer ---
      if (e.key === "Escape" && !typing) {
        if (ui.shortcutsOpen) ui.setShortcutsOpen(false);
        else if (ui.importOpen) ui.setImportOpen(false);
        else if (ui.tpyOpen) ui.setTpyOpen(false);
        else if (ui.inspectorOpen) ui.setInspectorOpen(false);
        else if (ui.sidebarOpen) ui.setSidebarOpen(false);
        return;
      }
      if (!mod) {
        // --- single-key shortcuts (never while typing) ---
        if (typing) return;
        if (e.key === "v" || e.key === "V") {
          ui.setView(ui.view === "grid" ? "table" : "grid");
          return;
        }
        if (e.key === "Delete" || e.key === "Backspace") {
          const ids = ui.selectedIds;
          if (ids.length > 0) {
            e.preventDefault();
            const { runCommand } = await import("@/lib/commands/ops");
            await runCommand(
              ctx,
              trashSubjectsOp(ctx, ids, "user", `${ids.length} item(s) to trash`),
              ["items", "trash", "meter"],
            );
            ui.setSelectedIds([]);
            ui.setActiveItemId(null);
          }
          return;
        }
        return;
      }
      // --- Ctrl/Cmd chords ---
      const k = e.key.toLowerCase();
      if (e.shiftKey && k === "i") {
        e.preventDefault();
        ui.setImportOpen(true);
      } else if (e.shiftKey && k === "n") {
        e.preventDefault();
        // New item → select it so the inspector opens on it.
        try {
          const item = await post<{ id: string }>(`/api/projects/${projectId}/items`, {
            title: "Untitled item",
          });
          ui.setSelectedIds([item.id]);
          ui.setActiveItemId(item.id);
          await mutate((kk) => typeof kk === "string" && kk.startsWith(`/api/projects/${projectId}/items`));
        } catch {
          /* toast handled by caller */
        }
      } else if (e.shiftKey && k === "l") {
        e.preventDefault();
        ui.setSidebarOpen(true);
        document.getElementById("ez-sidebar")?.querySelector<HTMLElement>(".ez-icon-btn")?.focus();
      } else if (e.shiftKey && k === "m") {
        e.preventDefault();
        if (ui.selectedIds.length >= 2) {
          const { runCommand, mergeItemsOp } = await import("@/lib/commands/ops");
          const [target] = ui.selectedIds;
          await runCommand(ctx, mergeItemsOp(ctx, ui.selectedIds, target), ["items", "trash", "meter"]);
          ui.setSelectedIds([target]);
        }
      } else if (k === "k") {
        e.preventDefault();
        document.getElementById("ez-global-search")?.focus();
      } else if (k === "z" && !e.shiftKey) {
        if (typing) return; // let the field/editor handle it
        e.preventDefault();
        const cmd = await commandBus.undo();
        if (cmd) {
          useDomainStore.getState().setLastAction(`Undid: ${cmd.label}`);
          await mutate((kk) => typeof kk === "string" && kk.includes(`/api/projects/${projectId}`));
        }
      } else if ((k === "z" && e.shiftKey) || k === "y") {
        if (typing) return;
        e.preventDefault();
        const cmd = await commandBus.redo();
        if (cmd) {
          useDomainStore.getState().setLastAction(`Redid: ${cmd.label}`);
          await mutate((kk) => typeof kk === "string" && kk.includes(`/api/projects/${projectId}`));
        }
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);
}

// Re-exported so WorkspaceClient can build the OpContext once.
export type { OpContext };
export { undoLast, redoLast };
