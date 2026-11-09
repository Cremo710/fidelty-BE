CREATE TABLE IF NOT EXISTS receipt_ocr_identities (
  session_id   VARCHAR(26) PRIMARY KEY REFERENCES receipt_ocr_sessions(id) ON DELETE CASCADE,
  vat_number   VARCHAR(16) NOT NULL,
  doc_id       VARCHAR(16) NOT NULL,
  receipt_date DATE NOT NULL,
  amount       NUMERIC(10,2) NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uidx_receipt_ocr_identity UNIQUE (vat_number, doc_id, receipt_date, amount)
);

INSERT INTO receipt_ocr_identities (session_id, vat_number, doc_id, receipt_date, amount)
SELECT DISTINCT ON (vat_number, doc_id, receipt_date, amount)
       id, vat_number, doc_id, receipt_date, amount
FROM receipt_ocr_sessions
WHERE consumed_at IS NOT NULL
  AND vat_number IS NOT NULL
  AND doc_id IS NOT NULL
  AND receipt_date IS NOT NULL
  AND amount IS NOT NULL
ORDER BY vat_number, doc_id, receipt_date, amount, consumed_at, id
ON CONFLICT DO NOTHING;
