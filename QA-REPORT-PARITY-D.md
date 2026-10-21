<!-- SPDX-License-Identifier: MIT -->
# QA Report — EZVault FULL PARITY Wave D (Omeka S + IIIF + Developer API tokens)

**Verdict: BLOCK — do not sign off.** Two security blockers (B1, B2 below),
both verified against the tree and by running probes. Everything else in
the wave is solid: all headline numbers reproduce exactly.

- Baseline: `main` @ `8d2719b` (Wave D commits `da26958`…`8d2719b`).
- QA method: full-tree reads of every Wave D lib + route, gate re-runs,
  and adversarial probes executed against `lib/fetch-guard.ts` via `tsx`.
- `.env.local` protocol followed for the build (moved aside, build run,
  restored immediately, verified back at 1097 bytes). Tree otherwise
  untouched; this report is the only file QA commits.

---

## 1. Gates — PASS

| Gate | Claim | QA result |
|---|---|---|
| `npm test` | 178/178, 44 suites | **178 pass / 0 fail, 44 suites** — reproduced |
| `npx tsc --noEmit` | clean | exit 0, no output |
| `npm run build` | green | exit 0 (`.env.local` aside per protocol, restored 1097 B) |
| `node scripts/check-licences.mjs` | PASS | OK — only the four pre-existing LGPL warnings (sharp/libheif) |
| `node scripts/verify-codecs.mjs` | OK | OK (libvips 8.18.7, sharp 0.35.5) |
| Zero new dependencies | yes | `git diff da26958^..HEAD -- package.json package-lock.json` is **empty** |

## 2. Developer tokens (row 36) — **FAIL (Blocker B1)**

### What passes (verified in code, not just tests)

- **Semantics on every wired route:** `enforceTokenScope`
  (`lib/token-auth.ts`) — no bearer → returns `null`, human path
  unchanged; non-`ezv_` bearer → 401; unknown → 401; revoked → 401;
  expired → 401; valid + wrong scope → 403; `last_used_at` stamped only
  after the scope check succeeds. Scopes are exact and non-implying
  (`tokenHasScope` is a plain membership check; `normalizeScopes`
  rejects unknown/empty scope lists).
- **Wiring matches DEVELOPER-API.md exactly:** `read` on GET projects,
  project, items, item, item-photos, photo, photo-notes, selection-notes,
  note (the last four via `lib/api/notes.ts` factories); `notes:write` on
  POST photo/selection notes and PATCH note. No documented route is
  missing enforcement, and no wired route uses the wrong scope.
- **Token management is human-only:** `rejectTokenAuth` (any presented
  bearer → 403) is invoked in GET + POST `/api/api-tokens` and DELETE
  `/api/api-tokens/[tokenId]`.
- **Note DELETE refuses presented tokens:** a `notes:write` token gets an
  explicit 403 ("API tokens may not delete notes"); a `read` token gets
  403 from the scope check; an invalid token gets 401. No-bearer human
  path proceeds.
- **Hash-only persistence:** the INSERT in `createApiToken` stores
  `generated.tokenHash` + display prefix only; `listApiTokens` never
  selects `token_hash`; grep finds the plaintext in exactly one place —
  the creation response (`secret` field, 201). No logging of token or
  Omeka credential anywhere in `lib/`/`app/` (grep clean). The settings
  UI holds the secret in component state only (no local/session storage).

### Minor overstatement (noted, not blocking)

- CONTRACT says verification is a "constant-time digest compare mirroring
  `lib/auth.ts`". The constant-time `verifyApiToken`/`digestsEqual` in
  `lib/token-core.ts` is real and unit-tested, but it is **not the live
  path**: `lib/token-auth.ts` verifies by DB lookup
  (`WHERE token_hash = ${hashApiToken(presented)}`). For a 256-bit random
  token hashed with SHA-256 this is standard, safe practice (the attacker
  never learns the stored hash; there is no practical timing oracle) —
  but the doc sentence describes the test-only helper, and the test
  asserts source patterns rather than the live path. Reword CONTRACT or
  route verification through `verifyApiToken`.

### **B1 — BLOCKER: tokens are NOT denied outside the documented subset**

`DEVELOPER-API.md` states: *"Tokens cannot delete anything, cannot
manage tokens, and are denied on every route outside the documented
subset"* and *"it can never widen access beyond its scopes"*. CONTRACT
repeats the claim. **The code does not implement it.** Enforcement is
opt-in per handler, and there is no global guard (`proxy.ts` and
`lib/api/route-utils.ts` `handle()` contain no bearer logic at all):

