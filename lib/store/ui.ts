// SPDX-License-Identifier: MIT
// UI store — interaction state only. Per architecture §9: persist covers
// theme + pane widths ONLY. No form state, no server cache here.

"use client";

import { create } from "zustand";
import { devtools, persist } from "zustand/middleware";

export type ViewMode = "grid" | "table";
export type Density = "comfortable" | "compact";
export type SortKey = "name" | "dateAdded" | "dateModified" | "photoCount";
export type InspectorTab = "viewer" | "metadata" | "notes" | "selections";
export type LibraryFilter = "all" | "unfiled" | "trash";

export interface Toast {
  id: string;
  message: string;
  kind?: "info" | "error";
  actionLabel?: string;
  onAction?: () => void;
}

interface UiState {
  // --- persisted ---
  theme: "light" | "dark";
  sidebarWidth: number;
  inspectorWidth: number;
  setTheme: (t: "light" | "dark") => void;
  setSidebarWidth: (n: number) => void;
  setInspectorWidth: (n: number) => void;

  // --- view ---
  view: ViewMode;
  density: Density;
  sort: SortKey;
  viewerZoomPct: number;
  setView: (v: ViewMode) => void;
  setDensity: (d: Density) => void;
  setSort: (s: SortKey) => void;
  setViewerZoom: (n: number) => void;

  // --- navigation / filters ---
  libraryFilter: LibraryFilter;
  activeListId: string | null;
  activeTagIds: string[];
  searchActive: boolean;
  searchBox: string;
  activeQuery: string;
  searchScope: string;
  setLibraryFilter: (f: LibraryFilter) => void;
  setActiveListId: (id: string | null) => void;
  toggleTag: (id: string, additive: boolean) => void;
  clearTagFilter: () => void;
  setSearchActive: (b: boolean) => void;
  setSearchBox: (q: string) => void;
  submitSearch: () => void;
  clearSearch: () => void;
  setSearchScope: (s: string) => void;

  // --- selection context ---
  selectedIds: string[];
  activeItemId: string | null;
  activePhotoId: string | null;
  activeSelectionId: string | null;
  inspectorTab: InspectorTab;
  setSelectedIds: (ids: string[]) => void;
  toggleSelect: (id: string) => void;
  selectRange: (ids: string[], anchor: string, id: string) => void;
  setActiveItemId: (id: string | null) => void;
  setActivePhotoId: (id: string | null) => void;
  setActiveSelectionId: (id: string | null) => void;
  setInspectorTab: (t: InspectorTab) => void;
  clearInspectorContext: () => void;

  // --- dialogs / drawers ---
  importOpen: boolean;
  shortcutsOpen: boolean;
  tpyOpen: boolean;
  retentionOpen: boolean;
  aboutOpen: boolean;
  settingsOpen: boolean;
  templatesOpen: boolean;
  mobileNav: "library" | "lists" | "tags" | "search" | "more";
  sidebarOpen: boolean; // tablet drawer
  inspectorOpen: boolean; // tablet drawer
  setImportOpen: (b: boolean) => void;
  setShortcutsOpen: (b: boolean) => void;
  setTpyOpen: (b: boolean) => void;
  setRetentionOpen: (b: boolean) => void;
  setAboutOpen: (b: boolean) => void;
  setSettingsOpen: (b: boolean) => void;
  setTemplatesOpen: (b: boolean) => void;
  setMobileNav: (n: UiState["mobileNav"]) => void;
  setSidebarOpen: (b: boolean) => void;
  setInspectorOpen: (b: boolean) => void;

  // --- toasts ---
  toasts: Toast[];
  pushToast: (t: Omit<Toast, "id">) => void;
  dismissToast: (id: string) => void;

  // --- import staging ---
  pendingFiles: File[];
  setPendingFiles: (f: File[]) => void;
}

let toastSeq = 0;

