'use strict';
const router = require('express').Router();
const supabase = require('../helpers/supabase');
const { assertDeviceFreeForEnrollment } = require('../helpers/deviceEnrollment');
const {
  parseRepaymentMonths,
  computeRepaymentSchedule,
  createInvoicesForLoan,
} = require('../helpers/loanInvoices');

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
      /** 1–3: total = principal×(120%/140%/160%); weekly = total÷(4×months). */
      repayment_months,
      /** Legacy: 4, 8, or 12 weeks if months not sent. */
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

    if (!borrower_id || !phone || !full_name || !national_id || !region || !address || !amount_tzs || !purpose) {
      return res.status(400).json({ success: false, message: 'Missing required fields.' });
    }
    const rmQuick = repayment_months != null ? parseInt(repayment_months, 10) : NaN;
    const hasTerm =
      (tenor_days != null && Number(tenor_days) > 0) ||
      (Number.isFinite(rmQuick) && rmQuick >= 1 && rmQuick <= 3);
    if (!hasTerm) {
      return res.status(400).json({ success: false, message: 'Provide tenor_days or repayment_months (1–3).' });
    }

    const loan_id = generateLoanId();

    const principal = Number(amount_tzs);
    const months = parseRepaymentMonths({
      repayment_months,
      installment_weeks,
      tenor_days,
    });
    const schedule = computeRepaymentSchedule(principal, months);
    const totalRepayment = schedule.totalRepayment;
    const interestAmount = schedule.interest_amount;
    const tenorDaysStored = Math.round(30 * months);

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
        tenor_days: tenorDaysStored,
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
        interest_amount: interestAmount,
        device_status: 'unregistered',
        created_at: now,
        updated_at: now,
      })
      .throwOnError();

    // 3b) Weekly installments: total = principal × 120%/140%/160%, ÷ (4×months) weeks
    await createInvoicesForLoan({
      loan_id,
      borrower_id,
      borrower_name: full_name,
      principal_amount: principal,
      repayment_months: months,
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

// POST /api/loan/contract-acceptance
// Persists electronic contract acceptance from KopaNow ContractActivity.
router.post('/contract-acceptance', async (req, res) => {
  try {
    const b = req.body || {};
    const required = [
      'contract_number', 'loan_id', 'borrower_id', 'borrower_name',
      'loan_amount_tzs', 'total_repayment_tzs', 'weekly_installment_tzs', 'num_weeks',
      'loan_start_at', 'first_repayment_at', 'last_repayment_at',
    ];
    for (const k of required) {
      if (b[k] == null || b[k] === '') {
        return res.status(400).json({ success: false, message: `Missing: ${k}` });
      }
    }

    const row = {
      contract_number: String(b.contract_number).trim(),
      loan_id: String(b.loan_id).trim(),
      borrower_id: String(b.borrower_id).trim(),
      borrower_name: String(b.borrower_name).trim(),
      borrower_phone: b.borrower_phone != null ? String(b.borrower_phone).trim() : null,
      borrower_region: b.borrower_region != null ? String(b.borrower_region).trim() : null,
      loan_amount_tzs: Number(b.loan_amount_tzs),
      total_repayment_tzs: Number(b.total_repayment_tzs),
      weekly_installment_tzs: Number(b.weekly_installment_tzs),
      num_weeks: parseInt(b.num_weeks, 10),
      loan_start_at: new Date(b.loan_start_at).toISOString(),
      first_repayment_at: new Date(b.first_repayment_at).toISOString(),
      last_repayment_at: new Date(b.last_repayment_at).toISOString(),
      device_android_model: b.device_android_model != null ? String(b.device_android_model).trim() : null,
      imei: b.imei != null ? String(b.imei).trim() : null,
      serial_number: b.serial_number != null ? String(b.serial_number).trim() : null,
      google_account: b.google_account != null ? String(b.google_account).trim() : null,
      device_id: b.device_id != null ? String(b.device_id).trim() : null,
      app_version: b.app_version != null ? String(b.app_version).trim() : null,
      accepted_at: b.accepted_at ? new Date(b.accepted_at).toISOString() : new Date().toISOString(),
    };

    if (!Number.isFinite(row.loan_amount_tzs) || row.num_weeks < 1) {
      return res.status(400).json({ success: false, message: 'Invalid amounts or num_weeks' });
    }

    const { data, error } = await supabase
      .from('contract_acceptances')
      .insert(row)
      .select('id')
      .maybeSingle();

    if (error) {
      if (error.code === '23505') {
        return res.status(409).json({ success: false, message: 'Contract number already recorded' });
      }
      throw error;
    }

    return res.json({ success: true, id: data?.id, message: 'Contract acceptance saved' });
  } catch (err) {
    const msg = err?.message || 'Internal server error';
    console.error('[loan:contract-acceptance]', msg);
    return res.status(500).json({ success: false, message: msg });
  }
});

module.exports = router;

