// SPDX-License-Identifier: MIT
// Command palette (D-INTa): cmdk + fuse.js.
//
// Mounted once in the workspace shell next to TopBar. The 23.9 KB
// (cmdk+fuse) chunk loads on first mod+k via next/dynamic(ssr:false) and
// stays mounted. Two modes:
//   - Actions: every registry entry with a real run, ranked locally by
//     fuse.js over the translated labels. Dispatches through the entry's
//     run (undoable ops go through lib/commands/bus, preserving undo/redo).
//   - Search: the server FTS stays the search authority (never client-rank
//     the server result set); fuse.js ranks only the client-side
//     recent-item quick-jump list.

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Command } from "cmdk";
import Fuse from "fuse.js";
import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import {
  HOTKEY_REGISTRY,
  type HotkeyContext,
  type HotkeyEntry,
} from "@/lib/shortcuts/registry";
import { key } from "@/lib/api/hooks";
import { get } from "@/lib/api/client";
import { useOffline } from "@/lib/pwa/useConnectivity";
import type { SearchHit, SearchResponse } from "@/lib/types";

const RECENT_KEY = (projectId: string) => `ezvault:recent-items:${projectId}:v1`;
const MAX_RECENT = 8;
const MAX_SEARCH_HITS = 8;

interface RecentItem {
  id: string;
  title: string;
}

interface ResolvedHit {
  itemId: string;
  title: string;
  kind: string;
}

/** Resolve a search hit to its parent item (same logic as SearchResults). */
async function resolveHit(
  projectId: string,
  hit: SearchHit,
): Promise<ResolvedHit | null> {
  try {
    let itemId: string | null = null;
    if (hit.subject_kind === "item") {
      itemId = hit.subject_id;
    } else if (hit.subject_kind === "photo") {
      const photo = await get<{ item_id: string }>(
        `/api/projects/${projectId}/photos/${hit.subject_id}`,
      );
      itemId = photo.item_id;
    } else {
      const sel = await get<{ photo_id: string }>(
        `/api/projects/${projectId}/selections/${hit.subject_id}`,
      );
      const photo = await get<{ item_id: string }>(
        `/api/projects/${projectId}/photos/${sel.photo_id}`,
      );
      itemId = photo.item_id;
    }
    if (!itemId) return null;
    const item = await get<{ title?: string }>(
      `/api/projects/${projectId}/items/${itemId}`,
    );
    return { itemId, title: item.title || "Untitled", kind: hit.subject_kind };
  } catch {
    return null;
  }
}

