-- MDM / permission snapshot from app heartbeats (JSON from Android mdm_compliance payload)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS mdm_compliance JSONB;
