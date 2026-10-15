// SPDX-License-Identifier: MIT
// e2e/auth-gate.spec.ts — B7 smoke as E2E (Dossier H5/H7 adjacency).
// Runs locally against `next start` with NO env (pre-env): the health 503
// path is real and green here. The root-302 expectation needs Vercel
// Deployment Protection, so it skips as OWNER-BLOCKED until a protected
// preview exists.

import { test, expect } from "@playwright/test";

test("GET /api/health → 503 not_configured without DATABASE_URL", async ({
  request,
}) => {
  const res = await request.get("/api/health");
  expect(res.status()).toBe(503);
  const body = await res.json();
  expect(body.status).toBe("not_configured");
});

test("unauthenticated GET / → 302 to login (Vercel Authentication)", async ({
  request,
}) => {
  test.skip(
    !process.env.E2E_LIVE,
    "OWNER-BLOCKED: live infra — needs a protected Vercel preview",
  );
  const res = await request.get("/", { maxRedirects: 0 });
  expect(res.status()).toBe(302);
  expect(res.headers()["location"] ?? "").toContain("vercel.com");
});

test("unauthenticated GET /api/health on a CONFIGURED deploy → 200, no leak", async ({
  request,
}) => {
  test.skip(
    !process.env.E2E_LIVE,
    "OWNER-BLOCKED: live infra — needs DATABASE_URL on the target",
  );
  const res = await request.get("/api/health");
  expect(res.status()).toBe(200);
  const text = await res.text();
  expect(text).not.toMatch(/sk_live|postgres:\/\/|AKIA/i);
});
