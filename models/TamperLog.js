const mongoose = require('mongoose');

const EVENT_TYPES = Object.freeze({
  ADMIN_REVOKED:       'ADMIN_REVOKED',
  ADMIN_SILENT_REMOVE: 'ADMIN_SILENT_REMOVE',
  DEVICE_MISMATCH:     'DEVICE_MISMATCH',
  SAFE_MODE_DETECTED:  'SAFE_MODE_DETECTED',
  HEARTBEAT_MISSING:   'HEARTBEAT_MISSING',
  HEARTBEAT_FAILED:    'HEARTBEAT_FAILED',
  LOCK_SENT:           'LOCK_SENT',
  UNLOCK_SENT:         'UNLOCK_SENT',
  LOCK_BYPASS_ATTEMPT: 'LOCK_BYPASS_ATTEMPT',
  ADMIN_REMOVAL_SENT:  'ADMIN_REMOVAL_SENT',
  PAYMENT_RECEIVED:    'PAYMENT_RECEIVED',
  MANUAL_FLAG:         'MANUAL_FLAG',
  // Added missing types from Android
  ADMIN_ENABLED:       'ADMIN_ENABLED',
  PASSWORD_CHANGED:    'PASSWORD_CHANGED',
  SYSTEM_DISABLED:     'ADMIN_DISABLED_BY_SYSTEM'
});

const SEVERITY = Object.freeze({
  LOW:      'LOW',
  MEDIUM:   'MEDIUM',
  HIGH:     'HIGH',
  CRITICAL: 'CRITICAL'
});

const DEFAULT_SEVERITY = {
  ADMIN_REVOKED:       'HIGH',
  ADMIN_SILENT_REMOVE: 'CRITICAL',
  DEVICE_MISMATCH:     'CRITICAL',
  SAFE_MODE_DETECTED:  'HIGH',
  HEARTBEAT_MISSING:   'MEDIUM',
  HEARTBEAT_FAILED:    'LOW',
  LOCK_SENT:           'LOW',
  UNLOCK_SENT:         'LOW',
  LOCK_BYPASS_ATTEMPT: 'CRITICAL',
  ADMIN_REMOVAL_SENT:  'LOW',
  PAYMENT_RECEIVED:    'LOW',
  MANUAL_FLAG:         'MEDIUM',
  ADMIN_ENABLED:       'LOW',
  PASSWORD_CHANGED:    'MEDIUM',
  SYSTEM_DISABLED:     'HIGH'
};

const TamperLogSchema = new mongoose.Schema(
  {
    borrower_id: { type: String, required: true, trim: true, index: true },
    loan_id:     { type: String, required: true, trim: true, index: true },
    device_id:   { type: String, default: null,  trim: true },
    event_type: {
      type:     String,
      required: [true, 'event_type is required'],
      enum:     Object.values(EVENT_TYPES),
      index:    true
    },
    severity: {
      type:    String,
      enum:    Object.values(SEVERITY),
      default: null
    },
    detail:      { type: String, default: null },
    metadata:    { type: mongoose.Schema.Types.Mixed, default: null },
    auto_action: { type: String, default: 'NONE' },
    reviewed:    { type: Boolean, default: false, index: true },
    reviewed_by: { type: String, default: null },
    reviewed_at: { type: Date,   default: null },
    source: {
      type:    String,
      enum:    ['device', 'server', 'ops'],
      default: 'server',
      index:   true
    }
  },
  { timestamps: true, collection: 'tamper_logs' }
);

TamperLogSchema.pre('save', function (next) {
  if (!this.severity) {
    this.severity = DEFAULT_SEVERITY[this.event_type] || 'MEDIUM';
  }
  next();
});

TamperLogSchema.statics.log = async function (borrowerId, loanId, eventType, opts = {}) {
  return this.create({
    borrower_id: borrowerId,
    loan_id:     loanId,
    event_type:  eventType,
    device_id:   opts.device_id   ?? null,
    detail:      opts.detail      ?? null,
    severity:    opts.severity    ?? null,
    auto_action: opts.auto_action ?? 'NONE',
    metadata:    opts.metadata    ?? null,
    source:      opts.source      ?? 'server'
  });
};

module.exports = mongoose.model('TamperLog', TamperLogSchema);
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.SEVERITY    = SEVERITY;
