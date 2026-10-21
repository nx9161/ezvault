// SPDX-License-Identifier: MIT
// Language selector (Wave E part 2, row 35): lists every supported
// locale by its native name; choosing one writes the `ezv_locale`
// cookie that i18n/request.ts resolves server-side, then refreshes so
// the server re-renders with the new catalog. No route changes
// (ADR-2.13, localePrefix 'never').

"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  SUPPORTED_LOCALES,
} from "@/lib/i18n/locales";

export default function LocaleSwitcher() {
  const t = useTranslations("topbar");
  const locale = useLocale();
  const router = useRouter();

  return (
    <select
      className="ez-select ez-lang-select"
      aria-label={t("language")}
      title={t("language")}
      value={locale}
      onChange={(e) => {
        const next = e.target.value;
        document.cookie = `${LOCALE_COOKIE}=${encodeURIComponent(next)}; path=/; max-age=${LOCALE_COOKIE_MAX_AGE}; samesite=lax`;
        router.refresh();
      }}
    >
      {SUPPORTED_LOCALES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.nativeName}
        </option>
      ))}
    </select>
  );
}
