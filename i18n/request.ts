// SPDX-License-Identifier: MIT
import { getRequestConfig } from "next-intl/server";

// Single-locale v1 (ADR-2.13): EN only, localePrefix 'never'.
// Adding a locale later = config flip + new messages/<locale>.json, no refactor.
export default getRequestConfig(async () => {
  const messages = (await import("../messages/en.json")).default;
  return {
    locale: "en",
    messages,
    timeZone: "America/New_York",
  };
});
