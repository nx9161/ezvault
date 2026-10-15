// SPDX-License-Identifier: MIT
// Center panel: header (breadcrumb, count, sort, density), virtualized
// item grid + table (roving tabindex), selection toolbar, search results.
// Design §1.3; virtualization per ADR-2.18 (@tanstack/react-virtual).

"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslations } from "next-intl";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useUiStore } from "@/lib/store/ui";
import { useDomainStore } from "@/lib/store/domain";
import {
  useItems,
  useSearch,
  useTags,
  useLists,
  thumbUrl,
} from "@/lib/api/hooks";
import { get, post } from "@/lib/api/client";
import {
  runCommand,
  trashSubjectsOp,
  mergeItemsOp,
  attachTagsOp,
  type OpContext,
} from "@/lib/commands/ops";
import { useOpContext } from "@/components/sidebar/Sidebar";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/Menu";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ErrorCard, SkeletonCards, SkeletonRows } from "@/components/ui/Feedback";
import { renderSnippet } from "@/lib/search-snippet";
import type { Item, Tag } from "@/lib/api/types";
import TrashView from "@/components/trash/TrashView";

function tagListOf(data: { items: Tag[]; total: number } | Tag[] | undefined): Tag[] {
  if (!data) return [];
  return Array.isArray(data) ? data : (data.items ?? []);
}

const SORT_MAP = {
  name: "name",
  dateAdded: "created_at",
  dateModified: "updated_at",
  photoCount: "photo_count",
} as const;

function useItemParams(): string {
  const libraryFilter = useUiStore((s) => s.libraryFilter);
  const activeListId = useUiStore((s) => s.activeListId);
  const activeTagIds = useUiStore((s) => s.activeTagIds);
  const sort = useUiStore((s) => s.sort);
  return useMemo(() => {
    const p = new URLSearchParams();
    if (libraryFilter === "unfiled") p.set("unfiled", "1");
    if (activeListId) p.set("list", activeListId);
    for (const id of activeTagIds) p.append("tag", id); // AND semantics
    p.set("sort", SORT_MAP[sort]);
    p.set("limit", "2000");
    return p.toString();
  }, [libraryFilter, activeListId, activeTagIds, sort]);
}

function itemAlt(t: (k: string, v?: Record<string, string | number>) => string, item: Item) {
  return t("coverAlt", { title: item.title || item.id });
}

function ItemCard({
  item,
  projectId,
  selected,
  tabIndex,
  onFocus,
  registerRef,
  onSelectClick,
}: {
  item: Item;
  projectId: string;
  selected: boolean;
  tabIndex: number;
  onFocus: () => void;
  registerRef: (id: string, el: HTMLDivElement | null) => void;
  onSelectClick: (e: React.MouseEvent, item: Item) => void;
}) {
  const t = useTranslations("center");
  const toggleSelect = useUiStore((s) => s.toggleSelect);
  const setActiveItemId = useUiStore((s) => s.setActiveItemId);
  const setInspectorOpen = useUiStore((s) => s.setInspectorOpen);
  const selectedIds = useUiStore((s) => s.selectedIds);
  const thumb = item.cover_photo_id
    ? thumbUrl(projectId, item.cover_photo_id)
    : null;

  return (
    <div
      ref={(el) => registerRef(item.id, el)}
      role="option"
      aria-selected={selected}
      tabIndex={tabIndex}
      className="ez-card"
      onFocus={onFocus}
      onClick={(e) => {
        onSelectClick(e, item);
        setActiveItemId(item.id);
      }}
      onDoubleClick={() => {
        setActiveItemId(item.id);
        setInspectorOpen(true);
      }}
      onKeyDown={(e) => {
        if (e.key === " " && !e.repeat) {
          e.preventDefault();
          toggleSelect(item.id);
        } else if (e.key === "Enter") {
          setActiveItemId(item.id);
          setInspectorOpen(true);
        }
      }}
      draggable
      onDragStart={(e) => {
        const ids = selected ? selectedIds : [item.id];
        e.dataTransfer.setData("application/x-ezvault-items", JSON.stringify(ids));
        e.dataTransfer.effectAllowed = "move";
      }}
      aria-label={`${item.title} — ${t("photosCount", { count: item.photo_count ?? 0 })}`}
    >
      <span className="ez-card-check" aria-hidden="true">
        ✓
      </span>
      <span className="ez-card-badges" aria-hidden="true">
        {item.selection_count > 0 ? (
          <span className="ez-mini-badge">◈{item.selection_count}</span>
        ) : null}
        {item.note_count > 0 ? (
          <span className="ez-mini-badge">✎{item.note_count}</span>
        ) : null}
      </span>
      {thumb ? (
        <img
          className="ez-card-cover"
          src={thumb}
          alt={itemAlt(t, item)}
          loading="lazy"
          decoding="async"
          draggable={false}
        />
      ) : (
        <span className="ez-card-cover" aria-hidden="true" />
      )}
      <span className="ez-card-body" style={{ display: "block" }}>
        <span className="ez-card-title" style={{ display: "block" }}>
          {item.title || <em>Untitled</em>}
        </span>
        <span className="ez-card-meta">
          <span>{t("photosCount", { count: item.photo_count ?? 0 })}</span>
        </span>
        {(item.tags?.length ?? 0) > 0 ? (
          <span className="ez-tag-dots" aria-hidden="true" title={item.tags!.join(", ")}>
            {item.tags!.slice(0, 5).map((name) => (
              <span key={name} className="ez-color-dot" style={{ background: "var(--accent)" }} />
            ))}
            {item.tags!.length > 5 ? (
              <span className="ez-more">+{item.tags!.length - 5}</span>
            ) : null}
          </span>
        ) : null}
      </span>
    </div>
  );
}

