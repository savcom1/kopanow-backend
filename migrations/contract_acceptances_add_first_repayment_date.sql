-- If `contract_acceptances` exists without first_repayment_date, add it.
ALTER TABLE contract_acceptances
  ADD COLUMN IF NOT EXISTS first_repayment_date TIMESTAMPTZ;
