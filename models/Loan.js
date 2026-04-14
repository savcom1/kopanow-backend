const mongoose = require('mongoose');

/**
 * Loan — one document per active or historical loan.
 *
 * The Loan is the source of truth for financial state.  The Device
 * model handles hardware/MDM state.  Routes join them via borrower_id
 * + loan_id.
 *
 * ## device_status lifecycle
 *
 *   active ──► locked          (overdue payment detected by cron / heartbeat)
 *         └──► admin_removed   (loan fully repaid → REMOVE_ADMIN FCM sent)
 *         └──► suspended       (manual ops action)
 *
 * ## Guarantor sub-schema
 * A guarantor is an optional secondary contact who co-signs the loan.
 * Their details are stored inline for fast access during collection calls.
 */

// ── Embedded: Guarantor ───────────────────────────────────────────────────────
const GuarantorSchema = new mongoose.Schema({
  name:         { type: String, required: true, trim: true },
  phone:        { type: String, required: true, trim: true },
  national_id:  { type: String, default: null,  trim: true },
  relationship: { type: String, default: null,  trim: true }  // e.g. 'spouse', 'sibling'
}, { _id: false });

// ── Main Loan schema ──────────────────────────────────────────────────────────
const LoanSchema = new mongoose.Schema(
  {
    // ── Parties ────────────────────────────────────────────────────────────

    borrower_id: {
      type:     String,
      required: [true, 'borrower_id is required'],
      trim:     true,
      index:    true
    },

    /** Immutable unique identifier for this loan (set at origination). */
    loan_id: {
      type:     String,
      required: [true, 'loan_id is required'],
      trim:     true,
      unique:   true
    },

    // ── Financial values ───────────────────────────────────────────────────

    /** Original principal disbursed (TSh, integer cents or whole shillings). */
    principal_amount: {
      type:     Number,
      required: true,
      min:      0
    },

    /**
     * Current outstanding balance (TSh).
     * Decremented by successful Payment records; used to decide lock/unlock.
     */
    outstanding_amount: {
      type:     Number,
      required: true,
      min:      0
    },

    /** Total interest charged over the loan term (TSh). */
    interest_amount: {
      type:    Number,
      default: 0,
      min:     0
    },

    // ── Schedule ───────────────────────────────────────────────────────────

    /** Date the loan was disbursed. */
    disbursed_at: {
      type:    Date,
      default: null
    },

    /**
     * Next repayment due date.
     * The payment scheduler / cron compares this against today to decide
     * whether to issue a LOCK command.
     */
    next_due_date: {
      type:    Date,
      default: null,
      index:   true
    },

    /** Date the loan was fully repaid (null if still active). */
    repaid_at: {
      type:    Date,
      default: null
    },

    /** Number of calendar days the loan is overdue (0 if current). */
    days_overdue: {
      type:    Number,
      default: 0,
      min:     0
    },

    // ── Device status ──────────────────────────────────────────────────────

    /**
     * MDM enforcement state of the device associated with this loan.
     * Mirrors Device.status for efficient querying without a join.
     *
     * | Value           | Meaning                                        |
     * |-----------------|------------------------------------------------|
     * | active          | In good standing — device unlocked             |
     * | locked          | Overdue — LOCK_DEVICE FCM sent                 |
     * | admin_removed   | Loan closed — REMOVE_ADMIN FCM sent            |
     * | suspended       | Manual ops action                              |
     * | unregistered    | Loan approved but device not yet enrolled       |
     */
    device_status: {
      type:    String,
      enum:    ['unregistered', 'active', 'locked', 'admin_removed', 'suspended'],
      default: 'unregistered',
      index:   true
    },

    // ── Guarantors ─────────────────────────────────────────────────────────

    /**
     * Array of guarantors who co-signed the loan.
     * Up to 3 guarantors; empty array for unsecured micro-loans.
     */
    guarantors: {
      type:    [GuarantorSchema],
      default: []
    },

    // ── Metadata ───────────────────────────────────────────────────────────

    /** Loan officer / branch that originated the loan (optional). */
    loan_officer_id: {
      type:    String,
      default: null,
      trim:    true
    },

    /** Free-text notes from ops (e.g. "Borrower called, will pay by Friday"). */
    notes: {
      type:    String,
      default: null
    }
  },
  {
    timestamps: true,   // createdAt + updatedAt
    collection: 'loans'
  }
);

// ── Compound indexes ──────────────────────────────────────────────────────────

// Payment cron: find all overdue active loans
LoanSchema.index({ device_status: 1, next_due_date: 1 });

// Collection dashboard: all loans for a borrower sorted by newest
LoanSchema.index({ borrower_id: 1, createdAt: -1 });

// ── Instance methods ──────────────────────────────────────────────────────────

/**
 * Apply a payment: subtract amount from outstanding_amount and return
 * whether the loan is now fully repaid.
 *
 * Usage:
 *   const fullyRepaid = loan.applyPayment(amount);
 *   await loan.save();
 */
LoanSchema.methods.applyPayment = function (amount) {
  this.outstanding_amount = Math.max(0, this.outstanding_amount - amount);
  if (this.outstanding_amount === 0) {
    this.repaid_at    = new Date();
    this.device_status = 'admin_removed';
    return true;
  }
  return false;
};

/**
 * Recompute days_overdue from next_due_date and today.
 * Call before deciding whether to issue a LOCK command.
 */
LoanSchema.methods.refreshOverdue = function () {
  if (!this.next_due_date) { this.days_overdue = 0; return; }
  const diff = Date.now() - this.next_due_date.getTime();
  this.days_overdue = diff > 0 ? Math.floor(diff / 86_400_000) : 0;
};

// ─────────────────────────────────────────────────────────────────────────────

module.exports = mongoose.model('Loan', LoanSchema);
