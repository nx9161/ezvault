// SPDX-License-Identifier: MIT
// Domain store — ephemeral cross-component domain state.
// NOT a server cache (SWR owns that) and NOT form state (component-local).
// Cross-tab staleness tracking lives here (architecture §9: projects.rev).

"use client";

import { create } from "zustand";
import { devtools } from "zustand/middleware";

interface DomainState {
  /** last known server rev (projects.rev) */
  rev: number;
  setRev: (n: number) => void;
  /** short label of the last completed action (status bar) */
  lastAction: string | null;
  setLastAction: (s: string | null) => void;
  /** true while any editor holds unflushed changes (cross-tab dirty guard) */
  dirty: boolean;
  setDirty: (b: boolean) => void;
  /** true while a mutation is being broadcast (suppress self-echo) */
  tabId: string;
  /** non-blocking "updated in another tab" notice */
  remoteUpdate: boolean;
  setRemoteUpdate: (b: boolean) => void;
}

const tabId =
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `tab-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export const useDomainStore = create<DomainState>()(
  devtools(
    (set) => ({
      rev: 0,
      setRev: (rev) => set({ rev }),
      lastAction: null,
      setLastAction: (lastAction) => set({ lastAction }),
      dirty: false,
      setDirty: (dirty) => set({ dirty }),
      tabId,
      remoteUpdate: false,
      setRemoteUpdate: (remoteUpdate) => set({ remoteUpdate }),
    }),
    { name: "ezvault-domain" },
  ),
);
