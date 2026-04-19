-- ============================================================
-- Kopanow Backend — Supabase / PostgreSQL schema (canonical)
-- Run once in: Supabase Dashboard → SQL Editor → Run entire file
--
-- Covers tables and columns referenced by:
--   routes/{device,loan,admin,payment-reference,mpesa,pin}.js
--   helpers/{deviceEnrollment,notify,tamperLog}.js, cron/jobs.js
--
-- Incremental migrations in ../migrations/ are kept for existing DBs
-- that were created from older snippets; a NEW project only needs this file.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ── Shared trigger helper ───────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;


-- ── Registrations (loan onboarding profile) ─────────────────
-- Used by: POST /api/loan/request, GET mpesa stk phone fallback
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

DROP TRIGGER IF EXISTS trg_registrations_updated_at ON registrations;
CREATE TRIGGER trg_registrations_updated_at
  BEFORE UPDATE ON registrations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Loans ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS loans (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id            TEXT        UNIQUE NOT NULL,
  borrower_id        TEXT        NOT NULL,

  principal_amount   NUMERIC     NOT NULL DEFAULT 0,
  outstanding_amount NUMERIC     NOT NULL DEFAULT 0,
  interest_amount    NUMERIC     NOT NULL DEFAULT 0,

  disbursed_at       TIMESTAMPTZ,
  next_due_date      TIMESTAMPTZ,
  repaid_at          TIMESTAMPTZ,
  days_overdue       INTEGER     NOT NULL DEFAULT 0,

  device_status      TEXT        NOT NULL DEFAULT 'unregistered'
                       CHECK (device_status IN (
                         'unregistered','registered','active','locked',
                         'admin_removed','suspended'
                       )),

  guarantors         JSONB       NOT NULL DEFAULT '[]',

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  installment_weeks          INTEGER     NOT NULL DEFAULT 5,
  total_repayment_amount     NUMERIC,
  weekly_installment_amount  NUMERIC,
  loan_schedule_start        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_loans_next_due_date ON loans (next_due_date);
CREATE INDEX IF NOT EXISTS idx_loans_device_status ON loans (device_status);

DROP TRIGGER IF EXISTS trg_loans_updated_at ON loans;
CREATE TRIGGER trg_loans_updated_at
  BEFORE UPDATE ON loans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Devices (one row per borrower_id + loan_id) ───────────
-- PIN columns: add_passcode_columns.sql / add_system_pin_column.sql (also included here)
CREATE TABLE IF NOT EXISTS devices (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id              TEXT        NOT NULL,
  loan_id                  TEXT        NOT NULL,

  device_id                TEXT,
  fcm_token                TEXT,
  device_model             TEXT,

  status                   TEXT        NOT NULL DEFAULT 'registered'
                           CHECK (status IN (
                             'registered','active','locked','admin_removed','suspended'
                           )),

  dpc_active               BOOLEAN     NOT NULL DEFAULT TRUE,
  is_locked                BOOLEAN     NOT NULL DEFAULT FALSE,
  lock_reason              TEXT,
  amount_due               TEXT,

  mpesa_phone              TEXT,
  last_checkout_request_id TEXT,

  last_seen                TIMESTAMPTZ,
  last_heartbeat           JSONB,
  -- Snapshot from POST /device/heartbeat (mdm_compliance); also embedded in last_heartbeat for history
  mdm_compliance           JSONB,
  device_info              JSONB,
  tamper_events            JSONB       NOT NULL DEFAULT '[]',

  passcode_hash            TEXT,
  passcode_active          BOOLEAN     NOT NULL DEFAULT FALSE,
  passcode_set_at          TIMESTAMPTZ,
  system_pin               TEXT,

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (borrower_id, loan_id)
);

CREATE INDEX IF NOT EXISTS idx_devices_status       ON devices (status);
CREATE INDEX IF NOT EXISTS idx_devices_is_locked      ON devices (is_locked);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen    ON devices (last_seen);
CREATE INDEX IF NOT EXISTS idx_devices_device_id    ON devices (device_id);
CREATE INDEX IF NOT EXISTS idx_devices_passcode_active
  ON devices (passcode_active)
  WHERE passcode_active = TRUE;

DROP TRIGGER IF EXISTS trg_devices_updated_at ON devices;
CREATE TRIGGER trg_devices_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Loan requests (immutable application rows) ──────────────
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

CREATE INDEX IF NOT EXISTS idx_loan_requests_borrower ON loan_requests (borrower_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_loan_requests_loan_id ON loan_requests (loan_id);


-- ── Loan invoices (weekly installments) ─────────────────────
CREATE TABLE IF NOT EXISTS loan_invoices (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id           TEXT NOT NULL,
  borrower_id       TEXT NOT NULL,
  invoice_number    TEXT NOT NULL UNIQUE,
  installment_index INTEGER NOT NULL,
  borrower_name     TEXT,
  amount_due        NUMERIC NOT NULL,
  due_date          TIMESTAMPTZ NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'paid', 'overdue')),
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loan_invoices_loan_due
  ON loan_invoices (loan_id, due_date);
CREATE INDEX IF NOT EXISTS idx_loan_invoices_status
  ON loan_invoices (status, due_date);

DROP TRIGGER IF EXISTS trg_loan_invoices_updated_at ON loan_invoices;
CREATE TRIGGER trg_loan_invoices_updated_at
  BEFORE UPDATE ON loan_invoices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Payment references (borrower-submitted M-Pesa refs) ───
CREATE TABLE IF NOT EXISTS payment_references (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id    TEXT NOT NULL,
  loan_id        TEXT NOT NULL,
  mpesa_ref      TEXT NOT NULL,
  amount_claimed NUMERIC(12,2),
  notes          TEXT,
  submitted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','verified','rejected')),
  verified_by    TEXT,
  verified_at    TIMESTAMPTZ,
  reviewer_note  TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_ref_mpesa
  ON payment_references (mpesa_ref);
CREATE INDEX IF NOT EXISTS idx_payment_ref_status
  ON payment_references (status, submitted_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_ref_borrower
  ON payment_references (borrower_id, loan_id);


-- ── Payments (verified M-Pesa / audit from admin verify) ─
CREATE TABLE IF NOT EXISTS payments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mpesa_ref    TEXT UNIQUE NOT NULL,
  loan_id      TEXT NOT NULL,
  borrower_id  TEXT,
  amount       NUMERIC NOT NULL,
  paid_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_processed BOOLEAN NOT NULL DEFAULT FALSE,
  raw_callback JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_loan_id ON payments (loan_id);


-- ── Lipa Till transactions (SMS ingest → auto / manual match) ─
CREATE TABLE IF NOT EXISTS lipa_transactions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_ref        TEXT        NOT NULL,
  amount                 NUMERIC(14,2) NOT NULL,
  payer_phone            TEXT        NOT NULL,
  till_number            TEXT,
  raw_sms                TEXT,
  ingested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source                 TEXT        NOT NULL DEFAULT 'sms',
  claimed_borrower_id    TEXT,
  claimed_loan_id        TEXT,
  claimed_at             TIMESTAMPTZ,
  payment_reference_id   UUID
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_lipa_transactions_ref
  ON lipa_transactions (transaction_ref);
CREATE INDEX IF NOT EXISTS idx_lipa_transactions_payer
  ON lipa_transactions (payer_phone);


-- ── Tamper logs ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tamper_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id TEXT NOT NULL,
  loan_id     TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'MEDIUM'
              CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  source      TEXT,
  device_id   TEXT,
  detail      TEXT,
  auto_action TEXT,
  reviewed    BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tamper_logs_borrower ON tamper_logs (borrower_id, loan_id);
CREATE INDEX IF NOT EXISTS idx_tamper_logs_severity ON tamper_logs (severity);
CREATE INDEX IF NOT EXISTS idx_tamper_logs_reviewed ON tamper_logs (reviewed);


-- ── Notifications log (SMS/FCM audit + dedupe) ─────────────
CREATE TABLE IF NOT EXISTS notifications_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  borrower_id  TEXT NOT NULL,
  loan_id      TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('sms', 'fcm', 'both')),
  event_type   TEXT NOT NULL,
  phone        TEXT,
  message      TEXT,
  status       TEXT NOT NULL DEFAULT 'sent'
               CHECK (status IN ('sent', 'failed', 'skipped')),
  error        TEXT,
  days_state   INTEGER,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_log_borrower ON notifications_log (borrower_id, loan_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_event    ON notifications_log (event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_notif_log_status   ON notifications_log (status);
