CREATE TABLE IF NOT EXISTS social_identities (
  id BIGSERIAL PRIMARY KEY,
  user_id VARCHAR(26) NOT NULL REFERENCES utenti(id) ON DELETE CASCADE,
  provider VARCHAR(16) NOT NULL CHECK (provider IN ('google', 'apple')),
  provider_subject TEXT NOT NULL,
  email_snapshot VARCHAR(255),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (provider, provider_subject),
  UNIQUE (user_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_social_identities_user_id
  ON social_identities(user_id);
