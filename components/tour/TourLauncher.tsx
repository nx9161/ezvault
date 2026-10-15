// SPDX-License-Identifier: MIT
// Tour mount point (D-INTb): renders in the workspace shell. Listens for
// the ezvault:start-tour event, then dynamically imports driver.js (the
// 7.3 KB only loads when a tour actually starts) and drives the steps
// from lib/tour/steps.ts. The 0.9 KB driver.css is a static import —
// negligible, and it keeps the popover styled on first paint.
// No auto-start: the tour runs only from explicit entry points
// (Settings, palette action, project menu, empty-library link).

"use client";

import "driver.js/dist/driver.css";
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { TOUR_START_EVENT, TOUR_DONE_KEY } from "@/lib/tour/launcher";
import { buildSteps } from "@/lib/tour/steps";

export function TourLauncher() {
  const t = useTranslations("tour");

  useEffect(() => {
    let cancelled = false;

    async function start() {
      const { driver } = await import("driver.js");
      if (cancelled) return;
      // Skip steps whose anchor is absent (mobile layout, empty viewer).
      const steps = buildSteps((k) => t(k)).filter(
        (s) => !s.element || document.querySelector(s.element as string),
      );
      if (steps.length === 0 || cancelled) return;
      const d = driver({
        showProgress: true,
        steps,
        onDestroyed: () => {
          try {
            localStorage.setItem(TOUR_DONE_KEY, "1");
          } catch {
            /* private mode */
          }
        },
      });
      d.drive();
    }

    const onEvent = () => {
      void start();
    };
    window.addEventListener(TOUR_START_EVENT, onEvent);
    return () => {
      cancelled = true;
      window.removeEventListener(TOUR_START_EVENT, onEvent);
    };
  }, [t]);

  return null;
}
