-- Queue: loans ready for cashier cash-out (first 7/7 protection complete, principal not yet confirmed sent).
CREATE TABLE IF NOT EXISTS cash_disbursement_queue (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id            TEXT NOT NULL UNIQUE,
  borrower_id        TEXT NOT NULL,
  enqueued_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'completed')),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  phone              TEXT,
  principal_amount   NUMERIC
);

CREATE INDEX IF NOT EXISTS idx_cash_disbursement_queue_pending
  ON cash_disbursement_queue (enqueued_at)
  WHERE status = 'pending';

DROP TRIGGER IF EXISTS trg_cash_disbursement_queue_updated_at ON cash_disbursement_queue;
CREATE TRIGGER trg_cash_disbursement_queue_updated_at
  BEFORE UPDATE ON cash_disbursement_queue
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Existing eligible loans (device already had first 7/7 before this migration)
INSERT INTO cash_disbursement_queue (loan_id, borrower_id, enqueued_at, status, phone, principal_amount)
SELECT
  d.loan_id,
  d.borrower_id,
  COALESCE(d.protection_first_completed_at, d.updated_at, NOW()),
  'pending',
  NULLIF(TRIM(COALESCE(r.phone, d.mpesa_phone)), ''),
  l.principal_amount
FROM devices d
INNER JOIN loans l ON l.loan_id = d.loan_id
LEFT JOIN registrations r ON r.borrower_id = d.borrower_id
WHERE d.protection_first_completed_at IS NOT NULL
  AND l.cash_disbursement_confirmed_at IS NULL
  AND l.repaid_at IS NULL
  AND l.outstanding_amount > 0
ON CONFLICT (loan_id) DO NOTHING;
