CREATE TABLE IF NOT EXISTS consumption_request_participants (
  request_id VARCHAR(26) NOT NULL REFERENCES consumption_requests(id) ON DELETE CASCADE,
  user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  participant_order SMALLINT NOT NULL CHECK (participant_order >= 0),
  points_allocated INTEGER NOT NULL DEFAULT 0 CHECK (points_allocated >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (request_id, user_id),
  UNIQUE (request_id, participant_order)
);

CREATE INDEX IF NOT EXISTS idx_consumption_request_participants_user
  ON consumption_request_participants(user_id, request_id);
