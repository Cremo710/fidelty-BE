-- Migration 008 — Hardening pre-lancio
-- Contiene: device_push_tokens, receipt_events, correzione default bar_config,
--           aggiornamento rate limit e nuove chiavi platform_config.
-- Idempotente: IF NOT EXISTS, ON CONFLICT DO NOTHING per INSERT seed.

BEGIN;

-- ─── 1. device_push_tokens ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_push_tokens (
  id          VARCHAR(26)   PRIMARY KEY,
  user_id     VARCHAR       NOT NULL,
  token       TEXT          NOT NULL,
  platform    VARCHAR(16),                  -- 'ios' | 'android' | null
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (token)
);
CREATE INDEX IF NOT EXISTS idx_device_push_tokens_user ON device_push_tokens (user_id);

-- ─── 2. receipt_events (shadow mode, append-only) ──────────────────────────
CREATE TABLE IF NOT EXISTS receipt_events (
  id                      VARCHAR(26)   PRIMARY KEY,
  user_id                 VARCHAR       NOT NULL,
  bar_id                  VARCHAR(26)   NOT NULL,
  consumption_request_id  VARCHAR(26),
  distance_meters         INT,
  amount                  NUMERIC(10,2),
  semaphore_status        VARCHAR(10),
  signal_codes            TEXT[],
  ocr_used                BOOLEAN       NOT NULL DEFAULT FALSE,
  ocr_fields_found        JSONB,
  ocr_duration_ms         INT,
  device_id               VARCHAR(128),
  is_mocked_location      BOOLEAN,
  notification_channel    VARCHAR(32),
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_receipt_events_bar_created ON receipt_events (bar_id, created_at);
CREATE INDEX IF NOT EXISTS idx_receipt_events_user ON receipt_events (user_id, created_at);

-- ─── 3. Nuovi DEFAULT più sicuri per bar_config ─────────────────────────────
ALTER TABLE bar_config
  ALTER COLUMN gps_radius_meters     SET DEFAULT 50,
  ALTER COLUMN cap_enabled           SET DEFAULT TRUE,
  ALTER COLUMN cap_amount            SET DEFAULT 30.00,
  ALTER COLUMN anomaly_enabled       SET DEFAULT TRUE,
  ALTER COLUMN young_account_enabled SET DEFAULT TRUE;

-- Allinea righe esistenti con i nuovi default di sicurezza
-- LEAST per GPS e cap_amount: non aumentiamo mai il raggio/cap di chi lo aveva già più basso
UPDATE bar_config SET
  gps_radius_meters     = LEAST(gps_radius_meters, 50),
  cap_enabled           = TRUE,
  cap_amount            = LEAST(cap_amount, 30.00),
  anomaly_enabled       = TRUE,
  young_account_enabled = TRUE,
  updated_at            = CURRENT_TIMESTAMP;

-- ─── 4. Aggiorna rate limit (005 usa ON CONFLICT DO NOTHING, serve UPDATE) ──
UPDATE platform_config
  SET value = '4'::jsonb, updated_at = CURRENT_TIMESTAMP
  WHERE key = 'rate_limit_per_user_per_bar_per_day';

-- ─── 5. Nuove chiavi platform_config ───────────────────────────────────────
INSERT INTO platform_config (key, value) VALUES
  -- TODO da tarare col titolare: 6000 = ~60 € al giorno (100 pt/€)
  ('max_points_per_user_per_day',  '6000'::jsonb),
  -- TODO da tarare col titolare: 200000 = ~2000 € di consumazioni/bar/giorno
  ('max_points_per_bar_per_day',   '200000'::jsonb),
  -- Feature flag OCR: attivato in Fase 1 (false = comportamento attuale)
  ('ocr_enabled',                  'false'::jsonb),
  -- Rifiuta richieste con posizione simulata (isMockedLocation=true su Android)
  ('mock_location_reject',         'true'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
