'use strict';

const supabase = require('./supabase');

function normalizePhone(phone) {
  if (phone == null) return '';
  return String(phone).trim().replace(/\s+/g, '');
}

/**
 * One physical device (device_id) may only be linked to a single Kopanow enrollment
 * (borrower_id + loan_id). Re-syncing the same enrollment is allowed.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
async function assertDeviceFreeForEnrollment(device_id, borrower_id, loan_id) {
  const id = device_id != null ? String(device_id).trim() : '';
  if (!id) {
    return { ok: false, reason: 'Missing device identifier — cannot verify enrollment.' };
  }
  if (!borrower_id || !loan_id) {
    return { ok: false, reason: 'borrower_id and loan_id are required.' };
  }

  const { data: rows, error } = await supabase
    .from('devices')
    .select('borrower_id, loan_id')
    .eq('device_id', id);

  if (error) throw error;

  const conflict = (rows || []).find(
    (r) => r.borrower_id !== borrower_id || r.loan_id !== loan_id
  );
  if (conflict) {
    console.warn(
      `[enrollment] BLOCK device_id=${id} already linked to borrower=${conflict.borrower_id} loan=${conflict.loan_id}`
    );
    return {
      ok: false,
      reason:
        'This device is already enrolled in Kopanow under another loan. One device cannot be used for two loans.',
    };
  }
  return { ok: true };
}

/**
 * Policy gate: allow a new loan/enrollment for this phone only if there is no
 * active cash-out-confirmed loan for the same phone.
 *
 * Active = repaid_at is null AND outstanding_amount > 0
 * Confirmed = cash_disbursement_confirmed_at is not null
 */
async function assertPhoneEligibleForNewLoan(phone) {
  const p = normalizePhone(phone);
  if (!p) return { ok: false, reason: 'Missing phone — cannot verify eligibility.' };

  const { data: regs, error: rErr } = await supabase
    .from('registrations')
    .select('borrower_id, phone')
    .eq('phone', p)
    .limit(5);
  if (rErr) throw rErr;

  const borrowerIds = (regs || []).map((r) => r.borrower_id).filter(Boolean);
  if (!borrowerIds.length) return { ok: true };

  const { data: loans, error: lErr } = await supabase
    .from('loans')
    .select('loan_id, borrower_id, outstanding_amount, repaid_at, cash_disbursement_confirmed_at')
    .in('borrower_id', borrowerIds)
    .not('cash_disbursement_confirmed_at', 'is', null)
    .is('repaid_at', null)
    .gt('outstanding_amount', 0)
    .limit(10);
  if (lErr) throw lErr;

  if ((loans || []).length) {
    return {
      ok: false,
      reason: 'You already have an active loan. Please finish repayment before requesting another loan.',
    };
  }
  return { ok: true };
}

module.exports = { assertDeviceFreeForEnrollment, assertPhoneEligibleForNewLoan, normalizePhone };
