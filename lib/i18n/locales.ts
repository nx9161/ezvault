// SPDX-License-Identifier: MIT
/**
 * lib/i18n/locales.ts — supported-locale registry + cookie resolution
 * (Wave E part 2, parity row 35 locale remainder). PURE module: imported
 * by i18n/request.ts (server), the TopBar switcher (client), and the
 * unit tests, so it stays free of framework imports.
 *
 * The locale LIST matches Tropy's shipped set (a fact, verified from
 * Tropy's public 1.13 announcements): English, German, Spanish, French,
 * Italian, Japanese, Dutch, Portuguese, Brazilian Portuguese, Ukrainian,
 * Chinese — 11 locales. All message CONTENT is EZVault's own: every
 * locale file under messages/ is an original translation of
 * messages/en.json (no Tropy translation files were used — Tropy is
 * AGPL; see docs/PLUGINS.md's clean-room note and the wave report).
 */

export interface LocaleInfo {
  /** BCP 47 code; also the messages/<code>.json file name. */
  code: string;
  /** The language's name in itself — how switchers list languages. */
  nativeName: string;
}

export const SUPPORTED_LOCALES: readonly LocaleInfo[] = [
  { code: "en", nativeName: "English" },
  { code: "de", nativeName: "Deutsch" },
  { code: "es", nativeName: "Español" },
  { code: "fr", nativeName: "Français" },
  { code: "it", nativeName: "Italiano" },
  { code: "ja", nativeName: "日本語" },
  { code: "nl", nativeName: "Nederlands" },
  { code: "pt", nativeName: "Português" },
  { code: "pt-BR", nativeName: "Português (Brasil)" },
  { code: "uk", nativeName: "Українська" },
  { code: "zh", nativeName: "中文（简体）" },
] as const;

export const SUPPORTED_LOCALE_CODES: readonly string[] = SUPPORTED_LOCALES.map((l) => l.code);

export const DEFAULT_LOCALE = "en";

/** Cookie carrying the user's locale choice (ADR-2.13: no URL prefix). */
export const LOCALE_COOKIE = "ezv_locale";

/** One year — a language preference is durable, like the theme. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isSupportedLocale(value: unknown): value is string {
  return typeof value === "string" && SUPPORTED_LOCALE_CODES.includes(value);
}

/**
 * Resolve a raw cookie value to a supported locale. Exact match first;
 * then a case-insensitive match on the primary subtag form the browser
 * may present (e.g. "pt-br" -> "pt-BR", "EN" -> "en"); a bare primary
 * subtag of a regional locale ("pt-br" handled above; plain "pt"
 * stays "pt"). Anything else — absent, empty, unsupported, malformed —
 * falls back to the default. Never throws.
 */
export function resolveLocale(raw: string | null | undefined): string {
  if (typeof raw !== "string" || !raw) return DEFAULT_LOCALE;
  const value = raw.trim();
  if (!value) return DEFAULT_LOCALE;
  if (SUPPORTED_LOCALE_CODES.includes(value)) return value;
  const lower = value.toLowerCase();
  for (const code of SUPPORTED_LOCALE_CODES) {
    if (code.toLowerCase() === lower) return code;
  }
  return DEFAULT_LOCALE;
}
