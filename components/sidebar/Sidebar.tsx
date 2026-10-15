// SPDX-License-Identifier: MIT
// Left sidebar: Library, nested lists tree (DnD re-nest + cycle guard),
// tags cloud (filter + manage). Design §1.2.

"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";
import { useLists, useTags, useSearch, useTrash } from "@/lib/api/hooks";
import { post, patch, del } from "@/lib/api/client";
import { runCommand, renameListOp, moveListOp, deleteListOp, renameTagOp, deleteTagOp, recolorTagOp, type OpContext } from "@/lib/commands/ops";
import { useDomainStore } from "@/lib/store/domain";
import { Menu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { ConfirmDialog } from "@/components/ui/Dialog";
import { ErrorCard, SkeletonRows } from "@/components/ui/Feedback";
import { useMediaQuery } from "@/lib/hooks/useMediaQuery";
import {
  LibraryIcon,
  TrashIcon,
  PlusIcon,
  ChevronRightIcon,
  ChevronDownIcon,
} from "@/components/ui/icons";
import type { ListNode, Tag } from "@/lib/api/types";
import { TAG_COLORS } from "@/components/ui/ColorSwatch";
import { ColorSwatchPopover } from "@/components/ui/ColorSwatch";

/** Build a nested tree from a flat list (parent_id). Handles pre-nested too. */
export function buildTree(lists: ListNode[]): ListNode[] {
  const byId = new Map<string, ListNode>();
  const roots: ListNode[] = [];
  for (const l of lists) byId.set(l.id, { ...l, children: l.children ?? [] });
  for (const l of byId.values()) {
    if (l.parent_list_id && byId.has(l.parent_list_id) && l.parent_list_id !== l.id) {
      byId.get(l.parent_list_id)!.children!.push(l);
    } else {
      roots.push(l);
    }
  }
  const sortFn = (a: ListNode, b: ListNode) => a.position - b.position || a.name.localeCompare(b.name);
  const sortDeep = (nodes: ListNode[]) => {
    nodes.sort(sortFn);
    nodes.forEach((n) => n.children && sortDeep(n.children));
  };
  sortDeep(roots);
  return roots;
}

/** True if `candidate` is `node` itself or one of its descendants. */
export function isDescendantOrSelf(node: ListNode, candidateId: string): boolean {
  if (node.id === candidateId) return true;
  return (node.children ?? []).some((c) => isDescendantOrSelf(c, candidateId));
}

function findNode(nodes: ListNode[], id: string): ListNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = n.children ? findNode(n.children, id) : null;
    if (hit) return hit;
  }
  return null;
}

/** id -> parent id (null for roots); used by treeview ArrowLeft. */
function parentMapOf(tree: ListNode[]): Map<string, string | null> {
  const m = new Map<string, string | null>();
  const walk = (nodes: ListNode[], parent: string | null) => {
    for (const n of nodes) {
      m.set(n.id, parent);
      if (n.children) walk(n.children, n.id);
    }
  };
  walk(tree, null);
  return m;
}

