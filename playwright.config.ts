// SPDX-License-Identifier: MIT
// Playwright E2E config (W2-C). Chromium ONLY — single browser keeps CI at $0.
// Base URL: E2E_BASE_URL (default: local production server). For protected
// Vercel previews set E2E_BASE_URL + E2E_BYPASS (the x-vercel-protection-bypass
// header — Deployment Protection stays ON, never disabled for tests).
// Live-infra specs (Neon/R2) skip with reason "OWNER-BLOCKED: live infra"
// unless E2E_LIVE=1 — they are NOT faked.
//
// Local CI flow:
//   npm ci && npm run build
//   npx playwright install --with-deps chromium   (browsers are NOT installed
//                                                 by postinstall — deliberate)
//   npx playwright test
// Manual live run (post-deploy, owner taps done):
//   E2E_LIVE=1 E2E_BASE_URL=https://<preview>.vercel.app E2E_BYPASS=<secret> \
//     npx playwright test

import { defineConfig } from "@playwright/test";

const bypass = process.env.E2E_BYPASS;

export default defineConfig({
  testDir: "./e2e",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  retries: 0,
  workers: 1, // single-user app; serial keeps rate-limit accounting honest
  reporter: [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    ...(bypass
      ? { extraHTTPHeaders: { "x-vercel-protection-bypass": bypass } }
      : {}),
  },
  // Local runs serve the production build; a live base URL disables this.
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: "npm run start -- --port 3000",
        port: 3000,
        reuseExistingServer: true,
        timeout: 120_000,
        env: {
          // Pre-env on purpose: no DATABASE_URL → the 503 not_configured
          // path is what the auth-gate spec asserts locally.
        },
      },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
