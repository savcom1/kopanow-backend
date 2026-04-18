'use strict';
const router = require('express').Router();
const supabase = require('../helpers/supabase');

function generateLoanId() {
  // Human-readable-ish unique loan id
  return `LN-${Date.now()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

// POST /api/loan/request
// Called by Android RegistrationActivity before activation is allowed.
router.post('/request', async (req, res) => {
  try {
    const {
      borrower_id,
      phone,
      full_name,
      national_id,
      region,
      address,
      amount_tzs,
      tenor_days,
      purpose
    } = req.body || {};

    if (!borrower_id || !phone || !full_name || !national_id || !region || !address || !amount_tzs || !tenor_days || !purpose) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const loan_id = generateLoanId();

    // 1) Upsert registration/profile
    const now = new Date().toISOString();
    const { error: regErr } = await supabase
      .from('registrations')
      .upsert({
        borrower_id,
        phone,
        full_name,
        national_id,
        region,
        address,
        updated_at: now
      }, { onConflict: 'borrower_id' });
    if (regErr) throw regErr;

    // 2) Insert loan request (immutable record)
    const { error: reqErr } = await supabase
      .from('loan_requests')
      .insert({
        borrower_id,
        loan_id,
        amount_tzs,
        tenor_days,
        purpose,
        status: 'submitted'
      });
    if (reqErr) throw reqErr;

    // 3) Create a loan row so the rest of the system can reference it
    // (Admin can later approve/update amounts / due dates.)
    await supabase
      .from('loans')
      .insert({
        loan_id,
        borrower_id,
        principal_amount: amount_tzs,
        outstanding_amount: amount_tzs,
        device_status: 'unregistered',
        created_at: now,
        updated_at: now
      })
      .throwOnError();

    return res.json({
      success: true,
      message: 'Loan request submitted.',
      borrower_id,
      loan_id
    });
  } catch (err) {
    const msg = err?.message || 'Internal server error';
    console.error('[loan:request]', msg);
    return res.status(500).json({ success: false, message: msg });
  }
});

module.exports = router;