/** Flattened ids in the order a keyboard user sees them (collapsed subtrees skipped). */
function visibleOrderIds(tree: ListNode[], collapsed: Set<string>): string[] {
  const out: string[] = [];
  const walk = (nodes: ListNode[]) => {
    for (const n of nodes) {
      out.push(n.id);
      if (n.children && !collapsed.has(n.id)) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

function useOpContext(projectId: string): OpContext {
  const pushToast = useUiStore((s) => s.pushToast);
  const setLastAction = useDomainStore((s) => s.setLastAction);
  const tabId = useDomainStore((s) => s.tabId);
  return {
    projectId,
    tabId,
    toast: (message, kind) => pushToast({ message, kind: kind ?? "info" }),
    setLastAction,
  };
}

function LibrarySection({ projectId }: { projectId: string }) {
  const t = useTranslations("sidebar");
  const libraryFilter = useUiStore((s) => s.libraryFilter);
  const setLibraryFilter = useUiStore((s) => s.setLibraryFilter);
  const setActiveListId = useUiStore((s) => s.setActiveListId);
  const { data: trashData } = useTrash(projectId);
  const trash = trashData?.items;
  return (
    <section className="ez-side-section" aria-label={t("library")}>
      <h2>{t("library")}</h2>
      <button
        type="button"
        className="ez-nav-row"
        aria-current={libraryFilter === "all"}
        onClick={() => setLibraryFilter("all")}
      >
        <LibraryIcon size={15} /> {t("allItems")}
      </button>
      <button
        type="button"
        className="ez-nav-row"
        aria-current={libraryFilter === "unfiled"}
        onClick={() => setLibraryFilter("unfiled")}
      >
        <LibraryIcon size={15} style={{ opacity: 0.55 }} /> {t("unfiled")}
      </button>
      <button
        type="button"
        className="ez-nav-row"
        aria-current={libraryFilter === "trash"}
        onClick={() => {
          setLibraryFilter("trash");
          setActiveListId(null);
        }}
      >
        <TrashIcon size={15} /> {t("trash")}
        {trash && trash.length > 0 ? (
          <span className="ez-count">{trash.length}</span>
        ) : null}
      </button>
    </section>
  );
}

interface TreeRowProps {
  node: ListNode;
  depth: number;
  projectId: string;
  tree: ListNode[];
  ctx: OpContext;
  collapsed: Set<string>;
  toggleCollapse: (id: string) => void;
  onRename: (node: ListNode) => void;
  focusId: string | null;
  firstVisibleId: string | null;
  visibleOrder: string[];
  parentMap: Map<string, string | null>;
  onFocusRow: (id: string) => void;
  focusRowById: (id: string) => void;
  registerRow: (id: string, el: HTMLLIElement | null) => void;
  /** SHOULD-10: search hit counts per list id (renders inline badges). */
  badges?: Record<string, number>;
}

function TreeRow({
  node,
  depth,
  projectId,
  tree,
  ctx,
  collapsed,
  toggleCollapse,
  onRename,
  focusId,
  firstVisibleId,
  visibleOrder,
  parentMap,
  onFocusRow,
  focusRowById,
  registerRow,
  badges,
}: TreeRowProps) {
  const t = useTranslations("sidebar");
  const tc = useTranslations("app");
  const activeListId = useUiStore((s) => s.activeListId);
  const setActiveListId = useUiStore((s) => s.setActiveListId);
  const pushToast = useUiStore((s) => s.pushToast);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  // D-M8a: swatch popover replaces window.prompt for the list color.
  const [swatchAt, setSwatchAt] = useState<{ x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState(false);
  const [shake, setShake] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newSublist, setNewSublist] = useState(false);
  const [sublistName, setSublistName] = useState("");
  const hasChildren = (node.children?.length ?? 0) > 0;
  const isCollapsed = collapsed.has(node.id);

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDropTarget(false);
    // Case 1: a list being re-nested.
    const draggedListId = e.dataTransfer.getData("application/x-ezvault-list");
    if (draggedListId && draggedListId !== node.id) {
      const dragged = findNode(tree, draggedListId);
      if (!dragged) return;
      if (isDescendantOrSelf(dragged, node.id)) {
        // Cycle guard: refuse with shake + message (design §2.5).
        setShake(true);
        pushToast({ message: t("cycleError"), kind: "error" });
        setTimeout(() => setShake(false), 300);
        return;
      }
      await runCommand(ctx, moveListOp(ctx, draggedListId, dragged.parent_list_id, node.id), ["lists"]);
      return;
    }
    // Case 2: item cards filed into the list.
    const itemIds = e.dataTransfer.getData("application/x-ezvault-items");
    if (itemIds) {
      const ids: string[] = JSON.parse(itemIds);
      for (const itemId of ids) {
        await post(`/api/projects/${projectId}/lists/${node.id}/items`, { item_id: itemId, position: -1 });
      }
      const { refreshAndBroadcast } = await import("@/lib/commands/ops");
      await refreshAndBroadcast(ctx, ["items", "lists"]);
      return;
    }
  }

  function onRowKeyDown(e: React.KeyboardEvent) {
    // Treeview pattern: arrows move focus, Enter activates, F2/Delete act.
    const idx = visibleOrder.indexOf(node.id);
    const move = (nextId: string) => {
      e.preventDefault();
      focusRowById(nextId);
    };
    if (e.key === "F2") {
      e.preventDefault();
      onRename(node);
      return;
    }
    if (e.key === "Delete") {
      e.preventDefault();
      setConfirmDelete(true);
      return;
    }
    if (e.key === "Enter") {
      setActiveListId(node.id);
      return;
    }
    if (e.key === "ArrowDown") {
      if (idx >= 0 && idx < visibleOrder.length - 1) move(visibleOrder[idx + 1]);
      return;
    }
    if (e.key === "ArrowUp") {
      if (idx > 0) move(visibleOrder[idx - 1]);
      return;
    }
    if (e.key === "ArrowRight") {
      // Nested rows bubble here, so stop the ancestor from double-handling.
      e.preventDefault();
      e.stopPropagation();
      if (hasChildren && isCollapsed) toggleCollapse(node.id);
      else if (hasChildren && node.children!.length > 0) move(node.children![0].id);
      return;
    }
    if (e.key === "ArrowLeft") {
      e.preventDefault();
      e.stopPropagation();
      if (hasChildren && !isCollapsed) toggleCollapse(node.id);
      else {
        const parent = parentMap.get(node.id);
        if (parent) move(parent);
      }
    }
  }

  return (
    <li
      ref={(el) => registerRow(node.id, el)}
      role="treeitem"
      aria-expanded={hasChildren ? !isCollapsed : undefined}
      aria-selected={activeListId === node.id}
      aria-level={depth + 1}
      tabIndex={node.id === (focusId ?? firstVisibleId) ? 0 : -1}
      onFocus={() => onFocusRow(node.id)}
      onClick={() => setActiveListId(node.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenuAt({ x: e.clientX, y: e.clientY });
      }}
      onKeyDown={onRowKeyDown}
    >
      <div
        className="ez-tree-row"
        data-drop-target={dropTarget || undefined}
        data-shake={shake || undefined}
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData("application/x-ezvault-list", node.id);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(e) => {
          if (
            e.dataTransfer.types.includes("application/x-ezvault-list") ||
            e.dataTransfer.types.includes("application/x-ezvault-items")
          ) {
            e.preventDefault();
            setDropTarget(true);
          }
        }}
        onDragLeave={() => setDropTarget(false)}
        onDrop={handleDrop}
        title={node.name}
      >
        {hasChildren ? (
          <span
            className="ez-tree-toggle"
            aria-hidden="true"
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapse(node.id);
            }}
          >
            {isCollapsed ? <ChevronRightIcon size={13} /> : <ChevronDownIcon size={13} />}
          </span>
        ) : (
          <span className="ez-tree-toggle" aria-hidden="true" />
        )}
        {node.color ? (
          <span className="ez-color-dot" style={{ background: node.color }} aria-hidden="true" />
        ) : null}
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {node.name}
        </span>
        {/* SHOULD-10: while searching, the row shows the search hit count
            instead of the library item count; the old bottom text block is gone. */}
        {badges?.[node.id] ? (
          <span
            className="ez-count ez-count--hit"
            title={t("searchHits", { count: badges[node.id] })}
            aria-label={t("searchHits", { count: badges[node.id] })}
          >
            {badges[node.id]}
          </span>
        ) : typeof node.item_count === "number" ? (
          <span className="ez-count">{node.item_count}</span>
        ) : null}
      </div>
      {menuAt ? (
        <Menu anchor={menuAt} onClose={() => setMenuAt(null)} label={node.name}>
          <MenuItem onSelect={() => onRename(node)}>{t("renameList")}</MenuItem>
          <MenuItem onSelect={() => setNewSublist(true)}>{t("newSublist")}</MenuItem>
          <MenuItem
            onSelect={(e) => {
              // The menu auto-closes; open the swatch popover at the click position.
              setSwatchAt({ x: e.clientX, y: e.clientY });
            }}
          >
            {t("listColor")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger onSelect={() => setConfirmDelete(true)}>
            {t("deleteList")}
          </MenuItem>
        </Menu>
      ) : null}
      {swatchAt ? (
        <ColorSwatchPopover
          anchor={swatchAt}
          initial={node.color ?? "#B3541E"}
          label={t("listColor")}
          onCancel={() => setSwatchAt(null)}
          onPick={async (color) => {
            setSwatchAt(null);
            await patch(`/api/projects/${projectId}/lists/${node.id}`, { color });
            const { refreshAndBroadcast } = await import("@/lib/commands/ops");
            await refreshAndBroadcast(ctx, ["lists"]);
          }}
        />
      ) : null}
      {newSublist ? (
        <form
          className="ez-inline-form"
          style={{ paddingLeft: 28 }}
          onSubmit={async (e) => {
            e.preventDefault();
            const name = sublistName.trim();
            if (!name) return;
            await post(`/api/projects/${projectId}/lists`, { name, parent_list_id: node.id });
            setNewSublist(false);
            setSublistName("");
            const { refreshAndBroadcast } = await import("@/lib/commands/ops");
            await refreshAndBroadcast(ctx, ["lists"]);
          }}
        >
          <input
            className="ez-input"
            value={sublistName}
            onChange={(e) => setSublistName(e.target.value)}
            placeholder={t("listName")}
            aria-label={t("newSublist")}
            autoFocus
          />
          <button type="submit" className="ez-btn ez-btn--sm ez-btn--primary">
            {tc("save")}
          </button>
        </form>
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          title={t("deleteListConfirmTitle")}
          body={t("deleteListConfirmBody", { name: node.name })}
          confirmLabel={t("deleteList")}
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={async () => {
            setConfirmDelete(false);
            await runCommand(ctx, deleteListOp(ctx, node), ["lists"]);
          }}
        />
      ) : null}
      {hasChildren && !isCollapsed ? (
        <ul className="ez-tree" role="group">
          {node.children!.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              projectId={projectId}
              tree={tree}
              ctx={ctx}
              collapsed={collapsed}
              toggleCollapse={toggleCollapse}
              onRename={onRename}
              focusId={focusId}
              firstVisibleId={firstVisibleId}
              visibleOrder={visibleOrder}
              parentMap={parentMap}
              onFocusRow={onFocusRow}
              focusRowById={focusRowById}
              registerRow={registerRow}
              badges={badges}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ListsSection({ projectId }: { projectId: string }) {
  const t = useTranslations("sidebar");
  const tc = useTranslations("app");
  const ctx = useOpContext(projectId);
  const { data, error, mutate } = useLists(projectId);
  const { data: searchData } = useSearch(
    projectId,
    useUiStore((s) => s.activeQuery),
    useUiStore((s) => s.searchScope),
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<ListNode | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const tree = useMemo(() => buildTree(data ?? []), [data]);
  const badges = searchData?.badges;

  // D-M3: roving tabindex registry for the treeview pattern.
  const [focusId, setFocusId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLLIElement>());
  const registerRow = useCallback((id: string, el: HTMLLIElement | null) => {
    if (el) rowRefs.current.set(id, el);
    else rowRefs.current.delete(id);
  }, []);
  const focusRowById = useCallback((id: string) => {
    setFocusId(id);
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  }, []);
  const visibleOrder = useMemo(() => visibleOrderIds(tree, collapsed), [tree, collapsed]);
  const parentMap = useMemo(() => parentMapOf(tree), [tree]);
  const firstVisibleId = visibleOrder[0] ?? null;

  function toggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function beginRename(node: ListNode) {
    setRenaming(node);
    setRenameValue(node.name);
  }

  async function commitRename() {
    if (!renaming) return;
    const next = renameValue.trim();
    setRenaming(null);
    if (next && next !== renaming.name) {
      await runCommand(ctx, renameListOp(ctx, renaming, next), ["lists"]);
    }
  }

  return (
    <section className="ez-side-section" aria-label={t("lists")} data-tour="sidebar-lists">
      <h2>
        {t("lists")}
        <button
          type="button"
          className="ez-icon-btn"
          onClick={() => setCreating(true)}
          aria-label={t("newList")}
          title={t("newList")}
        >
          <PlusIcon size={14} />
        </button>
      </h2>
      {error ? (
        <ErrorCard what={t("lists")} onRetry={() => mutate()} />
      ) : !data ? (
        <SkeletonRows rows={4} />
      ) : tree.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--ink-2)" }}>
          <p>{t("emptyLists")}</p>
          <button type="button" className="ez-btn ez-btn--sm" onClick={() => setCreating(true)}>
            {t("newList")}
          </button>
        </div>
      ) : (
        <ul className="ez-tree" role="tree" aria-label={t("lists")}>
          {tree.map((node) => (
            <TreeRow
              key={node.id}
              node={node}
              depth={0}
              projectId={projectId}
              tree={tree}
              ctx={ctx}
              collapsed={collapsed}
              toggleCollapse={toggleCollapse}
              onRename={beginRename}
              focusId={focusId}
              firstVisibleId={firstVisibleId}
              visibleOrder={visibleOrder}
              parentMap={parentMap}
              onFocusRow={setFocusId}
              focusRowById={focusRowById}
              registerRow={registerRow}
              badges={badges}
            />
          ))}
        </ul>
      )}
      {creating ? (
        <form
          className="ez-inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            await post(`/api/projects/${projectId}/lists`, { name: trimmed });
            setCreating(false);
            setName("");
            const { refreshAndBroadcast } = await import("@/lib/commands/ops");
            await refreshAndBroadcast(ctx, ["lists"]);
          }}
        >
          <input
            className="ez-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("listName")}
            aria-label={t("newList")}
            autoFocus
          />
          <button type="submit" className="ez-btn ez-btn--sm ez-btn--primary">
            {tc("save")}
          </button>
        </form>
      ) : null}
      {renaming ? (
        <form
          className="ez-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            commitRename();
          }}
        >
          <input
            className="ez-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            aria-label={t("renameList")}
            autoFocus
            onBlur={commitRename}
          />
          <button type="submit" className="ez-btn ez-btn--sm ez-btn--primary">
            {tc("save")}
          </button>
        </form>
      ) : null}
    </section>
  );
}

