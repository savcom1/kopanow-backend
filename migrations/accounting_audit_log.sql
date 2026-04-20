-- Accounting module: append-only audit for borrower/loan/book edits (separate from ops admin).
CREATE TABLE IF NOT EXISTS accounting_audit_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor        TEXT NOT NULL,
  entity_type  TEXT NOT NULL,
  entity_id    TEXT NOT NULL,
  action       TEXT NOT NULL,
  before_json  JSONB,
  after_json   JSONB,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounting_audit_entity
  ON accounting_audit_log (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_accounting_audit_created
  ON accounting_audit_log (created_at DESC);
