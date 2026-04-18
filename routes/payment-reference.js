'use strict';
const express  = require('express');
const router   = express.Router();
const supabase = require('../helpers/supabase');
const { sendUnlockCommand, sendRemoveAdminCommand } = require('../helpers/fcm');
const { logTamper, EVENT_TYPES } = require('../helpers/tamperLog');
const {
  applyPaymentToInvoices,
  refreshLoanNextDueDate,
} = require('../helpers/loanInvoices');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/submit
//
// Borrower submits their M-Pesa transaction reference from their phone's
// M-Pesa statement.  The reference is stored as "pending" for admin review.
// The device is NOT unlocked here — an admin must verify first.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/submit', async (req, res) => {
  try {
    const { borrower_id, loan_id, mpesa_ref, amount_claimed, notes } = req.body;

    if (!borrower_id || !loan_id || !mpesa_ref) {
      return res.status(400).json({
        success: false,
        error: 'borrower_id, loan_id and mpesa_ref are required'
      });
    }

    // Normalise the reference — trim whitespace, uppercase
    const ref = mpesa_ref.toString().trim().toUpperCase();

    // Reject obviously invalid formats (M-Pesa refs are 10 alphanumeric chars)
    if (!/^[A-Z0-9]{6,20}$/.test(ref)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid M-Pesa reference format. Example: RCK8XY1234'
      });
    }

    // Check for duplicate (idempotent)
    const { data: existing } = await supabase
      .from('payment_references')
      .select('id, status')
      .eq('mpesa_ref', ref)
      .maybeSingle();

    if (existing) {
      const messages = {
        pending:  'This reference is already submitted and awaiting admin review.',
        verified: 'This reference has already been verified and processed.',
        rejected: 'This reference was previously rejected. Please contact Kopanow support.'
      };
      return res.status(409).json({
        success: false,
        error:   messages[existing.status] || 'Duplicate reference.',
        status:  existing.status
      });
    }

    // Verify device exists
    const { data: device, error: devErr } = await supabase
      .from('devices')
      .select('id, borrower_id, loan_id, is_locked')
      .eq('borrower_id', borrower_id)
      .eq('loan_id', loan_id)
      .maybeSingle();

    if (devErr) throw devErr;
    if (!device) {
      return res.status(404).json({ success: false, error: 'Device not registered' });
    }

    // Insert pending reference
    const { error: insertErr } = await supabase
      .from('payment_references')
      .insert({
        borrower_id,
        loan_id,
        mpesa_ref:      ref,
        amount_claimed: amount_claimed ? Number(amount_claimed) : null,
        notes:          notes || null,
        submitted_at:   new Date().toISOString(),
        status:         'pending'
      });

    if (insertErr) throw insertErr;

    console.log(`[payment/submit] borrower=${borrower_id} ref=${ref} amount=${amount_claimed}`);
    return res.json({
      success: true,
      message: 'Payment reference submitted. Kopanow admin will verify and unlock your device shortly.',
      mpesa_ref: ref
    });

  } catch (err) {
    console.error('[payment/submit]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payment/status
//
// Borrower polls to check if their submission has been verified.
// Returns { status: 'pending' | 'verified' | 'rejected', reviewer_note }
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const { borrower_id, loan_id } = req.query;
    if (!borrower_id || !loan_id) {
      return res.status(400).json({ success: false, error: 'borrower_id and loan_id required' });
    }

    const { data: refs } = await supabase
      .from('payment_references')
      .select('mpesa_ref, amount_claimed, status, submitted_at, reviewer_note')
      .eq('borrower_id', borrower_id)
      .eq('loan_id', loan_id)
      .order('submitted_at', { ascending: false })
      .limit(5);

    return res.json({ success: true, submissions: refs || [] });
  } catch (err) {
    console.error('[payment/status]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/verify/:id    (admin only — called from admin panel)
//
// Admin confirms the M-Pesa reference is genuine.
// Updates the loan outstanding, unlocks or removes admin as appropriate.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/verify/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { verified_by, amount_paid, reviewer_note } = req.body;

    // Fetch the submission
    const { data: ref, error: refErr } = await supabase
      .from('payment_references')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (refErr) throw refErr;
    if (!ref)   return res.status(404).json({ success: false, error: 'Reference not found' });
    if (ref.status !== 'pending') {
      return res.status(409).json({ success: false, error: `Already ${ref.status}` });
    }

    // Use admin-supplied amount; fall back to borrower's claimed amount
    const paid = Number(amount_paid || ref.amount_claimed || 0);

    // Fetch device + loan
    const { data: device } = await supabase
      .from('devices')
      .select('id, fcm_token, is_locked, amount_due')
      .eq('borrower_id', ref.borrower_id)
      .eq('loan_id', ref.loan_id)
      .maybeSingle();

    const { data: loan } = await supabase
      .from('loans')
      .select('id, outstanding_amount')
      .eq('loan_id', ref.loan_id)
      .maybeSingle();

    const outstanding    = Number(loan?.outstanding_amount || 0);
    const newOutstanding = Math.max(0, outstanding - paid);

    // Mark reference as verified
    await supabase.from('payment_references').update({
      status:        'verified',
      verified_by:   verified_by || 'admin',
      verified_at:   new Date().toISOString(),
      reviewer_note: reviewer_note || null
    }).eq('id', id);

    // Record in payments table for audit trail
    await supabase.from('payments').upsert({
      mpesa_ref:    ref.mpesa_ref,
      loan_id:      ref.loan_id,
      borrower_id:  ref.borrower_id,
      amount:       paid,
      paid_at:      new Date().toISOString(),
      is_processed: true,
      raw_callback: { source: 'manual_reference', verified_by: verified_by || 'admin' }
    }, { onConflict: 'mpesa_ref' });

    // Mark matching weekly invoices as paid (oldest first)
    await applyPaymentToInvoices(ref.loan_id, paid);
    await refreshLoanNextDueDate(ref.loan_id);

    // Update loan outstanding
    if (loan) {
      await supabase.from('loans').update({
        outstanding_amount: newOutstanding,
        device_status: newOutstanding <= 0 ? 'admin_removed' : 'active',
        updated_at: new Date().toISOString()
      }).eq('id', loan.id);
    }

    // FCM action based on remaining balance
    if (device) {
      if (newOutstanding <= 0) {
        // Fully paid — release device admin
        if (device.fcm_token) await sendRemoveAdminCommand(device.fcm_token);
        await supabase.from('devices').update({
          is_locked:   false,
          status:      'admin_removed',
          lock_reason: null,
          amount_due:  null,
          updated_at:  new Date().toISOString()
        }).eq('id', device.id);
        await logTamper(ref.borrower_id, ref.loan_id, EVENT_TYPES.PAYMENT_RECEIVED, {
          source: 'manual_ref', detail: `Full repayment TSh ${paid.toLocaleString()} (ref: ${ref.mpesa_ref})`,
          auto_action: 'REMOVE_ADMIN'
        });
      } else {
        // Partial / overdue cleared — unlock
        if (device.is_locked && device.fcm_token) await sendUnlockCommand(device.fcm_token);
        await supabase.from('devices').update({
          is_locked:   false,
          status:      'active',
          amount_due:  `TSh ${newOutstanding.toLocaleString()}`,
          updated_at:  new Date().toISOString()
        }).eq('id', device.id);
        await logTamper(ref.borrower_id, ref.loan_id, EVENT_TYPES.PAYMENT_RECEIVED, {
          source: 'manual_ref',
          detail: `Partial TSh ${paid.toLocaleString()}, remaining TSh ${newOutstanding.toLocaleString()} (ref: ${ref.mpesa_ref})`,
          auto_action: 'UNLOCK_DEVICE'
        });
      }
    }

    console.log(`[payment/verify] ✓ ref=${ref.mpesa_ref} paid=${paid} remaining=${newOutstanding} by=${verified_by}`);
    return res.json({
      success:      true,
      mpesa_ref:    ref.mpesa_ref,
      amount_paid:  paid,
      remaining:    newOutstanding,
      action:       newOutstanding <= 0 ? 'REMOVE_ADMIN' : 'UNLOCK_DEVICE'
    });

  } catch (err) {
    console.error('[payment/verify]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/reject/:id    (admin only)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/reject/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { verified_by, reviewer_note } = req.body;

    const { data: ref } = await supabase
      .from('payment_references')
      .select('id, status, borrower_id, loan_id, mpesa_ref')
      .eq('id', id)
      .maybeSingle();

    if (!ref)           return res.status(404).json({ success: false, error: 'Not found' });
    if (ref.status !== 'pending') {
      return res.status(409).json({ success: false, error: `Already ${ref.status}` });
    }

    await supabase.from('payment_references').update({
      status:        'rejected',
      verified_by:   verified_by || 'admin',
      verified_at:   new Date().toISOString(),
      reviewer_note: reviewer_note || 'Reference could not be verified'
    }).eq('id', id);

    console.log(`[payment/reject] ref=${ref.mpesa_ref} by=${verified_by}`);
    return res.json({ success: true, message: 'Reference rejected' });

  } catch (err) {
    console.error('[payment/reject]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/payment/pending     (admin only — paginated list)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/pending', async (req, res) => {
  try {
    const limit  = Math.min(Number(req.query.limit  || 50), 100);
    const offset = Number(req.query.offset || 0);
    const status = req.query.status || 'pending';   // all | pending | verified | rejected

    let query = supabase
      .from('payment_references')
      .select('*', { count: 'exact' })
      .order('submitted_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (status !== 'all') query = query.eq('status', status);

    const { data: refs, count, error } = await query;
    if (error) throw error;

    return res.json({ success: true, references: refs || [], total: count });
  } catch (err) {
    console.error('[payment/pending]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
