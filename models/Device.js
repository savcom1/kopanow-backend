const mongoose = require('mongoose');

/**
 * Device — one document per enrolled borrower handset.
 *
 * Every Android device that has accepted the Kopanow device-admin policy
 * creates (or updates) a document here during the /device/register call.
 * The heartbeat endpoint (/device/heartbeat) updates this document every
 * 24 hours (or on-demand via FCM HEARTBEAT_REQUEST).
 *
 * ## Scenario 3 defence — device_id
 * `device_id` is the stable hardware fingerprint written at enrollment time
 * (ANDROID_ID or a hash of Build fields).  Every heartbeat re-sends this
 * value; if it ever differs from the stored fingerprint the backend knows
 * the SIM / loan data was moved to a different handset and can LOCK / alert.
 *
 * ## Status lifecycle
 *
 *   registered ──► active ──► locked ──► active  (on payment)
 *                         └──► admin_removed      (on loan closure)
 *             └──► suspended                      (manual admin action)
 */

// ── Embedded sub-schema: last heartbeat telemetry snapshot ───────────────────
const HeartbeatSnapshotSchema = new mongoose.Schema({
  dpc_active:   { type: Boolean, default: true },
  is_safe_mode: { type: Boolean, default: false },
  battery_pct:  { type: Number,  min: -1, max: 100, default: -1 },
  received_at:  { type: Date,    default: Date.now }
}, { _id: false });

// ── Main Device schema ────────────────────────────────────────────────────────
const DeviceSchema = new mongoose.Schema(
  {
    // ── Identity ───────────────────────────────────────────────────────────

    /**
     * Borrower identifier — links this device to the Loan / Borrower collection.
     * Indexed (non-unique) because one borrower could theoretically re-enroll
     * after a factory reset; old documents are archived, not deleted.
     */
    borrower_id: {
      type:     String,
      required: [true, 'borrower_id is required'],
      trim:     true
    },

    /**
     * Loan identifier — allows one borrower to have multiple sequential loans,
     * each with its own device enrollment record.
     */
    loan_id: {
      type:     String,
      required: [true, 'loan_id is required'],
      trim:     true
    },

    /**
     * Stable hardware fingerprint (ANDROID_ID or Build-field hash).
     *
     * ★ Scenario 3 defence anchor ★
     * Written once at enrollment; compared on every heartbeat.
     * A mismatch means the borrower cloned the app to a new device —
     * trigger an immediate LOCK + tamper alert.
     *
     * Unique within the collection: if a re-enrollment arrives with the same
     * device_id, it replaces the previous document (upsert in /register).
     */
    device_id: {
      type:    String,
      default: null,   // nullable — set at enrollment, compared on each heartbeat (Scenario 3)
      trim:    true
    },

    /**
     * Firebase Cloud Messaging registration token.
     * Updated whenever KopanowFCMService.onNewToken() fires on the device.
     * Used to send LOCK_DEVICE / UNLOCK_DEVICE / REMOVE_ADMIN push commands.
     */
    fcm_token: {
      type:    String,
      default: null
    },

    /**
     * Device model string (e.g. "Samsung Galaxy A52") — for support dashboards.
     */
    device_model: {
      type:    String,
      default: null,
      trim:    true
    },

    // ── Status ─────────────────────────────────────────────────────────────

    /**
     * Lifecycle status of this enrollment record.
     *
     * | Value           | Meaning                                    |
     * |-----------------|--------------------------------------------|
     * | registered      | Admin dialog accepted; pending first sync  |
     * | active          | Device in good standing                    |
     * | locked          | Screen locked due to overdue payment       |
     * | admin_removed   | Admin was removed (loan closed / tamper)   |
     * | suspended       | Manually suspended by Kopanow ops          |
     */
    status: {
      type:    String,
      enum:    ['registered', 'active', 'locked', 'admin_removed', 'suspended'],
      default: 'registered',
      index:   true
    },

    // ── DPC (Device Policy Controller) state ───────────────────────────────

    /**
     * Whether the Kopanow app is still an active device administrator
     * on the handset, as reported by the latest heartbeat.
     *
     * false + status != 'admin_removed'  →  silent removal detected  →  TAMPER
     */
    dpc_active: {
      type:    Boolean,
      default: true
    },

    // ── Lock state ─────────────────────────────────────────────────────────

    /**
     * Whether the device screen should currently be locked.
     * The heartbeat response echoes this value back to the device.
     */
    is_locked: {
      type:    Boolean,
      default: false
    },

    /**
     * Human-readable reason shown on LockScreenActivity
     * (e.g. "7 days overdue — TSh 4,500 due").
     */
    lock_reason: {
      type:    String,
      default: null
    },

    /**
     * Outstanding amount, stored as a formatted string
     * (e.g. "TSh 4,500") for direct display on the lock screen.
     */
    amount_due: {
      type:    String,
      default: null
    },

    // ── Heartbeat telemetry ────────────────────────────────────────────────

    /**
     * Timestamp of the most recent successful heartbeat POST.
     * Used to detect stale/offline devices (no heartbeat in > 48 h → alert).
     */
    last_seen: {
      type:    Date,
      default: null
    },

    /**
     * Snapshot of the last heartbeat payload for debug / support dashboards.
     */
    last_heartbeat: {
      type:    HeartbeatSnapshotSchema,
      default: null
    },

    // ── Tamper events ──────────────────────────────────────────────────────

    /**
     * Running log of tamper events reported by TamperReportWorker or detected
     * server-side (device_id mismatch, safe-mode boot, silent admin removal).
     * Capped at the 20 most recent events to limit document growth.
     */
    tamper_events: {
      type: [
        {
          event_type:  { type: String, required: true },  // e.g. 'admin_removed', 'safe_mode'
          reported_at: { type: Date,   default: Date.now },
          detail:      { type: String, default: null }
        }
      ],
      default: []
    },

    // ── M-Pesa ─────────────────────────────────────────────────────────────

    /**
     * Borrower's M-Pesa phone number (format: 2547XXXXXXXX).
     * Set during loan setup; used as the STK-push target.
     */
    mpesa_phone: {
      type:    String,
      default: null,
      trim:    true
    },

    /**
     * Last M-Pesa CheckoutRequestID — stored so the M-Pesa callback
     * can be matched to this device and trigger an UNLOCK_DEVICE command.
     */
    last_checkout_request_id: {
      type:    String,
      default: null
    }
  },
  {
    timestamps: true,    // adds createdAt + updatedAt automatically
    collection: 'devices'
  }
);

