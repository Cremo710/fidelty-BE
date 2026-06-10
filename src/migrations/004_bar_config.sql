-- Migration 004 — Per-bar configuration table
BEGIN;

CREATE TABLE IF NOT EXISTS bar_config (
  bar_id                  VARCHAR(26)      PRIMARY KEY REFERENCES bars(id) ON DELETE CASCADE,
  -- GPS
  gps_radius_meters       INT              NOT NULL DEFAULT 100,
  -- Semaphore — auto-credit (OFF = all requests go to barista queue, Soluzione A behaviour)
  auto_credit_enabled     BOOLEAN          NOT NULL DEFAULT TRUE,
  -- Signal 2: absolute cap
  cap_enabled             BOOLEAN          NOT NULL DEFAULT FALSE,
  cap_amount              NUMERIC(10,2)    NOT NULL DEFAULT 100.00,
  -- Signal 3: historical anomaly
  anomaly_enabled         BOOLEAN          NOT NULL DEFAULT FALSE,
  -- Signal 4: young account + high amount
  young_account_enabled   BOOLEAN          NOT NULL DEFAULT FALSE,
  created_at              TIMESTAMPTZ      NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMPTZ      NOT NULL DEFAULT CURRENT_TIMESTAMP
);

COMMIT;
