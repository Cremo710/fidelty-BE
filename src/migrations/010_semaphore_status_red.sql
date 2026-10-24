-- Migration 010 - semaphore_status ammette anche 'red'

      DO $migration010$ BEGIN
        ALTER TABLE consumption_requests
          DROP CONSTRAINT IF EXISTS consumption_requests_semaphore_status_check;
        ALTER TABLE consumption_requests
          ADD CONSTRAINT consumption_requests_semaphore_status_check
          CHECK (semaphore_status IS NULL OR semaphore_status IN ('green', 'yellow', 'red'));
      EXCEPTION WHEN undefined_table OR undefined_column THEN NULL;
      END $migration010$;
    