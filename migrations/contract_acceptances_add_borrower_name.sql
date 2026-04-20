-- If `contract_acceptances` exists without borrower_name (older minimal migration), add it.
ALTER TABLE contract_acceptances
  ADD COLUMN IF NOT EXISTS borrower_name TEXT;
