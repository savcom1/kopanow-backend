-- Extend lipa_transactions for SMS fetcher: Mixx/Lipa na Simu structured fields + audit blobs.
-- Auto invoice settlement continues to use transaction_ref, amount, payer_phone + attemptAutoMatchIncomingLipa.

ALTER TABLE lipa_transactions
  ADD COLUMN IF NOT EXISTS lipa_channel TEXT,
  ADD COLUMN IF NOT EXISTS transaction_occurred_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS payer_display_name TEXT,
  ADD COLUMN IF NOT EXISTS till_contract_name TEXT,
  ADD COLUMN IF NOT EXISTS transaction_id_alt TEXT,
  ADD COLUMN IF NOT EXISTS field_details_text TEXT,
  ADD COLUMN IF NOT EXISTS sms_concatenated_body TEXT,
  ADD COLUMN IF NOT EXISTS new_balance_after_tzs NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS provider_tail TEXT,
  ADD COLUMN IF NOT EXISTS parsed_payload JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN lipa_transactions.transaction_ref IS 'Primary receipt / confirmation ID (unique); same as Ref No in FieldDetails when present.';
COMMENT ON COLUMN lipa_transactions.payer_phone IS 'Normalized 255… MSISDN; must match for auto-match to devices.mpesa_phone.';
COMMENT ON COLUMN lipa_transactions.lipa_channel IS 'e.g. MIXX BY YAS';
COMMENT ON COLUMN lipa_transactions.transaction_occurred_at IS 'Parsed from SMS date (EAT).';
COMMENT ON COLUMN lipa_transactions.payer_display_name IS 'Sender name from SMS (e.g. Richard Kalimbangula).';
COMMENT ON COLUMN lipa_transactions.till_contract_name IS 'Contract / business name line on Till receipt (may aid manual review).';
COMMENT ON COLUMN lipa_transactions.transaction_id_alt IS 'Duplicate ID field from provider if different from transaction_ref.';
COMMENT ON COLUMN lipa_transactions.field_details_text IS 'Full FieldDetails blob (Ref No, Channel, Date, Sender, Contract Name, Amount, Transaction ID).';
COMMENT ON COLUMN lipa_transactions.sms_concatenated_body IS 'Long single-line concatenated SMS from fetcher (REF+CHANNEL+DATE+…).';
COMMENT ON COLUMN lipa_transactions.new_balance_after_tzs IS 'Salio jipya from SMS when parsed.';
COMMENT ON COLUMN lipa_transactions.provider_tail IS 'Trailing provider fragment (e.g. LKS255699060278…).';
COMMENT ON COLUMN lipa_transactions.parsed_payload IS 'Flexible JSON for extra keys from your parser without schema churn.';

CREATE INDEX IF NOT EXISTS idx_lipa_transactions_occurred_at
  ON lipa_transactions (transaction_occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_lipa_transactions_till_contract_name
  ON lipa_transactions (till_contract_name)
  WHERE till_contract_name IS NOT NULL;

-- Example mapping from your fetcher (adjust after parse):
--   transaction_ref        = '26950606576361'
--   amount                 = 12500
--   payer_phone            = '255699060278'
--   lipa_channel           = 'MIXX BY YAS'
--   transaction_occurred_at = '2026-01-01T00:00:00+03'  -- EAT
--   payer_display_name     = 'Richard Kalimbangula'
--   till_contract_name     = 'Frank Richard Kasomi'
--   transaction_id_alt     = '26950606576361'
--   field_details_text     = <full FieldDetails string>
--   sms_concatenated_body  = <long REF NOCHANNEL… string>
--   new_balance_after_tzs  = 1332367
--   provider_tail          = 'LKS255699060278FRANK RICHARD KASOMI1250026950606576361'
--   raw_sms                = <optional duplicate or shorter SMS>
--   parsed_payload         = {"kumbukumbu":"26950606576361", ...}
