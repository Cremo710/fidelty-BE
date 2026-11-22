-- 017: vincoli di integrità sui punti, storico dei riscatti preservato, indici per il semaforo.
--
-- Sicura sui dati esistenti: il runner blocca l'avvio se una migrazione fallisce, quindi
-- i CHECK nascono NOT VALID (valgono subito per le nuove scritture) e vengono validati
-- sulle righe esistenti solo se nessuna li viola; altrimenti resta un WARNING nei log.

-- ── Saldi e quote mai negativi ───────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_loyalty_cards_points_nonneg') THEN
    ALTER TABLE loyalty_cards
      ADD CONSTRAINT chk_loyalty_cards_points_nonneg CHECK (points >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_loyalty_cards_lifetime_nonneg') THEN
    ALTER TABLE loyalty_cards
      ADD CONSTRAINT chk_loyalty_cards_lifetime_nonneg CHECK (lifetime_points >= 0) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_crp_participant_order_max') THEN
    ALTER TABLE consumption_request_participants
      ADD CONSTRAINT chk_crp_participant_order_max CHECK (participant_order <= 9) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_offers_points_required_nonneg') THEN
    ALTER TABLE offers
      ADD CONSTRAINT chk_offers_points_required_nonneg CHECK (points_required >= 0) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM loyalty_cards WHERE points < 0) THEN
    ALTER TABLE loyalty_cards VALIDATE CONSTRAINT chk_loyalty_cards_points_nonneg;
  ELSE
    RAISE WARNING '017: loyalty_cards con points < 0, vincolo lasciato NOT VALID';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM loyalty_cards WHERE lifetime_points < 0) THEN
    ALTER TABLE loyalty_cards VALIDATE CONSTRAINT chk_loyalty_cards_lifetime_nonneg;
  ELSE
    RAISE WARNING '017: loyalty_cards con lifetime_points < 0, vincolo lasciato NOT VALID';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM consumption_request_participants WHERE participant_order > 9) THEN
    ALTER TABLE consumption_request_participants VALIDATE CONSTRAINT chk_crp_participant_order_max;
  ELSE
    RAISE WARNING '017: consumption_request_participants con participant_order > 9, vincolo lasciato NOT VALID';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM offers WHERE points_required < 0) THEN
    ALTER TABLE offers VALIDATE CONSTRAINT chk_offers_points_required_nonneg;
  ELSE
    RAISE WARNING '017: offers con points_required < 0, vincolo lasciato NOT VALID';
  END IF;
END $$;

-- ── Offerte: eliminazione logica, lo storico dei riscatti non si perde più ──
ALTER TABLE offers ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- La FK offer_redemptions.offer_id era ON DELETE CASCADE: cancellare un'offerta cancellava
-- anche i riscatti e i loro eventi. Diventa NO ACTION (default): un'offerta con riscatti non
-- si cancella fisicamente, ma la cancellazione di un bar (che elimina nello stesso comando
-- anche i riscatti tramite bar_id) continua a funzionare.
DO $$
DECLARE
  fk_name text;
BEGIN
  FOR fk_name IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'offer_redemptions'::regclass
      AND c.contype = 'f'
      AND c.confrelid = 'offers'::regclass
      AND a.attname = 'offer_id'
  LOOP
    EXECUTE format('ALTER TABLE offer_redemptions DROP CONSTRAINT %I', fk_name);
  END LOOP;

  ALTER TABLE offer_redemptions
    ADD CONSTRAINT offer_redemptions_offer_id_fkey
    FOREIGN KEY (offer_id) REFERENCES offers(id);
END $$;

-- ── Indici per le query del semaforo e dei tetti giornalieri ─────────────────
-- (richiedente + bar + giorno, richiedente + giorno, bar + giorno: semaphoreService.ts)
CREATE INDEX IF NOT EXISTS idx_cr_requester_bar_created
  ON consumption_requests (requester_user_id, bar_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cr_requester_created
  ON consumption_requests (requester_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_cr_bar_created
  ON consumption_requests (bar_id, created_at);

CREATE INDEX IF NOT EXISTS idx_bar_team_audit_bar_created
  ON bar_team_audit (bar_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_receipt_events_request
  ON receipt_events (consumption_request_id);
