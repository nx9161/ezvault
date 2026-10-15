// SPDX-License-Identifier: MIT
// Color swatch popover (design D-M8a): replaces window.prompt for list
// and tag colors. 12-color radiogroup grid, Esc/click-outside cancels,
// commit-on-select. Shares one palette with the tag-creation form.

"use client";

import { useEffect, useRef, useState } from "react";

export const TAG_COLORS = [
  "#B3541E", "#2E7D4F", "#2B5E8B", "#B3261E",
  "#7A4FA3", "#0E7C7B", "#B98A12", "#C2437E",
  "#4A6FA5", "#5B8C3E", "#8C5B2E", "#5A5A5A",
];

interface ColorSwatchPopoverProps {
  anchor: { x: number; y: number };
  initial: string;
  onPick(color: string): void;
  onCancel(): void;
  label: string;
}

export function ColorSwatchPopover({ anchor, initial, onPick, onCancel, label }: ColorSwatchPopoverProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Keep inside the viewport (same clamp as Menu.tsx).
    const rect = el.getBoundingClientRect();
    let { x, y } = anchor;
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${Math.max(8, y)}px`;

    // Focus capture: remember who opened us, focus the checked swatch.
    const trigger = document.activeElement as HTMLElement | null;
    el.querySelector<HTMLElement>(`[data-color="${initial}"]`)?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      const swatches = Array.from(el.querySelectorAll<HTMLElement>(".ez-swatch"));
      const i = swatches.indexOf(document.activeElement as HTMLElement);
      const cols = 6;
      let next = i;
      if (e.key === "ArrowRight") next = (i + 1) % swatches.length;
      else if (e.key === "ArrowLeft") next = (i - 1 + swatches.length) % swatches.length;
      else if (e.key === "ArrowDown") next = (i + cols) % swatches.length;
      else next = (i - cols + swatches.length) % swatches.length;
      swatches[next]?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) onCancel();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
      if (trigger && typeof trigger.focus === "function") trigger.focus();
    };
  }, [anchor, initial, onCancel]);

  const pick = (c: string) => {
    setValue(c);
    onPick(c);
  };

  return (
    <div
      ref={ref}
      className="ez-menu ez-swatch-pop"
      role="dialog"
      aria-label={label}
      style={{ position: "fixed", left: anchor.x, top: anchor.y }}
    >
      <div className="ez-swatch-grid" role="radiogroup" aria-label={label}>
        {TAG_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={c === value}
            aria-label={c}
            data-color={c}
            className="ez-swatch"
            style={{ background: c }}
            onClick={() => pick(c)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                pick(c);
              }
            }}
          />
        ))}
      </div>
    </div>
  );
}
