// SPDX-License-Identifier: MIT
// Undoable command factories. Each returns a Command { id, label, scope, do, undo }.
// Small ops: optimistic SWR cache patch + rollback on server reject.
// Imports / bulk / .tpy: pessimistic, single compound command.
// Server rejects → caller drops the command, toasts, and refetches.

"use client";

import { mutate } from "swr";
import { api, del, patch, post, newClientOpId } from "../api/client";
import { key } from "../api/hooks";
import type { ListNode, Tag } from "@/lib/types";
import type { MetadataValuesMap, PhotoEdits, Selection } from "../api/types";
import { adaptMetadataValues, metadataWire } from "../api/types";
import { broadcastMutation } from "../sync";
import { commandBus, type Command } from "./bus";

export interface OpContext {
  projectId: string;
  tabId: string;
  toast: (message: string, kind?: "info" | "error") => void;
  setLastAction: (label: string) => void;
}

function itemScope(projectId: string): string[] {
  return ["items"];
}

/** Revalidate SWR keys for scopes, then broadcast to other tabs. */
export async function refreshAndBroadcast(
  ctx: OpContext,
  scopes: string[],
): Promise<void> {
  const p = ctx.projectId;
  const matchers: Record<string, (k: unknown) => boolean> = {
    items: (k) => typeof k === "string" && k.startsWith(`/api/projects/${p}/items`),
    lists: (k) => k === key.lists(p),
    tags: (k) => k === key.tags(p),
    templates: (k) => k === key.templates(p),
    trash: (k) => k === key.trash(p),
    meter: (k) => k === key.meter(p),
    photos: (k) =>
      typeof k === "string" && k.includes(`/api/projects/${p}/items/`) && k.endsWith("/photos"),
    selections: (k) => typeof k === "string" && k.includes(`/api/projects/${p}/photos/`) && k.includes("/selections"),
    notes: (k) => typeof k === "string" && k.includes("/notes"),
    metadata: (k) => typeof k === "string" && k.includes(`/api/projects/${p}/subjects/`),
    search: (k) => typeof k === "string" && k.startsWith(`/api/projects/${p}/search`),
  };
  await mutate((k) => scopes.some((s) => matchers[s]?.(k)));
  let rev = 0;
  try {
    const r = await mutate<{ rev: number }>(key.rev(p));
    if (r && typeof r.rev === "number") rev = r.rev;
  } catch {
    /* rev check is best-effort */
  }
  broadcastMutation(p, rev, ctx.tabId, scopes);
}

function makeCommand(
  label: string,
  scope: string,
  doFn: () => Promise<void>,
  undoFn: () => Promise<void>,
): Command {
  return { id: newClientOpId(), label, scope, do: doFn, undo: undoFn, at: Date.now() };
}

/** Execute a command; on server reject: drop it, toast, refetch. */
export async function runCommand(
  ctx: OpContext,
  cmd: Command,
  scopes: string[],
): Promise<boolean> {
  try {
    await commandBus.execute(cmd);
    ctx.setLastAction(cmd.label);
    await refreshAndBroadcast(ctx, scopes);
    return true;
  } catch (err) {
    commandBus.dropTop(err instanceof Error ? err.message : "failed");
    ctx.toast(
      err instanceof Error ? err.message : "Operation failed",
      "error",
    );
    await refreshAndBroadcast(ctx, scopes);
    return false;
  }
}

export async function undoLast(ctx: OpContext, scopes: string[]): Promise<void> {
  const cmd = await commandBus.undo();
  if (cmd) {
    ctx.setLastAction(`Undid: ${cmd.label}`);
    await refreshAndBroadcast(ctx, scopes.length ? scopes : [cmd.scope]);
  }
}

export async function redoLast(ctx: OpContext, scopes: string[]): Promise<void> {
  const cmd = await commandBus.redo();
  if (cmd) {
    ctx.setLastAction(`Redid: ${cmd.label}`);
    await refreshAndBroadcast(ctx, scopes.length ? scopes : [cmd.scope]);
  }
}

// ---------- Lists ----------

