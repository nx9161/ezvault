// SPDX-License-Identifier: MIT
/**
 * lib/items/clipboard.ts — app-level item clipboard (row 32 fix).
 *
 * Copy/paste between projects: "Copy to project…" stores the current
 * selection's item refs (source project id + item ids) in an in-app
 * clipboard; "Paste items" in any project executes the bulk copy for
 * all refs via POST /api/projects/[source]/items/copy.
 *
 * Framework-free and storage-injectable so the whole flow's pure parts
 * (make/parse/plan/summarize/execute) are unit-testable. Persistence is
 * localStorage (survives project navigation + reload); there is NO
 * server clipboard table. Nothing here touches the OS clipboard.
 */

export interface ItemClipboard {
  sourceProjectId: string;
  itemIds: string[];
  /** epoch ms the refs were copied at */
  copiedAt: number;
}

export const CLIPBOARD_STORAGE_KEY = 'ezvault:item-clipboard';
/** window event dispatched after a write/clear so open UI re-reads. */
export const CLIPBOARD_CHANGED_EVENT = 'ez:item-clipboard-changed';

const UUID_SHAPE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Build a clipboard payload; null when there is nothing valid to copy. */
export function makeClipboard(
  sourceProjectId: string,
  itemIds: readonly string[],
  now: number = Date.now(),
): ItemClipboard | null {
  if (!UUID_SHAPE.test(sourceProjectId)) return null;
  const ids = [...new Set(itemIds)].filter((id) => UUID_SHAPE.test(id));
  if (ids.length === 0) return null;
  return { sourceProjectId, itemIds: ids, copiedAt: now };
}

export function serializeClipboard(clip: ItemClipboard): string {
  return JSON.stringify({
    v: 1,
    sourceProjectId: clip.sourceProjectId,
    itemIds: clip.itemIds,
    copiedAt: clip.copiedAt,
  });
}

/** Parse a stored payload; null for anything malformed or empty. */
export function parseClipboard(raw: string | null | undefined): ItemClipboard | null {
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const rec = data as Record<string, unknown>;
  if (!Array.isArray(rec['itemIds'])) return null;
  return makeClipboard(
    typeof rec['sourceProjectId'] === 'string' ? rec['sourceProjectId'] : '',
    rec['itemIds'].filter((x): x is string => typeof x === 'string'),
    typeof rec['copiedAt'] === 'number' ? rec['copiedAt'] : 0,
  );
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export function readItemClipboard(storage: StorageLike | null = defaultStorage()): ItemClipboard | null {
  if (!storage) return null;
  try {
    return parseClipboard(storage.getItem(CLIPBOARD_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function writeItemClipboard(
  clip: ItemClipboard,
  storage: StorageLike | null = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(CLIPBOARD_STORAGE_KEY, serializeClipboard(clip));
  } catch {
    /* storage full/blocked: the in-memory caller still holds the refs */
  }
  notifyClipboardChanged();
}

export function clearItemClipboard(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(CLIPBOARD_STORAGE_KEY);
  } catch {
    /* ignore */
  }
  notifyClipboardChanged();
}

function notifyClipboardChanged(): void {
  try {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(CLIPBOARD_CHANGED_EVENT));
    }
  } catch {
    /* non-browser context */
  }
}

// ---------------------------------------------------------------------------
// Paste planning + execution
// ---------------------------------------------------------------------------

export interface PastePlan {
  sourceProjectId: string;
  targetProjectId: string;
  itemIds: string[];
  /** pasting back into the source project (a duplicate-in-place) */
  sameProject: boolean;
}

export function planPaste(clip: ItemClipboard | null, targetProjectId: string): PastePlan | null {
  if (!clip || clip.itemIds.length === 0) return null;
  if (!UUID_SHAPE.test(targetProjectId)) return null;
  return {
    sourceProjectId: clip.sourceProjectId,
    targetProjectId,
    itemIds: [...clip.itemIds],
    sameProject: clip.sourceProjectId === targetProjectId,
  };
}

export interface PasteFailure {
  item_id: string;
  reason: string;
}

export interface PasteSummary {
  copied: number;
  /** new item ids created in the target project */
  copiedItemIds: string[];
  failed: PasteFailure[];
}

/** The bulk route's response shape (app/api/projects/[id]/items/copy). */
export interface BulkCopyResponse {
  target_project_id: string;
  copied: { source_item_id: string; item_id: string }[];
  failed: { item_id: string; error: string }[];
}

export function summarizeBulkCopyResponse(res: BulkCopyResponse): PasteSummary {
  return {
    copied: res.copied.length,
    copiedItemIds: res.copied.map((c) => c.item_id),
    failed: res.failed.map((f) => ({ item_id: f.item_id, reason: f.error })),
  };
}

export type PostFn = <T>(path: string, body?: unknown) => Promise<T>;

/**
 * Execute a paste: one bulk-copy call from the SOURCE project into the
 * target. A transport-level failure fails EVERY ref with that reason
 * (honest counts — never a partial-looking success).
 */
export async function executePaste(
  plan: PastePlan,
  postFn: PostFn,
): Promise<PasteSummary> {
  try {
    const res = await postFn<BulkCopyResponse>(
      `/api/projects/${plan.sourceProjectId}/items/copy`,
      { item_ids: plan.itemIds, target_project_id: plan.targetProjectId },
    );
    return summarizeBulkCopyResponse(res);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      copied: 0,
      copiedItemIds: [],
      failed: plan.itemIds.map((item_id) => ({ item_id, reason })),
    };
  }
}
