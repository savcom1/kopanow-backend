-- If `contract_acceptances` exists without borrower_region, add it.
ALTER TABLE contract_acceptances
  ADD COLUMN IF NOT EXISTS borrower_region TEXT;
