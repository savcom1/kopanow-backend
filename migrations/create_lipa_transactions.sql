-- Lipa Till transactions ingested from SMS (or manual API).
-- Auto-match: payer_phone matches devices.mpesa_phone → apply payment.
-- Manual: borrower submits transaction_ref in app → match row and claim for their loan.

CREATE TABLE IF NOT EXISTS lipa_transactions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_ref        TEXT        NOT NULL,
  amount                 NUMERIC(14,2) NOT NULL,
  payer_phone            TEXT        NOT NULL,
  till_number            TEXT,
  raw_sms                TEXT,
  ingested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source                 TEXT        NOT NULL DEFAULT 'sms',
  claimed_borrower_id    TEXT,
  claimed_loan_id        TEXT,
  claimed_at             TIMESTAMPTZ,
  payment_reference_id   UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lipa_transactions_ref
  ON lipa_transactions (transaction_ref);

CREATE INDEX IF NOT EXISTS idx_lipa_transactions_payer
  ON lipa_transactions (payer_phone);

CREATE INDEX IF NOT EXISTS idx_lipa_transactions_claimed
  ON lipa_transactions (claimed_borrower_id)
  WHERE claimed_borrower_id IS NOT NULL;

COMMENT ON TABLE lipa_transactions IS 'M-Pesa Lipa na Till rows from SMS fetcher; drives auto + manual invoice settlement';
