-- Minimal electronic contract acceptance (KopaNow — scroll + tap NIMEKUBALI).
-- Snapshot at accept: ids, contract #, borrower name/phone/region, first/last repayment due, device + app version + time.
-- Principal/totals stay canonical in `loans` / `loan_invoices`; repayment dates mirror schedule week 1 / last week.
--
-- If Supabase still has an OLD wide table (extra columns / NOT NULL issues), run once:
--   contract_acceptances_reset_minimal.sql

CREATE TABLE IF NOT EXISTS contract_acceptances (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_number     TEXT        NOT NULL,
  loan_id             TEXT        NOT NULL,
  borrower_id         TEXT        NOT NULL,
  borrower_name       TEXT,
  borrower_phone      TEXT,
  borrower_region     TEXT,
  first_repayment_date TIMESTAMPTZ,
  last_repayment_date  TIMESTAMPTZ,
  accepted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  android_device_id   TEXT,
  app_version         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_acceptances_number
  ON contract_acceptances (contract_number);

CREATE INDEX IF NOT EXISTS idx_contract_acceptances_loan
  ON contract_acceptances (loan_id);

CREATE INDEX IF NOT EXISTS idx_contract_acceptances_borrower
  ON contract_acceptances (borrower_id);
