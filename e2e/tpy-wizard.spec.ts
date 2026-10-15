// SPDX-License-Identifier: MIT
// e2e/tpy-wizard.spec.ts — .tpy wizard on COMMITTED SYNTHETIC fixtures
// (e2e/fixtures/ — never the owner's real 48-item file in CI).
// OWNER-BLOCKED: the wizard needs live Neon + R2 (staging uploads,
// sql.js analyze, run transactions). Skips with reason "OWNER-BLOCKED:
// live infra" unless E2E_LIVE=1.
//
// Selectors were written against the 2026-10-15 tree (data-tour hooks +
// messages/en.json copy). Standard: 3 items / 4 photos / 1 selection /
// 2 notes / 3 metadata rows / 2 tags / 1 list. Advanced: 2 items / 3 photos
// with missing originals, re-linked from e2e/fixtures/advanced-originals/.
// Both specs re-run the wizard and assert NO duplicates.

import { test, expect } from "@playwright/test";
import { join } from "node:path";

const FX = join(__dirname, "fixtures");
const LIVE = !!process.env.E2E_LIVE;

test.beforeEach(async () => {
  test.skip(!LIVE, "OWNER-BLOCKED: live infra — wizard needs Neon + R2");
});

async function createProject(request: any, name: string): Promise<string> {
  const r = await request.post("/api/projects", { data: { name } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).id as string;
}

async function itemCount(request: any, projectId: string): Promise<number> {
  const r = await request.get(`/api/projects/${projectId}/items?limit=1`);
  expect(r.ok()).toBeTruthy();
  return (await r.json()).total as number;
}

async function photoCount(request: any, projectId: string): Promise<number> {
  const r = await request.get(
    `/api/projects/${projectId}/items?limit=100`,
  );
  const items = (await r.json()).items as { photo_count: number }[];
  return items.reduce((n, i) => n + (i.photo_count ?? 0), 0);
}

async function openWizard(page: any) {
  await page.locator('button[aria-haspopup="menu"]').first().click();
  await page.getByRole("menuitem", { name: "Import from .tpy…" }).click();
  await expect(
    page.getByRole("dialog").getByText("Import from .tpy"),
  ).toBeVisible();
}

async function runWizardToReport(
  page: any,
  kind: "standard" | "advanced",
  tpy: string,
  assets?: string,
) {
  await openWizard(page);
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("radio", {
      name:
        kind === "standard"
          ? "My photos are inside the project"
          : "My photos are separate files on my computer",
    })
    .click();
  await dialog.locator('input[accept=".tpy"]').setInputFiles(join(FX, tpy));
  if (assets) {
    await dialog.locator('input[accept=".zip"]').setInputFiles(join(FX, assets));
  }
  await dialog.getByRole("button", { name: "Next", exact: true }).click();
  // analyze → map
  await expect(dialog.locator('[data-tour="tpy-map"]')).toBeVisible({
    timeout: 120_000,
  });
  await dialog.getByRole("button", { name: "Run import" }).click();
  // run → report
  await expect(dialog.locator('[data-tour="tpy-report"]')).toBeVisible({
    timeout: 180_000,
  });
  return dialog;
}

test("Standard: fixture imports 3 items / 4 photos, re-run adds nothing", async ({
  page,
  request,
}) => {
  const projectId = await createProject(request, "e2e-tpy-standard");
  await page.goto(`/${projectId}`);

  const dialog = await runWizardToReport(
    page,
    "standard",
    "standard.tpy",
    "standard-assets.zip",
  );
  await expect(dialog.getByText("Import complete")).toBeVisible();
  await dialog.getByRole("button", { name: "Done" }).click();

  expect(await itemCount(request, projectId)).toBe(3);
  expect(await photoCount(request, projectId)).toBe(4);

  // Re-run the same fixture: idempotent, no duplicates.
  const dialog2 = await runWizardToReport(
    page,
    "standard",
    "standard.tpy",
    "standard-assets.zip",
  );
  await dialog2.getByRole("button", { name: "Done" }).click();
  expect(await itemCount(request, projectId)).toBe(3);
  expect(await photoCount(request, projectId)).toBe(4);

  await request.delete(`/api/projects/${projectId}`);
});

test("Advanced: missing originals re-link by checksum, counts intact", async ({
  page,
  request,
}) => {
  const projectId = await createProject(request, "e2e-tpy-advanced");
  await page.goto(`/${projectId}`);

  const dialog = await runWizardToReport(page, "advanced", "advanced.tpy");
  await expect(dialog.getByText("Some originals are missing")).toBeVisible();

  await dialog
    .locator('input[type="file"][multiple]')
    .setInputFiles([
      join(FX, "advanced-originals", "adv-a.png"),
      join(FX, "advanced-originals", "adv-b.png"),
      join(FX, "advanced-originals", "adv-c.png"),
    ]);
  // QA: the success confirmation is a shell-level toast (WorkspaceClient
  // <Toasts/>), not dialog content — scope it to the page.
  await expect(page.getByText("3 originals re-linked.")).toBeVisible({
    timeout: 120_000,
  });
  await dialog.getByRole("button", { name: "Done" }).click();

  expect(await itemCount(request, projectId)).toBe(2);
  expect(await photoCount(request, projectId)).toBe(3);

  // No photo may remain missing after the re-link.
  const items = (
    await (await request.get(`/api/projects/${projectId}/items?limit=100`)).json()
  ).items as { id: string }[];
  for (const item of items) {
    const pr = await request.get(
      `/api/projects/${projectId}/items/${item.id}/photos`,
    );
    const photos = (await pr.json()).items as { missing_original: boolean }[];
    expect(photos.every((p) => !p.missing_original)).toBeTruthy();
  }

  await request.delete(`/api/projects/${projectId}`);
});
