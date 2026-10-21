// SPDX-License-Identifier: MIT
// Single source of truth for every keyboard binding (D-INTc).
//
// Framework-free: entries declare { id, keys, scope, group, labelKey, hint,
// run } once. Global entries are bound by components/shortcuts/
// useRegisteredHotkeys.ts via react-hotkeys-hook; viewer entries are bound
// locally in PhotoViewer's onViewerKeyDown (tabIndex-scoped) and listed here
// docs-only so the `?` overlay stays the single source of truth.
// Typing guard matches the old hand-rolled map: single keys never fire in
// INPUT/TEXTAREA/SELECT/contentEditable/.ProseMirror (the library's
// enableOnFormTags/enableOnContentEditable defaults).

import { useUiStore } from "@/lib/store/ui";
import { useDomainStore } from "@/lib/store/domain";
import { commandBus } from "@/lib/commands/bus";
import { startTour } from "@/lib/tour/launcher";
import {
  runCommand,
  trashSubjectsOp,
  mergeItemsOp,
  type OpContext,
} from "@/lib/commands/ops";
import { post } from "@/lib/api/client";
import { mutate } from "swr";
import {
  makeClipboard,
  writeItemClipboard,
  readItemClipboard,
  planPaste,
  executePaste,
} from "@/lib/items/clipboard";

export interface HotkeyContext {
  projectId: string;
  ctx: OpContext;
}

export type HotkeyGroup = "general" | "organize" | "viewer";
export type HotkeyScope = "global" | "viewer";

export interface HotkeyEntry {
  id: string;
  /** react-hotkeys-hook key syntax; absent for palette-only actions (tour) */
  keys?: string | string[];
  scope: HotkeyScope;
  group: HotkeyGroup;
  /** shortcuts.* i18n key */
  labelKey: string;
  /** display hint, e.g. "Ctrl/⌘ K" */
  hint: string;
  /** run is absent for viewer entries (bound locally in PhotoViewer) */
  run?: (ctx: HotkeyContext) => void | Promise<void>;
}

function closeTopmost() {
  const ui = useUiStore.getState();
  if (ui.paletteOpen) ui.setPaletteOpen(false);
  else if (ui.csvImportOpen) ui.setCsvImportOpen(false);
  else if (ui.shortcutsOpen) ui.setShortcutsOpen(false);
  else if (ui.importOpen) ui.setImportOpen(false);
  else if (ui.tpyOpen) ui.setTpyOpen(false);
  else if (ui.inspectorOpen) ui.setInspectorOpen(false);
  else if (ui.sidebarOpen) ui.setSidebarOpen(false);
}

