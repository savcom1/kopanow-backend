'use strict';
const express  = require('express');
const router   = express.Router();
const supabase = require('../helpers/supabase');
const { applyVerifiedMpesaAmount, tryResolveFromLipaTable } = require('../helpers/lipaPayment');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/payment/submit
//
// Borrower submits M-Pesa transaction / confirmation ID.
// If the row already exists in lipa_transactions (from your SMS ingest app),
// the loan is settled automatically — no admin step.
// Otherwise stays pending until SMS arrives + user taps retry-resolve or admin verifies.
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

    const { data: inserted, error: insertErr } = await supabase
      .from('payment_references')
      .insert({
        borrower_id,
        loan_id,
        mpesa_ref:      ref,
        amount_claimed: amount_claimed ? Number(amount_claimed) : null,
        notes:          notes || null,
        submitted_at:   new Date().toISOString(),
        status:         'pending'
      })
      .select('id')
      .single();

    if (insertErr) throw insertErr;

    let tryResult;
    try {
      tryResult = await tryResolveFromLipaTable({
        borrower_id,
        loan_id,
        mpesa_ref: ref,
        payment_reference_id: inserted.id,
      });
    } catch (e) {
      console.error('[payment/submit] tryResolveFromLipaTable', e.message);
      tryResult = { resolved: false };
    }

    if (tryResult.conflict) {
      return res.status(409).json({
        success: false,
        error: tryResult.conflict,
        mpesa_ref: ref,
      });
    }

    const autoVerified = tryResult.resolved === true;
    console.log(`[payment/submit] borrower=${borrower_id} ref=${ref} auto_verified=${autoVerified}`);
    return res.json({
      success: true,
      message: autoVerified
        ? 'Payment found in M-Pesa records. Your loan balance has been updated.'
        : 'Reference saved. If you paid with a number not on file, we will match it when the transaction appears (usually within a minute). You can tap “Check payment” to retry.',
      mpesa_ref: ref,
      auto_verified: autoVerified,
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
// POST /api/payment/retry-resolve
//
// Call when SMS ingest has landed in lipa_transactions after the user submitted ref.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/retry-resolve', async (req, res) => {
  try {
    const { borrower_id, loan_id, mpesa_ref } = req.body;
    if (!borrower_id || !loan_id || !mpesa_ref) {
      return res.status(400).json({
        success: false,
        error: 'borrower_id, loan_id and mpesa_ref are required',
      });
    }
    const ref = mpesa_ref.toString().trim().toUpperCase();

    const { data: pref, error: pErr } = await supabase
      .from('payment_references')
      .select('id, status')
      .eq('borrower_id', borrower_id)
      .eq('loan_id', loan_id)
      .eq('mpesa_ref', ref)
      .maybeSingle();

    if (pErr) throw pErr;
    if (!pref) {
      return res.status(404).json({ success: false, error: 'No submission found for this reference' });
    }
    if (pref.status === 'verified') {
      return res.json({
        success: true,
        auto_verified: true,
        message: 'This payment was already verified.',
        mpesa_ref: ref,
      });
    }

    const tryResult = await tryResolveFromLipaTable({
      borrower_id,
      loan_id,
      mpesa_ref: ref,
      payment_reference_id: pref.id,
    });

    if (tryResult.conflict) {
      return res.status(409).json({ success: false, error: tryResult.conflict, mpesa_ref: ref });
    }

    return res.json({
      success: true,
      auto_verified: tryResult.resolved === true,
      message: tryResult.resolved
        ? 'Payment matched. Your loan balance has been updated.'
        : 'Transaction not found yet. Wait a short time after paying, then try again.',
      mpesa_ref: ref,
    });
  } catch (err) {
    console.error('[payment/retry-resolve]', err.message);
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

    const paid = Number(amount_paid || ref.amount_claimed || 0);

    const result = await applyVerifiedMpesaAmount({
      borrower_id: ref.borrower_id,
      loan_id: ref.loan_id,
      mpesa_ref: ref.mpesa_ref,
      amount: paid,
      verified_by: verified_by || 'admin',
      reviewer_note: reviewer_note || null,
      payment_reference_id: ref.id,
      raw_callback: { source: 'manual_reference', verified_by: verified_by || 'admin' },
    });

    console.log(`[payment/verify] ✓ ref=${ref.mpesa_ref} paid=${paid} remaining=${result.remaining} by=${verified_by}`);
    return res.json({
      success:      true,
      mpesa_ref:    ref.mpesa_ref,
      amount_paid:  result.amount_paid,
      remaining:    result.remaining,
      action:       result.action,
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
