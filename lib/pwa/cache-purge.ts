// SPDX-License-Identifier: MIT
// Document-cache purge on auth loss (Wave E, E-SEC-10a).
//
// There is no app-controlled sign-out (Vercel Authentication fronts the
// deployment), so when the client detects an auth-shaped API failure it
// drops the cached shell documents two ways: it asks the SW to delete
// its document caches, and it deletes them in-page as a fallback. The
// OCR runtime cache (public assets only) deliberately persists.

export async function purgeDocumentCaches(): Promise<void> {
  try {
    if ("serviceWorker" in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: "EZVAULT_PURGE_DOCUMENT_CACHES",
      });
    }
  } catch {
    /* in-page fallback below still runs */
  }
  try {
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((k) => k.startsWith("ezvault-documents-"))
          .map((k) => caches.delete(k)),
      );
    }
  } catch {
    /* Cache Storage unavailable (private mode etc.) — nothing to purge */
  }
}
