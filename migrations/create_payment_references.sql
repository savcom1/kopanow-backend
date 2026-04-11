-- =====================================================================
-- Migration: payment_references table
-- Run once in Supabase SQL editor
-- =====================================================================

CREATE TABLE IF NOT EXISTS payment_references (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id    TEXT NOT NULL,
  loan_id        TEXT NOT NULL,
  mpesa_ref      TEXT NOT NULL,              -- e.g. "RCK8XY1234"
  amount_claimed NUMERIC(12,2),             -- amount borrower says they paid
  notes          TEXT,                       -- optional borrower note
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  status         TEXT NOT NULL DEFAULT 'pending',  -- pending | verified | rejected
  verified_by    TEXT,                       -- admin user who actioned it
  verified_at    TIMESTAMPTZ,
  reviewer_note  TEXT                        -- optional admin note on rejection
);

-- Prevent duplicate submission of the same M-Pesa ref
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_ref_mpesa
  ON payment_references (mpesa_ref);

-- Fast lookup by status for admin panel
CREATE INDEX IF NOT EXISTS idx_payment_ref_status
  ON payment_references (status, submitted_at DESC);

-- Fast lookup of a borrower's submissions
CREATE INDEX IF NOT EXISTS idx_payment_ref_borrower
  ON payment_references (borrower_id, loan_id);
