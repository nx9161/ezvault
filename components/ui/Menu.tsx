// SPDX-License-Identifier: MIT
// Lightweight popover menu (project menu, context menus). Esc closes,
// click-outside closes, arrow keys move.

"use client";

import {
  useEffect,
  useRef,
  type ReactNode,
  type MouseEvent as RMouseEvent,
} from "react";

interface MenuProps {
  anchor: { x: number; y: number };
  onClose: () => void;
  children: ReactNode;
  label: string;
}

export function Menu({ anchor, onClose, children, label }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Keep inside the viewport.
    const rect = el.getBoundingClientRect();
    let { x, y } = anchor;
    if (x + rect.width > window.innerWidth - 8) x = window.innerWidth - rect.width - 8;
    if (y + rect.height > window.innerHeight - 8) y = window.innerHeight - rect.height - 8;
    el.style.left = `${Math.max(8, x)}px`;
    el.style.top = `${Math.max(8, y)}px`;

    const first = el.querySelector<HTMLElement>(".ez-menu-item");
    first?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      const items = Array.from(el.querySelectorAll<HTMLElement>(".ez-menu-item"));
      const i = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "ArrowDown"
          ? items[(i + 1) % items.length]
          : items[(i - 1 + items.length) % items.length];
      next?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!el.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown);
    };
  }, [anchor, onClose]);

  return (
    <div
      ref={ref}
      className="ez-menu"
      role="menu"
      aria-label={label}
      style={{ position: "fixed", left: anchor.x, top: anchor.y }}
      onClick={(e: RMouseEvent) => {
        // Close after any menu item activates (items handle their action first).
        if ((e.target as HTMLElement).closest(".ez-menu-item")) onClose();
      }}
    >
      {children}
    </div>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="ez-menu-item"
      style={danger ? { color: "var(--danger)" } : undefined}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="ez-menu-sep" role="separator" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="ez-menu-label">{children}</div>;
}
