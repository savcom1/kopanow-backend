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

    const scheduleStart = new Date(now);
    const contractNumber = `KN-${String(loan_id).replace(/[^A-Za-z0-9]/g, '').slice(-10)}-${Date.now().toString(36).toUpperCase()}`;

    return res.json({
      success: true,
      message: 'Loan request submitted.',
      borrower_id,
      loan_id,
      contract_number: contractNumber,
      total_repayment_tzs: Math.round(schedule.totalRepayment),
      weekly_installment_tzs: Math.round(schedule.weekly),
      num_weeks: schedule.weeks,
      loan_start_date: scheduleStart.toISOString(),
    });
  } catch (err) {
    const msg = err?.message || 'Internal server error';
    console.error('[loan:request]', msg);
    return res.status(500).json({ success: false, message: msg });
  }
});

/** Empty string → null so Postgres TIMESTAMPTZ / TEXT columns never get "". */
function trimOrNull(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// POST /api/loan/contract-acceptance — minimal row (ids + time + device); contract text lives in the app only.
router.post('/contract-acceptance', async (req, res) => {
  try {
    const b = req.body || {};
    const contract_number = b.contract_number != null ? String(b.contract_number).trim() : '';
    const loan_id = b.loan_id != null ? String(b.loan_id).trim() : '';
    const borrower_id = b.borrower_id != null ? String(b.borrower_id).trim() : '';
    if (!contract_number || !loan_id || !borrower_id) {
      return res.status(400).json({ success: false, message: 'contract_number, loan_id, and borrower_id are required.' });
    }

    const row = {
      contract_number,
      loan_id,
      borrower_id,
      borrower_name: trimOrNull(b.borrower_name),
      borrower_phone: trimOrNull(b.borrower_phone),
      borrower_region: trimOrNull(b.borrower_region),
      first_repayment_date: trimOrNull(b.first_repayment_date),
      last_repayment_date: trimOrNull(b.last_repayment_date),
      accepted_at: new Date().toISOString(),
      android_device_id: trimOrNull(b.android_device_id) || 'unknown',
      app_version: trimOrNull(b.app_version) || 'unknown',
    };

    const { error } = await supabase.from('contract_acceptances').insert(row);
    if (error) {
      if (String(error.message || '').includes('duplicate') || String(error.code) === '23505') {
        return res.status(409).json({ success: false, message: 'Contract number already recorded.' });
      }
      throw error;
    }
    return res.json({ success: true, message: 'Contract acceptance saved.', contract_number });
  } catch (err) {
    console.error('[loan:contract-acceptance]', err.message);
    return res.status(500).json({ success: false, message: err.message || 'Internal server error' });
  }
});

module.exports = router;