export default function CommandPalette({
  projectId,
  opCtx,
}: {
  projectId: string;
  opCtx: HotkeyContext["ctx"];
}) {
  const t = useTranslations("palette");
  const ts = useTranslations("shortcuts");
  const tse = useTranslations("search");
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const offline = useOffline();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ResolvedHit[]>([]);
  const [recent, setRecent] = useState<RecentItem[]>([]);
  const resolveCache = useRef(new Map<string, ResolvedHit>());

  const hotkeyCtx: HotkeyContext = useMemo(
    () => ({ projectId, ctx: opCtx }),
    [projectId, opCtx],
  );

  // Fresh state on every open; load recent quick-jump list.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setHits([]);
    try {
      const raw = localStorage.getItem(RECENT_KEY(projectId));
      setRecent(raw ? (JSON.parse(raw) as RecentItem[]) : []);
    } catch {
      setRecent([]);
    }
  }, [open, projectId]);

  // Actions: registry entries with a real global run, fuse-ranked locally.
  const actions = useMemo(
    () =>
      HOTKEY_REGISTRY.filter((e) => e.scope === "global" && e.run).map(
        (entry) => ({ entry, label: ts(entry.labelKey) }),
      ),
    [ts],
  );
  const rankedActions = useMemo(() => {
    const q = query.trim();
    if (!q) return actions;
    const fuse = new Fuse(actions, { keys: ["label"], threshold: 0.4 });
    return fuse.search(q).map((r) => r.item);
  }, [query, actions]);

  // Recent quick-jump: fuse-ranked locally (never the server result set).
  const rankedRecent = useMemo(() => {
    const q = query.trim();
    if (!q) return recent;
    const fuse = new Fuse(recent, { keys: ["title"], threshold: 0.4 });
    return fuse.search(q).map((r) => r.item);
  }, [query, recent]);

  // Search mode: server FTS is the authority (debounced, scope=all).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const id = setTimeout(async () => {
      try {
        const res = await get<SearchResponse>(key.search(projectId, q, "all"));
        const list = (res?.hits ?? []).slice(0, MAX_SEARCH_HITS);
        const resolved: ResolvedHit[] = [];
        for (const hit of list) {
          const cacheKey = `${hit.subject_kind}:${hit.subject_id}`;
          const cached = resolveCache.current.get(cacheKey);
          if (cached) {
            resolved.push(cached);
            continue;
          }
          const r = await resolveHit(projectId, hit);
          if (cancelled) return;
          if (r) {
            resolveCache.current.set(cacheKey, r);
            resolved.push(r);
          }
        }
        if (!cancelled) setHits(resolved);
      } catch {
        if (!cancelled) setHits([]);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [query, projectId]);

  function recordRecent(id: string, title: string) {
    const next = [{ id, title }, ...recent.filter((r) => r.id !== id)].slice(
      0,
      MAX_RECENT,
    );
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY(projectId), JSON.stringify(next));
    } catch {
      /* private mode */
    }
  }

  /** Display label for a resolved hit, reusing the search.* keys. */
  function hitLabel(h: ResolvedHit): string {
    if (h.kind === "photo") return tse("hitPhotoIn", { title: h.title });
    if (h.kind === "selection")
      return tse("hitSelectionIn", { title: h.title });
    return h.title;
  }

  function jumpToItem(id: string, title: string) {
    const ui = useUiStore.getState();
    ui.setSelectedIds([id]);
    ui.setActiveItemId(id);
    ui.setSearchActive(false);
    recordRecent(id, title);
    setOpen(false);
  }

  function runAction(entry: HotkeyEntry) {
    setOpen(false);
    void entry.run?.(hotkeyCtx);
  }

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label={t("title")}
      shouldFilter={false}
      className="ez-palette"
    >
      <Command.Input
        value={query}
        onValueChange={setQuery}
        placeholder={t("placeholder")}
        className="ez-palette-input"
      />
      <Command.List className="ez-palette-list">
        {offline && query.trim().length >= 2 ? (
          <div className="ez-palette-empty" role="note">
            {t("searchUnavailableOffline")}
          </div>
        ) : null}
        <Command.Empty>
          {/* E-SEC-21: offline, server search is "unavailable" — never
              an empty result set. Recents (localStorage) still work and
              are labelled as on-device below. */}
          <span className="ez-palette-empty">
            {offline && query.trim().length >= 2
              ? t("searchUnavailableOffline")
              : t("noResults")}
          </span>
        </Command.Empty>
        {rankedActions.length > 0 && (
          <Command.Group heading={t("actions")}>
            {rankedActions.map(({ entry, label }) => (
              <Command.Item
                key={entry.id}
                value={entry.id}
                onSelect={() => runAction(entry)}
                className="ez-palette-item"
              >
                <span>{label}</span>
                <span className="ez-kbd">{entry.hint}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {rankedRecent.length > 0 && (
          <Command.Group heading={offline ? t("recentOfflineNote") : t("recent")}>
            {rankedRecent.map((r) => (
              <Command.Item
                key={`recent-${r.id}`}
                value={`recent-${r.id}`}
                onSelect={() => jumpToItem(r.id, r.title)}
                className="ez-palette-item"
              >
                <span>{r.title}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        {hits.length > 0 && (
          <Command.Group heading={t("searchResults")}>
            {hits.map((h) => (
              <Command.Item
                key={`hit-${h.itemId}-${h.kind}`}
                value={`hit-${h.itemId}-${h.kind}`}
                onSelect={() => jumpToItem(h.itemId, h.title)}
                className="ez-palette-item"
              >
                <span>{hitLabel(h)}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command.Dialog>
  );
}
