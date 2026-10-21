// SPDX-License-Identifier: MIT
// PWA service-worker routing policy — PURE module (Wave E, APPSEC-REVIEW-PWA).
//
// This module is the single source of truth for what the service worker
// may touch. It is imported by app/sw.ts (the SW source) AND by the unit
// tests (test/pwa-routing.test.mjs), so it must stay free of DOM, SW, and
// framework globals: plain data in, plain decisions out.
//
// The taxonomy implements APPSEC-REVIEW-PWA.md §A + E-SEC-16: the hard
// exclusion list is evaluated FIRST, before any cache route.

/** What the SW should do with a request. */
export type SwRouteClass =
  /** Never respondWith: plain network pass-through (or browser default). */
  | "bypass"
  /** Network-first navigation; cached shell ONLY on fetch rejection. */
  | "navigation"
  /** Lazy runtime cache-first for the self-hosted OCR engine assets. */
  | "ocr"
  /** Static asset: left for the Serwist precache route (cache-first). */
  | "static";

export interface RequestFacts {
  /** Absolute URL of the request. */
  url: string;
  /** The origin the SW is registered on (self.location.origin). */
  origin: string;
  method?: string;
  /** request.mode ("navigate" for document navigations). */
  mode?: string;
  /** True when the request carries a Range header (E-SEC-23). */
  hasRange?: boolean;
}

/** The representative project-shell document (see app/sw.ts header). */
export const PROJECT_SHELL_PATH = "/pwa-project-shell";
export const HOME_PATH = "/";
export const SW_PATH = "/sw.js";
export const MANIFEST_PATH = "/manifest.webmanifest";

/** Tesseract version embedded in the OCR runtime cache name (E-SEC-4). */
export const OCR_ENGINE_VERSION = "7.0.0";

/**
 * The exact OCR asset allowlist (E-SEC-4/15): the files shipped under
 * public/ocr/ by scripts/sync-ocr-assets.mjs. Cache-first applies to
 * these paths ONLY, and never to a URL carrying a query string.
 */
export const OCR_ASSET_PATHS: ReadonlySet<string> = new Set([
  "/ocr/worker.min.js",
  "/ocr/tesseract-core-lstm.js",
  "/ocr/tesseract-core-lstm.wasm",
  "/ocr/tesseract-core-simd-lstm.js",
  "/ocr/tesseract-core-simd-lstm.wasm",
  "/ocr/tesseract-core-relaxedsimd-lstm.js",
  "/ocr/tesseract-core-relaxedsimd-lstm.wasm",
  "/ocr/lang/eng.traineddata.gz",
]);

/** First path segments that are never an app document route. */
const NON_DOCUMENT_SEGMENTS: ReadonlySet<string> = new Set([
  "api",
  "ocr",
  "_next",
  "_vercel",
  "icons",
  "sw.js",
  "manifest.webmanifest",
  "favicon.ico",
]);

/**
 * True when `pathname` is an app-shell document route: "/" or a single
 * segment (the /[projectId] route), excluding reserved segments.
 * Lookalikes such as "/apiary" are single-segment app paths, NOT API
 * paths (E-SEC-16 QA table) — they classify as documents here.
 */
export function isShellPath(pathname: string): boolean {
  if (pathname === HOME_PATH) return true;
  const m = /^\/([^/]+)\/?$/.exec(pathname);
  if (!m) return false;
  return !NON_DOCUMENT_SEGMENTS.has(m[1]);
}

/** Which precached shell document serves `pathname` offline, if any. */
export function shellPathFor(pathname: string): string | null {
  if (pathname === HOME_PATH) return HOME_PATH;
  if (isShellPath(pathname)) return PROJECT_SHELL_PATH;
  return null;
}

/** True for the /api/** surface — exact segment match, case-sensitive. */
export function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * Classify a request. The E-SEC-16 exclusion list is evaluated before
 * any cache route, in this order:
 *   1. non-GET/HEAD methods (E-SEC-17)        → bypass
 *   2. unparseable / cross-origin URLs (E-SEC-2, incl. presigned R2)
 *                                               → bypass
 *   3. /sw.js itself, /_vercel/** (E-SEC-7/16) → bypass
 *   4. /api/** — every method, every status (E-SEC-1) → bypass
 *   5. Range requests (E-SEC-23)               → bypass
 *   6. navigations (E-SEC-8)                   → navigation
 *   7. OCR allowlist, no query string (E-SEC-4)→ ocr
 *   8. everything else same-origin            → static (precache route)
 */
