// SPDX-License-Identifier: MIT
// Astryx providers: Theme (EZVault brand theme) + LinkProvider (Next
// router links inside Astryx components). The Astryx colour mode is
// driven by EZVault's existing theme store — the same store that sets
// <html data-theme> — so the app keeps one theme switch, not two.

"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { Theme } from "@astryxdesign/core/theme";
import { LinkProvider } from "@astryxdesign/core/Link";
// Built theme (astryx theme build output) — the production form of
// lib/theme/ezvault-theme.ts; its stylesheet is imported in
// app/globals.css, so no styles are injected at hydration.
import { ezvaultTheme } from "@/lib/theme/ezvault";
import { useUiStore } from "@/lib/store/ui";

export function AstryxProviders({ children }: { children: ReactNode }) {
  const mode = useUiStore((s) => s.theme);
  return (
    <Theme theme={ezvaultTheme} mode={mode}>
      <LinkProvider component={Link}>{children}</LinkProvider>
    </Theme>
  );
}
