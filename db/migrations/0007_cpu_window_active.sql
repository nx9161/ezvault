-- SPDX-License-Identifier: MIT
-- db/migrations/0007_cpu_window_active.sql — A5: cpu_budget_windows
-- concurrency uniqueness guard.
--
-- currentWindow() used to SELECT-then-INSERT: two concurrent first-calls
-- could both see no window and insert two rows (the guard then under-counts
-- CPU). Fix: a single active window at a time, enforced by a partial unique
-- index; currentWindow() (lib/cpu-budget.ts) deactivates expired windows,
-- then INSERTs the fresh window with ON CONFLICT (active) WHERE active
-- DO UPDATE — concurrent first-calls converge on exactly one row.
--
-- Apply with: psql "$DATABASE_URL" -f db/migrations/0007_cpu_window_active.sql
-- (see README "Deploy runbook" — migrations apply in filename order).

ALTER TABLE cpu_budget_windows
  ADD COLUMN active BOOLEAN NOT NULL DEFAULT false;

-- Backfill: the latest window becomes the active one (no-op on empty table).
UPDATE cpu_budget_windows SET active = true
WHERE id = (SELECT id FROM cpu_budget_windows ORDER BY window_end DESC LIMIT 1);

-- Exactly one row may carry active = true (inactive history rows are
-- unconstrained).
CREATE UNIQUE INDEX cpu_budget_windows_active_uniq
  ON cpu_budget_windows (active) WHERE active;
