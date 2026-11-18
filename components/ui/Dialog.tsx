// SPDX-License-Identifier: MIT
// Dialog — Astryx-backed since the astryx-upgrade branch.
//
// The exported API is unchanged (Dialog / ConfirmDialog with the same
// props every call site already uses); the rendering is now Astryx's
// Dialog (native <dialog>, focus trap, Esc, focus return come from
// Astryx) instead of the hand-rolled trap this file used to carry.
// Widths mirror the old .ez-dialog sizes (560px, 860px wide).
//
// Behaviour note: initial focus is Astryx/native-dialog behaviour
// (autofocus element wins, else first focusable). The old hand-rolled
// "first text field before the close button" ordering is superseded.

"use client";

import type { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Dialog as AstryxDialog } from "@astryxdesign/core/Dialog";
import { DialogHeader } from "@astryxdesign/core/Dialog";
import { Button } from "@astryxdesign/core/Button";

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  labelledBy?: string;
}

export function Dialog({ title, onClose, children, footer, wide }: DialogProps) {
  return (
    <AstryxDialog
      isOpen
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      width={wide ? 860 : 560}
      maxHeight="88dvh"
      aria-label={title}
    >
      <DialogHeader
        title={title}
        onOpenChange={(isOpen) => {
          if (!isOpen) onClose();
        }}
      />
      <div style={{ overflowY: "auto", paddingTop: 8 }}>{children}</div>
      {footer ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            alignItems: "center",
            paddingTop: 12,
          }}
        >
          {footer}
        </div>
      ) : null}
    </AstryxDialog>
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
          <Button label={t("cancel")} onClick={onCancel} />
          <Button
            label={confirmLabel}
            variant={danger ? "destructive" : "primary"}
            onClick={onConfirm}
          />
        </>
      }
    >
      <div style={{ fontSize: 14 }}>{body}</div>
    </Dialog>
  );
}
