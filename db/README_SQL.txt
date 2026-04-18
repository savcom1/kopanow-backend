Kopanow Supabase SQL — how the files fit together
================================================

CANONICAL (new project or full reset)
-------------------------------------
  Run:  db/schema.sql  (single paste in Supabase SQL Editor)

  This creates or aligns:
    registrations, loans, devices, loan_requests, payment_references,
    payments, tamper_logs, notifications_log

  Column-level parity with Node routes under routes/ and helpers/.


INCREMENTAL (existing database created before 2026 consolidation)
------------------------------------------------------------------
  If you already ran an older db/schema.sql, apply only what you miss:

    migrations/create_registrations_and_loan_requests.sql
    migrations/create_payment_references.sql
    migrations/add_passcode_columns.sql
    migrations/add_system_pin_column.sql

  These use IF NOT EXISTS / ADD COLUMN IF NOT EXISTS where possible.
  Safe to run after db/schema.sql (no-op if already applied).


CODE ↔ TABLE QUICK MAP
----------------------
  devices.device_info (JSONB) stores registration + MDM telemetry, e.g.:
    manufacturer, brand, android_version, sdk_version, screen_* , battery_pct,
    build_product, build_device, is_rooted, source, registered_at, mdm_enrolled_at

  /api/loan/request          → registrations, loan_requests, loans, devices
  /api/device/register       → devices, loans (device_status)
  /api/device/heartbeat        → devices, loans
  /api/payment/*             → payment_references, payments, devices, loans
  /api/pin/*                 → devices, tamper_logs
  helpers/notify.js          → notifications_log
  helpers/tamperLog.js         → tamper_logs
