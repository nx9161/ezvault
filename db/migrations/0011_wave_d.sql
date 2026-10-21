-- SPDX-License-Identifier: MIT
-- db/migrations/0011_wave_d.sql — Wave D (rows 25/26/36): Omeka S push,
-- IIIF manifest import, developer API tokens.
--
-- 1. omeka_settings: per-project Omeka S connection. The key credential
--    is stored ONLY as AES-256-GCM ciphertext (lib/crypto/master-key.ts,
--    key derived from the app's MASTER_KEY) — never plaintext. When
--    MASTER_KEY is unconfigured the settings route refuses to accept a
--    credential at all (feature reports not_configured), so this column
--    can never hold a plaintext fallback.
-- 2. omeka_sync: per-item sync state so a re-push UPDATES the remote item
--    instead of duplicating it. media_map maps photo subject id -> remote
--    media id for photos already attached on the Omeka side.
-- 3. api_tokens: developer API tokens (row 36). Only the SHA-256 hash of
--    the secret is stored; the plaintext is shown ONCE at creation.
--    scopes is a JSONB array drawn from {'read','notes:write'}.
-- 4. import_jobs gains the 'omeka' (batched push report) and 'iiif'
--    (manifest harvest report) kinds.
--
-- Apply with: psql "$DATABASE_URL" -f db/migrations/0011_wave_d.sql
-- (migrations apply in filename order).

CREATE TABLE IF NOT EXISTS omeka_settings (
  project_id          UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  base_url            TEXT NOT NULL,
  key_identity        TEXT NOT NULL DEFAULT '',
  -- AES-256-GCM ciphertext, format v1:<iv b64>:<tag b64>:<ciphertext b64>.
  credential_cipher   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS omeka_sync (
  item_id             UUID PRIMARY KEY REFERENCES subjects(id) ON DELETE CASCADE,
  project_id          UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  remote_id           BIGINT NOT NULL,
  remote_url          TEXT,
  media_map           JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_pushed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status         TEXT NOT NULL DEFAULT 'ok',
  last_error          TEXT
);
CREATE INDEX IF NOT EXISTS omeka_sync_project_idx ON omeka_sync(project_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                TEXT NOT NULL,
  -- SHA-256 hex of the full token secret. The secret itself is NEVER stored.
  token_hash          TEXT NOT NULL UNIQUE,
  -- Display prefix (e.g. 'ezv_Ab3d…') — safe to show in listings.
  prefix              TEXT NOT NULL,
  scopes              JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at        TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS api_tokens_hash_idx ON api_tokens(token_hash) WHERE revoked_at IS NULL;

ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_kind_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_kind_check
  CHECK (kind IN ('upload','folder','tpy','jsonld','compress','csv','omeka','iiif'));