function TagsSection({ projectId }: { projectId: string }) {
  const t = useTranslations("sidebar");
  const tc = useTranslations("app");
  const ctx = useOpContext(projectId);
  const { data: tagsData, error, mutate } = useTags(projectId);
  const data = Array.isArray(tagsData) ? tagsData : (tagsData?.items ?? []);
  // SHOULD-10: search hit counts per tag id (same SWR key as ListsSection — one fetch).
  const { data: searchData } = useSearch(
    projectId,
    useUiStore((s) => s.activeQuery),
    useUiStore((s) => s.searchScope),
  );
  const tagBadges = searchData?.badges;
  const activeTagIds = useUiStore((s) => s.activeTagIds);
  const toggleTag = useUiStore((s) => s.toggleTag);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState(TAG_COLORS[0]);
  const [menu, setMenu] = useState<{ tag: Tag; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<Tag | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Tag | null>(null);
  // D-M8a: swatch popover replaces window.prompt for the tag color.
  const [swatch, setSwatch] = useState<{ tag: Tag; x: number; y: number } | null>(null);

  async function commitRename() {
    if (!renaming) return;
    const next = renameValue.trim();
    const tag = renaming;
    setRenaming(null);
    if (next && next !== tag.name) {
      await runCommand(ctx, renameTagOp(ctx, tag, next), ["tags", "items"]);
    }
  }

  return (
    <section className="ez-side-section" aria-label={t("tags")} data-tour="sidebar-tags">
      <h2>
        {t("tags")}
        <button
          type="button"
          className="ez-icon-btn"
          onClick={() => setCreating(true)}
          aria-label={t("newTag")}
          title={t("newTag")}
        >
          <PlusIcon size={14} />
        </button>
      </h2>
      <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "0 0 8px" }}>{t("filterHint")}</p>
      {error ? (
        <ErrorCard what={t("tags")} onRetry={() => mutate()} />
      ) : !data ? (
        <SkeletonRows rows={3} />
      ) : (
        <div className="ez-tag-cloud" role="group" aria-label={t("tags")}>
          {data.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className="ez-tag-chip"
              aria-pressed={activeTagIds.includes(tag.id)}
              onClick={(e) => toggleTag(tag.id, e.shiftKey)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ tag, x: e.clientX, y: e.clientY });
              }}
              title={tag.name}
            >
              <span className="ez-color-dot" style={{ background: tag.color }} aria-hidden="true" />
              {tag.name}
              {/* SHOULD-10: search hit badge on the chip. */}
              {tagBadges?.[tag.id] ? (
                <span
                  className="ez-count ez-count--hit"
                  title={t("searchHits", { count: tagBadges[tag.id] })}
                  aria-label={t("searchHits", { count: tagBadges[tag.id] })}
                >
                  {tagBadges[tag.id]}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      )}
      {creating ? (
        <form
          className="ez-inline-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const trimmed = name.trim();
            if (!trimmed) return;
            await post(`/api/projects/${projectId}/tags`, { name: trimmed, color });
            setCreating(false);
            setName("");
            const { refreshAndBroadcast } = await import("@/lib/commands/ops");
            await refreshAndBroadcast(ctx, ["tags"]);
          }}
        >
          <input
            className="ez-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t("tagName")}
            aria-label={t("newTag")}
            autoFocus
          />
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            aria-label={t("tagColor")}
            list="ez-tag-colors"
            style={{ width: 36, height: 30, padding: 0, border: "1px solid var(--border)", borderRadius: 4 }}
          />
          <datalist id="ez-tag-colors">
            {TAG_COLORS.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
          <button type="submit" className="ez-btn ez-btn--sm ez-btn--primary">
            {tc("save")}
          </button>
        </form>
      ) : null}
      {renaming ? (
        <form
          className="ez-inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            commitRename();
          }}
        >
          <input
            className="ez-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            aria-label={t("renameTag")}
            autoFocus
            onBlur={commitRename}
          />
          <button type="submit" className="ez-btn ez-btn--sm ez-btn--primary">
            {tc("save")}
          </button>
        </form>
      ) : null}
      {menu ? (
        <Menu
          anchor={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          label={menu.tag.name}
        >
          <MenuItem
            onSelect={() => {
              setRenaming(menu.tag);
              setRenameValue(menu.tag.name);
            }}
          >
            {t("renameTag")}
          </MenuItem>
          <MenuItem
            onSelect={(e) => {
              setSwatch({ tag: menu.tag, x: e.clientX, y: e.clientY });
            }}
          >
            {t("tagColor")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger onSelect={() => setConfirmDelete(menu.tag)}>
            {t("deleteTag")}
          </MenuItem>
        </Menu>
      ) : null}
      {swatch ? (
        <ColorSwatchPopover
          anchor={{ x: swatch.x, y: swatch.y }}
          initial={swatch.tag.color}
          label={t("tagColor")}
          onCancel={() => setSwatch(null)}
          onPick={async (next) => {
            const tag = swatch.tag;
            setSwatch(null);
            await runCommand(ctx, recolorTagOp(ctx, tag, next), ["tags"]);
          }}
        />
      ) : null}
      {confirmDelete ? (
        <ConfirmDialog
          title={t("deleteTagConfirmTitle")}
          body={t("deleteTagConfirmBody", { name: confirmDelete.name })}
          confirmLabel={t("deleteTag")}
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={async () => {
            const tag = confirmDelete;
            setConfirmDelete(null);
            await runCommand(ctx, deleteTagOp(ctx, tag), ["tags", "items"]);
          }}
        />
      ) : null}
    </section>
  );
}

export default function Sidebar({ projectId }: { projectId: string }) {
  const t = useTranslations("sidebar");
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setSidebarOpen = useUiStore((s) => s.setSidebarOpen);
  const sidebarWidth = useUiStore((s) => s.sidebarWidth);
  // D-M10: inline widths apply only at desktop widths; drawers below 1280px.
  const isDesktop = useMediaQuery("(min-width: 1280px)");
  return (
    <>
      {sidebarOpen ? (
        <div className="ez-scrim" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      ) : null}
      <aside
        id="ez-sidebar"
        className="ez-sidebar"
        data-open={sidebarOpen}
        style={isDesktop ? { width: sidebarWidth } : undefined}
        aria-label={t("paneLabel")}
      >
        <div className="ez-sidebar-scroll">
          <LibrarySection projectId={projectId} />
          <ListsSection projectId={projectId} />
          <TagsSection projectId={projectId} />
        </div>
      </aside>
    </>
  );
}

export { useOpContext };
