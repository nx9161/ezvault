// SPDX-License-Identifier: MIT
import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, resolveLocale } from "@/lib/i18n/locales";
import en from "../messages/en.json";
import de from "../messages/de.json";
import es from "../messages/es.json";
import fr from "../messages/fr.json";
import it from "../messages/it.json";
import ja from "../messages/ja.json";
import nl from "../messages/nl.json";
import pt from "../messages/pt.json";
import ptBR from "../messages/pt-BR.json";
import uk from "../messages/uk.json";
import zh from "../messages/zh.json";

// Wave E part 2 (row 35): 11 locales, ADR-2.13 stands — localePrefix
// 'never', no route changes. The locale resolves per request from the
// `ezv_locale` cookie (validated against the supported set in
// lib/i18n/locales.ts; default en). Messages are server-loaded for the
// ACTIVE locale only: getMessages()/the client provider receive just
// that one catalog, so the other ten never enter a client bundle.
const MESSAGES: Record<string, typeof en> = {
  en,
  de,
  es,
  fr,
  it,
  ja,
  nl,
  pt,
  "pt-BR": ptBR,
  uk,
  zh,
};

export default getRequestConfig(async () => {
  const store = await cookies();
  const locale = resolveLocale(store.get(LOCALE_COOKIE)?.value);
  return {
    locale,
    messages: MESSAGES[locale] ?? en,
    timeZone: "America/New_York",
  };
});
