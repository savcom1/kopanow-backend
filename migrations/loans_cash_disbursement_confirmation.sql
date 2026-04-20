-- Cashier confirmation: principal sent to borrower; required for "complete" loan in portfolio reports.
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS cash_disbursement_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cash_disbursement_confirmed_by TEXT,
  ADD COLUMN IF NOT EXISTS cash_disbursement_notes TEXT;

CREATE INDEX IF NOT EXISTS idx_loans_cash_disbursement_pending
  ON loans (cash_disbursement_confirmed_at)
  WHERE cash_disbursement_confirmed_at IS NULL AND repaid_at IS NULL;
