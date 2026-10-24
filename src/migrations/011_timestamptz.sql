-- Migration 011 - Tutte le colonne temporali diventano TIMESTAMPTZ
-- I valori esistenti erano scritti in UTC, quindi vengono interpretati come UTC.
-- Idempotente: dopo la conversione non restano colonne "timestamp without time zone".

DROP INDEX IF EXISTS uidx_consumption_requests_receipt_bar_day;

DO $migration011$
DECLARE  col RECORD;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.data_type = 'timestamp without time zone'
      AND c.table_name <> 'schema_migrations'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I ALTER COLUMN %I TYPE TIMESTAMPTZ USING %I AT TIME ZONE ''UTC''',
      col.table_name, col.column_name, col.column_name
    );
  END LOOP;
END
$migration011$;

-- Indice univoco parziale (codice, bar, giorno italiano); i codici NULL sono esclusi
CREATE UNIQUE INDEX IF NOT EXISTS uidx_consumption_requests_receipt_bar_day
  ON consumption_requests (
    receipt_code_block1,
    receipt_code_block2,
    bar_id,
    date_trunc('day', created_at AT TIME ZONE 'Europe/Rome')
  )
  WHERE receipt_code_block1 IS NOT NULL
    AND receipt_code_block2 IS NOT NULL
    AND status != 'rejected';
