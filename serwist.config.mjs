// SPDX-License-Identifier: MIT
/**
 * Serwist configurator-mode build (Wave E, APPSEC-REVIEW-PWA).
 *
 * Why configurator mode: this repo builds with Turbopack (Next 16's
 * default) and @serwist/next is webpack-only — its own build warning
 * offers Turbopack users "@serwist/turbopack" or "configurator mode".
 * The route-handler variant was rejected for this app: it can only
 * serve the SW from a dynamic [path] segment, always sets a
 * scope-widening `Service-Worker-Allowed: /` header (E-SEC-11 forbids
 * it), and a root dynamic segment would collide with /[projectId].
 * Configurator mode instead compiles app/sw.ts → public/sw.js with
 * esbuild after `next build` (see the "build" script in package.json):
 * a real static /sw.js at scope "/", no extra headers, no app routes.
 *
 * Precache scope (E-SEC-3/4/24): content-hashed build assets under
 * .next/static/**, the public SVG set, the PWA icons, and the web app
 * manifest — revisioned per build by @serwist/build. The OCR payload
 * under public/ocr/ is NEVER precached (globIgnores + the patterns
 * below never reach it); the two shell documents are cached by the SW
 * itself at install behind the E-SEC-6 guard (see app/sw.ts).
 */
import { spawnSync } from "node:child_process";

const revision =
  spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).stdout?.trim() ||
  "dev";

export default {
  swSrc: "app/sw.ts",
  swDest: "public/sw.js",
  globDirectory: ".",
  globPatterns: [
    ".next/static/**/*.{js,css,ico,png,svg,json,webmanifest}",
    "public/*.svg",
    "public/icons/*.png",
  ],
  globIgnores: ["**/ocr/**", "public/sw.js", "**/*.map"],
  modifyURLPrefix: {
    ".next/static/": "/_next/static/",
    "public/": "/",
  },
  additionalPrecacheEntries: [{ url: "/manifest.webmanifest", revision }],
  maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
};
