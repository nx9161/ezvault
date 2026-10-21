// SPDX-License-Identifier: MIT
import type { Metadata, Viewport } from "next";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getMessages, getTranslations } from "next-intl/server";
import PwaProvider from "@/components/pwa/PwaProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "EZVault — personal photo-research workspace",
  description:
    "EZVault is an independent personal cloud photo-research workspace. Not affiliated with the Tropy project.",
  // Wave E installability: app/manifest.ts supplies the web app
  // manifest; these fields supply the Apple/meta wiring Next needs.
  applicationName: "EZVault",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "EZVault",
  },
  icons: {
    apple: "/icons/apple-touch-icon.png",
  },
  formatDetection: { telephone: false },
};

// Design tokens (app/globals.css): light --bg #FAF8F3, dark --bg #14120E.
export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#FAF8F3" },
    { media: "(prefers-color-scheme: dark)", color: "#14120E" },
  ],
};

// Applies the persisted theme before first paint (no FOUC). Reads the same
// key the Zustand persist middleware writes ('ezvault-ui').
const THEME_BOOTSTRAP = `(function(){try{var raw=localStorage.getItem('ezvault-ui');var theme=raw&&JSON.parse(raw).state&&JSON.parse(raw).state.theme;if(theme!=='dark'&&theme!=='light'){theme=window.matchMedia&&window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',theme);}catch(e){document.documentElement.setAttribute('data-theme','light');}})();`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  const messages = await getMessages();
  const t = await getTranslations("app");

  return (
    <html lang={locale} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        <a className="skip-link" href="#ez-grid">
          {t("skipToGrid")}
        </a>
        <a className="skip-link" href="#ez-sidebar">
          {t("skipToSidebar")}
        </a>
        <a className="skip-link" href="#ez-inspector">
          {t("skipToInspector")}
        </a>
        <NextIntlClientProvider messages={messages} locale={locale}>
          <PwaProvider>{children}</PwaProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
