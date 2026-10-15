// SPDX-License-Identifier: MIT
// Thin fetch wrapper for the /api/* surface (architecture §2 + CONTRACT.md).
// Mutating routes carry `clientOpId` (UUID) for server-side dedupe.

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

  const payload =
    body === undefined
      ? undefined
      : isMutation && opId
        ? { ...(body as Record<string, unknown>), clientOpId: opId }
        : body;

  const res = await fetch(path, {
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
