// SPDX-License-Identifier: MIT
// e2e/rate-limit.spec.ts — hardening H2: concurrent burst → 429s, zero 500s.
// The durable buckets live in Neon (lib/ratelimit.ts), so this spec needs a
// live database: OWNER-BLOCKED until E2E_LIVE=1.
//
// Target: POST /api/import/presign (bucket `import:presign`, capacity 30,
// refill 0.5/s). A 40-concurrent burst must trip 429s while the server stays
// up — every response is 429, 4xx, or 2xx; a single 500 fails the spec.
// NOTE: presign requires a project; E2E_PROJECT_ID must point at a scratch
// project on the target deploy.

import { test, expect } from "@playwright/test";

test("40-burst on /api/import/presign → 429s, zero 500s", async ({
  request,
}) => {
  test.skip(
    !process.env.E2E_LIVE,
    "OWNER-BLOCKED: live infra — durable rate buckets need Neon",
  );
  const projectId = process.env.E2E_PROJECT_ID;
  test.skip(!projectId, "E2E_PROJECT_ID is required for the live run");

  const results = await Promise.all(
    Array.from({ length: 40 }, () =>
      request.post("/api/import/presign", {
        data: { project_id: projectId, files: [] },
      }),
    ),
  );
  const statuses = results.map((r) => r.status());
  expect(statuses.filter((s) => s === 500)).toHaveLength(0);
  expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  for (const r of results) {
    const tooMany = r.status() === 429;
    if (tooMany) {
      expect(r.headers()["retry-after"]).toBeTruthy();
    }
  }
});
