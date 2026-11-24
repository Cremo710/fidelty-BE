-- 019: un invito ricorda se è stato creato per email o per codice Fidelty.
-- Serve a mostrare il nome dell'invitato solo quando chi invita lo conosceva già (codice),
-- senza rivelare se un'email qualsiasi è registrata. Gli inviti esistenti restano 'email'.

ALTER TABLE bar_team_members ADD COLUMN IF NOT EXISTS invited_via VARCHAR(10) NOT NULL DEFAULT 'email';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_bar_team_invited_via') THEN
    ALTER TABLE bar_team_members
      ADD CONSTRAINT chk_bar_team_invited_via CHECK (invited_via IN ('email', 'public_id'));
  END IF;
END $$;

-- Ricerche per email case-insensitive (login, inviti, lista team)
CREATE INDEX IF NOT EXISTS idx_utenti_email_lower ON utenti (lower(email));