export function classifyRequest(facts: RequestFacts): SwRouteClass {
  const method = (facts.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") return "bypass";

  let url: URL;
  try {
    url = new URL(facts.url);
  } catch {
    return "bypass";
  }
  if (url.origin !== facts.origin) return "bypass";

  const { pathname } = url;
  if (pathname === SW_PATH) return "bypass";
  if (pathname === "/_vercel" || pathname.startsWith("/_vercel/")) {
    return "bypass";
  }
  if (isApiPath(pathname)) return "bypass";
  if (facts.hasRange) return "bypass";

  if (facts.mode === "navigate") return "navigation";

  if (OCR_ASSET_PATHS.has(pathname)) {
    // Query-bearing OCR URLs are never cached (E-SEC-4/15): plain network.
    return url.search ? "bypass" : "ocr";
  }

  return "static";
}

// ---------------------------------------------------------------------------
// Response cacheability guard (E-SEC-6 / E-SEC-25)
// ---------------------------------------------------------------------------

export interface ResponseFacts {
  status: number;
  /** Response.type: "basic" | "cors" | "opaque" | "opaqueredirect" | … */
  type?: string;
  redirected?: boolean;
  /** Header lookup by lowercase name; null when absent. */
  header: (name: string) => string | null;
}

export type CacheClass = "document" | "ocr" | "static";

const CONTENT_TYPE_ALLOWLIST: Record<CacheClass, RegExp> = {
  document: /^text\/html\b/i,
  ocr: /^(application\/javascript|text\/javascript|application\/wasm|application\/gzip|application\/octet-stream)\b/i,
  static:
    /^(text\/javascript|application\/javascript|text\/css|image\/(png|jpeg|svg\+xml|x-icon|vnd\.microsoft\.icon|webp|avif)|font\/|application\/(font|wasm|manifest\+json|json))\b/i,
};

/**
 * A response may enter a cache ONLY when every E-SEC-6/25 check passes:
 * status exactly 200, not redirected, same-origin type ("basic"),
 * no Set-Cookie, no attachment disposition, no `Vary: *`, and a
 * Content-Type on the allowlist for its class.
 */
export function isCacheableResponse(
  facts: ResponseFacts,
  cls: CacheClass,
): boolean {
  if (facts.status !== 200) return false;
  if (facts.redirected) return false;
  if (facts.type !== undefined && facts.type !== "basic") return false;
  if (facts.header("set-cookie")) return false;
  const disposition = facts.header("content-disposition");
  if (disposition && /attachment/i.test(disposition)) return false;
  const vary = facts.header("vary");
  if (vary && vary.split(",").map((v) => v.trim()).includes("*")) return false;
  const contentType = facts.header("content-type");
  if (!contentType) return false;
  return CONTENT_TYPE_ALLOWLIST[cls].test(contentType);
}

// ---------------------------------------------------------------------------
// Auth-shaped API failure detection (E-SEC-9)
// ---------------------------------------------------------------------------

export interface ApiResponseFacts {
  status: number;
  contentType?: string | null;
  redirected?: boolean;
  /** Final URL after redirects (res.url). */
  responseUrl?: string;
  /** The origin the API call was made on. */
  origin: string;
}

/**
 * An /api response is "auth-shaped" — evidence the Vercel SSO session is
 * gone — when the fetch was redirected to a non-app origin, the body is
 * HTML (the platform gate answering an API call), or the status is
 * 401/403. API routes in this app answer JSON (or files/text), never
 * HTML, and the human browser path never legitimately earns a 401/403.
 */
export function isAuthShapedFailure(facts: ApiResponseFacts): boolean {
  if (facts.redirected && facts.responseUrl) {
    try {
      if (new URL(facts.responseUrl).origin !== facts.origin) return true;
    } catch {
      /* unparseable final URL: fall through to the other signals */
    }
  }
  if (facts.status === 401 || facts.status === 403) return true;
  if (facts.contentType && /text\/html/i.test(facts.contentType)) return true;
  return false;
}
