-- Migration 006 — Consumption details (item 10: optional receipt breakdown)
BEGIN;

CREATE TABLE IF NOT EXISTS consumption_details (
  id                       VARCHAR(26)    PRIMARY KEY,
  consumption_request_id   VARCHAR(26)    NOT NULL REFERENCES consumption_requests(id) ON DELETE CASCADE,
  user_id                  VARCHAR        NOT NULL,
  bar_id                   VARCHAR(26)    NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
  declared_amount          NUMERIC(10,2)  NOT NULL,
  items_total              NUMERIC(10,2),
  detail_status            VARCHAR(20)    NOT NULL DEFAULT 'pending'
    CHECK (detail_status IN ('pending', 'verified', 'low_quality')),
  bonus_awarded            BOOLEAN        NOT NULL DEFAULT FALSE,
  created_at               TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at               TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uidx_consumption_details_request
  ON consumption_details (consumption_request_id);

CREATE TABLE IF NOT EXISTS consumption_detail_items (
  id           SERIAL         PRIMARY KEY,
  detail_id    VARCHAR(26)    NOT NULL REFERENCES consumption_details(id) ON DELETE CASCADE,
  product_name VARCHAR(200)   NOT NULL,
  category     VARCHAR(100),
  unit_price   NUMERIC(10,2)  NOT NULL,
  quantity     INT            NOT NULL DEFAULT 1,
  line_total   NUMERIC(10,2)  NOT NULL
);

COMMIT;
