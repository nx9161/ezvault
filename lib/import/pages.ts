// SPDX-License-Identifier: MIT
/**
 * lib/import/pages.ts — multi-page split planning (Wave B1, parity row 34).
 *
 * Pure planning helpers shared by the process pipeline and its tests:
 * given a source file's page count and the import options, decide how many
 * photo rows the file produces and which 0-based page each row renders.
 *
 * Tropy behavior (clean-room, behavior only): a multi-page PDF/TIFF
 * imports as ONE item whose photos are the pages in order, unless the
 * user groups it — EZVault's ImportDialog checkbox is phrased positively
 * as "Group multi-page files into one item": unchecked (the default) =
 * split into separate items, one per page; checked = one item, one photo
 * per page. Either way every page becomes its own photo row recording its
 * 0-based `page` number (photos.page, Tropy parity). A single-page file
 * always produces exactly one photo on page 0.
 */

/** Hard cap on pages split out of one file (runaway-file guard). */
export const MAX_SPLIT_PAGES = 500;

export interface PagePlanEntry {
  /** 0-based page index inside the source file (photos.page). */
  page: number;
  /** Position of the photo within its item (photos.position). */
  position: number;
  /** True when this entry's photo starts a new item. */
  newItem: boolean;
}

/**
 * Plan the photo rows for one multi-page-capable file.
 *
 * @param pageCount pages in the source file (≥1; clamped to MAX_SPLIT_PAGES)
 * @param groupIntoItem true = all pages under one item (photos ordered by
 *   page); false = one item per page (each photo is position 0 of its item)
 */
export function planPageSplit(pageCount: number, groupIntoItem: boolean): PagePlanEntry[] {
  const n = Math.max(1, Math.min(MAX_SPLIT_PAGES, Math.floor(pageCount) || 1));
  const out: PagePlanEntry[] = [];
  for (let page = 0; page < n; page++) {
    out.push({
      page,
      position: groupIntoItem ? page : 0,
      newItem: groupIntoItem ? page === 0 : true,
    });
  }
  return out;
}

/** How many photo rows a file with `pageCount` pages produces. */
export function splitPhotoCount(pageCount: number): number {
  return Math.max(1, Math.min(MAX_SPLIT_PAGES, Math.floor(pageCount) || 1));
}
