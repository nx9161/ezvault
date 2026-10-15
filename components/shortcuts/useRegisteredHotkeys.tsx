// SPDX-License-Identifier: MIT
// Binds the global entries of lib/shortcuts/registry.ts via
// react-hotkeys-hook. Viewer entries are bound locally in PhotoViewer
// (tabIndex-scoped) and listed in the registry docs-only.

"use client";

import { useHotkeys } from "react-hotkeys-hook";
import {
  HOTKEY_REGISTRY,
  type HotkeyContext,
  type HotkeyEntry,
} from "@/lib/shortcuts/registry";

function BoundHotkey({ entry, ctx }: { entry: HotkeyEntry; ctx: HotkeyContext }) {
  useHotkeys(
    entry.keys ?? "",
    () => {
      void entry.run?.(ctx);
    },
    {
      // Same typing guard as the old hand-rolled map: chords are inert in
      // inputs, contenteditables, and the TipTap editor (.ProseMirror).
      enableOnFormTags: false,
      enableOnContentEditable: false,
      preventDefault: true,
    },
  );
  return null;
}

export function RegisteredHotkeys({
  projectId,
  ctx,
}: {
  projectId: string;
  ctx: HotkeyContext["ctx"];
}) {
  const hotkeyCtx: HotkeyContext = { projectId, ctx };
  return (
    <>
      {HOTKEY_REGISTRY.filter((e) => e.scope === "global" && e.run && e.keys).map(
        (entry) => (
          <BoundHotkey key={entry.id} entry={entry} ctx={hotkeyCtx} />
        ),
      )}
    </>
  );
}
