CREATE TABLE IF NOT EXISTS bar_team_members (
  id VARCHAR(26) PRIMARY KEY,
  bar_id VARCHAR(26) NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
  user_id VARCHAR(26) REFERENCES utenti(id) ON DELETE CASCADE,
  email VARCHAR(320) NOT NULL,
  role VARCHAR(32) NOT NULL CHECK (role IN ('manager', 'co_manager', 'waiter')),
  status VARCHAR(16) NOT NULL CHECK (status IN ('active', 'pending', 'revoked', 'left', 'expired')),
  invited_by_user_id VARCHAR(26) REFERENCES utenti(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (
    (status = 'pending' AND user_id IS NULL AND expires_at IS NOT NULL)
    OR (status IN ('active', 'left') AND user_id IS NOT NULL)
    OR status IN ('revoked', 'expired')
  )
);

INSERT INTO bar_team_members
  (id, bar_id, user_id, email, role, status, accepted_at)
SELECT
  b.id,
  b.id,
  b.user_id,
  lower(u.email),
  'manager',
  'active',
  CURRENT_TIMESTAMP
FROM bars b
JOIN utenti u ON u.id = b.user_id
ON CONFLICT DO NOTHING;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_bar_team_active_user
  ON bar_team_members (bar_id, user_id)
  WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS uidx_bar_team_pending_email
  ON bar_team_members (bar_id, lower(email))
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS uidx_bar_team_one_manager
  ON bar_team_members (bar_id)
  WHERE role = 'manager' AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_bar_team_user_status
  ON bar_team_members (user_id, status);

CREATE TABLE IF NOT EXISTS bar_team_audit (
  id VARCHAR(26) PRIMARY KEY,
  bar_id VARCHAR(26) NOT NULL REFERENCES bars(id) ON DELETE CASCADE,
  actor_user_id VARCHAR(26) REFERENCES utenti(id) ON DELETE SET NULL,
  target_email VARCHAR(320) NOT NULL,
  action VARCHAR(32) NOT NULL,
  old_role VARCHAR(32),
  new_role VARCHAR(32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
