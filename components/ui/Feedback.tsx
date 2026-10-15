// SPDX-License-Identifier: MIT
// Small shared bits: error card with retry, skeleton rows, inline spinner.

"use client";

import { useTranslations } from "next-intl";

export function ErrorCard({
  what,
  onRetry,
}: {
  what: string;
  onRetry?: () => void;
}) {
  const t = useTranslations("errors");
  return (
    <div className="ez-state">
      <div className="ez-error-card" role="alert">
        <p style={{ margin: "0 0 12px" }}>{t("loadFailed", { what })}</p>
        {onRetry ? (
          <button type="button" className="ez-btn" onClick={onRetry}>
            {t("retry")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          className="ez-skeleton"
          style={{ height: 14, width: `${92 - (i % 3) * 12}%` }}
        />
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 12 }: { count?: number }) {
  return (
    <div className="ez-grid" data-density="comfortable" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i}>
          <div className="ez-skeleton" style={{ aspectRatio: "4/3" }} />
          <div className="ez-skeleton" style={{ height: 12, marginTop: 8, width: "70%" }} />
        </div>
      ))}
    </div>
  );
}
