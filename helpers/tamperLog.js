'use strict';
const supabase = require('./supabase');

// ── Event type constants (mirror TamperLog model + KopanowFCMService.kt) ─────
const EVENT_TYPES = Object.freeze({
  DEVICE_MISMATCH:     'DEVICE_MISMATCH',
  ADMIN_REVOKED:       'ADMIN_REVOKED',
  ADMIN_SILENT_REMOVE: 'ADMIN_SILENT_REMOVE',
  SAFE_MODE_DETECTED:  'SAFE_MODE_DETECTED',
  HEARTBEAT_MISSING:   'HEARTBEAT_MISSING',
  HEARTBEAT_FAILED:    'HEARTBEAT_FAILED',
  LOCK_SENT:           'LOCK_SENT',
  UNLOCK_SENT:         'UNLOCK_SENT',
  PAYMENT_RECEIVED:    'PAYMENT_RECEIVED',
  ADMIN_REMOVAL_SENT:  'ADMIN_REMOVAL_SENT',
  MANUAL_FLAG:         'MANUAL_FLAG',
  LOCK_BYPASS_ATTEMPT: 'LOCK_BYPASS_ATTEMPT'
});

// Severity for each event type
const SEVERITY_MAP = {
  DEVICE_MISMATCH:     'CRITICAL',
  ADMIN_REVOKED:       'HIGH',
  ADMIN_SILENT_REMOVE: 'CRITICAL',
  SAFE_MODE_DETECTED:  'HIGH',
  HEARTBEAT_MISSING:   'MEDIUM',
  HEARTBEAT_FAILED:    'MEDIUM',
  LOCK_SENT:           'LOW',
  UNLOCK_SENT:         'LOW',
  PAYMENT_RECEIVED:    'LOW',
  ADMIN_REMOVAL_SENT:  'LOW',
  MANUAL_FLAG:         'MEDIUM',
  LOCK_BYPASS_ATTEMPT: 'CRITICAL'
};

/**
 * Write a tamper event to the tamper_logs table.
 * Never throws — logs any DB error to console and continues.
 *
 * @param {string} borrowerId
 * @param {string} loanId
 * @param {string} eventType        - One of EVENT_TYPES.*
 * @param {Object} [extra]          - { source, device_id, detail, auto_action }
 */
async function logTamper(borrowerId, loanId, eventType, extra = {}) {
  const severity = SEVERITY_MAP[eventType] || 'MEDIUM';
  const { error } = await supabase.from('tamper_logs').insert({
    borrower_id: borrowerId,
    loan_id:     loanId,
    event_type:  eventType,
    severity,
    source:      extra.source      || 'device',
    device_id:   extra.device_id   || null,
    detail:      extra.detail      || null,
    auto_action: extra.auto_action || null
  });
  if (error) console.error(`[tamper_logs] Failed to log ${eventType}:`, error.message);
}

module.exports = { logTamper, EVENT_TYPES, SEVERITY_MAP };