- **70 of 79** `app/api/**/route.ts` files contain no
  `enforceTokenScope`/`rejectTokenAuth` reference. On those routes a
  presented bearer token is **silently ignored** and the request runs on
  the human path.
- This includes the **non-GET methods of the documented files
  themselves**: `PATCH`/`DELETE /api/projects/[id]` (DELETE ignores the
  request object entirely — `_req` — and deletes the project plus its
  R2 objects), `PATCH`/`DELETE` on items and photos, and
  `POST /api/projects`.
- It also includes `POST /api/admin/delete-everything`,
  `GET …/export/zip|csv|jsonld` (full archive incl. original bytes),
  `POST …/trash/empty`, items merge/bulk, metadata bulk, and
  storage compress.
- This matters in the **documented operating configuration**:
  DEVELOPER-API.md instructs scripts to present the Vercel bypass header
  *together with* the bearer token. A holder of a `read`-only token in
  that configuration can therefore delete a whole project or the entire
  database — the exact outcome the docs promise is impossible.

**Required fix:** deny any presented `ezv_` bearer on every route
outside the documented subset (e.g. a proxy-level or shared-handler
guard), and enforce on **all methods** of subset paths (only GET/note
-writes may proceed, per scope; everything else with a token → 403).
Add wiring tests that assert denial on representative non-subset routes
(admin, export, project DELETE), not only presence on subset routes.
Alternatively narrow the docs to match the code — QA does not accept
that resolution: the scoped-token guarantee is the feature.

## 3. Omeka S (row 25) — PASS (notes below)

- **Cipher-only storage:** `lib/crypto/master-key.ts` — AES-256-GCM,
  `v1:<iv b64>:<tag b64>:<ct b64>`, random 12-byte IV, key derived from
  `MASTER_KEY` via `scryptSync` (hex-shaped keys decoded byte-exact
  first). Tests prove round-trip, wrong-key failure, and tamper failure.
  The only credential column is `credential_cipher` (migration + service
  grep clean; no plaintext insert path).
- **No MASTER_KEY → nothing persisted:** `saveOmekaSettings` throws
  `HttpError(400, 'not_configured', …)` *before* any SQL when a
  credential is supplied without a key — even the base_url/identity
  update is aborted. No plaintext fallback exists anywhere.
- **Settings GET never returns the credential:** the view carries
  `has_credential` only (service selects `credential_cipher` but maps it
  to a boolean; the `lib/types.ts` view type has no credential field).
- **Client shapes match the real Omeka S API:** key auth as
  `key_identity`/`key_credential` query params; `POST /api/items`;
  property ids resolved from `GET /api/properties` (`o:term`/`o:id`,
  paginated); values as `{property_id, type:'literal', '@value'}`;
  media attached via the `url` ingester. All exercised against the real
  request-building code with mocked fetch, incl. DC terms *and*
  elements-1.1 URI mapping, notes → extra `dcterms:description`, and
  honest warnings for non-DC/unresolved properties.
- **Re-push is an update:** `pushItemToOmeka` branches on the
  `omeka_sync` row — existing `remote_id` → `PUT /api/items/{id}`,
  never a second create; `media_map` prevents re-attaching photos.
- **Errors surface honestly:** `OmekaError` carries status + body
  excerpt; single push maps it to an `omeka_error` HttpError with the
  Omeka status; project push records per-item `failed` entries with the
  message and never reports a failed item as pushed.

Notes (non-blocking):
1. If media attachment throws *after* a successful create, no sync row
   is written, so the next push takes the create path again and can
   duplicate the remote item. Persist the sync row (or a pending state)
   immediately after create, before attaching media.
2. Omeka fetches do not use `lib/fetch-guard.ts` and have no byte cap or
   timeout (`res.text()` unbounded). The base URL is owner-configured
   (and `http://` is allowed — with key auth in the query string, the
   credential then travels cleartext and lands in the Omeka server's
   logs; that is Omeka's key-auth design, but the settings UI should
   warn when an `http://` base URL is saved).

## 4. IIIF (row 26) — PASS (note below)

