// SPDX-License-Identifier: MIT
// Toast stack. Toasts never steal focus (design §5).

"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";
import { useUiStore } from "@/lib/store/ui";

export function Toasts() {
  const t = useTranslations("app");
  const toasts = useUiStore((s) => s.toasts);
  const dismissToast = useUiStore((s) => s.dismissToast);

  useEffect(() => {
    if (toasts.length === 0) return;
    const timers = toasts.map((toast) =>
      setTimeout(() => dismissToast(toast.id), 6000),
    );
    return () => timers.forEach(clearTimeout);
  }, [toasts, dismissToast]);

  return (
    <div className="ez-toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className="ez-toast"
          data-kind={toast.kind ?? "info"}
          role={toast.kind === "error" ? "alert" : "status"}
        >
          <span style={{ flex: 1 }}>{toast.message}</span>
          {toast.actionLabel ? (
            <button
              type="button"
              onClick={() => {
                toast.onAction?.();
                dismissToast(toast.id);
              }}
            >
              {toast.actionLabel}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => dismissToast(toast.id)}
            aria-label={t("dismiss")}
            style={{ textDecoration: "none" }}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
