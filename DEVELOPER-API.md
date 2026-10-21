# SPDX-License-Identifier: MIT

# EZVault Developer API

Scripted access to an EZVault archive (parity row 36 — the Tropy
developer-API leg: scripted note insertion). The API is the app's own
REST surface plus an app-level bearer-token layer documented here.

## Two gates, honestly

1. **Platform gate.** On the public deployment, Vercel Authentication
   (Deployment Protection) fronts the whole app. Scripts must ALSO
   present the Vercel protection-bypass credential for automation
   (the `x-vercel-protection-bypass` header, from the project's
   Deployment Protection settings) — or target a local / self-hosted
   run where you control that layer. **Never disable Deployment
   Protection to make scripts work.**
2. **App gate.** Requests to the documented subset below may carry
   `Authorization: Bearer <token>`. The token is the authorization
   layer: it is checked on every documented route, it can never widen
   access beyond its scopes, and revoked/expired tokens get `401`.
   Requests with no bearer header ride the human (browser session)
   path, exactly as the UI does.

## Tokens

Create tokens in **Project settings → Developer API tokens** (or via
the human-session API below). The plaintext secret is shown **once**,
at creation; only its SHA-256 hash is stored. Tokens look like
`ezv_<43 base64url chars>`; listings show only a display prefix.

| Scope | Allows |
|---|---|
| `read` | GET projects, items, photos, notes (the routes below) |
| `notes:write` | Create notes on photos + selections; update a note by id |

Scopes are exact: `read` does not imply `notes:write`, and
`notes:write` does not imply `read`. Tokens cannot delete anything,
cannot manage tokens, and are denied on every route outside the
documented subset.

### Token management (human session only)

```bash
# List tokens (prefix/scopes/last-used — never secrets or hashes)
curl https://<deployment>/api/api-tokens -H 'Cookie: <browser session>'

# Create (the response's `secret` field appears ONCE)
curl -X POST https://<deployment>/api/api-tokens \
  -H 'Content-Type: application/json' \
  -d '{"name":"field-notes-script","scopes":["read","notes:write"]}'

# Revoke
curl -X DELETE https://<deployment>/api/api-tokens/<token-id>
```

## Documented subset

Base: `https://<deployment>/api`. All routes also accept the human
session with no bearer header.

### Read (`read` scope)

```bash
curl https://<deployment>/api/projects \
  -H "Authorization: Bearer $EZV_TOKEN"

curl https://<deployment>/api/projects/<projectId> \
  -H "Authorization: Bearer $EZV_TOKEN"

curl "https://<deployment>/api/projects/<projectId>/items?limit=50" \
  -H "Authorization: Bearer $EZV_TOKEN"

curl https://<deployment>/api/projects/<projectId>/items/<itemId> \
  -H "Authorization: Bearer $EZV_TOKEN"

curl https://<deployment>/api/projects/<projectId>/items/<itemId>/photos \
  -H "Authorization: Bearer $EZV_TOKEN"

curl https://<deployment>/api/projects/<projectId>/photos/<photoId> \
  -H "Authorization: Bearer $EZV_TOKEN"

curl https://<deployment>/api/projects/<projectId>/photos/<photoId>/notes \
  -H "Authorization: Bearer $EZV_TOKEN"

curl https://<deployment>/api/projects/<projectId>/selections/<selectionId>/notes \
  -H "Authorization: Bearer $EZV_TOKEN"

curl https://<deployment>/api/projects/<projectId>/notes/<noteId> \
  -H "Authorization: Bearer $EZV_TOKEN"
```

On the public deployment, add the platform bypass header to every
call: `-H "x-vercel-protection-bypass: $VERCEL_BYPASS"`.

### Write notes (`notes:write` scope)

Note bodies are TipTap/ProseMirror JSON (`state`); the server
sanitizes link marks before storage (http/https/mailto/tel only) and
derives the plain `text` when you omit it.

```bash
# Create a note on a photo (the Tropy dev-API parity core)
curl -X POST https://<deployment>/api/projects/<projectId>/photos/<photoId>/notes \
  -H "Authorization: Bearer $EZV_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"state":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Transcribed from the field notebook, p. 12."}]}]}}'

# Create a note on a selection
curl -X POST https://<deployment>/api/projects/<projectId>/selections/<selectionId>/notes \
  -H "Authorization: Bearer $EZV_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"state":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Detail: harbour light."}]}]}}'

# Update a note
curl -X PATCH https://<deployment>/api/projects/<projectId>/notes/<noteId> \
  -H "Authorization: Bearer $EZV_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"state":{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Corrected transcription."}]}]}}'
```

## Errors

| Status | Meaning |
|---|---|
| `401` | Token invalid, revoked, or expired (or a non-token bearer was presented) |
| `403` | Token lacks the required scope; tokens attempting token management or note deletion |
| `400` | Validation (missing/invalid body fields) |
| `404` | Project / item / photo / note not found |
| `429` | Rate limited (see `Retry-After`) |

## Omeka S + IIIF (rows 25/26)

Not token routes — human-session features, documented in CONTRACT.md
(Wave D section): Omeka connection + push live in Project settings and
the item inspector; IIIF manifest import is a tab in the Import dialog.
There is NO live public Omeka instance for EZVault: pushes can only be
verified against your own Omeka S site.