export function renameListOp(
  ctx: OpContext,
  list: ListNode,
  nextName: string,
): Command {
  const before = list.name;
  return makeCommand("Rename list", "lists", async () => {
    await mutate<ListNode[]>(
      key.lists(ctx.projectId),
      (cur) => (cur ?? []).map((l) => (l.id === list.id ? { ...l, name: nextName } : l)),
      { optimisticData: undefined, revalidate: false, populateCache: true, rollbackOnError: true },
    );
    await patch(`${key.lists(ctx.projectId)}/${list.id}`, { name: nextName }, { opId: newClientOpId() });
  }, async () => {
    await patch(`${key.lists(ctx.projectId)}/${list.id}`, { name: before }, { opId: newClientOpId() });
  });
}

export function moveListOp(
  ctx: OpContext,
  listId: string,
  beforeParent: string | null,
  afterParent: string | null,
): Command {
  return makeCommand("Move list", "lists", async () => {
    // No dedicated /move route — re-parent via PATCH (UpdateListRequest).
    await patch(`${key.lists(ctx.projectId)}/${listId}`, { parent_list_id: afterParent }, { opId: newClientOpId() });
  }, async () => {
    await patch(`${key.lists(ctx.projectId)}/${listId}`, { parent_list_id: beforeParent }, { opId: newClientOpId() });
  });
}

export function deleteListOp(ctx: OpContext, list: ListNode): Command {
  return makeCommand("Delete list", "lists", async () => {
    await del(`${key.lists(ctx.projectId)}/${list.id}`, undefined, { opId: newClientOpId() });
  }, async () => {
    // Re-create with the same id is not possible; restore as a new list
    // with the same name/color/parent (items were unfiled, not deleted).
    await post(key.lists(ctx.projectId), { name: list.name, parent_list_id: list.parent_list_id, color: list.color }, { opId: newClientOpId() });
  });
}

// ---------- Tags ----------

export function renameTagOp(ctx: OpContext, tag: Tag, nextName: string): Command {
  const before = tag.name;
  return makeCommand("Rename tag", "tags", async () => {
    await mutate<Tag[]>(
      key.tags(ctx.projectId),
      (cur) => (cur ?? []).map((t) => (t.id === tag.id ? { ...t, name: nextName } : t)),
      { revalidate: false, populateCache: true, rollbackOnError: true },
    );
    await patch(`${key.tags(ctx.projectId)}/${tag.id}`, { name: nextName }, { opId: newClientOpId() });
  }, async () => {
    await patch(`${key.tags(ctx.projectId)}/${tag.id}`, { name: before }, { opId: newClientOpId() });
  });
}

export function deleteTagOp(ctx: OpContext, tag: Tag): Command {
  return makeCommand("Delete tag", "tags", async () => {
    await del(`${key.tags(ctx.projectId)}/${tag.id}`, undefined, { opId: newClientOpId() });
  }, async () => {
    await post(key.tags(ctx.projectId), { name: tag.name, color: tag.color }, { opId: newClientOpId() });
  });
}

export function recolorTagOp(ctx: OpContext, tag: Tag, color: string): Command {
  const before = tag.color;
  return makeCommand("Change tag color", "tags", async () => {
    await mutate<Tag[]>(
      key.tags(ctx.projectId),
      (cur) => (cur ?? []).map((t) => (t.id === tag.id ? { ...t, color } : t)),
      { revalidate: false, populateCache: true, rollbackOnError: true },
    );
    await patch(`${key.tags(ctx.projectId)}/${tag.id}`, { color }, { opId: newClientOpId() });
  }, async () => {
    await patch(`${key.tags(ctx.projectId)}/${tag.id}`, { color: before }, { opId: newClientOpId() });
  });
}

