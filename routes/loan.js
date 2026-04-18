'use strict';
const router = require('express').Router();
const supabase = require('../helpers/supabase');
const { assertDeviceFreeForEnrollment } = require('../helpers/deviceEnrollment');
const { createInvoicesForLoan } = require('../helpers/loanInvoices');

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
      /** Total to repay (principal + fees). Default: 125% of principal if omitted. */
      total_repayment_tzs,
      /** Weekly installments count (default 5 → due days 7,14,21,28,35). */
      installment_weeks,
      tenor_days,
      purpose,
      device_id,
      device_model,
      manufacturer,
      brand,
      android_version,
      sdk_version,
      screen_density,
      screen_width_dp,
      screen_height_dp,
      battery_pct,
      build_product,
      build_device,
      is_rooted
    } = req.body || {};

    if (!borrower_id || !phone || !full_name || !national_id || !region || !address || !amount_tzs || !tenor_days || !purpose) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }

    const loan_id = generateLoanId();

    const principal = Number(amount_tzs);
    const weeks = installment_weeks != null ? parseInt(installment_weeks, 10) : 5;
    const totalRepayment =
      total_repayment_tzs != null && total_repayment_tzs !== ''
        ? Number(total_repayment_tzs)
        : Math.round(principal * 1.25);

    if (device_id && String(device_id).trim()) {
      const enr = await assertDeviceFreeForEnrollment(device_id, borrower_id, loan_id);
      if (!enr.ok) {
        return res.status(409).json({ success: false, message: enr.reason });
      }
    }

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
        principal_amount: principal,
        outstanding_amount: totalRepayment,
        interest_amount: Math.max(0, totalRepayment - principal),
        device_status: 'unregistered',
        created_at: now,
        updated_at: now,
      })
      .throwOnError();

    // 3b) Weekly installment invoices (fixed total, equal weekly amounts)
    await createInvoicesForLoan({
      loan_id,
      borrower_id,
      borrower_name: full_name,
      principal_amount: principal,
      weeks,
      total_repayment: totalRepayment,
      schedule_start: now,
    });

    // 4) Pre-create / update devices row so admin UI lists the handset with device_id
    //    before MDM enrollment (dpc_active = false until /api/device/register).
    const device_info = {
      source: 'loan_registration',
      registered_at: now,
      manufacturer: manufacturer || null,
      brand: brand || null,
      android_version: android_version || null,
      sdk_version: sdk_version ?? null,
      screen_density: screen_density ?? null,
      screen_width_dp: screen_width_dp ?? null,
      screen_height_dp: screen_height_dp ?? null,
      battery_pct: battery_pct ?? null,
      build_product: build_product || null,
      build_device: build_device || null,
      is_rooted: is_rooted ?? null
    };
    const { error: devUpsertErr } = await supabase
      .from('devices')
      .upsert({
        borrower_id,
        loan_id,
        device_id: device_id || null,
        device_model: device_model || null,
        mpesa_phone: phone,
        status: 'registered',
        dpc_active: false,
        device_info,
        updated_at: now
      }, { onConflict: 'borrower_id,loan_id' });
    if (devUpsertErr) throw devUpsertErr;

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

