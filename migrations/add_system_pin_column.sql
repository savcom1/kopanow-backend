-- ============================================================
-- Migration: add system_pin column to devices table
-- Run this in the Supabase SQL Editor
-- NOTE: Fresh installs: ../db/schema.sql already defines this column.
-- ============================================================

-- Encrypted system PIN reported back from the device.
-- Format: iv(hex):tag(hex):ciphertext(hex)  (AES-256-GCM)
-- NULL = no system PIN currently active.
ALTER TABLE devices
  ADD COLUMN IF NOT EXISTS system_pin TEXT DEFAULT NULL;

-- Index not needed (column is read by PK lookup only).
-- Done.
