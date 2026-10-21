-- SPDX-License-Identifier: MIT
-- db/migrations/0009_csv_import_kind.sql — Wave B2 (parity row 23).
--
-- CSV metadata import reports through the existing import_jobs pattern
-- (status + per-row error report in `report`), so its rows need a 'csv'
-- kind alongside upload/folder/tpy/jsonld/compress. The 0001 CHECK is
-- anonymous in the DDL (Postgres names it import_jobs_kind_check).

ALTER TABLE import_jobs DROP CONSTRAINT IF EXISTS import_jobs_kind_check;
ALTER TABLE import_jobs ADD CONSTRAINT import_jobs_kind_check
  CHECK (kind IN ('upload','folder','tpy','jsonld','compress','csv'));
