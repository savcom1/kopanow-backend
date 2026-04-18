-- =====================================================================
-- Migration: registrations + loan_requests tables
-- Run once in Supabase SQL editor.
-- =====================================================================

-- Enable gen_random_uuid() if not already enabled (Supabase usually has this)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One row per borrower profile captured during onboarding.
CREATE TABLE IF NOT EXISTS registrations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id   TEXT NOT NULL UNIQUE,
  full_name     TEXT NOT NULL,
  national_id   TEXT NOT NULL,
  phone         TEXT NOT NULL,
  region        TEXT NOT NULL,
  address       TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Track loan requests submitted from the Android app before activation.
CREATE TABLE IF NOT EXISTS loan_requests (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id TEXT NOT NULL,
  loan_id     TEXT NOT NULL,
  amount_tzs  NUMERIC NOT NULL,
  tenor_days  INTEGER NOT NULL,
  purpose     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'submitted'
               CHECK (status IN ('submitted','approved','rejected','cancelled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookup / dedupe
CREATE INDEX IF NOT EXISTS idx_loan_requests_borrower ON loan_requests (borrower_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_requests_loan_id ON loan_requests (loan_id);

-- Keep registrations.updated_at current
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_registrations_updated_at ON registrations;
CREATE TRIGGER trg_registrations_updated_at
  BEFORE UPDATE ON registrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