- **Real fixtures:** `test/fixtures/iiif-v2.json` is a genuine
  Presentation 2 manifest (`sc:Manifest`, sequences/canvases,
  `oa:Annotation` painting, Image API 2 service) and `iiif-v3.json` a
  genuine Presentation 3 manifest (language maps, AnnotationPage,
  ImageService2). Parser output asserted field-by-field for both.
- **Grouping as documented:** one item per canvas (`planHarvest`),
  grouped in a list named from the manifest label (import creates the
  list with `manifest.label`).
- **Image API normalization correct:** `fullSizeImageUrl` yields
  `{service}/full/max/0/default.jpg` with trailing slashes stripped;
  service-less canvases fall back to the body/resource URL as-is.
- **Harvest does not trust fetched content-type:**
  `lib/iiif/import.ts` ignores `fetched.contentType` entirely — bytes
  pass `detectFormat` magic-byte verification, the mimetype is derived
  from the detected format, and only then staged via `keys.upload` →
  `createPhotoRows` → `processPhoto`.
- **Unmapped metadata preserved:** `mapManifestMetadata` returns
  unmapped pairs and the import writes them verbatim into an item note
  (plus the manifest-source line), matching the jsonld-accept
  convention. Canvas label → `title`, manifest description →
  `description` fills verified.

Note (non-blocking): the item + note rows are committed *before* the
image harvest, so a canvas whose image fetch fails leaves a photo-less
item behind (the job result honestly reports `failed`). Also, canvases
whose photo dedupes are counted in `imported` with status `duplicate` —
acceptable, but the count semantics should be stated in CONTRACT.

## 5. fetch-guard — **FAIL (Blocker B2)**

### What passes (probed)

- https-only; embedded credentials rejected; dotted-quad private /
  loopback / link-local / CGNAT / reserved ranges rejected
  (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 0/8, 100.64/10,
  240/4); `localhost`, `*.localhost`, `*.local`, `*.internal` rejected;
  IPv6 `::1`, `::`, fe80::/10, fc00::/7 rejected.
- **Every exotic IPv4 encoding is caught** — `0x7f.1`, `0x7f.0.0.1`,
  `0177.0.0.1`, `2130706433`, `127.1`, `127.0.0.1.` (trailing dot),
  `%31%32%37.0.0.1`, `0x7f000001` — because WHATWG URL canonicalizes
  the hostname to dotted-quad before the check runs.
- Redirects are followed manually and **re-validated per hop**
  (test proves a redirect to 169.254.169.254 is refused); byte caps are
  enforced (manifest 5 MiB, images `MAX_PHOTO_BYTES`). Minor hardening
  note: the cap is checked after `arrayBuffer()` completes, so it
  bounds the accepted size, not peak memory while streaming.
- **DNS-rebinding limit is honestly documented** in both
  `lib/fetch-guard.ts` and CONTRACT.md, and nothing in code or docs
  claims DNS resolution protection. That part is exactly as stated.

### **B2 — BLOCKER: IPv4-mapped IPv6 literals bypass the guard**

`isPrivateIpv6` handles `::ffff:` only when followed by a *dotted*
IPv4 address — a form WHATWG URL parsing never produces. The parser
canonicalizes `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, the hex tail
fails `ipv4Octets`, and the address is **allowed**. Probed live against
`assertPublicHttpsUrl`:

| URL | Result |
|---|---|
| `https://[::ffff:127.0.0.1]/x` | **ALLOWED** (host `[::ffff:7f00:1]`) |
| `https://[::ffff:7f00:1]/x` | **ALLOWED** |
| `https://[0:0:0:0:0:ffff:127.0.0.1]/x` | **ALLOWED** |
| `https://[::ffff:0a00:1]/x` (= 10.0.0.1) | **ALLOWED** |
| `https://[::ffff:169.254.169.254]/latest/meta-data/` | **ALLOWED** (`[::ffff:a9fe:a9fe]`) |
| `https://[64:ff9b::a9fe:a9fe]/x` (NAT64-embedded metadata IP) | **ALLOWED** |

An IPv4-mapped IPv6 address connects to the embedded IPv4 host on
mainstream runtimes, so a hostile IIIF manifest (or image URL inside
one) can reach loopback services and the cloud metadata endpoint
through both guarded fetch sites. This contradicts the module's and
CONTRACT's claim that "IP literals are range-checked", and it is **not**
covered by the documented DNS-rebinding limit, which concerns *names*.
Also allowed, lower risk: `198.18.0.0/15` (benchmarking) and the
documentation ranges — worth adding while fixing B2.

