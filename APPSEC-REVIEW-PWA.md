# APPSEC-REVIEW-PWA.md — AppSec review, FULL PARITY Wave E (PWA / offline, Serwist)

**Status: BINDING.** The Wave E builder implements against every condition
below; QA gates the wave on the "QA test" line of each. Deviations need a
written AppSec re-review, not a builder judgment call.

**Baseline reviewed:** `main @ 38c1055` — `proxy.ts` (token guard → CSRF →
outer rate-limit → CSP/security headers, matcher excludes only
`_next/static|_next/image|favicon.ico`), `next.config.ts` (no PWA config
yet; Serwist **not installed**), `app/` route tree (home `/` client page,
`/[projectId]` thin server wrapper around `WorkspaceClient`, ~80
`app/api/**` Node handlers), `lib/api/client.ts` + `lib/api/hooks.ts`
(SWR = the only data cache, in-memory), the photo file route
(`302 → 5-min presigned R2 GET`, `Cache-Control: private, max-age=240`),
export routes (`private, no-store` / presigned 302s),
`INTEGRATION-DECISIONS.md` (40 KB/route bundle rule + canonical First
Load measurement; OCR assets self-hosted under `public/ocr/`,
~10.5 MiB, lazy-loaded), `CONTRACT.md`, and
`messages/en.json` → `app.offlineNote` ("You appear to be offline.
EZVault needs a connection in v1." — currently unused by any component
and, after Wave E, inaccurate; see E-SEC-22).

**Threat model in one paragraph.** EZVault has no app-level session:
Vercel Authentication (SSO) fronts every route at the platform edge, and
there is **no app sign-out endpoint the app controls**. Cache Storage,
unlike the HTTP cache, ignores `Cache-Control: private/no-store`, is
never cleared by cookie expiry, by Vercel protection changes, or by SSO
sign-out, and is readable by any script running on the origin. Every rule
below follows from three standing decisions: (1) originals stay
network-only; (2) stale data is never presented as current; (3) nothing
cached by the service worker (SW) may carry user data across the Vercel
Auth boundary.

---

## Approved architecture (summary — the builder follows this shape)

1. **Serwist** (`@serwist/next` + `serwist`, MIT) generates `/sw.js` from
   an explicit SW source the builder writes and reviews — the effective
   runtime route table is printed/inspected at build time, never assumed
   from library defaults (E-SEC-15).
2. **Precache (build-revisioned, immutable):** `/_next/static/**`
   content-hashed chunks/CSS, favicon + PWA icons, `public/*.svg`, the
   web app manifest, and the data-free app-shell documents for `/` and
   `/[projectId]` under the strict limits of E-SEC-5.
3. **Runtime cache (one, versioned):** OCR assets under `/ocr/**`,
   cache-first, lazy on first OCR run — never precached (E-SEC-4).
4. **Everything else is network-only pass-through:** all `/api/**`, all
   cross-origin traffic (R2 presigned URLs), all non-GET, all downloads,
   all redirects/auth responses (E-SEC-1/2/6/16/17).
5. **Navigations are network-first;** the cached shell is an
   *offline-only* fallback on network failure, and booting from it puts
   the app in the degraded offline mode of E-SEC-19…21.
6. **Updates activate immediately** (`skipWaiting` + `clientsClaim`) with
   full old-cache purge and a guarded one-time reload of open clients
   (E-SEC-13/14).

---

## A. Cache taxonomy

