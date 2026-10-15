-- SPDX-License-Identifier: MIT
-- db/migrations/0003_relative_path.sql — audit column for folder uploads (F2).
--
-- photos.relative_path stores the client's folder-relative path
-- ("a/b/photo.jpg") as accepted on POST /api/import/complete. Audit-only:
-- never read-rendered, never emitted in export payloads. Used to trace a
-- photo back to its original location in a dropped folder tree.
--
-- Apply with: psql "$DATABASE_URL" -f db/migrations/0003_relative_path.sql
-- (see README "Deploy runbook" — migrations apply in filename order).

ALTER TABLE photos ADD COLUMN IF NOT EXISTS relative_path TEXT;
