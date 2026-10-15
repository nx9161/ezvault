// SPDX-License-Identifier: MIT
// Framework-free tour trigger (D-INTb). Registry entries and menu items
// call startTour(); components/tour/TourLauncher.tsx listens for the event
// and runs driver.js (dynamically imported, so the 7.3 KB only loads when
// a tour actually starts).

export const TOUR_START_EVENT = "ezvault:start-tour";

/** First-run flag: set when a tour run completes. No auto-start. */
export const TOUR_DONE_KEY = "ezvault:tour:v1";

export function startTour() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(TOUR_START_EVENT));
  }
}
