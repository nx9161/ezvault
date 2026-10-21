// SPDX-License-Identifier: MIT
// e2e/hotfix-dialog-workspace.spec.ts — regression coverage for the two
// live bugs of 2026-10-21:
//
// Bug A (iOS keyboard dismissed per character): Dialog's focus-trap
// effect was keyed on the inline `onClose` prop, so every parent
// re-render (each keystroke) refired cleanup (focus → trigger) + setup
// (focus → close button), stealing focus from the name input.
// components/ui/Dialog.tsx now holds onClose in a ref and traps once.
//
// Bug B (workspace page crash, React #185 "Maximum update depth
// exceeded"): lib/commands/bus.ts fed useSyncExternalStore an uncached
// snapshot and invoked the listener synchronously in subscribe().
// StatusBar (workspace-only) looped on mount; every /[projectId] page
// hit the error boundary while all APIs returned 200. Stacked behind
// it: useLists returned the raw { lists } envelope while consumers
// expect ListNode[] — Sidebar's buildTree threw "lists is not
// iterable" as soon as the lists fetch landed. Both fixed at the
// source (bus contract + hook unwrapping).
//
// Both need a live DB (the home page needs /api/projects to settle; the
// workspace needs a real project), so they skip unless E2E_LIVE=1 —
// same OWNER-BLOCKED convention as the rest of the live suite. The
// scratch project is created and deleted inside the spec; no other
// project is touched.

import { test, expect } from "@playwright/test";

test.skip(
  !process.env.E2E_LIVE,
  "OWNER-BLOCKED: live infra — needs Neon-backed server (E2E_BASE_URL)",
);

test("Bug A: typing in the New Project dialog keeps focus in the input", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "New project" }).click();
  const input = page.getByLabel("Project name");
  await expect(input).toBeVisible();
  await input.click();
  await page.keyboard.type("Naman", { delay: 40 });
  await expect(input).toHaveValue("Naman");
  const stillFocused = await input.evaluate(
    (el) => el === document.activeElement,
  );
  expect(stillFocused, "focus must stay in the input while typing").toBe(true);
  await page.keyboard.press("Escape");
  await expect(input).toBeHidden();
});

test("Bug B: workspace page renders (no React #185 error boundary)", async ({
  page,
  request,
}) => {
  const name = `e2e-hotfix-scratch-${Date.now()}`;
  const create = await request.post("/api/projects", { data: { name } });
  expect(create.ok()).toBeTruthy();
  const scratchId = ((await create.json()) as { id: string }).id;

  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  try {
    await page.goto(`/${scratchId}`);
    // TopBar shows the project name; StatusBar is the useCommandBus
    // consumer whose mount looped before the fix.
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    await expect(page.locator('footer[aria-label="status"]')).toBeVisible();
    // Let every SWR fetch land — the lists-envelope throw only fired
    // once the lists response arrived, after first paint.
    await page.waitForTimeout(3000);
    await expect(page.getByText(/couldn.t load/i)).toHaveCount(0);
    expect(
      pageErrors,
      "no uncaught page errors (React #185 loop, lists-is-not-iterable, …)",
    ).toEqual([]);
  } finally {
    // Best-effort cleanup: project DELETE also sweeps R2 via the S3
    // SDK, which some sandboxes cannot reach (TLS-intercepted egress);
    // the render assertions above are the strict part of this spec.
    const del = await request.delete(`/api/projects/${scratchId}`);
    if (!del.ok()) {
      console.warn(
        `scratch cleanup: DELETE ${scratchId} → ${del.status()} (leftover row may need manual removal)`,
      );
    }
  }
});
