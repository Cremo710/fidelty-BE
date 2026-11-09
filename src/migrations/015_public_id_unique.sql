DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_index i
    JOIN pg_class t ON t.oid = i.indrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(i.indkey)
    WHERE t.oid = 'utenti'::regclass
      AND a.attname = 'public_id'
      AND i.indisunique
      AND i.indisvalid
      AND i.indnkeyatts = 1
  ) THEN
    ALTER TABLE utenti
      ADD CONSTRAINT utenti_public_id_key UNIQUE (public_id);
  END IF;
END;
$$;
