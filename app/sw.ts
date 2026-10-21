// SPDX-License-Identifier: MIT
// EZVault service worker (Wave E, APPSEC-REVIEW-PWA.md — BINDING).
//
// Architecture (approved in the review, §"Approved architecture"):
//   - Serwist precaches ONLY static build assets (content-hashed
//     /_next/static/**, favicon, PWA icons, public/*.svg, the web app
//     manifest) — revisioned per build, cache-first. Serwist's
//     `defaultCache` preset is NOT used (E-SEC-15: its stock rules
//     runtime-cache /api/ GETs and pages — rejected patterns #1/#2).
//     runtimeCaching is an empty, hand-written table; all runtime
//     behavior lives in the explicit fetch listener below.
//   - The two data-free app-shell documents ("/" and the representative
//     project shell "/pwa-project-shell", which renders the /[projectId]
//     route) are cached at install time in a build-versioned document
//     cache, behind the E-SEC-6 response guard: an auth-shaped response
//     (redirect to SSO, non-200, HTML login for an asset, Set-Cookie,
//     attachment) FAILS the install instead of being cached (E-SEC-10).
//   - Runtime runtime routes, evaluated by lib/pwa/routing.ts with the
//     E-SEC-16 exclusion list FIRST: /api/**, cross-origin (presigned
//     R2), /_vercel/**, /sw.js, non-GET/HEAD, and Range requests are
//     never intercepted. Navigations are network-first with verbatim
//     pass-through; the cached shell answers ONLY on fetch rejection
//     (E-SEC-5/8). OCR assets are lazy cache-first in a versioned
//     cache, never precached (E-SEC-4).
//   - Updates: skipWaiting + clientsClaim (E-SEC-13); activation
//     deletes every cache outside the current build's set (E-SEC-14).

/// <reference lib="esnext" />
/// <reference lib="webworker" />

import type { PrecacheEntry, SerwistGlobalConfig } from "serwist";
import { Serwist, cacheNames } from "serwist";
import {
  classifyRequest,
  isCacheableResponse,
  shellPathFor,
  OCR_ENGINE_VERSION,
  PROJECT_SHELL_PATH,
  HOME_PATH,
  type ResponseFacts,
} from "../lib/pwa/routing";

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

// --- build identity ---------------------------------------------------------
// Derived from the injected precache manifest (every entry carries a
// content revision): any new build yields new cache names, and the
// activate handler purges every cache from any other build (E-SEC-14).
const precacheEntries = self.__SW_MANIFEST ?? [];
function buildKey(entries: (PrecacheEntry | string)[]): string {
  let h1 = 0x811c9dc5;
  const mix = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h1 ^= s.charCodeAt(i);
      h1 = Math.imul(h1, 0x01000193) >>> 0;
    }
  };
  for (const e of entries) {
    if (typeof e === "string") mix(e);
    else {
      mix(e.url);
      mix(String(e.revision ?? ""));
    }
  }
  return h1.toString(36);
}
const BUILD_KEY = buildKey(precacheEntries);
const DOCUMENT_CACHE = `ezvault-documents-${BUILD_KEY}`;
const OCR_CACHE = `ezvault-ocr-tess${OCR_ENGINE_VERSION}-${BUILD_KEY}`;

// Quota budget (E-SEC-24): precache ≤ 10 MiB is measured on the build
// and reported in the wave PR; runtime writes stop at the total cap.
const TOTAL_CACHE_CAP_BYTES = 25 * 1024 * 1024;
const OCR_CACHE_CAP_BYTES = 12 * 1024 * 1024;

const serwist = new Serwist({
  precacheEntries,
  precacheOptions: { cleanupOutdatedCaches: true },
  skipWaiting: true,
  clientsClaim: true,
  navigationPreload: false,
  // Hand-written route table ONLY (see the fetch listener below).
  // Serwist's defaultCache is deliberately NOT adopted (E-SEC-15).
  runtimeCaching: [],
});

// --- helpers -----------------------------------------------------------------

function responseFacts(res: Response): ResponseFacts {
  return {
    status: res.status,
    type: res.type,
    redirected: res.redirected,
    header: (name) => res.headers.get(name),
  };
}

async function cacheUsageBytes(): Promise<number> {
  try {
    const est = await self.navigator.storage.estimate();
    return est.usage ?? 0;
  } catch {
    return 0;
  }
}

/**
 * cache.put that can never break the fetch handler (E-SEC-24): a
 * QuotaExceededError evicts the cache's oldest entry and retries once;
 * a second failure drops the write and the network response is served
 * uncached.
 */
