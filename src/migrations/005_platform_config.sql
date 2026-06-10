-- Migration 005 — Platform-level configuration + seed defaults
BEGIN;

CREATE TABLE IF NOT EXISTS platform_config (
  key        VARCHAR(100)  PRIMARY KEY,
  value      JSONB         NOT NULL,
  updated_at TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO platform_config (key, value) VALUES
  ('rate_limit_per_user_per_bar_per_day',  '15'::jsonb),
  ('points_per_euro',                       '100'::jsonb),
  ('anomaly_multiplier',                    '3.0'::jsonb),
  ('young_account_min_days',                '7'::jsonb),
  ('young_account_min_requests',            '3'::jsonb),
  ('young_account_max_amount',              '40.0'::jsonb),
  ('consumption_detail_bonus_points',       '100'::jsonb),
  ('consumption_detail_tolerance_pct',      '20.0'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