| Request class | Strategy | Bound |
|---|---|---|
| `/_next/static/**` JS/CSS (content-hashed), favicon, PWA icons, `public/*.svg` | Precache, cache-first | Build revision only; prior build evicted at activation |
| App-shell HTML for `/` and `/[projectId]` | Precache + network-first navigations, cache fallback **only** on network failure | One revision (current build); E-SEC-5 conditions |
| `public/ocr/**` (worker, cores, WASM, `lang/*.traineddata.gz`) | Runtime cache-first, lazy | Separate versioned cache, ≤ 12 MiB, E-SEC-4 |
| Web app manifest (`/manifest.webmanifest` or equivalent) | Precache | Build revision |
| **All `/api/**` responses (any method, any status)** | **Network-only — NEVER cached** | — |
| **Presigned R2 URLs and the bytes they fetch (originals + thumbnails), any `*.r2.cloudflarestorage.com` or other cross-origin fetch** | **Network-only — NEVER cached, NEVER intercepted** | — |
| **`/api/storage/local/**` signed-token URLs (dev driver)** | **Network-only** (covered by `/api/**`) | — |
| **Auth/SSO responses: 3xx, redirected, 401/403, `Set-Cookie`, opaque** | **NEVER cached, passed through verbatim** | — |
| **Export/download responses (ZIP/CSV/JSON-LD/PNG/ALTO/text, 302 or streamed)** | **Network-only** (covered by `/api/**`) | — |
| HTML for any route other than `/` and `/[projectId]` | Network-only (no other document routes exist today) | — |

### E-SEC-1 — `/api/**` is network-only, absolutely
No `/api/**` response may enter any cache (precache, runtime, or a
hand-rolled `caches.open`), at any status, for any method — including
GETs, including `/api/health`, including error bodies. The SW route
table must contain no rule that matches `/api/`, and the SW must not
synthesize a cached or fallback body for a failed API fetch (the app
layer surfaces the error; see E-SEC-19).
*Rationale:* API bodies are the entire user dataset (items, notes,
search, Omeka settings view, token list view). Caching them puts user
data in a store that survives SSO sign-out and protection changes, with
no server-side revocation path. It would also cache responses fetched
under a developer-token bearer in any future same-origin scripting
context.
*QA test:* drive a full session (projects, items, search, notes, trash,
settings), then `performance`/DevTools + `caches.keys()` enumeration via
Playwright `page.evaluate`: zero cache entries whose URL path starts
with `/api/`. Grep the built `public/sw.js` for any runtime route
matching `/api` with a caching handler — must be absent.

### E-SEC-2 — Presigned URLs and R2 bytes are network-only
The SW must not `respondWith` for, cache, or rewrite any cross-origin
request (in particular `https://*.r2.cloudflarestorage.com`), nor the
same-origin `302` that mints the presigned URL (covered by E-SEC-1), nor
the local driver's HMAC-signed URLs. A presigned URL is a **bearer
credential** (5-minute GET, B3 in the file route); Cache Storage would
persist both the credential (as the cache key) and the original bytes
past expiry.
*Rationale:* standing decision — originals stay network-only; thumbnails
are served only via the same presigned path, so they inherit the rule.
*QA test:* open the viewer + lightbox (thumb + original loads), inspect
every cache: no entry on a non-app origin, no entry whose URL contains
`X-Amz-` / `sig=` / `Signature`. Offline, the viewer shows the honest
unavailable state (E-SEC-19), never a cached photo.

### E-SEC-3 — Static build assets: precache, build-revisioned only
`/_next/static/**`, favicon, PWA icons, and `public/*.svg` are precached
via Serwist's build manifest, cache-first, keyed by content hash /
precache revision — no time-based TTL and no runtime route may cache
additional JS/CSS by URL pattern (an unhashed URL cached cache-first is
a stale-pin vector).
*QA test:* cache inventory after install contains only manifest URLs;
every precache entry has a revision/`__WB_REVISION__`-equivalent or a
content-hashed filename; a second deploy replaces, not appends
(E-SEC-14).

