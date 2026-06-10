-- Migration 003 — Soluzione B: receipt code, semaphore fields, new status values
-- Run: psql $DATABASE_URL -f 003_soluzione_b_receipt_semaphore.sql
-- Impact on legacy rows:
--   pending   → remain pending  (barista queue, unchanged)
--   approved  → remain approved (points already credited at approval time, no double-credit)
--   rejected  → remain rejected
--   receipt_code_block1/2 = NULL for all legacy rows (partial unique index skips them)
--   semaphore_status      = NULL for all legacy rows (treated as legacy by app logic)

BEGIN;

-- 1. Add receipt code columns
ALTER TABLE consumption_requests
  ADD COLUMN IF NOT EXISTS receipt_code_block1   VARCHAR(4)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS receipt_code_block2   VARCHAR(4)   DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS receipt_submitted_at  TIMESTAMPTZ  DEFAULT NULL;

-- 2. Add semaphore columns
ALTER TABLE consumption_requests
  ADD COLUMN IF NOT EXISTS semaphore_status      VARCHAR(10)  DEFAULT NULL
    CHECK (semaphore_status IS NULL OR semaphore_status IN ('green', 'yellow')),
  ADD COLUMN IF NOT EXISTS signal_flags          JSONB        NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS retroactive_flagged   BOOLEAN      NOT NULL DEFAULT FALSE;

-- 3. Extend status check to include 'credited'
--    (pending=yellow queue, credited=auto-accredited green, approved=barista manual, rejected)
ALTER TABLE consumption_requests DROP CONSTRAINT IF EXISTS consumption_requests_status_check;
ALTER TABLE consumption_requests
  ADD CONSTRAINT consumption_requests_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'credited'));

-- 4. Partial unique index: (code, bar, calendar-day) — NULL codes are excluded
CREATE UNIQUE INDEX IF NOT EXISTS uidx_consumption_requests_receipt_bar_day
  ON consumption_requests (
    receipt_code_block1,
    receipt_code_block2,
    bar_id,
    date_trunc('day', created_at AT TIME ZONE 'Europe/Rome')
  )
  WHERE receipt_code_block1 IS NOT NULL
    AND receipt_code_block2 IS NOT NULL
    AND status != 'rejected';

COMMIT;
