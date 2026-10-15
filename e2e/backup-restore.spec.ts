// SPDX-License-Identifier: MIT
// e2e/backup-restore.spec.ts — application-level export → restore-to-scratch
// round-trip: JSON-LD export of project A, import into scratch project B,
// counts match (Dossier H7 adjacency).
// OWNER-BLOCKED: needs live Neon + R2 (export reads real photo bytes).
// The restore target is a SCRATCH project — never production data.
//
// (The monthly off-site backup itself is a database dump + R2 object per
// docs/RUNBOOK.md, verified by scripts/restore-scratch.sh — outside HTTP E2E.)

import { test, expect } from "@playwright/test";

test("JSON-LD export → import-to-scratch: counts match", async ({
  request,
}) => {
  test.skip(
    !process.env.E2E_LIVE,
    "OWNER-BLOCKED: live infra — export/import needs Neon + R2",
  );

  const createProject = async (name: string): Promise<string> => {
    const r = await request.post("/api/projects", { data: { name } });
    expect(r.ok()).toBeTruthy();
    return (await r.json()).id as string;
  };
  const counts = async (projectId: string) => {
    const r = await request.get(`/api/projects/${projectId}/items?limit=1`);
    expect(r.ok()).toBeTruthy();
    return { items: (await r.json()).total as number };
  };

  const projectA = await createProject("e2e-export-source");
  const before = await counts(projectA);

  // Export A as JSON-LD (the archive format).
  const exp = await request.get(`/api/projects/${projectA}/export/jsonld`);
  expect(exp.ok()).toBeTruthy();
  const doc = await exp.json();
  expect(doc["@context"] ?? doc.context).toBeTruthy();

  // Import the document into scratch project B.
  const projectB = await createProject("e2e-import-restore-target");
  const imp = await request.post("/api/import/jsonld", {
    data: { project_id: projectB, document: doc },
  });
  expect(imp.ok()).toBeTruthy();

  const after = await counts(projectB);
  expect(after.items).toBe(before.items);

  await request.delete(`/api/projects/${projectA}`);
  await request.delete(`/api/projects/${projectB}`);
});