async function safePut(
  cache: Cache,
  request: Request | string,
  response: Response,
): Promise<void> {
  try {
    await cache.put(request, response.clone());
    return;
  } catch (err) {
    if (!err || (err as DOMException).name !== "QuotaExceededError") return;
  }
  try {
    const keys = await cache.keys();
    if (keys.length > 0) await cache.delete(keys[0]);
    await cache.put(request, response.clone());
  } catch {
    /* drop the write — the page still gets its network response */
  }
}

// --- install: precache the two data-free shell documents ---------------------

async function precacheDocuments(): Promise<void> {
  const cache = await caches.open(DOCUMENT_CACHE);
  for (const path of [HOME_PATH, PROJECT_SHELL_PATH]) {
    const url = new URL(path, self.location.origin).href;
    const res = await fetch(url, { credentials: "same-origin" });
    // E-SEC-6/10: an auth-shaped or otherwise uncacheable document
    // response fails the whole install — the login page must never
    // become the cached "shell".
    if (!isCacheableResponse(responseFacts(res), "document")) {
      throw new Error(`EZVault SW: refusing to cache shell document ${path}`);
    }
    await safePut(cache, url, res);
  }
}

// --- activate: total purge of prior builds (E-SEC-14) -------------------------

async function purgeStaleCaches(): Promise<void> {
  const expected = new Set([DOCUMENT_CACHE, OCR_CACHE, cacheNames.precache]);
  const keys = await caches.keys();
  await Promise.all(
    keys.filter((k) => !expected.has(k)).map((k) => caches.delete(k)),
  );
}

// --- runtime routes ------------------------------------------------------------

async function handleNavigation(event: FetchEvent): Promise<Response> {
  const request = event.request;
  try {
    // Verbatim pass-through: any status, any redirect, any challenge
    // the platform answers with is returned untouched (E-SEC-8). The
    // cached shell is served ONLY when the fetch rejects.
    return await fetch(request);
  } catch (err) {
    const { pathname } = new URL(request.url);
    const shellPath = shellPathFor(pathname);
    if (shellPath) {
      const cache = await caches.open(DOCUMENT_CACHE);
      const shell = await cache.match(
        new URL(shellPath, self.location.origin).href,
        { ignoreSearch: true },
      );
      if (shell) {
        // Tell the booting page it came from the cache so it enters
        // the degraded offline mode of E-SEC-19 immediately.
        event.waitUntil(
          (async () => {
            const client = event.clientId
              ? await self.clients.get(event.clientId)
              : undefined;
            client?.postMessage({ type: "EZVAULT_SHELL_FROM_CACHE" });
          })(),
        );
        return shell;
      }
    }
    throw err;
  }
}

async function handleOcr(request: Request): Promise<Response> {
  const cache = await caches.open(OCR_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  if (isCacheableResponse(responseFacts(res), "ocr")) {
    const length = Number(res.headers.get("content-length") ?? 0);
    const usage = await cacheUsageBytes();
    if (
      length <= OCR_CACHE_CAP_BYTES &&
      usage + length <= TOTAL_CACHE_CAP_BYTES
    ) {
      await safePut(cache, request, res);
    }
  }
  return res;
}

// The E-SEC-16 exclusion list is evaluated inside classifyRequest,
// FIRST, before any route below can match. "bypass" and "static"
// requests are not answered here at all: bypass goes straight to the
// network; static assets fall through to Serwist's precache route.
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const cls = classifyRequest({
    url: request.url,
    origin: self.location.origin,
    method: request.method,
    mode: request.mode,
    hasRange: request.headers.has("range"),
  });
  if (cls === "navigation") {
    event.respondWith(handleNavigation(event));
  } else if (cls === "ocr") {
    event.respondWith(handleOcr(request));
  }
});

self.addEventListener("install", (event) => {
  event.waitUntil(precacheDocuments());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(purgeStaleCaches());
});

// E-SEC-10(a): on an auth-shaped failure the client asks the SW to drop
// the document caches before the re-auth navigation. The OCR cache
// (public assets only) may persist.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "EZVAULT_PURGE_DOCUMENT_CACHES") {
    event.waitUntil(
      (async () => {
        const keys = await caches.keys();
        await Promise.all(
          keys
            .filter((k) => k.startsWith("ezvault-documents-"))
            .map((k) => caches.delete(k)),
        );
      })(),
    );
  }
});

serwist.addEventListeners();
