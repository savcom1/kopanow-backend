-- For databases that already ran cash_disbursement_queue.sql without phone/principal_amount.
ALTER TABLE cash_disbursement_queue ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE cash_disbursement_queue ADD COLUMN IF NOT EXISTS principal_amount NUMERIC;

-- Subquery avoids referencing target table "q" inside FROM joins (PostgreSQL 42P01).
UPDATE cash_disbursement_queue q
SET
  phone = sub.phone,
  principal_amount = sub.principal_amount
FROM (
  SELECT
    q2.loan_id,
    NULLIF(TRIM(COALESCE(r.phone, d.mpesa_phone)), '') AS phone,
    l.principal_amount AS principal_amount
  FROM cash_disbursement_queue q2
  INNER JOIN loans l ON l.loan_id = q2.loan_id
  LEFT JOIN registrations r ON r.borrower_id = q2.borrower_id
  LEFT JOIN devices d ON d.loan_id = q2.loan_id AND d.borrower_id = q2.borrower_id
  WHERE q2.phone IS NULL OR q2.principal_amount IS NULL
) sub
WHERE q.loan_id = sub.loan_id;
