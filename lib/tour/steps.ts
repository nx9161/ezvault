// SPDX-License-Identifier: MIT
// Tour step definitions (D-INTb). Steps reference the stable data-tour
// anchors; copy lives under the tour.* i18n keys (plain words, ≤8 steps).
// Steps whose anchor is absent (mobile layouts, unopened dialogs, empty
// viewer) are filtered out at runtime by TourLauncher — never broken.

import type { DriveStep } from "driver.js";

export function buildSteps(t: (key: string) => string): DriveStep[] {
  const step = (id: string, element?: string): DriveStep => ({
    ...(element ? { element } : {}),
    popover: {
      title: t(`${id}Title`),
      description: t(`${id}Body`),
    },
  });
  return [
    step("welcome"),
    step("lists", '[data-tour="sidebar-lists"]'),
    step("tags", '[data-tour="sidebar-tags"]'),
    step("grid", '[data-tour="item-grid"]'),
    step("viewer", '[data-tour="viewer-toolbar"]'),
    step("palette", '[data-tour="palette-button"]'),
    step("search", '[data-tour="global-search"]'),
    step("shortcuts"),
  ];
}
