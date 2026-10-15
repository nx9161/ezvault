// SPDX-License-Identifier: MIT
// Accessible dialog: focus trap, Esc to close, focus returned to trigger.
// WCAG 2.1 AA per design §5.

"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  labelledBy?: string;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, onClose, children, footer, wide }: DialogProps) {
  const t = useTranslations("app");
  const scrimRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<Element | null>(null);

  useEffect(() => {
    triggerRef.current = document.activeElement;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusables = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
    // Focus the dialog itself first (or the first focusable).
    const first = focusables()[0];
    (dialog.tabIndex = -1);
    if (first) first.focus();
    else dialog.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.body.style.overflow = "";
      const trigger = triggerRef.current as HTMLElement | null;
      if (trigger && typeof trigger.focus === "function") trigger.focus();
    };
  }, [onClose]);

  return (
    <div
      className="ez-dialog-scrim"
      ref={scrimRef}
      onMouseDown={(e) => {
        if (e.target === scrimRef.current) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`ez-dialog${wide ? " ez-dialog--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="ez-dialog-head">
          <h2>{title}</h2>
          <button
            type="button"
            className="ez-icon-btn"
            onClick={onClose}
            aria-label={t("close")}
          >
            ✕
          </button>
        </div>
        <div className="ez-dialog-body">{children}</div>
        {footer ? <div className="ez-dialog-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

interface ConfirmProps {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  danger?: boolean;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  danger,
}: ConfirmProps) {
  const t = useTranslations("app");
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button type="button" className="ez-btn" onClick={onCancel}>
            {t("cancel")}
          </button>
          <button
            type="button"
            className={`ez-btn ${danger ? "ez-btn--danger" : "ez-btn--primary"}`}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div style={{ fontSize: 14 }}>{body}</div>
    </Dialog>
  );
}
