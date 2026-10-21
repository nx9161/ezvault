// SPDX-License-Identifier: MIT
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./i18n/request.ts");

// Wave E (APPSEC-REVIEW-PWA): the service worker (app/sw.ts →
// public/sw.js) is built by Serwist in configurator mode AFTER
// `next build` — see serwist.config.mjs for why (Turbopack build;
// @serwist/next is webpack-only) and for the precache scope. Nothing
// about the SW changes this Next config.

const nextConfig: NextConfig = {
  // cacheComponents/PPR intentionally OFF: this is a private single-user
  // workspace — every route is dynamic (Vercel Authentication at the edge,
  // all data via browser API calls). Enabling it breaks `export const
  // runtime = 'nodejs'` / `dynamic` segment configs across app/api/**.
  //
  // Wave B1: the PDF/JP2000 render layer (lib/import/render.ts) loads
  // native/WASM server binaries — @napi-rs/canvas ships a .node addon and
  // @cornerstonejs/codec-openjpeg a .wasm, neither of which Turbopack can
  // place in a bundle. Keep all three external so Node requires them from
  // node_modules at runtime (same treatment sharp gets by default).
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas", "@cornerstonejs/codec-openjpeg"],
  // The OpenJPEG .wasm is handed to Emscripten as a filesystem path (see
  // render.ts), so static tracing cannot see it — include the render
  // layer's runtime files explicitly in every API function's bundle.
  outputFileTracingIncludes: {
    "/api/**": [
      "./node_modules/@cornerstonejs/codec-openjpeg/dist/**",
      "./node_modules/@napi-rs/canvas/**",
      "./node_modules/@napi-rs/canvas-linux-x64-gnu/**",
      "./node_modules/pdfjs-dist/**",
    ],
  },
};

export default withNextIntl(nextConfig);
