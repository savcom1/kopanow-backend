-- Loan invoices (weekly installments) + schedule columns on loans
-- Run in Supabase SQL Editor if schema.sql was applied before this migration.

CREATE TABLE IF NOT EXISTS loan_invoices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id           TEXT NOT NULL,
  borrower_id       TEXT NOT NULL,
  invoice_number    TEXT NOT NULL UNIQUE,
  installment_index INTEGER NOT NULL,
  borrower_name     TEXT,
  amount_due        NUMERIC NOT NULL,
  due_date          TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'paid', 'overdue')),
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_invoices_loan_due
  ON loan_invoices (loan_id, due_date);
CREATE INDEX IF NOT EXISTS idx_loan_invoices_status
  ON loan_invoices (status, due_date);

DROP TRIGGER IF EXISTS trg_loan_invoices_updated_at ON loan_invoices;
CREATE TRIGGER trg_loan_invoices_updated_at
  BEFORE UPDATE ON loan_invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE loans ADD COLUMN IF NOT EXISTS installment_weeks INTEGER NOT NULL DEFAULT 5;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS total_repayment_amount NUMERIC;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS weekly_installment_amount NUMERIC;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS loan_schedule_start TIMESTAMPTZ;

COMMENT ON TABLE loan_invoices IS 'One row per weekly installment; generated at loan creation.';