export function attachTagsOp(
  ctx: OpContext,
  tagId: string,
  subjectIds: string[],
  attach: boolean,
): Command {
  // Tag attach/detach rides the bulk-items endpoint (landed); there is no
  // per-tag /subjects route in v1.
  const label = attach ? "Add tags" : "Remove tags";
  const op = attach
    ? { op: "add_tags", tag_ids: [tagId] }
    : { op: "remove_tags", tag_ids: [tagId] };
  const inverse = attach
    ? { op: "remove_tags", tag_ids: [tagId] }
    : { op: "add_tags", tag_ids: [tagId] };
  const url = `/api/projects/${ctx.projectId}/items/bulk`;
  return makeCommand(label, "tags", async () => {
    await post(url, { item_ids: subjectIds, ops: [op] }, { opId: newClientOpId() });
  }, async () => {
    await post(url, { item_ids: subjectIds, ops: [inverse] }, { opId: newClientOpId() });
  });
}

// ---------- Items / trash ----------

export function trashSubjectsOp(
  ctx: OpContext,
  subjectIds: string[],
  reason: "user" | "merge" | "auto",
  label: string,
): Command {
  // Trash rides the bulk-items endpoint (single txn + single rev bump).
  const url = `/api/projects/${ctx.projectId}/items/bulk`;
  return makeCommand(label, "trash", async () => {
    await post(url, { item_ids: subjectIds, ops: [{ op: "trash", reason }] }, { opId: newClientOpId() });
  }, async () => {
    for (const sid of subjectIds) {
      await post(`/api/projects/${ctx.projectId}/trash/${sid}/restore`, {}, { opId: newClientOpId() });
    }
  });
}

export function restoreTrashOp(ctx: OpContext, subjectIds: string[]): Command {
  return makeCommand("Restore from trash", "trash", async () => {
    for (const sid of subjectIds) {
      await post(`/api/projects/${ctx.projectId}/trash/${sid}/restore`, {}, { opId: newClientOpId() });
    }
  }, async () => {
    for (const sid of subjectIds) {
      await post(`/api/projects/${ctx.projectId}/subjects/${sid}/trash`, { reason: "user" }, { opId: newClientOpId() });
    }
  });
}

export function emptyTrashOp(ctx: OpContext): Command {
  // Irreversible server-side — undo() explains instead of pretending.
  return makeCommand("Empty trash", "trash", async () => {
    await post(`/api/projects/${ctx.projectId}/trash/empty`, {}, { opId: newClientOpId() });
  }, async () => {
    ctx.toast("Emptying the trash is irreversible — nothing to undo.", "error");
  });
}

export function mergeItemsOp(
  ctx: OpContext,
  itemIds: string[],
  targetId: string,
): Command {
  // Wave-2 placeholder: merge needs photo reassignment, which the landed
  // routes do not offer (photo PATCH has no item_id; bulk has no merge op).
  // The UI is gated until then (disabled "Merge items (wave 2)" button —
  // QA round 1): this op exists only so wave 2 has the seam. It changes
  // nothing and says so honestly instead of promising something pending.
  void itemIds;
  void targetId;
  return makeCommand("Merge items", "items", async () => {
    ctx.toast(
      "Merging items ships in wave 2 — the backend merge endpoint (photo reassignment) does not exist yet. Nothing was changed.",
      "error",
    );
  }, async () => {
    /* nothing was done — nothing to undo */
  });
}

// ---------- Metadata (before-image snapshots) ----------

export function setMetadataOp(
  ctx: OpContext,
  subjectId: string,
  before: MetadataValuesMap,
  after: MetadataValuesMap,
  label = "Edit metadata",
): Command {
  const url = `/api/projects/${ctx.projectId}/subjects/${subjectId}/metadata`;
  return makeCommand(label, "metadata", async () => {
    await patch(url, { values: metadataWire(after), replace: true }, { opId: newClientOpId() });
  }, async () => {
    await patch(url, { values: metadataWire(before), replace: true }, { opId: newClientOpId() });
  });
}

