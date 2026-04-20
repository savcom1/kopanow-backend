-- If `contract_acceptances` exists without borrower_phone, add it.
ALTER TABLE contract_acceptances
  ADD COLUMN IF NOT EXISTS borrower_phone TEXT;
