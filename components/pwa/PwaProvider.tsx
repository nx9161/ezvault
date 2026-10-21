// SPDX-License-Identifier: MIT
// PwaProvider (Wave E) — mounted once in the root layout. Owns:
//   - SW registration: production builds only, default scope "/", the
//     same-origin script URL "/sw.js", from bundled client JS (E-SEC-11;
//     no inline snippet — CSP script-src 'self' forbids one).
//   - The offline banner (E-SEC-19): appears on shell-from-cache boot,
//     navigator offline, or an /api network rejection; clears ONLY
//     after a successful /api response AND a full SWR revalidation —
//     the browser `online` event alone never clears it. The `online`
//     event only triggers a health probe through the API client.
//   - The session-expired state (E-SEC-9/10): on an auth-shaped API
//     failure, document caches are purged and the only primary action
//     is a hard navigation so the platform SSO runs end-to-end.
//   - The update flow (E-SEC-13): skipWaiting + clientsClaim mean a new
//     SW takes control immediately; on controllerchange the page
//     reloads ONCE (sessionStorage loop guard, cleared after a stable
//     boot), or — while a mutation is in flight — defers behind the
//     update banner until the mutation settles.
// No "offline ready" claim is ever surfaced (E-SEC-22).

"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";
import { mutate as revalidateAll } from "swr";
import {
  dispatchConnectivity,
  getConnectivityState,
  getMutationsInFlight,
  subscribeConnectivity,
  subscribeMutations,
} from "@/lib/pwa/connectivity";
import { purgeDocumentCaches } from "@/lib/pwa/cache-purge";
import { get } from "@/lib/api/client";

const RELOAD_GUARD_KEY = "ezvault:sw-reload-guard:v1";

export default function PwaProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const t = useTranslations("app");
  const conn = useSyncExternalStore(
    subscribeConnectivity,
    getConnectivityState,
    getConnectivityState,
  );

  // SW registration + browser event wiring (once).
  useEffect(() => {
    if (typeof navigator === "undefined") return;

    if (!navigator.onLine) dispatchConnectivity("NAVIGATOR_OFFLINE");

    // Belt-and-braces with the SW's EZVAULT_SHELL_FROM_CACHE message
    // (which can race this mount): a document delivered from Cache
    // Storage reports deliveryType "cache" on its navigation entry.
    try {
      const nav = performance.getEntriesByType("navigation")[0] as
        | (PerformanceNavigationTiming & { deliveryType?: string })
        | undefined;
      // "cache-storage" is the delivery type for a document served
      // from Cache Storage by the SW; "cache" is an HTTP-cache hit.
      if (nav && (nav.deliveryType === "cache-storage" || nav.deliveryType === "cache")) {
        dispatchConnectivity("SHELL_FROM_CACHE");
      }
    } catch {
      /* navigation timing unavailable — the SW message still covers it */
    }

    const onOffline = () => dispatchConnectivity("NAVIGATOR_OFFLINE");
    const onOnline = () => {
      dispatchConnectivity("NAVIGATOR_ONLINE");
      // Probe through the API client: only a real successful /api
      // response may start recovery (E-SEC-19). Failure re-marks
      // offline inside the client.
      void get("/api/health").catch(() => undefined);
    };
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);

    let removeSwListeners: (() => void) | undefined;
    if (process.env.NODE_ENV === "production" && "serviceWorker" in navigator) {
      void navigator.serviceWorker
        .register("/sw.js")
        .catch(() => undefined); // no "offline ready" claim on failure

      const onMessage = (event: MessageEvent) => {
        if (event.data && event.data.type === "EZVAULT_SHELL_FROM_CACHE") {
          dispatchConnectivity("SHELL_FROM_CACHE");
        }
      };
      navigator.serviceWorker.addEventListener("message", onMessage);

      // Only a controller change with a PRE-EXISTING controller is an
      // update; the first install's clientsClaim must not reload the
      // page the user is looking at.
      let hadController = !!navigator.serviceWorker.controller;
      let reloadScheduled = false;
      const tryReload = () => {
        if (!hadController) {
          hadController = true;
          return;
        }
        if (reloadScheduled) return;
        if (sessionStorage.getItem(RELOAD_GUARD_KEY)) {
          // Already reloaded once for an update this session: never loop.
          sessionStorage.removeItem(RELOAD_GUARD_KEY);
          return;
        }
        if (getMutationsInFlight() > 0) {
          // Defer to the update banner until the mutation settles.
          dispatchConnectivity("UPDATE_READY");
          return;
        }
        reloadScheduled = true;
        sessionStorage.setItem(RELOAD_GUARD_KEY, "1");
        window.location.reload();
      };
      const onControllerChange = () => tryReload();
      navigator.serviceWorker.addEventListener(
        "controllerchange",
        onControllerChange,
      );
      const unsubMutations = subscribeMutations(() => {
        if (getConnectivityState().updateReady) tryReload();
      });
      // A stable boot clears the loop guard so the NEXT deploy may
      // reload once again.
      const guardTimer = window.setTimeout(
        () => sessionStorage.removeItem(RELOAD_GUARD_KEY),
        15_000,
      );
      removeSwListeners = () => {
        navigator.serviceWorker.removeEventListener("message", onMessage);
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          onControllerChange,
        );
        unsubMutations();
        window.clearTimeout(guardTimer);
      };
    }

    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      removeSwListeners?.();
    };
  }, []);

  // Recovery (E-SEC-19/21): a successful /api response arrived while
  // offline — revalidate every active SWR key BEFORE the banner clears.
  useEffect(() => {
    if (!conn.pendingRecovery) return;
    let cancelled = false;
    void revalidateAll(() => true, undefined, { revalidate: true })
      .catch(() => undefined)
      .then(() => {
        if (!cancelled) dispatchConnectivity("REVALIDATED");
      });
    return () => {
      cancelled = true;
    };
  }, [conn.pendingRecovery]);

  // Session expiry (E-SEC-9/10a): purge the document caches.
  useEffect(() => {
    if (conn.sessionExpired) void purgeDocumentCaches();
  }, [conn.sessionExpired]);

  // Stale marking (E-SEC-21): data already on screen stays visible only
  // under the banner; the document carries the marker for styling.
  useEffect(() => {
    document.documentElement.dataset.offline = conn.offline ? "true" : "false";
  }, [conn.offline]);

  return (
    <>
      {conn.offline && !conn.sessionExpired ? (
        <div className="ez-banner" data-kind="warn" role="alert">
          <span>{t("offlineNote")}</span>
        </div>
      ) : null}
      {conn.updateReady && !conn.sessionExpired ? (
        <div className="ez-banner" data-kind="info" role="status">
          <span>{t("updateReady")}</span>
          <span className="ez-spacer" />
          <button
            type="button"
            className="ez-btn ez-btn--sm"
            onClick={() => window.location.reload()}
          >
            {t("updateNow")}
          </button>
        </div>
      ) : null}
      {conn.sessionExpired ? (
        <div className="ez-session-expired" role="alertdialog" aria-modal="true" aria-label={t("sessionExpiredTitle")}>
          <div className="ez-session-expired-card">
            <h2>{t("sessionExpiredTitle")}</h2>
            <p>{t("sessionExpiredBody")}</p>
            <button
              type="button"
              className="ez-btn ez-btn--primary"
              onClick={() => window.location.assign("/")}
            >
              {t("sessionExpiredAction")}
            </button>
          </div>
        </div>
      ) : null}
      {children}
    </>
  );
}
