-- Migration 007 — Points revocations audit log (admin, item 8)
BEGIN;

CREATE TABLE IF NOT EXISTS points_revocations (
  id                       VARCHAR(26)    PRIMARY KEY,
  user_id                  VARCHAR        NOT NULL,
  bar_id                   VARCHAR(26)    NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
  consumption_request_id   VARCHAR(26)    REFERENCES consumption_requests(id) ON DELETE SET NULL,
  points_amount            INT            NOT NULL CHECK (points_amount > 0),
  reason                   TEXT           NOT NULL,
  revoked_by_admin_id      VARCHAR        NOT NULL,
  created_at               TIMESTAMPTZ    NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_points_revocations_user_bar
  ON points_revocations (user_id, bar_id);

COMMIT;
