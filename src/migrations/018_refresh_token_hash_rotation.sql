-- 018: refresh token salvati come hash SHA-256 e organizzati in famiglie per la rotazione.
--
-- Le sessioni esistenti restano valide: l'hash viene calcolato dai token già presenti,
-- poi il testo in chiaro viene cancellato. Ogni token esistente diventa una famiglia a sé.

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS token_hash CHAR(64);
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS family_id VARCHAR(32);
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ;

UPDATE refresh_tokens
SET token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex')
WHERE token_hash IS NULL AND token IS NOT NULL;

UPDATE refresh_tokens
SET family_id = 'legacy-' || id
WHERE family_id IS NULL;

-- Il token in chiaro non serve più: da qui in avanti si scrive e si cerca solo per hash
ALTER TABLE refresh_tokens ALTER COLUMN token DROP NOT NULL;
UPDATE refresh_tokens SET token = NULL WHERE token IS NOT NULL;

ALTER TABLE refresh_tokens ALTER COLUMN token_hash SET NOT NULL;
ALTER TABLE refresh_tokens ALTER COLUMN family_id SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uidx_refresh_tokens_token_hash ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens (family_id);
