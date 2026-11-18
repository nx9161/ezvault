// SPDX-License-Identifier: MIT
// Toast stack — Astryx-backed since the astryx-upgrade branch.
//
// The Zustand UI store stays the source of truth (pushToast is called
// from non-React code all over the app, so the store API cannot move
// to a hook). This component bridges the store into Astryx: a
// ToastViewport hosts the stack, and each store toast is shown once
// via useToast. Semantics preserved from the hand-rolled stack:
//   - errors persist until dismissed (no auto-hide);
//   - info toasts auto-dismiss after 6s;
//   - an optional action button runs the toast's action and dismisses;
//   - toasts never steal focus (Astryx live-region announcement).

"use client";

import { useEffect, useRef } from "react";
import { ToastViewport, useToast } from "@astryxdesign/core/Toast";
import { Button } from "@astryxdesign/core/Button";
import { useUiStore } from "@/lib/store/ui";
import { useTranslations } from "next-intl";

function ToastBridge() {
  const t = useTranslations("app");
  const showToast = useToast();
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);
  const shown = useRef(new Map<string, () => void>());

  useEffect(() => {
    // Show store toasts that Astryx has not seen yet.
    for (const toast of toasts) {
      if (shown.current.has(toast.id)) continue;
      const dismiss = showToast({
        uniqueID: toast.id,
        collisionBehavior: "ignore",
        body: toast.message,
        type: toast.kind === "error" ? "error" : "info",
        isAutoHide: toast.kind !== "error",
        autoHideDuration: 6000,
        endContent: (
          <>
            {toast.actionLabel ? (
              <Button
                label={toast.actionLabel}
                variant="ghost"
                size="sm"
                onClick={() => {
                  toast.onAction?.();
                  dismissToast(toast.id);
                }}
              />
            ) : null}
            <Button
              label={t("dismiss")}
              variant="ghost"
              size="sm"
              isIconOnly
              icon={<span aria-hidden="true">✕</span>}
              onClick={() => dismissToast(toast.id)}
            />
          </>
        ),
        onHide: () => {
          shown.current.delete(toast.id);
          dismissToast(toast.id);
        },
      });
      shown.current.set(toast.id, dismiss);
    }
    // Dismiss Astryx toasts whose store entry is gone.
    for (const [id, dismiss] of [...shown.current]) {
      if (!toasts.some((toast) => toast.id === id)) {
        shown.current.delete(id);
        dismiss();
      }
    }
  }, [toasts, showToast, dismissToast, t]);

  return null;
}

export function Toasts() {
  return (
    <ToastViewport position="bottomEnd">
      <ToastBridge />
    </ToastViewport>
  );
}
