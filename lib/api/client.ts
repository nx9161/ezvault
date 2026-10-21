// SPDX-License-Identifier: MIT
// Thin fetch wrapper for the /api/* surface (architecture §2 + CONTRACT.md).
// Mutating routes carry `clientOpId` (UUID) for server-side dedupe.
//
// Wave E (APPSEC-REVIEW-PWA §E): this wrapper is also the offline gate.
//   - Mutations are blocked HERE, before any fetch, while the offline
//     or session-expired state is active (E-SEC-20) — no optimistic UI,
//     no queue, no replay (E-SEC-17).
//   - Fetch outcomes feed the connectivity state machine: a network
//     rejection marks offline; a successful /api response starts the
//     recovery path (the banner clears only after SWR revalidation);
//     an auth-shaped failure (E-SEC-9) raises the session-expired
//     state. Nothing is ever cached here — SWR stays in-memory only
//     and the service worker never caches /api (E-SEC-1).

import {
  beginMutation,
  dispatchConnectivity,
  endMutation,
  isMutationBlocked,
} from "@/lib/pwa/connectivity";
import { isApiPath, isAuthShapedFailure } from "@/lib/pwa/routing";

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/** A mutation attempted while offline / session-expired (E-SEC-20). */
export class OfflineBlockedError extends ApiError {
  constructor() {
    super(
      0,
      "You are offline — changes can't be saved right now. Anything shown is from before the connection dropped.",
    );
    this.name = "OfflineBlockedError";
  }
}

export function newClientOpId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

interface ApiOptions extends Omit<RequestInit, "body"> {
  body?: unknown;
  /** attach a clientOpId for idempotent mutation */
  opId?: string;
  /** keep the response as a blob (downloads) */
  asBlob?: boolean;
}

export async function api<T = unknown>(
  path: string,
  opts: ApiOptions = {},
): Promise<T> {
  const { body, opId, asBlob, headers, ...rest } = opts;
  const method = (rest.method ?? "GET").toUpperCase();
  const isMutation = !["GET", "HEAD"].includes(method);

  // E-SEC-20: blocked at the client layer BEFORE any fetch is
  // attempted — no network attempt, no optimistic state, no queue.
  if (isMutation && isMutationBlocked()) {
    throw new OfflineBlockedError();
  }

  const payload =
    body === undefined
      ? undefined
      : isMutation && opId
        ? { ...(body as Record<string, unknown>), clientOpId: opId }
        : body;

  if (isMutation) beginMutation();
  let res: Response;
  try {
    res = await fetch(path, {
      ...rest,
      method,
      headers: {
        ...(payload !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(isMutation && opId && payload === undefined
          ? { "x-client-op-id": opId }
          : {}),
        ...(headers ?? {}),
      },
      body: payload !== undefined ? JSON.stringify(payload) : undefined,
    });
  } catch (err) {
    // A rejected fetch is a connectivity failure (E-SEC-19 trigger).
    dispatchConnectivity("API_NETWORK_FAILURE");
    throw err;
  } finally {
    if (isMutation) endMutation();
  }

  // Feed the connectivity machine (E-SEC-9/19). Only /api traffic
  // counts: it is the app's data plane and its auth canary.
  try {
    const pathname = new URL(path, window.location.origin).pathname;
    if (isApiPath(pathname)) {
      if (
        isAuthShapedFailure({
          status: res.status,
          contentType: res.headers.get("content-type"),
          redirected: res.redirected,
          responseUrl: res.url,
          origin: window.location.origin,
        })
      ) {
        dispatchConnectivity("AUTH_FAILURE");
      } else if (res.ok) {
        dispatchConnectivity("API_SUCCESS");
      }
    }
  } catch {
    /* connectivity bookkeeping must never break a request */
  }

  if (!res.ok) {
    let detail: unknown = null;
    let message = `Request failed (${res.status})`;
    try {
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("application/json")) {
        detail = await res.json();
        const d = detail as Record<string, unknown>;
        if (typeof d?.error === "string") message = d.error;
        else if (typeof d?.message === "string") message = d.message;
      } else {
        const text = await res.text();
        if (text) message = text.slice(0, 300);
      }
    } catch {
      /* keep generic message */
    }
    throw new ApiError(res.status, message, detail);
  }

  if (asBlob) return (await res.blob()) as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return (await res.json()) as T;
  return (await res.text()) as T;
}

export const get = <T>(path: string, init?: RequestInit) =>
  api<T>(path, { ...init, method: "GET" });
export const post = <T>(path: string, body?: unknown, opts?: ApiOptions) =>
  api<T>(path, { ...opts, method: "POST", body });
export const patch = <T>(path: string, body?: unknown, opts?: ApiOptions) =>
  api<T>(path, { ...opts, method: "PATCH", body });
export const del = <T>(path: string, body?: unknown, opts?: ApiOptions) =>
  api<T>(path, { ...opts, method: "DELETE", body });