// ── Compound indexes ──────────────────────────────────────────────────────────

// Primary lookup: borrower + loan (used by heartbeat, lock routes)
DeviceSchema.index({ borrower_id: 1, loan_id: 1 }, { unique: true });

// Scenario 3 check: fast lookup by hardware fingerprint
DeviceSchema.index({ device_id: 1 }, { unique: true, sparse: true });

// Ops dashboard: find all locked devices quickly
DeviceSchema.index({ is_locked: 1, last_seen: -1 });

// Stale-device detection: find devices not seen in > 48 h
DeviceSchema.index({ last_seen: 1 });

// ── Instance methods ──────────────────────────────────────────────────────────

/**
 * Append a tamper event and cap the array at 20 entries.
 * Call via:  await device.addTamperEvent('safe_mode', 'Detected on boot');
 */
DeviceSchema.methods.addTamperEvent = function (eventType, detail = null) {
  this.tamper_events.push({ event_type: eventType, detail });
  if (this.tamper_events.length > 20) {
    this.tamper_events = this.tamper_events.slice(-20);
  }
};

/**
 * Update last_seen + last_heartbeat from a heartbeat payload object.
 * Call via:  device.recordHeartbeat(req.body);
 */
DeviceSchema.methods.recordHeartbeat = function (payload) {
  this.last_seen = new Date();
  this.last_heartbeat = {
    dpc_active:   payload.dpc_active   ?? true,
    is_safe_mode: payload.is_safe_mode ?? false,
    battery_pct:  payload.battery_pct  ?? -1,
    received_at:  new Date()
  };
  if (typeof payload.dpc_active === 'boolean') {
    this.dpc_active = payload.dpc_active;
  }
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = mongoose.model('Device', DeviceSchema);