export function bulkMetadataOp(
  ctx: OpContext,
  subjectIds: string[],
  values: MetadataValuesMap,
  label = "Bulk edit metadata",
): Command {
  // Snapshot every subject first (immutable-value semantics make inverses unsound).
  let befores: Map<string, MetadataValuesMap> | null = null;
  const cmd = makeCommand(label, "metadata", async () => {
    befores = new Map<string, MetadataValuesMap>();
    for (const sid of subjectIds) {
      const cur = await api<{ values: { property_uri: string; text: string }[] }>(
        `/api/projects/${ctx.projectId}/subjects/${sid}/metadata`,
      ).then((r) => adaptMetadataValues(r.values));
      befores.set(sid, cur);
    }
    await post(`/api/projects/${ctx.projectId}/metadata/bulk`, { subject_ids: subjectIds, values: metadataWire(values) }, { opId: newClientOpId() });
  }, async () => {
    if (!befores) return;
    for (const [sid, before] of befores) {
      await patch(`/api/projects/${ctx.projectId}/subjects/${sid}/metadata`, { values: metadataWire(before), replace: true }, { opId: newClientOpId() });
    }
  });
  return cmd;
}

// ---------- Photo edits ----------

export function setEditsOp(
  ctx: OpContext,
  photoId: string,
  before: PhotoEdits,
  after: PhotoEdits,
): Command {
  return makeCommand("Edit photo", "edits", async () => {
    await post(`/api/projects/${ctx.projectId}/photos/${photoId}/edits`, { edits: after }, { opId: newClientOpId() });
  }, async () => {
    await post(`/api/projects/${ctx.projectId}/photos/${photoId}/edits`, { edits: before }, { opId: newClientOpId() });
  });
}

export function revertEditsOp(
  ctx: OpContext,
  photoId: string,
  before: PhotoEdits,
): Command {
  return makeCommand("Revert to original", "edits", async () => {
    await post(`/api/projects/${ctx.projectId}/photos/${photoId}/revert`, {}, { opId: newClientOpId() });
  }, async () => {
    await post(`/api/projects/${ctx.projectId}/photos/${photoId}/edits`, { edits: before }, { opId: newClientOpId() });
  });
}

// ---------- Selections ----------

export function updateSelectionOp(
  ctx: OpContext,
  selection: Selection,
  patchBody: Partial<Pick<Selection, "name" | "x" | "y" | "w" | "h" | "template_id">>,
  label = "Edit selection",
): Command {
  // Wire uses width/height; the view-model uses w/h.
  const wire = (b: typeof patchBody) => ({
    ...(b.name !== undefined ? { name: b.name } : {}),
    ...(b.x !== undefined ? { x: b.x } : {}),
    ...(b.y !== undefined ? { y: b.y } : {}),
    ...(b.w !== undefined ? { width: b.w } : {}),
    ...(b.h !== undefined ? { height: b.h } : {}),
    ...(b.template_id !== undefined ? { template_id: b.template_id } : {}),
  });
  const before = { name: selection.name, x: selection.x, y: selection.y, w: selection.w, h: selection.h, template_id: selection.template_id };
  return makeCommand(label, "selections", async () => {
    await patch(`/api/projects/${ctx.projectId}/selections/${selection.id}`, wire(patchBody), { opId: newClientOpId() });
  }, async () => {
    await patch(`/api/projects/${ctx.projectId}/selections/${selection.id}`, wire(before), { opId: newClientOpId() });
  });
}

export function deleteSelectionOp(ctx: OpContext, selection: Selection): Command {
  return makeCommand("Delete selection", "selections", async () => {
    await del(`/api/projects/${ctx.projectId}/selections/${selection.id}`, undefined, { opId: newClientOpId() });
  }, async () => {
    await post(`/api/projects/${ctx.projectId}/photos/${selection.photo_id}/selections`, {
      name: selection.name, x: selection.x, y: selection.y, width: selection.w, height: selection.h, template_id: selection.template_id,
    }, { opId: newClientOpId() });
  });
}

// ---------- Compound import undo ----------

export function importUndoCommand(
  ctx: OpContext,
  jobId: string,
  label: string,
): Command {
  return makeCommand(label, "import",
    async () => {
      // do() = the import already happened via the upload flow; redo is manual.
      ctx.toast("Re-running an import is manual — open Import and choose the files again.", "info");
    },
    async () => {
      await post(`/api/jobs/${jobId}/undo`, {}, { opId: newClientOpId() });
    },
  );
}

export { itemScope };