export const useUiStore = create<UiState>()(
  devtools(
    persist(
      (set) => ({
        theme: "light",
        sidebarWidth: 280,
        inspectorWidth: 420,
        setTheme: (theme) => {
          set({ theme });
          if (typeof document !== "undefined") {
            document.documentElement.setAttribute("data-theme", theme);
          }
        },
        setSidebarWidth: (sidebarWidth) =>
          set({ sidebarWidth: Math.min(360, Math.max(220, sidebarWidth)) }),
        setInspectorWidth: (inspectorWidth) =>
          set({ inspectorWidth: Math.min(640, Math.max(340, inspectorWidth)) }),

        view: "grid",
        density: "comfortable",
        sort: "dateAdded",
        viewerZoomPct: 100,
        setView: (view) => set({ view }),
        setDensity: (density) => set({ density }),
        setSort: (sort) => set({ sort }),
        setViewerZoom: (viewerZoomPct) => set({ viewerZoomPct }),

        libraryFilter: "all",
        activeListId: null,
        activeTagIds: [],
        searchActive: false,
        searchBox: "",
        activeQuery: "",
        searchScope: "all",
        setLibraryFilter: (libraryFilter) =>
          set({ libraryFilter, activeListId: null, activeTagIds: [], searchActive: false, activeQuery: "" }),
        setActiveListId: (activeListId) =>
          set({ activeListId, libraryFilter: "all", activeTagIds: [], searchActive: false, activeQuery: "" }),
        toggleTag: (id, additive) =>
          set((s) => {
            const has = s.activeTagIds.includes(id);
            const activeTagIds = additive
              ? has
                ? s.activeTagIds.filter((t) => t !== id)
                : [...s.activeTagIds, id]
              : has && s.activeTagIds.length === 1
                ? []
                : [id];
            return { activeTagIds, libraryFilter: "all", activeListId: null, searchActive: false, activeQuery: "" };
          }),
        clearTagFilter: () => set({ activeTagIds: [] }),
        setSearchActive: (searchActive) =>
          set(
            searchActive
              ? { searchActive, libraryFilter: "all", activeListId: null, activeTagIds: [] }
              : { searchActive, activeQuery: "" },
          ),
        setSearchBox: (searchBox) => set({ searchBox }),
        submitSearch: () =>
          set((s) => {
            const q = s.searchBox.trim();
            return q
              ? { searchActive: true, activeQuery: q, libraryFilter: "all", activeListId: null, activeTagIds: [] }
              : { searchActive: false, activeQuery: "" };
          }),
        clearSearch: () => set({ searchActive: false, activeQuery: "", searchBox: "" }),
        setSearchScope: (searchScope) => set({ searchScope }),

        selectedIds: [],
        activeItemId: null,
        activePhotoId: null,
        activeSelectionId: null,
        inspectorTab: "viewer",
        setSelectedIds: (selectedIds) => set({ selectedIds }),
        toggleSelect: (id) =>
          set((s) => ({
            selectedIds: s.selectedIds.includes(id)
              ? s.selectedIds.filter((x) => x !== id)
              : [...s.selectedIds, id],
          })),
        selectRange: (ids, anchor, id) =>
          set((s) => {
            const a = ids.indexOf(anchor);
            const b = ids.indexOf(id);
            if (a === -1 || b === -1) return { selectedIds: [...s.selectedIds, id] };
            const [lo, hi] = a < b ? [a, b] : [b, a];
            const range = new Set(ids.slice(lo, hi + 1));
            return { selectedIds: Array.from(new Set([...s.selectedIds, ...range])) };
          }),
        setActiveItemId: (activeItemId) =>
          set({ activeItemId, activePhotoId: null, activeSelectionId: null }),
        setActivePhotoId: (activePhotoId) => set({ activePhotoId, activeSelectionId: null }),
        setActiveSelectionId: (activeSelectionId) => set({ activeSelectionId }),
        setInspectorTab: (inspectorTab) => set({ inspectorTab }),
        clearInspectorContext: () =>
          set({ activeItemId: null, activePhotoId: null, activeSelectionId: null, selectedIds: [] }),

        importOpen: false,
        shortcutsOpen: false,
        tpyOpen: false,
        retentionOpen: false,
        aboutOpen: false,
        settingsOpen: false,
        templatesOpen: false,
        mobileNav: "library",
        sidebarOpen: false,
        inspectorOpen: false,
        setImportOpen: (importOpen) => set({ importOpen }),
        setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
        setTpyOpen: (tpyOpen) => set({ tpyOpen }),
        setRetentionOpen: (retentionOpen) => set({ retentionOpen }),
        setAboutOpen: (aboutOpen) => set({ aboutOpen }),
        setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
        setTemplatesOpen: (templatesOpen) => set({ templatesOpen }),
        setMobileNav: (mobileNav) => set({ mobileNav }),
        setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
        setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),

        toasts: [],
        pushToast: (t) =>
          set((s) => ({
            toasts: [...s.toasts.slice(-3), { ...t, id: `toast-${++toastSeq}` }],
          })),
        dismissToast: (id) =>
          set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

        pendingFiles: [],
        setPendingFiles: (pendingFiles) => set({ pendingFiles }),
      }),
      {
        name: "ezvault-ui",
        partialize: (s) => ({
          theme: s.theme,
          sidebarWidth: s.sidebarWidth,
          inspectorWidth: s.inspectorWidth,
        }),
      },
    ),
    { name: "ezvault-ui" },
  ),
);
