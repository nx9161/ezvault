// SPDX-License-Identifier: MIT
// Accessible dialog: focus trap, Esc to close, focus returned to trigger.
// WCAG 2.1 AA per design §5.

"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { CloseIcon } from "@/components/ui/icons";

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
  // Parents almost always pass an inline onClose arrow, so its identity
  // changes on EVERY parent re-render (e.g. each keystroke in a form).
  // The trap effect must not key on it: hold the latest callback in a
  // ref and run the trap once on mount. Keying the effect on [onClose]
  // refired cleanup (focus back to the trigger) + setup (focus to the
  // first focusable — the close button) on every keystroke, which stole
  // focus from inputs and dismissed the iOS keyboard per character.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    triggerRef.current = document.activeElement;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusables = () =>
      Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
    // Initial focus: an explicit [autofocus] element wins (React's
    // autoFocus lands before this effect — keep it if focus is already
    // inside the dialog), then the first text field, then the first
    // focusable (previously always the close button, ahead of inputs in
    // DOM order), else the dialog itself.
    const items = focusables();
    (dialog.tabIndex = -1);
    const auto = dialog.querySelector<HTMLElement>("[autofocus]");
    const active = document.activeElement as HTMLElement | null;
    const field = items.find((el) =>
      ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName),
    );
    if (auto) auto.focus();
    else if (active && active !== document.body && dialog.contains(active)) {
      /* React autoFocus already placed focus inside — keep it. */
    } else if (field) field.focus();
    else if (items[0]) items[0].focus();
    else dialog.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
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
    // Mount-once by design (see onCloseRef above): re-running this trap
    // on parent re-renders steals focus from dialog inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
            <CloseIcon size={14} />
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