### E-SEC-4 — OCR assets: lazy runtime cache-first, versioned, capped
`/ocr/**` (~10.5 MiB) must **not** be precached (install-time cost +
quota, E-SEC-24). On first OCR use they may be runtime-cached
cache-first in a dedicated cache whose name embeds the tesseract
version **and** the build/deployment id (the asset URLs are unhashed and
regenerated by `scripts/sync-ocr-assets.mjs` on version bumps — a
path-only cache-first rule would serve a stale engine forever). Cap:
the 10 shipped files only; URLs with query strings are not cached.
*Rationale:* OCR is the one genuinely offline-capable feature (client
worker, INTEGRATION-DECISIONS #9) — caching its engine preserves that
without touching user data (the assets are public, identical for all
visitors, and already served unauthenticated-by-content under
`public/`).
*QA test:* fresh profile → OCR cache absent; run OCR online → cache
populated (≤ 12 MiB); go offline → OCR still completes on an
already-loaded photo view is **not** required (photo bytes are
network-only) but the engine loads from cache when the page already
holds the image; deploy a new build → old OCR cache name gone.

### E-SEC-5 — App-shell HTML: conditional YES, data-free, offline-fallback only
Document HTML for `/` and `/[projectId]` **may** be cached, only as
follows: (a) navigations are **network-first whenever the network
answers at all** — the cached shell is served solely when the fetch
rejects (offline/DNS failure), never in response to any HTTP status or
redirect (E-SEC-6/8); (b) cache-first for documents is **rejected**;
(c) the shell is precache-revisioned per build, exactly one revision
retained; (d) booting from the cached shell forces the degraded offline
mode of §E. This approval is premised on the verified shape of both
routes today: `/[projectId]` SSR is a thin wrapper (`WorkspaceClient`)
and `/` renders its loading state server-side — **neither document
contains project names, item data, notes, or any user content** (the
serialized next-intl messages are public app copy).
*Rationale:* a data-free shell leaks nothing across the auth boundary —
all data still requires a live `/api` call the SW never caches — while
enabling installability and an honest offline screen instead of a
browser error page.
*QA test:* per release, fetch both documents authenticated and diff the
cached copies against a blocklist (project names, item titles from a
seeded fixture, note text): zero matches. If a future change puts user
data in either document's HTML/RSC payload, this approval **lapses
automatically** and shell caching must be removed. Offline reload of
`/[projectId]` renders the shell in offline mode (E-SEC-19), with no
item data.

### E-SEC-6 — Auth-shaped responses are never cacheable
The SW must refuse to store any response that is: status ≠ 200, a
redirect or `response.redirected === true`, status 401/403, carrying
`Set-Cookie`, `opaque`/`opaqueredirect` type, or `Content-Disposition:
attachment`. This check must exist as an explicit guard in front of
every `cache.put` the SW performs (precache excepted — precache entries
are build files fetched at install; if a precache fetch returns a
redirect to SSO because install ran unauthenticated, install must fail,
not cache the login page — see E-SEC-10).
*Rationale:* the classic SW-behind-SSO failure is caching the SSO login
HTML (or a redirect stub) as the "shell" and serving it as the app.
*QA test:* clear the SSO session (new browser profile / cookies
blocked), trigger SW install + a navigation, inspect caches: no login/
challenge HTML, no 3xx entries; the browser lands on the real Vercel
SSO flow.

### E-SEC-7 — `/sw.js` itself is never cached and is revalidated
`/sw.js` must be served with `Cache-Control: no-cache` (or `max-age=0,
must-revalidate`) — verify the live response header post-deploy (Next/
Vercel static serving defaults are not assumed) — and the SW must never
precache or runtime-cache its own script or its precache manifest.
*QA test:* `curl -sI https://<prod>/sw.js` shows the no-cache header; a
new deployment's SW is detected by an open client within one navigation
(E-SEC-13).

---

## B. Auth-boundary risks

### E-SEC-8 — Navigation requests: network pass-through for the SSO flow
For `request.mode === 'navigate'`: try the network and return its
response **verbatim** — including 3xx redirects to Vercel's SSO
endpoints and any platform challenge. Never `respondWith` a cached
shell for a navigation the network answered; never intercept
navigations whose target is outside the app origin (the SSO endpoints
live on Vercel hosts — the SW must have no route that can match
cross-origin navigations); never follow, rewrite, or "helpfully"
retry a redirect. Fallback to the E-SEC-5 shell is permitted **only**
on fetch rejection.
*Rationale:* intercepting or answering the SSO redirect flow breaks
sign-in outright, and serving the shell where the platform said
"authenticate first" manufactures a signed-in illusion (E-SEC-9).
*QA test:* signed-out profile → navigate to `/` and to a deep
`/[projectId]` link: the untouched Vercel SSO flow completes and the
user lands in the app (Playwright `auth-gate.spec.ts` pattern, extended
to run with the SW active and controlling). Repeat with the SW already
installed from a prior authenticated session.

### E-SEC-9 — Session expiry: no signed-in illusion, forced re-auth path
When the Vercel session expires mid-use, `/api` fetches will fail the
platform gate (redirect-to-SSO HTML or 401, depending on request type).
The app must detect an auth-shaped API failure — non-JSON/HTML body on
an API call, `res.redirected` to a non-app URL, or 401/403 from
`/api/**` — and: (1) stop presenting the workspace as a live signed-in
session; (2) show a "session expired — sign in again" state whose only
primary action performs a **hard navigation** (e.g.
`location.assign('/')`) so the platform SSO runs end-to-end; (3) not
retry-loop (SWR's `shouldRetryOnError` already excludes 4xx — keep it
that way); (4) not fall back to any cached data (there is none, per
E-SEC-1 — this condition is about the UI state, not data).
*Rationale:* a cached shell + dead APIs otherwise renders a convincing
but hollow "signed-in" app — the exact failure the prior design
recommendation prohibits.
*QA test:* Playwright route interception fulfilling `/api/**` with 401
(and a second run with a 302 → HTML login fixture): the sign-in state
appears, no workspace data is shown as current, no mutation is
attempted, and the re-auth action issues a real document navigation.

### E-SEC-10 — Cache purge on auth loss; install must not happen behind the gate
Because there is no app-controlled sign-out hook, defense is layered:
(a) on detecting an auth-shaped failure (E-SEC-9), the client must ask
the SW (or run in-page) to delete the shell/document cache and the OCR
cache may persist (public assets only) — document caches must be gone
before the re-auth navigation; (b) SW registration/install must not be
treated as successful when the SW script or precache fetches were
answered by the SSO gate — a precache response that is redirected/HTML
login for a `.js`/`.css` entry fails install (E-SEC-6) and the app must
surface no "offline ready" claim (E-SEC-22); (c) the standing backstop
is the taxonomy itself: even if a purge never runs, caches contain no
user data, no credentials, and at most one build's data-free shell.
*QA test:* seed caches, force the E-SEC-9 401 path, assert the document
cache is deleted; fresh signed-out profile: SW does not reach
"activated with a login-page shell" — caches contain no HTML login
page.

### E-SEC-11 — Registration discipline
Register the SW only in production builds, from the bundled client JS
(the root layout's client tree), with default scope `/` and a
same-origin script URL `/sw.js`. No inline registration snippet
(CSP `script-src 'self'` — `proxy.ts` — forbids it, and no CSP weakening
to permit one), no `blob:` worker, no scope-widening
`Service-Worker-Allowed` header, no registration on a non-app document.
*QA test:* `test/csp.test.mjs` still green; production page registers
exactly one SW, scope = origin root; dev build registers none.

### E-SEC-12 — Cached responses keep their security headers; CSP unchanged
Wave E must not change the `proxy.ts` CSP (no `unsafe-inline`/
`unsafe-eval`/`blob:` additions for Serwist's sake — Serwist needs
none). Responses replayed from Cache Storage must be the stored
responses (which carry the `proxy.ts` header set from fetch time), not
SW-constructed responses stripped of CSP/HSTS/`X-Frame-Options`.
*QA test:* offline reload from the cached shell: read
`document`/response headers via Playwright for the SW-served document —
CSP present and identical in value to the network-served document.

---

## C. Update semantics

### E-SEC-13 — Immediate activation + guarded one-time client reload (required policy)
The SW must set `skipWaiting: true` and `clientsClaim: true` (Serwist
options), so a new deployment's SW activates without waiting for all
tabs to close — a "wait until every tab closes" policy is **rejected**
because a single-user PWA tab can stay open for days, pinning the user
to a stale shell. **Tradeoff (accepted, mitigated):** immediate
activation can leave an already-open page (old build JS) controlled by
a new SW whose precache cleanup deleted chunks the old page may still
lazy-load (palette, lightbox, OCR chunks). Mitigation is mandatory: on
`controllerchange`, the app reloads the page **once** (loop-guarded,
e.g. a `sessionStorage` flag cleared on successful boot), or — if a
mutation is in flight — defers the reload to the next navigation while
showing the update banner of E-SEC-22. Working indefinitely in a
mixed-build state is not permitted.
*QA test:* with a v1 client open and controlling SW, deploy v2: within
one update check the v2 SW is active, old caches are gone (E-SEC-14),
and the client has reloaded to v2 exactly once (no reload loop across
two consecutive deploys).

### E-SEC-14 — Versioned cache names + total purge of prior builds
Every cache name embeds the build/deployment identity (Serwist
precache revisioning satisfies this for the precache; runtime caches
follow E-SEC-4). On `activate`, delete **every** app cache not in the
current build's set (`cleanupOutdatedCaches` or equivalent explicit
code). Retaining "one previous shell for safety" is rejected — that is
the stale-pin vector.
*QA test:* after the E-SEC-13 deploy, `caches.keys()` equals exactly
the current build's expected set; an entry planted under a fake old
cache name is deleted on activation.

### E-SEC-15 — No dynamic cache poisoning surface
Runtime caching may only store URLs from the fixed allowlist in §A
(`/ocr/**` paths, no query strings). No `cache.add()`/`put()` of
page-supplied, user-supplied, or query-bearing URLs; no caching keyed
on URLs containing signatures, tokens, or search params. The builder
must dump the **effective** runtime route table from the built SW and
attach it to the wave PR — Serwist's shipped `defaultCache` preset
includes a NetworkFirst runtime rule for `/api/` GETs and a pages rule;
**adopting `defaultCache` unpruned is rejected** (it violates
E-SEC-1/E-SEC-5 by default).
*QA test:* the attached route table + a grep of the built `sw.js` show
no API/pages runtime caching beyond E-SEC-5's navigation handler; a
request to `/ocr/worker.min.js?x=poison` is not stored under the
query-bearing key.

---

## D. Scope exclusions

### E-SEC-16 — Hard exclusion list, evaluated before any cache route
The SW's fetch handling must bypass caching logic entirely (plain
network fetch or no `respondWith`) for: `/api/**` (incl. `/api/cron/
nightly`, `/api/health`, all `*/export/*`, the photo `file` route, ALTO/
text downloads, the local storage driver), `/_vercel/**` and any SSO/
challenge path the platform injects, `/sw.js` itself, and every
cross-origin URL. The exclusion check must be the first thing the
routing layer evaluates and must be unit-testable as a URL table (the
repo's `node --test` convention).
*QA test:* a table-driven test (≥ the classes above, incl. lookalikes:
`/apiary`, `/api%2f..`, uppercase variants) asserts bypass vs. cache
eligibility per URL; `/apiary`-style non-API paths behave as normal app
paths.

### E-SEC-17 — Non-GET requests are never intercepted; no offline write queue
The SW calls `respondWith` for GET/HEAD only. POST/PUT/PATCH/DELETE
pass through untouched. **Background Sync, request queuing, and any
store-and-replay of mutations are rejected** for Wave E: replay across
a session-expiry boundary can execute writes under a different auth
context than the user saw, and `clientOpId` idempotency was designed
for retry of a *known* submission, not silent deferred execution.
Offline mutations are blocked in the UI instead (E-SEC-20).
*QA test:* offline, attempt a mutation: no fetch is queued anywhere
(SW, IndexedDB, localStorage outbox — assert none exists), nothing is
sent on reconnect, and the user saw the blocked state (E-SEC-20).

### E-SEC-18 — Downloads and streams are pass-through
Export ZIP (streamed), CSV, JSON-LD, baked PNGs, CSV reports, and ALTO/
text downloads must not be cloned, teed, or stored by the SW; the SW
must not break `Content-Disposition: attachment` delivery or the
`asBlob` client path. (All are `/api/**` — this condition exists so QA
tests them explicitly rather than assuming the prefix rule is enough.)
*QA test:* with the SW controlling, run a ZIP export and a CSV export:
downloads complete byte-identical to the no-SW baseline; zero new cache
entries afterwards.

---

## E. Data honesty rules for the offline UX

### E-SEC-19 — Offline detection and banner semantics (exact)
The offline banner (revised `app.offlineNote`, E-SEC-22) appears when
**any** of: the shell was served from cache; `navigator.onLine` is
false; an `/api` fetch network-rejects. It disappears **only after a
successful `/api` response** (e.g. an SWR revalidation or `/api/health`
200) — the browser `online` event alone never clears it (captive
portals and dead upstreams fire `online` while every fetch fails).
While the banner is up: data regions show an explicit "content
unavailable offline" / stale state. **False empty states are
prohibited:** offline, the item grid must not render "Your archive is
empty", search must not render "No results for …", and lists/tags must
not render as empty — SWR having no data because every fetch failed is
not evidence the library is empty.
*Rationale:* `app.offlineNote`'s contract is honesty; an empty-library
message offline is stale-data's mirror image — a false claim about the
user's archive.
*QA test:* Playwright offline context (`context.setOffline(true)`)
from a controlling SW: reload shows shell + banner + unavailable
states, zero false-empty strings (assert against the en.json copy);
toggle offline off → banner clears only after the first successful API
response lands and the grid populates.

### E-SEC-20 — Mutations disabled while offline/stale
While the E-SEC-19 state is active: every mutating control (create,
import, edit/save, trash/restore, merge, copy, Omeka push, token
create/revoke, delete-everything, OCR **save**) is disabled or blocked
at the `lib/api/client.ts` layer before any fetch is attempted, with
the block surfaced to the user (disabled affordance + the banner, not
a silent no-op and not an optimistic UI change). Zustand/UI state must
not present an unsaved change as saved (the existing
`errors.saveFailed` honesty semantics are the floor). OCR itself may
run offline (local engine, cached assets) but its result lives only in
the panel until reconnect enables save.
*QA test:* offline: mutation buttons disabled/blocked; a programmatic
`post()` call through the client rejects without a network attempt;
no toast claims success; reconnecting does not auto-submit anything
(E-SEC-17).

### E-SEC-21 — In-memory and localStorage data under the stale banner
Data already in memory (SWR) when connectivity drops may stay on
screen **only** under the persistent banner, visually marked stale,
with mutations off (E-SEC-20); on reconnect, all active SWR keys
revalidate **before** the banner clears (E-SEC-19). Client-persisted
surfaces get the same treatment: the command palette's localStorage
recent-items (`ezvault:recent-items:<id>:v1`, which contains item
titles) may render offline only as recents under the banner — server
search offline must show "unavailable", never an empty result set. The
cross-tab `rev` sync (`lib/sync.ts`) is unchanged by the SW and must
not be routed through it.
*QA test:* load a project online, go offline: items remain visible
with banner + stale marking; open the palette: recents present and
labelled, search section unavailable; reconnect: banner clears after
revalidation and a server-side change made meanwhile appears.

### E-SEC-22 — Copy and claims: `offlineNote` rewrite, no "offline-ready" overclaim
Wave E must replace `app.offlineNote` — the v1 text ("EZVault needs a
connection in v1") becomes false the moment a shell + OCR engine work
offline. Required meaning of the new copy: *you are offline; your
library lives online and can't be loaded or changed right now; anything
shown is from before the connection dropped.* No UI string, settings
copy, or install prompt may claim the library is available offline.
An update-available notice (E-SEC-13) uses the same honesty bar: it
says a new version is ready, nothing more.
*QA test:* grep shipped copy for offline claims and check them against
this section; screenshot the offline state for the QA report.

---

## F. Platform pitfalls (SW behind an auth proxy)

### E-SEC-23 — Range and partial responses bypass the SW
Any request carrying a `Range` header, and any `206` response, is
never intercepted or cached (Cache Storage cannot serve ranges from a
stored 200 correctly for media seeking, and a stored 206 poisons the
key). Current media flow is cross-origin R2 (already bypassed,
E-SEC-2); this condition binds any future same-origin media path
(e.g. the local driver if it ever leaves `/api/**`).
*QA test:* issue a `Range: bytes=0-1023` fetch against a same-origin
media URL in the SW's scope: response comes from the network, no cache
entry is created, a second ranged read returns the correct bytes.

### E-SEC-24 — Quota and eviction budget
Precache size must be measured on the canonical build and reported in
the wave PR (bundle rule, INTEGRATION-DECISIONS.md): hard caps —
precache ≤ 10 MiB, OCR runtime cache ≤ 12 MiB, total app Cache Storage
≤ 25 MiB. A `QuotaExceededError` from any `cache.put` must be caught
inside the SW, evict that cache's oldest entries or drop the write, and
**never** reject the fetch handler into a broken page (fall back to the
network response uncached). The app must not call
`navigator.storage.persist()` — no persistence promise may be made or
implied, and the app must tolerate whole-origin eviction (all Wave E
state is rebuildable: shell from the network, OCR assets refetched).
*QA test:* fill/evict simulation (or a unit test with a throwing
`cache.put` stub): page still loads from network, no unhandled SW
error; build PR contains the measured precache byte total.

### E-SEC-25 — Only well-formed, complete responses are stored
A response is stored only if: GET request, status 200, not redirected,
same-origin (or the `/ocr/**` same-origin set), `Content-Type` on the
allowlist for its class (JS/CSS/HTML/WASM/gzip data/images for icons),
no `Vary: *`, body fully readable, stored via `response.clone()` so
the page's copy is never the consumed one. Streamed/chunked responses
must not be teed into a cache.
*QA test:* unit/table tests over the put-guard with synthetic
Responses for each refusal class (206, redirect, `Vary: *`, opaque,
attachment) — all refused; a stored entry's body reads back
byte-identical.

### E-SEC-26 — Proxy and platform interplay is preserved, not worked around
`proxy.ts` still runs on every network request the SW makes (precache
fetches included): the builder must not "fix" SW problems by widening
the proxy matcher exclusions beyond a possible `Cache-Control` header
complement for `/sw.js` (E-SEC-7), must not move any security duty
(CSRF, token guard, rate limit) into the SW, and must confirm the SW
does not reduce the token guard's coverage — API requests from a
SW-controlled page traverse the same proxy path as before (they are
network-only pass-throughs, E-SEC-1/17). Vercel cron
(`/api/cron/nightly`) is invoked platform-side without a SW and needs
no handling beyond E-SEC-16.
*QA test:* with the SW controlling: the B1 token-guard probe suite
(presented `ezv_` bearer outside the subset → 403) and the CSRF probe
(cross-origin mutation → 403) pass unchanged; `proxy.ts` diff for the
wave is empty or limited to the E-SEC-7 header.

---

## Explicitly REJECTED patterns (no ambiguity)

1. **Runtime caching of API GETs** — cache-first, network-first,
   stale-while-revalidate, "short TTL", all of it. (E-SEC-1)
2. **Adopting Serwist `defaultCache` unpruned** — its stock `/api/` and
   pages runtime rules violate this review out of the box. (E-SEC-15)
3. **Offline photo gallery** — caching thumbnails/originals or
   presigned URLs for offline viewing. Originals stay network-only.
   (E-SEC-2)
4. **Cache-first HTML / serving the cached shell on any HTTP response**
   (redirect, 401, 500) instead of only on network failure. (E-SEC-5/8)
5. **`skipWaiting: false`** / update-on-all-tabs-closed policies, and
   retaining a previous build's shell "just in case". (E-SEC-13/14)
6. **Background Sync / offline mutation queues / store-and-replay.**
   (E-SEC-17)
7. **Precaching the ~10.5 MiB OCR payload** at install. (E-SEC-4)
8. **Caching opaque cross-origin responses** for any reason. (E-SEC-2/6)
9. **Weakening CSP or the proxy** (matcher exclusions, `unsafe-inline`,
   `blob:` workers) to make the SW fit. (E-SEC-11/12/26)
10. **`navigator.storage.persist()`** and any copy implying the archive
    is stored on-device. (E-SEC-22/24)

## Sign-off checklist for QA (wave gate)

- [ ] Cache inventory contains only §A-allowed classes after a full session
- [ ] Signed-out, session-expired, and offline flows each land in their
      honest state (E-SEC-8/9/19) — none renders a hollow "signed-in" app
- [ ] v1→v2 deploy test: immediate activation, total old-cache purge,
      exactly one client reload (E-SEC-13/14)
- [ ] Effective SW route table attached to the PR; `defaultCache`
      pruned or unused (E-SEC-15)
- [ ] Precache byte total reported and within caps (E-SEC-24)
- [ ] `npm test`, `tsc`, `next build`, licence gate green; First Load JS
      delta within the 40 KB/route rule by the canonical measurement
