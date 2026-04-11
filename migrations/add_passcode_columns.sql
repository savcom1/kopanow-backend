-- =====================================================================
-- Migration: Add passcode columns to devices table
-- Run this once in your Supabase SQL editor.
-- =====================================================================

-- passcode_hash:   SHA-256 of the admin-issued PIN (never the raw PIN)
-- passcode_active: true while a PIN is actively enforced on this device
-- passcode_set_at: timestamp of when the PIN was last pushed

ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS passcode_hash    TEXT,
  ADD COLUMN IF NOT EXISTS passcode_active  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS passcode_set_at  TIMESTAMPTZ;

-- Index for fast lookup of passcode-locked devices
CREATE INDEX IF NOT EXISTS idx_devices_passcode_active
  ON devices (passcode_active)
  WHERE passcode_active = TRUE;

-- Verify
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'devices'
  AND column_name IN ('passcode_hash', 'passcode_active', 'passcode_set_at');