function ItemGrid({
  items,
  projectId,
}: {
  items: Item[];
  projectId: string;
}) {
  const density = useUiStore((s) => s.density);
  const selectedIds = useUiStore((s) => s.selectedIds);
  const setSelectedIds = useUiStore((s) => s.setSelectedIds);
  const toggleSelect = useUiStore((s) => s.toggleSelect);
  const selectRange = useUiStore((s) => s.selectRange);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const parentRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const refs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    const el = parentRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const cardMin = density === "compact" ? 104 : 160;
  const gap = density === "compact" ? 8 : 12;
  const lanes = Math.max(1, Math.floor((width + gap) / (cardMin + gap)));
  const cardW = width > 0 ? (width - gap * (lanes - 1)) / lanes : cardMin;
  // Deterministic card height: 4:3 cover + body (title/meta/dots).
  const cardH = cardW * 0.75 + (density === "compact" ? 44 : 62);

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => cardH + gap,
    lanes,
    overscan: 4,
  });

  const registerRef = useCallback((id: string, el: HTMLDivElement | null) => {
    if (el) refs.current.set(id, el);
    else refs.current.delete(id);
  }, []);
  const anchorRef = useRef<string | null>(null);

  /** Click selection: plain = single, Ctrl/Cmd = toggle, Shift = range. */
  function onSelectClick(e: React.MouseEvent, item: Item) {
    if (e.shiftKey && anchorRef.current) {
      selectRange(
        items.map((it) => it.id),
        anchorRef.current,
        item.id,
      );
    } else if (e.metaKey || e.ctrlKey) {
      anchorRef.current = item.id;
      toggleSelect(item.id);
    } else {
      anchorRef.current = item.id;
      setSelectedIds([item.id]);
    }
  }

  // Roving tabindex: arrows move across the grid.
  function onGridKeyDown(e: React.KeyboardEvent) {
    const target = e.target as HTMLElement;
    const id = target.closest("[role=option]")?.getAttribute("data-item-id");
    const idx = items.findIndex((it) => it.id === (id ?? focusId));
    if (idx === -1) return;
    let next = -1;
    if (e.key === "ArrowRight") next = Math.min(items.length - 1, idx + 1);
    else if (e.key === "ArrowLeft") next = Math.max(0, idx - 1);
    else if (e.key === "ArrowDown") next = Math.min(items.length - 1, idx + lanes);
    else if (e.key === "ArrowUp") next = Math.max(0, idx - lanes);
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      setSelectedIds(items.map((it) => it.id));
      return;
    } else return;
    e.preventDefault();
    const nextItem = items[next];
    setFocusId(nextItem.id);
    virtualizer.scrollToIndex(next, { align: "auto" });
    requestAnimationFrame(() => refs.current.get(nextItem.id)?.focus());
  }

  const virtualItems = virtualizer.getVirtualItems();

  return (
    <div
      ref={parentRef}
      id="ez-grid"
      className="ez-grid-scroll"
      onKeyDown={onGridKeyDown}
      role="listbox"
      aria-multiselectable="true"
      aria-label="items"
      tabIndex={-1}
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
        {virtualItems.map((vi) => {
          const item = items[vi.index];
          if (!item) return null;
          return (
            <div
              key={item.id}
              data-item-id={item.id}
              style={{
                position: "absolute",
                top: 0,
                left: `${(vi.lane * 100) / lanes}%`,
                width: `${100 / lanes}%`,
                paddingRight: gap,
                paddingBottom: gap,
                transform: `translateY(${vi.start}px)`,
              }}
            >
              <ItemCard
                item={item}
                projectId={projectId}
                selected={selectedSet.has(item.id)}
                tabIndex={focusId === item.id || (focusId === null && vi.index === 0) ? 0 : -1}
                onFocus={() => setFocusId(item.id)}
                registerRef={registerRef}
                onSelectClick={onSelectClick}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const TABLE_COLS = "56px minmax(140px,1fr) 70px minmax(100px,1fr) 100px 100px";

function ItemTable({ items, projectId }: { items: Item[]; projectId: string }) {
  const t = useTranslations("center");
  const density = useUiStore((s) => s.density);
  const selectedIds = useUiStore((s) => s.selectedIds);
  const setSelectedIds = useUiStore((s) => s.setSelectedIds);
  const toggleSelect = useUiStore((s) => s.toggleSelect);
  const setActiveItemId = useUiStore((s) => s.setActiveItemId);
  const parentRef = useRef<HTMLDivElement>(null);
  const rowH = density === "compact" ? 44 : 60;

  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowH,
    overscan: 10,
  });

  const headerCell: React.CSSProperties = {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: ".06em",
    color: "var(--ink-2)",
    padding: "8px 12px",
    textAlign: "left",
    fontWeight: 600,
  };

  return (
    <div ref={parentRef} className="ez-table-wrap" id="ez-grid" tabIndex={-1} role="grid" aria-label="items">
      <div
        role="row"
        style={{
          display: "grid",
          gridTemplateColumns: TABLE_COLS,
          position: "sticky",
          top: 0,
          background: "var(--surface-2)",
          zIndex: 1,
          borderBottom: "1px solid var(--border)",
        }}
      >
        <span role="columnheader" style={headerCell}>{t("colCover")}</span>
        <span role="columnheader" style={headerCell}>{t("colTitle")}</span>
        <span role="columnheader" style={headerCell}>{t("colPhotos")}</span>
        <span role="columnheader" style={headerCell}>{t("colTags")}</span>
        <span role="columnheader" style={headerCell}>{t("colAdded")}</span>
        <span role="columnheader" style={headerCell}>{t("colModified")}</span>
      </div>
      <div style={{ position: "relative", height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((vi) => {
          const item = items[vi.index];
          if (!item) return null;
          const selected = selectedIds.includes(item.id);
          return (
            <div
              key={item.id}
              role="row"
              aria-selected={selected}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) toggleSelect(item.id);
                else setSelectedIds([item.id]);
                setActiveItemId(item.id);
              }}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${vi.start}px)`,
                height: rowH,
                display: "grid",
                gridTemplateColumns: TABLE_COLS,
                alignItems: "center",
                borderBottom: "1px solid var(--border)",
                background: selected ? "var(--accent-soft)" : undefined,
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              <span role="gridcell" style={{ padding: "4px 12px" }}>
                {item.cover_photo_id ? (
                  <img
                    className="ez-row-thumb"
                    src={thumbUrl(projectId, item.cover_photo_id)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                  />
                ) : null}
              </span>
              <span role="gridcell" style={{ padding: "4px 12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {item.title || <em>Untitled</em>}
              </span>
              <span role="gridcell" style={{ padding: "4px 12px", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {item.photo_count ?? 0}
              </span>
              <span role="gridcell" style={{ padding: "4px 12px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--ink-2)" }}>
                {(item.tags ?? []).join(", ") || "—"}
              </span>
              <span role="gridcell" style={{ padding: "4px 12px", fontSize: 12, color: "var(--ink-2)" }}>
                {new Date(item.created_at).toLocaleDateString()}
              </span>
              <span role="gridcell" style={{ padding: "4px 12px", fontSize: 12, color: "var(--ink-2)" }}>
                {new Date(item.updated_at).toLocaleDateString()}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SelectionToolbar({
  projectId,
  items,
  ctx,
}: {
  projectId: string;
  items: Item[];
  ctx: OpContext;
}) {
  const t = useTranslations("center");
  const td = useTranslations("dialogs");
  const selectedIds = useUiStore((s) => s.selectedIds);
  const setSelectedIds = useUiStore((s) => s.setSelectedIds);
  const setInspectorTab = useUiStore((s) => s.setInspectorTab);
  const setInspectorOpen = useUiStore((s) => s.setInspectorOpen);
  const { data: tagsData } = useTags(projectId);
  const { data: lists } = useLists(projectId);
  const tags = tagListOf(tagsData);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; kind: "tags" | "lists" } | null>(null);
  const [mergeOpen, setMergeOpen] = useState(false);

  const selected = items.filter((i) => selectedIds.includes(i.id));

  async function trashSelected() {
    await runCommand(ctx, trashSubjectsOp(ctx, selectedIds, "user", t("trashItems")), ["items", "trash", "meter"]);
    setSelectedIds([]);
  }

  return (
    <div className="ez-selection-bar" role="toolbar" aria-label="selection">
      <strong>
        {t("itemsCount", { count: selectedIds.length })}
      </strong>
      <button type="button" className="ez-btn ez-btn--sm" onClick={() => setSelectedIds([])}>
        {t("deselect")}
      </button>
      {selectedIds.length >= 2 ? (
        <button type="button" className="ez-btn ez-btn--sm" onClick={() => setMergeOpen(true)} title={t("mergeHint")}>
          {t("merge")}
        </button>
      ) : null}
      <button
        type="button"
        className="ez-btn ez-btn--sm"
        onClick={() => {
          setInspectorTab("metadata");
          setInspectorOpen(true);
        }}
      >
        {t("bulkEdit")}
      </button>
      <button
        type="button"
        className="ez-btn ez-btn--sm"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenuAt({ x: r.left, y: r.bottom + 6, kind: "tags" });
        }}
      >
        {t("addTags")}
      </button>
      <button
        type="button"
        className="ez-btn ez-btn--sm"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenuAt({ x: r.left, y: r.bottom + 6, kind: "lists" });
        }}
      >
        {t("moveToList")}
      </button>
      <button
        type="button"
        className="ez-btn ez-btn--sm ez-btn--danger"
        onClick={trashSelected}
        title={t("trashHint")}
      >
        {t("trashItems")}
      </button>
      {menuAt?.kind === "tags" ? (
        <Menu anchor={menuAt} onClose={() => setMenuAt(null)} label={td("tagPickerTitle")}>
          <MenuLabel>{td("tagPickerTitle")}</MenuLabel>
          {(tags ?? []).map((tag: Tag) => (
            <MenuItem
              key={tag.id}
              onSelect={async () => {
                await runCommand(ctx, attachTagsOp(ctx, tag.id, selectedIds, true), ["items", "tags"]);
              }}
            >
              {tag.name}
            </MenuItem>
          ))}
        </Menu>
      ) : null}
      {menuAt?.kind === "lists" ? (
        <Menu anchor={menuAt} onClose={() => setMenuAt(null)} label={td("listPickerTitle")}>
          <MenuLabel>{td("listPickerTitle")}</MenuLabel>
          {(lists ?? []).map((l) => (
            <MenuItem
              key={l.id}
              onSelect={async () => {
                await post(`/api/projects/${projectId}/items/bulk`, {
                  item_ids: selectedIds,
                  ops: [{ op: "move_to_list", list_id: l.id }],
                });
                const { refreshAndBroadcast } = await import("@/lib/commands/ops");
                await refreshAndBroadcast(ctx, ["items", "lists"]);
              }}
            >
              {l.name}
            </MenuItem>
          ))}
        </Menu>
      ) : null}
      {mergeOpen ? (
        <ConfirmDialog
          title={t("mergeTitle", { count: selectedIds.length })}
          body={t("mergeBody", { title: selected[0]?.title ?? "" })}
          confirmLabel={t("merge")}
          onCancel={() => setMergeOpen(false)}
          onConfirm={async () => {
            setMergeOpen(false);
            const [target, ...rest] = selectedIds;
            await runCommand(ctx, mergeItemsOp(ctx, selectedIds, target), ["items", "trash", "meter"]);
            setSelectedIds([target]);
            void rest;
          }}
        />
      ) : null}
    </div>
  );
}

function SearchResults({ projectId }: { projectId: string }) {
  const t = useTranslations("search");
  const tc = useTranslations("center");
  const activeQuery = useUiStore((s) => s.activeQuery);
  const searchScope = useUiStore((s) => s.searchScope);
  const setSearchScope = useUiStore((s) => s.setSearchScope);
  const clearSearch = useUiStore((s) => s.clearSearch);
  const setActiveItemId = useUiStore((s) => s.setActiveItemId);
  const setSelectedIds = useUiStore((s) => s.setSelectedIds);
  const setSearchActive = useUiStore((s) => s.setSearchActive);
  const { data, error, isLoading } = useSearch(projectId, activeQuery, searchScope);

  const results = data?.hits ?? [];

  /** Resolve a non-item hit to its parent item id (lazy, one fetch). */
  async function resolveHitItemId(hit: { subject_id: string; subject_kind: string }): Promise<string | null> {
    try {
      if (hit.subject_kind === "item") return hit.subject_id;
      if (hit.subject_kind === "photo") {
        const photo = await get<{ item_id: string }>(`/api/projects/${projectId}/photos/${hit.subject_id}`);
        return photo.item_id;
      }
      const sel = await get<{ photo_id: string }>(`/api/projects/${projectId}/selections/${hit.subject_id}`);
      const photo = await get<{ item_id: string }>(`/api/projects/${projectId}/photos/${sel.photo_id}`);
      return photo.item_id;
    } catch {
      return null;
    }
  }

  return (
    <div className="ez-grid-scroll" id="ez-grid" tabIndex={-1} aria-label={t("resultsFor", { query: activeQuery })}>
      <div className="ez-center-head" style={{ padding: "0 0 12px", border: 0 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>{t("resultsFor", { query: activeQuery })}</h2>
        <span className="ez-spacer" />
        <label style={{ fontSize: 12, color: "var(--ink-2)" }}>
          {t("scope")}{" "}
          <select
            className="ez-select"
            value={searchScope}
            onChange={(e) => setSearchScope(e.target.value)}
            aria-label={t("scope")}
          >
            <option value="all">{t("scopeAll")}</option>
            <option value="metadata">{t("scopeMetadata")}</option>
            <option value="notes">{t("scopeNotes")}</option>
            <option value="tags">{t("scopeTags")}</option>
          </select>
        </label>
        <button type="button" className="ez-btn ez-btn--sm" onClick={clearSearch}>
          {t("clearSearch")}
        </button>
      </div>
      <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "0 0 12px" }}>{t("andHint")}</p>
      {isLoading ? (
        <div className="ez-grid-scroll"><SkeletonRows rows={6} /></div>
      ) : error ? (
        <ErrorCard what={t("resultsFor", { query: activeQuery })} />
      ) : results.length === 0 ? (
        <div className="ez-state">
          <h2>{t("noResults", { query: activeQuery })}</h2>
          <p>{t("noResultsBody")}</p>
        </div>
      ) : (
        results.map((r) => (
          <button
            key={`${r.subject_kind}-${r.subject_id}`}
            type="button"
            className="ez-result-row"
            onClick={async () => {
              const itemId = await resolveHitItemId(r);
              if (itemId) {
                setSelectedIds([itemId]);
                setActiveItemId(itemId);
              }
              setSearchActive(false);
            }}
          >
            <span className="ez-result-scope">{r.subject_kind}</span>
            <h3>
              {r.subject_kind} {r.subject_id.slice(0, 8)}
            </h3>
            <span className="ez-result-snippet">{renderSnippet(r.snippet)}</span>
          </button>
        ))
      )}
    </div>
  );
}

export default function CenterPanel({ projectId }: { projectId: string }) {
  const t = useTranslations("center");
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const density = useUiStore((s) => s.density);
  const setDensity = useUiStore((s) => s.setDensity);
  const sort = useUiStore((s) => s.sort);
  const setSort = useUiStore((s) => s.setSort);
  const libraryFilter = useUiStore((s) => s.libraryFilter);
  const activeListId = useUiStore((s) => s.activeListId);
  const activeTagIds = useUiStore((s) => s.activeTagIds);
  const searchActive = useUiStore((s) => s.searchActive);
  const selectedIds = useUiStore((s) => s.selectedIds);
  const setImportOpen = useUiStore((s) => s.setImportOpen);
  const setTpyOpen = useUiStore((s) => s.setTpyOpen);
  const { data: lists } = useLists(projectId);
  const { data: tagsData } = useTags(projectId);
  const tags = tagListOf(tagsData);

  const params = useItemParams();
  const { data, error, isLoading, mutate } = useItems(
    projectId,
    searchActive || libraryFilter === "trash" ? "" : params,
  );
  const items = useMemo(
    () => (searchActive || libraryFilter === "trash" ? [] : (data?.items ?? [])),
    [data, searchActive, libraryFilter],
  );
  const ctx = useOpContext(projectId);

  const breadcrumb = useMemo(() => {
    if (searchActive) return t("breadcrumbSearch");
    if (libraryFilter === "trash") return t("breadcrumbTrash");
    if (libraryFilter === "unfiled") return t("breadcrumbUnfiled");
    if (activeListId) {
      const found = (lists ?? []).find((l) => l.id === activeListId);
      return found?.name ?? t("breadcrumbAll");
    }
    if (activeTagIds.length > 0) {
      const names = (tags ?? [])
        .filter((g) => activeTagIds.includes(g.id))
        .map((g) => g.name);
      return names.join(" + ") || t("breadcrumbAll");
    }
    return t("breadcrumbAll");
  }, [searchActive, libraryFilter, activeListId, activeTagIds, lists, tags, t]);

  if (libraryFilter === "trash") {
    return (
      <section className="ez-center" aria-label={t("breadcrumbTrash")}>
        <TrashView projectId={projectId} />
      </section>
    );
  }

  if (searchActive) {
    return (
      <section className="ez-center" aria-label="search">
        <SearchResults projectId={projectId} />
      </section>
    );
  }

  const emptyLibrary = !isLoading && !error && items.length === 0 && libraryFilter === "all" && !activeListId && activeTagIds.length === 0;

  return (
    <section className="ez-center" aria-label="items">
      <div className="ez-center-head">
        <nav className="ez-breadcrumb" aria-label="breadcrumb">
          <strong>{breadcrumb}</strong>
          <span aria-hidden="true">·</span>
          <span>{t("itemsCount", { count: items.length })}</span>
        </nav>
        <span className="ez-spacer" />
        <label style={{ fontSize: 12, color: "var(--ink-2)" }}>
          {t("sort")}{" "}
          <select
            className="ez-select"
            value={sort}
            onChange={(e) => setSort(e.target.value as typeof sort)}
            aria-label={t("sort")}
          >
            <option value="name">{t("sortName")}</option>
            <option value="dateAdded">{t("sortDateAdded")}</option>
            <option value="dateModified">{t("sortDateModified")}</option>
            <option value="photoCount">{t("sortPhotos")}</option>
          </select>
        </label>
        <div className="ez-segmented" role="group" aria-label={t("density")}>
          <button type="button" aria-pressed={density === "comfortable"} onClick={() => setDensity("comfortable")}>
            {t("densityComfortable")}
          </button>
          <button type="button" aria-pressed={density === "compact"} onClick={() => setDensity("compact")}>
            {t("densityCompact")}
          </button>
        </div>
      </div>
      {selectedIds.length > 0 ? (
        <SelectionToolbar projectId={projectId} items={items} ctx={ctx} />
      ) : null}
      {isLoading ? (
        <div className="ez-grid-scroll"><SkeletonCards /></div>
      ) : error ? (
        <ErrorCard what={t("breadcrumbAll")} onRetry={() => mutate()} />
      ) : emptyLibrary ? (
        <div className="ez-state">
          <h2>{t("emptyLibraryTitle")}</h2>
          <p>{t("emptyLibraryBody")}</p>
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" className="ez-btn ez-btn--primary" onClick={() => setImportOpen(true)}>
              {t("importCta")}
            </button>
            <button type="button" className="ez-btn" onClick={() => setTpyOpen(true)}>
              {t("importTpyLink")}
            </button>
          </div>
        </div>
      ) : items.length === 0 ? (
        <div className="ez-state">
          <h2>{t("emptyListTitle")}</h2>
          <p>{t("emptyListBody")}</p>
        </div>
      ) : view === "grid" ? (
        <ItemGrid items={items} projectId={projectId} />
      ) : (
        <ItemTable items={items} projectId={projectId} />
      )}
    </section>
  );
}
