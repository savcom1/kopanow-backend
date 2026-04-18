-- ============================================================
-- Kopanow Backend — Supabase Schema
-- Run once in: Supabase Dashboard → SQL Editor → Run
-- ============================================================

-- ── Devices ──────────────────────────────────────────────────
-- One row per enrolled borrower handset.
CREATE TABLE IF NOT EXISTS devices (
  id                       UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  borrower_id              TEXT        NOT NULL,
  loan_id                  TEXT        NOT NULL,

  -- Scenario 3 defence: stable ANDROID_ID / fingerprint hash
  device_id                TEXT,
  fcm_token                TEXT,
  device_model             TEXT,

  -- Lifecycle status
  status                   TEXT        NOT NULL DEFAULT 'registered'
                             CHECK (status IN ('registered','active','locked','admin_removed','suspended')),

  -- DPC / lock state
  dpc_active               BOOLEAN     NOT NULL DEFAULT TRUE,
  is_locked                BOOLEAN     NOT NULL DEFAULT FALSE,
  lock_reason              TEXT,
  amount_due               TEXT,

  -- M-Pesa
  mpesa_phone              TEXT,
  last_checkout_request_id TEXT,

  -- Heartbeat telemetry (stored as JSON snapshot)
  last_seen                TIMESTAMPTZ,
  last_heartbeat           JSONB,

  -- Rich device info collected at enrollment
  -- { manufacturer, brand, android_version, sdk_version, screen_density,
  --   screen_width_dp, screen_height_dp, network_type, battery_pct }
  device_info              JSONB,

  -- Embedded tamper events (capped at 20 in application logic)
  tamper_events            JSONB       NOT NULL DEFAULT '[]',

  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (borrower_id, loan_id)
);

-- Add device_info to existing table (safe to run multiple times)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_info JSONB;


-- Fast lookups used by heartbeat & lock routes
CREATE INDEX IF NOT EXISTS idx_devices_status      ON devices (status);
CREATE INDEX IF NOT EXISTS idx_devices_is_locked   ON devices (is_locked);
CREATE INDEX IF NOT EXISTS idx_devices_last_seen   ON devices (last_seen);
CREATE INDEX IF NOT EXISTS idx_devices_device_id   ON devices (device_id);

-- Auto-update updated_at on any row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$;

DROP TRIGGER IF EXISTS trg_devices_updated_at ON devices;
CREATE TRIGGER trg_devices_updated_at
  BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Loans ─────────────────────────────────────────────────────
-- One row per loan agreement.
CREATE TABLE IF NOT EXISTS loans (
  id                 UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
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
                       CHECK (device_status IN ('unregistered','registered','active','locked','admin_removed','suspended')),

  -- Array of guarantor objects: [{name, phone, national_id}]
  guarantors         JSONB       NOT NULL DEFAULT '[]',

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_loans_next_due_date ON loans (next_due_date);
CREATE INDEX IF NOT EXISTS idx_loans_device_status ON loans (device_status);

DROP TRIGGER IF EXISTS trg_loans_updated_at ON loans;
CREATE TRIGGER trg_loans_updated_at
  BEFORE UPDATE ON loans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();


-- ── Payments ──────────────────────────────────────────────────
-- Idempotent M-Pesa payment records.
CREATE TABLE IF NOT EXISTS payments (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  mpesa_ref    TEXT        UNIQUE NOT NULL,     -- MpesaReceiptNumber (idempotency key)
  loan_id      TEXT        NOT NULL,
  borrower_id  TEXT,
  amount       NUMERIC     NOT NULL,
  paid_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_processed BOOLEAN     NOT NULL DEFAULT FALSE,
  raw_callback JSONB,                            -- full Safaricom callback stored for audit
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payments_loan_id ON payments (loan_id);


-- ── Tamper Logs ───────────────────────────────────────────────
-- Immutable forensic audit trail — never deleted.
CREATE TABLE IF NOT EXISTS tamper_logs (
  id          UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  borrower_id TEXT        NOT NULL,
  loan_id     TEXT        NOT NULL,
  event_type  TEXT        NOT NULL,
  severity    TEXT        NOT NULL DEFAULT 'MEDIUM'
                CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  source      TEXT,       -- 'device' | 'cron' | 'ops'
  device_id   TEXT,
  detail      TEXT,
  auto_action TEXT,       -- FCM command sent in response
  reviewed    BOOLEAN     NOT NULL DEFAULT FALSE,
  reviewed_at TIMESTAMPTZ,
  reviewed_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tamper_logs_borrower ON tamper_logs (borrower_id, loan_id);
CREATE INDEX IF NOT EXISTS idx_tamper_logs_severity ON tamper_logs (severity);
CREATE INDEX IF NOT EXISTS idx_tamper_logs_reviewed ON tamper_logs (reviewed);


-- ── Notifications Log ─────────────────────────────────────────────
-- Audit trail of every SMS and FCM notification ever dispatched.
-- Used for deduplication (same event_type won't fire twice per day)
-- and admin visibility into the messaging pipeline.
CREATE TABLE IF NOT EXISTS notifications_log (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  borrower_id  TEXT        NOT NULL,
  loan_id      TEXT        NOT NULL,
  channel      TEXT        NOT NULL CHECK (channel IN ('sms', 'fcm', 'both')),
  event_type   TEXT        NOT NULL,
  phone        TEXT,
  message      TEXT,
  status       TEXT        NOT NULL DEFAULT 'sent'
                 CHECK (status IN ('sent', 'failed', 'skipped')),
  error        TEXT,
  days_state   INTEGER,    -- negative = days before due, positive = days overdue
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notif_log_borrower ON notifications_log (borrower_id, loan_id);
CREATE INDEX IF NOT EXISTS idx_notif_log_event    ON notifications_log (event_type, created_at);
CREATE INDEX IF NOT EXISTS idx_notif_log_status   ON notifications_log (status);

