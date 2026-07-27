-- Migration 009 — Sessioni OCR lato server (Fase 1)
-- La sessione tiene i campi estratti dall'OCR per 10 minuti.
-- Il client non vede mai i valori raw — li usa solo al momento della conferma.

BEGIN;

CREATE TABLE IF NOT EXISTS receipt_ocr_sessions (
  id            VARCHAR(26)   PRIMARY KEY,
  user_id       VARCHAR       NOT NULL,
  bar_id        VARCHAR(26)   NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
  amount        NUMERIC(10,2),
  vat_number    VARCHAR(16),
  doc_id        VARCHAR(16),
  receipt_date  DATE,
  image_sha256  CHAR(64)      NOT NULL,
  image_url     TEXT,
  raw_text      TEXT,
  fields_found  JSONB         NOT NULL DEFAULT '{}'::jsonb,
  consumed_at   TIMESTAMPTZ,
  expires_at    TIMESTAMPTZ   NOT NULL,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ocr_sessions_user    ON receipt_ocr_sessions (user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ocr_sessions_hash    ON receipt_ocr_sessions (image_sha256);
CREATE INDEX IF NOT EXISTS idx_ocr_sessions_expires ON receipt_ocr_sessions (expires_at);

COMMIT;
