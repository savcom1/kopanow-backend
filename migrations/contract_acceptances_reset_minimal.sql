-- ONE-TIME (Supabase SQL Editor): replace an old wide `contract_acceptances` with the minimal schema.
-- Export rows first if you need history. Then run this whole script.

DROP TABLE IF EXISTS contract_acceptances CASCADE;

CREATE TABLE contract_acceptances (
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

CREATE UNIQUE INDEX idx_contract_acceptances_number
  ON contract_acceptances (contract_number);

CREATE INDEX idx_contract_acceptances_loan
  ON contract_acceptances (loan_id);

CREATE INDEX idx_contract_acceptances_borrower
  ON contract_acceptances (borrower_id);
