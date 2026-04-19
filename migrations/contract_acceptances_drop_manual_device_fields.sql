-- Align existing `contract_acceptances` with simplified ContractActivity (no manual device/Google inputs).
-- Run once in Supabase SQL Editor if you already applied an older migration that included:
--   device_android_model, device_imei, device_serial, google_account
-- Safe to run multiple times (IF EXISTS).

ALTER TABLE contract_acceptances
  DROP COLUMN IF EXISTS device_android_model,
  DROP COLUMN IF EXISTS device_imei,
  DROP COLUMN IF EXISTS device_serial,
  DROP COLUMN IF EXISTS google_account;
