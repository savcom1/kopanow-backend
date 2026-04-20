-- If `contract_acceptances` exists without last_repayment_date, add it.
ALTER TABLE contract_acceptances
  ADD COLUMN IF NOT EXISTS last_repayment_date TIMESTAMPTZ;
