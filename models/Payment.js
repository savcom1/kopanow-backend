const mongoose = require('mongoose');

/**
 * Payment — one document per confirmed M-Pesa transaction.
 *
 * Created by the M-Pesa STK-push callback handler (/mpesa/callback).
 * When saved:
 *  1. Outstanding loan balance is decremented.
 *  2. If fully repaid: REMOVE_ADMIN FCM sent, Loan.device_status → admin_removed.
 *  3. If partially paid / overdue cleared: UNLOCK_DEVICE FCM sent.
 *
 * The `mpesa_ref` field (M-Pesa transaction ID / receipt number) is the
 * immutable external identifier.  It is unique to prevent double-counting.
 */
const PaymentSchema = new mongoose.Schema(
  {
    // ── Loan linkage ───────────────────────────────────────────────────────

    borrower_id: {
      type:     String,
      required: [true, 'borrower_id is required'],
      trim:     true,
      index:    true
    },

    loan_id: {
      type:     String,
      required: [true, 'loan_id is required'],
      trim:     true,
      index:    true
    },

    // ── M-Pesa transaction ─────────────────────────────────────────────────

    /**
     * M-Pesa receipt number (e.g. "OEI2AK3LQ7").
     * Returned by Safaricom in the STK-push callback.
     * Unique to prevent duplicate payment processing.
     */
    mpesa_ref: {
      type:     String,
      required: [true, 'mpesa_ref is required'],
      trim:     true,
      unique:   true,
      uppercase: true
    },

    /**
     * M-Pesa CheckoutRequestID that initiated this transaction.
     * Used to correlate the STK push to its callback.
     */
    checkout_request_id: {
      type:    String,
      default: null,
      trim:    true,
      index:   true
    },

    /**
     * Amount paid in this transaction (TSh, whole number).
     */
    amount: {
      type:     Number,
      required: [true, 'amount is required'],
      min:      [1, 'payment amount must be at least 1 TSh']
    },

    /**
     * M-Pesa phone number that made the payment (format: 2547XXXXXXXX).
     */
    phone_number: {
      type:    String,
      default: null,
      trim:    true
    },

    // ── Timestamps ─────────────────────────────────────────────────────────

    /**
     * When the payment was confirmed by Safaricom (from callback body).
     * Distinct from Mongoose's auto createdAt so it survives re-processing.
     */
    paid_at: {
      type:     Date,
      required: [true, 'paid_at is required'],
      index:    true
    },

    // ── Processing state ───────────────────────────────────────────────────

    /**
     * Whether this payment has been applied to the loan balance.
     * Set to true by the callback handler after Loan.applyPayment() succeeds.
     * Lets the system safely re-process callbacks (idempotent).
     */
    applied: {
      type:    Boolean,
      default: false,
      index:   true
    },

    /**
     * Whether this payment resulted in full loan repayment.
     * Denormalised here for fast dashboard queries.
     */
    fully_repaid: {
      type:    Boolean,
      default: false
    },

    // ── Raw callback ───────────────────────────────────────────────────────

    /**
     * Raw Safaricom callback body (stored as Mixed for auditability).
     * Never used in business logic — only for debugging / disputes.
     */
    raw_callback: {
      type:    mongoose.Schema.Types.Mixed,
      default: null
    }
  },
  {
    timestamps: true,   // createdAt + updatedAt
    collection: 'payments'
  }
);

// ── Compound indexes ──────────────────────────────────────────────────────────

// Payment history for a loan, newest first
PaymentSchema.index({ loan_id: 1, paid_at: -1 });

// Find unapplied payments to reprocess on startup
PaymentSchema.index({ applied: 1, paid_at: 1 });

// ─────────────────────────────────────────────────────────────────────────────

module.exports = mongoose.model('Payment', PaymentSchema);
