-- Foreign key su user_id (niente dati orfani alla cancellazione dell'utente)
-- e stati uniformi per business_requests (pending / approved / rejected).

UPDATE business_requests SET status = 'approved' WHERE status = 'CONFIRMED';
UPDATE business_requests SET status = 'rejected' WHERE status = 'REFUSED';

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'device_push_tokens',
    'receipt_events',
    'receipt_ocr_sessions',
    'points_revocations',
    'consumption_details'
  ]
  LOOP
    IF to_regclass('public.' || t) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = t || '_user_id_fkey') THEN
      EXECUTE format('DELETE FROM %I WHERE user_id NOT IN (SELECT id FROM utenti)', t);
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES utenti(id) ON DELETE CASCADE',
        t, t || '_user_id_fkey'
      );
    END IF;
  END LOOP;
END $$;
