-- Electronic loan contract acceptances (KopaNow app — ContractActivity)
-- Run in Supabase SQL Editor if the table does not exist yet.

CREATE TABLE IF NOT EXISTS contract_acceptances (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_number           TEXT        NOT NULL,
  loan_id                   TEXT        NOT NULL,
  borrower_id               TEXT        NOT NULL,

  borrower_name             TEXT,
  borrower_phone            TEXT,
  borrower_region           TEXT,

  loan_amount_tzs           BIGINT,
  total_repayment_tzs       BIGINT,
  weekly_installment_tzs    BIGINT,
  num_weeks                 INTEGER,

  loan_start_date           TIMESTAMPTZ,
  first_repayment_date      TIMESTAMPTZ,
  last_repayment_date       TIMESTAMPTZ,

  device_android_model      TEXT,
  device_imei               TEXT,
  device_serial             TEXT,
  google_account            TEXT,

  android_device_id         TEXT,
  app_version               TEXT,

  accepted_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_contract_acceptances_number
  ON contract_acceptances (contract_number);

CREATE INDEX IF NOT EXISTS idx_contract_acceptances_loan
  ON contract_acceptances (loan_id);

CREATE INDEX IF NOT EXISTS idx_contract_acceptances_borrower
  ON contract_acceptances (borrower_id);