**Required fix:** after the `::ffff:` prefix, parse the remaining hex
groups into the embedded IPv4 address and range-check it (likewise
consider the NAT64 well-known prefix `64:ff9b::/96`); add regression
tests using the canonical hex forms above — the current tests only
exercise the dotted form indirectly via plain IPv4 URLs, which is why
this shipped green.

## 6. Migration `0011_wave_d.sql` — PASS

Creates `omeka_settings` / `omeka_sync` / `api_tokens` with
`IF NOT EXISTS` throughout (indexes included); the `import_jobs` kind
constraint is dropped `IF EXISTS` and re-added with the full prior set
(`…'csv'`) plus `'omeka'` and `'iiif'` — re-runnable and lossless.
Filename order intact: `…0010_transcriptions_search.sql`,
`0011_wave_d.sql` (the pre-existing 0004 gap predates this wave).
`api_tokens.token_hash` is `UNIQUE`; no plaintext credential column
exists in `omeka_settings`.

## 7. Bundle — PASS

Canonical method (INTEGRATION-DECISIONS: `rootMainFiles` + the
`/[projectId]` route's non-async client-reference chunks, per-file
gzip, summed), measured on QA's own production build:

- **First Load JS = 215.03 KB gzip** (11 files, 0 missing; raw 731.6 KB)
- Delta vs Wave C's 213.67 KB = **+1.36 KB** — the builder's figures
  reproduce **exactly**.

## 8. Docs honesty — FAIL (via B1/B2; rest passes)

- The platform note is present in DEVELOPER-API.md and **never**
  suggests disabling Deployment Protection — it explicitly says
  *"Never disable Deployment Protection to make scripts work"* and
  documents the `x-vercel-protection-bypass` header requirement.
- CONTRACT's Wave D section matches the code on schema, Omeka routes
  and shapes, IIIF response shape (201 + `{job_id, list_id,
  manifest_label, version, imported, failed, results[]}`), the token
  subset, and the bundle figure. The link-policy deviation note is
  present and accurate (`lib/link-policy.ts` is the note-link allowlist;
  the fetch guard is correctly a new module).
- **Overstated:** (a) the token-denial claims quoted in B1; (b) the
  fetch-guard literal range-check claim quoted in B2; (c) the
  constant-time verification phrasing (minor, §2); (d) small: CONTRACT
  says project-push Omeka errors surface "as `omeka_error`" — per-item
  results carry the message text (status + excerpt embedded) but no
  `omeka_error` code field; the code is only on the single-push route.

---

## Findings ranked

1. **B1 (blocker, security):** bearer tokens silently honored-as-human
   on all non-subset routes incl. `admin/delete-everything` and project
   DELETE — scoped-token guarantee in DEVELOPER-API.md/CONTRACT is not
   implemented. (§2)
2. **B2 (blocker, security):** IPv4-mapped IPv6 literal SSRF bypass in
   `lib/fetch-guard.ts` — loopback / private / cloud-metadata reachable
   via `[::ffff:…]` in manifest or image URLs. (§5)
3. Omeka media-attach failure after create can duplicate the remote
   item on re-push (no sync row persisted before attach). (§3)
4. IIIF failed harvest leaves the pre-created item/note rows behind;
   `duplicate` canvases count as `imported` (state CONTRACT semantics).
   (§4)
5. CONTRACT overstates the constant-time compare (live path is a DB
   hash lookup — safe, but not what the sentence says). (§2)
6. Omeka fetches: no fetch-guard / byte cap / timeout; `http://` base
   URLs put the key credential on the wire in cleartext query params.
   (§3)
7. fetch-guard byte cap enforced post-read (peak-memory bound), and
   198.18/15 + documentation ranges allowed. (§5)

## Builder claims audit

Reproduced exactly: 178/178 tests (44 suites), tsc clean, build green,
licence PASS, zero new deps, First Load JS 215.03 KB (+1.36 KB).
Overstated: the token subset-denial guarantee (B1) and the fetch-guard
IP-literal coverage (B2) — in both cases the unit tests assert the
*wired/happy* paths (presence of enforcement on subset routes; dotted
IPv4 rejections) and never probe the negative space QA probed here.

**Sign-off withheld until B1 and B2 are fixed and re-verified.**
