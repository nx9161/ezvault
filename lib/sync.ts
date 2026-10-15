// SPDX-License-Identifier: MIT
// Cross-tab sync (architecture §9): BroadcastChannel('ezvault-sync') +
// `localStorage`+`storage`-event fallback, broadcasting
// { projectId, rev, tabId, scopes } on every mutation.
// projects.rev is bumped in the same transaction as every mutation (backend);
// the client resume-checks rev on visibilitychange → visible (no polling).

"use client";

export const SYNC_CHANNEL = "ezvault-sync";

export interface SyncMessage {
  projectId: string;
  rev: number;
  tabId: string;
  scopes: string[];
  at: number;
}

type Handler = (msg: SyncMessage) => void;

let channel: BroadcastChannel | null = null;
const handlers = new Set<Handler>();

function ensureChannel(): BroadcastChannel | null {
  if (typeof window === "undefined") return null;
  if (!("BroadcastChannel" in window)) return null;
  if (!channel) {
    channel = new BroadcastChannel(SYNC_CHANNEL);
    channel.onmessage = (ev) => {
      const msg = ev.data as SyncMessage;
      for (const h of handlers) h(msg);
    };
  }
  return channel;
}

function storageFallback(msg: SyncMessage) {
  try {
    localStorage.setItem(
      SYNC_CHANNEL,
      JSON.stringify({ ...msg, nonce: Math.random() }),
    );
  } catch {
    /* storage unavailable — sync degrades silently */
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (ev) => {
    if (ev.key !== SYNC_CHANNEL || !ev.newValue) return;
    try {
      const msg = JSON.parse(ev.newValue) as SyncMessage;
      for (const h of handlers) h(msg);
    } catch {
      /* ignore malformed */
    }
  });
}

/** Broadcast a mutation to other tabs. Call after every successful mutation. */
export function broadcastMutation(
  projectId: string,
  rev: number,
  tabId: string,
  scopes: string[],
): void {
  const msg: SyncMessage = { projectId, rev, tabId, scopes, at: Date.now() };
  const ch = ensureChannel();
  if (ch) ch.postMessage(msg);
  else storageFallback(msg);
}

/** Subscribe to other tabs' mutations. Handler receives every message. */
export function onRemoteMutation(fn: Handler): () => void {
  ensureChannel();
  handlers.add(fn);
  return () => {
    handlers.delete(fn);
  };
}