export const HOTKEY_REGISTRY: HotkeyEntry[] = [
  // ---------- general ----------
  {
    id: "toggleShortcuts",
    keys: "?",
    scope: "global",
    group: "general",
    labelKey: "shortcuts",
    hint: "?",
    run: () => {
      const ui = useUiStore.getState();
      ui.setShortcutsOpen(!ui.shortcutsOpen);
    },
  },
  {
    id: "closeTopmost",
    keys: "esc",
    scope: "global",
    group: "general",
    labelKey: "escClose",
    hint: "Esc",
    run: () => closeTopmost(),
  },
  {
    id: "import",
    keys: "mod+shift+i",
    scope: "global",
    group: "general",
    labelKey: "import",
    hint: "Ctrl/⌘ Shift I",
    run: () => useUiStore.getState().setImportOpen(true),
  },
  {
    id: "palette",
    keys: "mod+k",
    scope: "global",
    group: "general",
    labelKey: "palette",
    hint: "Ctrl/⌘ K",
    // D-INTa: the palette supersedes mod+k-focuses-search; the
    // #ez-global-search input keeps working standalone as the fallback.
    run: () => useUiStore.getState().setPaletteOpen(true),
  },
  {
    id: "undo",
    keys: "mod+z",
    scope: "global",
    group: "general",
    labelKey: "undo",
    hint: "Ctrl/⌘ Z",
    run: async ({ projectId }) => {
      const cmd = await commandBus.undo();
      if (cmd) {
        useDomainStore.getState().setLastAction(`Undid: ${cmd.label}`);
        await mutate(
          (kk) => typeof kk === "string" && kk.includes(`/api/projects/${projectId}`),
        );
      }
    },
  },
  {
    id: "redo",
    keys: ["mod+shift+z", "mod+y"],
    scope: "global",
    group: "general",
    labelKey: "redo",
    hint: "Ctrl/⌘ Shift Z / Ctrl Y",
    run: async ({ projectId }) => {
      const cmd = await commandBus.redo();
      if (cmd) {
        useDomainStore.getState().setLastAction(`Redid: ${cmd.label}`);
        await mutate(
          (kk) => typeof kk === "string" && kk.includes(`/api/projects/${projectId}`),
        );
      }
    },
  },
  {
    id: "toggleView",
    keys: "v",
    scope: "global",
    group: "general",
    labelKey: "toggleView",
    hint: "V",
    run: () => {
      const ui = useUiStore.getState();
      ui.setView(ui.view === "grid" ? "table" : "grid");
    },
  },
  {
    id: "takeTour",
    scope: "global",
    group: "general",
    labelKey: "takeTour",
    hint: "⌘K",
    // Palette-only action (D-INTb): no key binding of its own; run it from
    // the palette, the project menu, Settings, or the empty-library link.
    run: () => startTour(),
  },
  // ---------- organize ----------
  {
    id: "newItem",
    keys: "mod+shift+n",
    scope: "global",
    group: "organize",
    labelKey: "newItem",
    hint: "Ctrl/⌘ Shift N",
    run: async ({ projectId }) => {
      const ui = useUiStore.getState();
      try {
        const item = await post<{ id: string }>(
          `/api/projects/${projectId}/items`,
          { title: "Untitled item" },
        );
        ui.setSelectedIds([item.id]);
        ui.setActiveItemId(item.id);
        await mutate(
          (kk) =>
            typeof kk === "string" &&
            kk.startsWith(`/api/projects/${projectId}/items`),
        );
      } catch {
        /* toast handled by caller */
      }
    },
  },
  {
    id: "newList",
    keys: "mod+shift+l",
    scope: "global",
    group: "organize",
    labelKey: "newList",
    hint: "Ctrl/⌘ Shift L",
    // Real behavior (kept from the hand-rolled map): opens the sidebar and
    // focuses it so a list can be created there.
    run: () => {
      useUiStore.getState().setSidebarOpen(true);
      document
        .getElementById("ez-sidebar")
        ?.querySelector<HTMLElement>(".ez-icon-btn")
        ?.focus();
    },
  },
  {
    id: "trash",
    keys: ["delete", "backspace"],
    scope: "global",
    group: "organize",
    labelKey: "trash",
    hint: "Delete",
    run: async ({ ctx }) => {
      const ui = useUiStore.getState();
      const ids = ui.selectedIds;
      if (ids.length === 0) return;
      await runCommand(
        ctx,
        trashSubjectsOp(ctx, ids, "user", `${ids.length} item(s) to trash`),
        ["items", "trash", "meter"],
      );
      ui.setSelectedIds([]);
      ui.setActiveItemId(null);
    },
  },
  {
    id: "merge",
    keys: "mod+shift+m",
    scope: "global",
    group: "organize",
    labelKey: "merge",
    hint: "Ctrl/⌘ Shift M",
    // Wave B2: mergeItemsOp runs the real backend merge (one undoable
    // command); the first selected item is the survivor.
    run: async ({ ctx }) => {
      const ids = useUiStore.getState().selectedIds;
      if (ids.length < 2) return;
      await runCommand(ctx, mergeItemsOp(ctx, ids.slice(1), ids[0]), [
        "items",
        "trash",
        "meter",
      ]);
    },
  },
  {
    id: "copySelection",
    keys: "mod+shift+c",
    scope: "global",
    group: "organize",
    labelKey: "copySelection",
    hint: "Ctrl/⌘ Shift C",
    // Row 32 fix: stores the selection's item refs in the app clipboard
    // (lib/items/clipboard); paste executes the copy in the target
    // project. Toast wording mirrors center.copyStored in en.json.
    run: ({ projectId, ctx }) => {
      const clip = makeClipboard(projectId, useUiStore.getState().selectedIds);
      if (!clip) return;
      writeItemClipboard(clip);
      ctx.toast(
        `${clip.itemIds.length} item(s) copied — open a project and choose “Paste items” to copy them there.`,
      );
    },
  },
  {
    id: "pasteItems",
    keys: "mod+shift+v",
    scope: "global",
    group: "organize",
    labelKey: "pasteItems",
    hint: "Ctrl/⌘ Shift V",
    // Row 32 fix: executes the bulk copy for every clipboard ref into
    // THIS project; the toast reports honest copied/failed counts.
    // Wording mirrors center.paste* in en.json.
    run: async ({ projectId, ctx }) => {
      const plan = planPaste(readItemClipboard(), projectId);
      if (!plan) return;
      const summary = await executePaste(plan, post);
      const reasons = summary.failed.map((f) => f.reason).join("; ");
      if (summary.failed.length === 0) {
        ctx.toast(`Pasted ${summary.copied} item(s) into this project.`);
      } else if (summary.copied > 0) {
        ctx.toast(
          `Pasted ${summary.copied} item(s); ${summary.failed.length} failed: ${reasons}`,
          "error",
        );
      } else {
        ctx.toast(`Paste failed: ${reasons}`, "error");
      }
      if (summary.copied > 0) {
        await mutate(
          (kk) => typeof kk === "string" && kk.includes(`/api/projects/${projectId}`),
        );
      }
    },
  },
  {
    id: "print",
    keys: "mod+p",
    scope: "global",
    group: "general",
    labelKey: "print",
    hint: "Ctrl/⌘ P",
    // Row 28/29: the cloud equivalent of Tropy's print dialog is the
    // browser print of the current view, laid out by the @media print
    // stylesheet in globals.css. When the inspector is open on one item,
    // print targets the item document (metadata + notes); otherwise the
    // item grid/list prints as a contact sheet. The mode rides on
    // <body data-print> and is cleared after printing.
    run: () => {
      const ui = useUiStore.getState();
      const mode = ui.inspectorOpen && ui.activeItemId ? "inspector" : "items";
      document.body.dataset.print = mode;
      const clear = () => {
        delete document.body.dataset.print;
        window.removeEventListener("afterprint", clear);
      };
      window.addEventListener("afterprint", clear);
      window.print();
      // afterprint is reliable in modern browsers; also clear on a delay
      // for engines that skip it when the dialog is cancelled instantly.
      window.setTimeout(clear, 1000);
    },
  },
  // ---------- viewer (docs-only; bound in PhotoViewer onViewerKeyDown) ----------
  // W2-A: zoom/pan/fit bindings moved to the lightbox (its own keymap);
  // only the edit-surface bindings (rotate, draw) remain here.
  {
    id: "rotate",
    keys: ["r", "mod+space"],
    scope: "viewer",
    group: "viewer",
    labelKey: "rotate",
    hint: "R / Ctrl Space",
  },
  {
    id: "drawSelection",
    keys: "s",
    scope: "viewer",
    group: "viewer",
    labelKey: "drawSelection",
    hint: "S",
  },
];
