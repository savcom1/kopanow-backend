-- Sticky "first time all 7 protections OK" for admin Applicant vs Customer (see plan).
ALTER TABLE devices ADD COLUMN IF NOT EXISTS protection_first_completed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_devices_protection_first_completed_at
  ON devices (protection_first_completed_at)
  WHERE protection_first_completed_at IS NOT NULL;

-- One-time backfill: historical devices that already had all_required_ok in the snapshot
UPDATE devices
SET protection_first_completed_at = COALESCE(updated_at, created_at, NOW() AT TIME ZONE 'UTC')
WHERE protection_first_completed_at IS NULL
  AND mdm_compliance IS NOT NULL
  AND mdm_compliance @> '{"all_required_ok": true}'::jsonb;
