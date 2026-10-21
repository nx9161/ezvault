// SPDX-License-Identifier: MIT
// Connectivity / offline state machine (Wave E, APPSEC-REVIEW-PWA §E).
//
// Framework-free singleton + a PURE reducer (unit-tested in
// test/pwa-offline.test.mjs). It is the one authority on "are we
// offline" for the whole client: lib/api/client.ts reports fetch
// outcomes here, components/pwa/PwaProvider renders the banner from
// here, and mutations consult `isMutationBlocked()` before any fetch.
//
// Honesty rules baked in (E-SEC-19/20/22):
//   - the browser `online` event NEVER clears the offline state — only
//     a successful /api response, followed by an SWR revalidation,
//     may clear it (NAVIGATOR_ONLINE is deliberately a no-op);
//   - an auth-shaped API failure switches to the session-expired
//     state (E-SEC-9), which also blocks mutations;
//   - there is no queue and no replay: blocked mutations simply throw
//     in lib/api/client.ts before a fetch is attempted (E-SEC-17).

export interface ConnectivityState {
  /** The offline banner is up: data on screen is stale or absent. */
  offline: boolean;
  /** This document was booted from the SW's cached shell. */
  shellFromCache: boolean;
  /** An /api success arrived while offline; revalidation is pending. */
  pendingRecovery: boolean;
  /** Auth-shaped API failure detected (E-SEC-9). */
  sessionExpired: boolean;
  /** A new SW has taken control while a mutation is in flight. */
  updateReady: boolean;
}

export const INITIAL_CONNECTIVITY: ConnectivityState = {
  offline: false,
  shellFromCache: false,
  pendingRecovery: false,
  sessionExpired: false,
  updateReady: false,
};

export type ConnectivityEvent =
  | "API_NETWORK_FAILURE"
  | "API_SUCCESS"
  | "NAVIGATOR_OFFLINE"
  | "NAVIGATOR_ONLINE"
  | "SHELL_FROM_CACHE"
  | "REVALIDATED"
  | "AUTH_FAILURE"
  | "UPDATE_READY"
  | "UPDATE_DISMISSED";

export function connectivityReducer(
  state: ConnectivityState,
  event: ConnectivityEvent,
): ConnectivityState {
  switch (event) {
    case "API_NETWORK_FAILURE":
    case "NAVIGATOR_OFFLINE":
      return { ...state, offline: true, pendingRecovery: false };
    case "NAVIGATOR_ONLINE":
      // Deliberate no-op (E-SEC-19): captive portals fire `online`
      // while every fetch still fails. Only API_SUCCESS may recover.
      return state;
    case "SHELL_FROM_CACHE":
      return { ...state, offline: true, shellFromCache: true };
    case "API_SUCCESS":
      if (state.sessionExpired) return state;
      return state.offline ? { ...state, pendingRecovery: true } : state;
    case "REVALIDATED":
      return state.pendingRecovery
        ? { ...state, offline: false, pendingRecovery: false, shellFromCache: false }
        : state;
    case "AUTH_FAILURE":
      return { ...state, sessionExpired: true, pendingRecovery: false };
    case "UPDATE_READY":
      return { ...state, updateReady: true };
    case "UPDATE_DISMISSED":
      return { ...state, updateReady: false };
    default:
      return state;
  }
}

// --- singleton store -------------------------------------------------------

let state: ConnectivityState = INITIAL_CONNECTIVITY;
const listeners = new Set<() => void>();

export function dispatchConnectivity(event: ConnectivityEvent): void {
  const next = connectivityReducer(state, event);
  if (next === state) return;
  state = next;
  for (const fn of listeners) fn();
}

export function getConnectivityState(): ConnectivityState {
  return state;
}

export function subscribeConnectivity(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// --- mutation in-flight tracking (E-SEC-13 deferral + E-SEC-20) -----------

let mutationsInFlight = 0;
const mutationListeners = new Set<() => void>();

export function beginMutation(): void {
  mutationsInFlight += 1;
  for (const fn of mutationListeners) fn();
}

export function endMutation(): void {
  mutationsInFlight = Math.max(0, mutationsInFlight - 1);
  for (const fn of mutationListeners) fn();
}

export function getMutationsInFlight(): number {
  return mutationsInFlight;
}

export function subscribeMutations(fn: () => void): () => void {
  mutationListeners.add(fn);
  return () => {
    mutationListeners.delete(fn);
  };
}

// --- the one question mutating code asks -----------------------------------

/**
 * Mutations are blocked while the offline banner state is active, while
 * the session is expired, or while the browser itself reports offline
 * (E-SEC-20). The block happens in lib/api/client.ts BEFORE any fetch.
 */
export function isMutationBlocked(): boolean {
  if (state.offline || state.sessionExpired) return true;
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return true;
  }
  return false;
}
