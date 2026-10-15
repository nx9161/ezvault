// SPDX-License-Identifier: MIT
// Palette mount point (D-INTa): renders next to TopBar in the workspace
// shell. The CommandPalette chunk (cmdk+fuse) loads lazily on the first
// mod+k via next/dynamic(ssr:false) and stays mounted afterwards, so
// repeat opens are instant.

"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { useUiStore } from "@/lib/store/ui";
import type { HotkeyContext } from "@/lib/shortcuts/registry";

const CommandPalette = dynamic(() => import("./CommandPalette"), {
  ssr: false,
});

export function PaletteLauncher({
  projectId,
  opCtx,
}: {
  projectId: string;
  opCtx: HotkeyContext["ctx"];
}) {
  const open = useUiStore((s) => s.paletteOpen);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (open) setMounted(true);
  }, [open ]);

  if (!mounted) return null;
  return <CommandPalette projectId={projectId} opCtx={opCtx} />;
}
