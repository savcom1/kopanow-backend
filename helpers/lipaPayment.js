'use strict';
const supabase = require('./supabase');
const { sendUnlockCommand, sendRemoveAdminCommand } = require('./fcm');
const { logTamper, EVENT_TYPES } = require('./tamperLog');
const {
  applyPaymentToInvoices,
  refreshLoanNextDueDate,
} = require('./loanInvoices');

/**
 * Normalize Tanzania mobile to digits starting with 255 (no +).
 */
function normalizeTzPhone(raw) {
  if (raw == null || raw === '') return '';
  let d = String(raw).replace(/\D/g, '');
  if (d.startsWith('255')) return d;
  if (d.startsWith('0') && d.length >= 10) return `255${d.slice(1)}`;
  if (d.length === 9 && d.startsWith('7')) return `255${d}`;
  return d;
}

/**
 * Apply a verified M-Pesa amount to loan + device (same as admin verify).
 * @param {object} opts
 * @param {string} opts.borrower_id
 * @param {string} opts.loan_id
 * @param {string} opts.mpesa_ref
 * @param {number} opts.amount
 * @param {string} opts.verified_by
 * @param {string|null} opts.reviewer_note
 * @param {string|null} opts.payment_reference_id  UUID of payment_references row to mark verified, or null
 * @param {object} opts.raw_callback
 */
async function applyVerifiedMpesaAmount(opts) {
  const {
    borrower_id,
    loan_id,
    mpesa_ref,
    amount: amountRaw,
    verified_by,
    reviewer_note,
    payment_reference_id,
    raw_callback,
  } = opts;

  const paid = Number(amountRaw);
  if (!Number.isFinite(paid) || paid <= 0) {
    throw new Error('Invalid payment amount');
  }

  const { data: dupPay } = await supabase
    .from('payments')
    .select('id, amount')
    .eq('mpesa_ref', mpesa_ref)
    .maybeSingle();
  if (dupPay) {
    if (payment_reference_id) {
      await supabase.from('payment_references').update({
        status: 'verified',
        verified_by: verified_by || 'system',
        verified_at: new Date().toISOString(),
        reviewer_note: reviewer_note || 'Ledger already contained this M-Pesa ref',
      }).eq('id', payment_reference_id);
    }
    const { data: loanSnap } = await supabase
      .from('loans')
      .select('outstanding_amount')
      .eq('loan_id', loan_id)
      .maybeSingle();
    const rem = Number(loanSnap?.outstanding_amount || 0);
    return {
      amount_paid: Number(dupPay.amount) || paid,
      remaining: rem,
      action: rem <= 0 ? 'REMOVE_ADMIN' : 'UNLOCK_DEVICE',
      duplicate: true,
    };
  }

  const { data: device } = await supabase
    .from('devices')
    .select('id, fcm_token, is_locked, amount_due')
    .eq('borrower_id', borrower_id)
    .eq('loan_id', loan_id)
    .maybeSingle();

  const { data: loan } = await supabase
    .from('loans')
    .select('id, outstanding_amount')
    .eq('loan_id', loan_id)
    .maybeSingle();

  const outstanding = Number(loan?.outstanding_amount || 0);
  const newOutstanding = Math.max(0, outstanding - paid);

  if (payment_reference_id) {
    await supabase.from('payment_references').update({
      status: 'verified',
      verified_by: verified_by || 'system',
      verified_at: new Date().toISOString(),
      reviewer_note: reviewer_note || null,
    }).eq('id', payment_reference_id);
  }

  await supabase.from('payments').upsert({
    mpesa_ref,
    loan_id,
    borrower_id,
    amount: paid,
    paid_at: new Date().toISOString(),
    is_processed: true,
    raw_callback: raw_callback || { source: 'lipa_auto' },
  }, { onConflict: 'mpesa_ref' });

  await applyPaymentToInvoices(loan_id, paid);
  await refreshLoanNextDueDate(loan_id);

  if (loan) {
    await supabase.from('loans').update({
      outstanding_amount: newOutstanding,
      device_status: newOutstanding <= 0 ? 'admin_removed' : 'active',
      updated_at: new Date().toISOString(),
    }).eq('id', loan.id);
  }

  if (device) {
    if (newOutstanding <= 0) {
      if (device.fcm_token) await sendRemoveAdminCommand(device.fcm_token);
      await supabase.from('devices').update({
        is_locked: false,
        status: 'admin_removed',
        lock_reason: null,
        amount_due: null,
        updated_at: new Date().toISOString(),
      }).eq('id', device.id);
      await logTamper(borrower_id, loan_id, EVENT_TYPES.PAYMENT_RECEIVED, {
        source: 'lipa_match',
        detail: `Full repayment TSh ${paid.toLocaleString()} (ref: ${mpesa_ref})`,
        auto_action: 'REMOVE_ADMIN',
      });
    } else {
      if (device.is_locked && device.fcm_token) await sendUnlockCommand(device.fcm_token);
      await supabase.from('devices').update({
        is_locked: false,
        status: 'active',
        amount_due: `TSh ${newOutstanding.toLocaleString()}`,
        updated_at: new Date().toISOString(),
      }).eq('id', device.id);
      await logTamper(borrower_id, loan_id, EVENT_TYPES.PAYMENT_RECEIVED, {
        source: 'lipa_match',
        detail: `Partial TSh ${paid.toLocaleString()}, remaining TSh ${newOutstanding.toLocaleString()} (ref: ${mpesa_ref})`,
        auto_action: 'UNLOCK_DEVICE',
      });
    }
  }

  return { amount_paid: paid, remaining: newOutstanding, action: newOutstanding <= 0 ? 'REMOVE_ADMIN' : 'UNLOCK_DEVICE' };
}

/**
 * Sanity-check transaction amount against loan outstanding.
 */
async function validateTxAmountForLoan(loan_id, txAmount) {
  const { data: loan } = await supabase
    .from('loans')
    .select('outstanding_amount')
    .eq('loan_id', loan_id)
    .maybeSingle();
  const outstanding = Number(loan?.outstanding_amount || 0);
  const amt = Number(txAmount);
  if (!Number.isFinite(amt) || amt <= 0) return { ok: false, reason: 'Invalid transaction amount' };
  // Allow overpayment: apply across invoices and cap outstanding at 0.
  return { ok: true, outstanding };
}

/**
 * After borrower submits payment_references row, try to match lipa_transactions and settle.
 * @returns {Promise<{ resolved: boolean, conflict?: string, result?: object }>}
 */
async function tryResolveFromLipaTable({
  borrower_id,
  loan_id,
  mpesa_ref,
  payment_reference_id,
}) {
  const ref = mpesa_ref.toString().trim().toUpperCase();

  const { data: tx, error: txErr } = await supabase
    .from('lipa_transactions')
    .select('*')
    .eq('transaction_ref', ref)
    .maybeSingle();

  if (txErr) throw txErr;
  if (!tx) return { resolved: false };

  if (tx.claimed_borrower_id) {
    if (tx.claimed_borrower_id !== borrower_id || tx.claimed_loan_id !== loan_id) {
      return {
        resolved: false,
        conflict: 'This transaction ID is already linked to another account. Contact support if this is a mistake.',
      };
    }
    const { data: pref } = await supabase
      .from('payment_references')
      .select('id, status')
      .eq('id', payment_reference_id)
      .maybeSingle();
    if (pref?.status === 'pending') {
      await supabase.from('payment_references').update({
        status: 'verified',
        verified_by: 'lipa_reconcile',
        verified_at: new Date().toISOString(),
        reviewer_note: 'Reconciled with existing Lipa settlement',
      }).eq('id', payment_reference_id);
    }
    return { resolved: true, result: { already_claimed: true } };
  }

  const { ok, reason } = await validateTxAmountForLoan(loan_id, tx.amount);
  if (!ok) return { resolved: false, conflict: reason };

  const result = await applyVerifiedMpesaAmount({
    borrower_id,
    loan_id,
    mpesa_ref: ref,
    amount: tx.amount,
    verified_by: 'lipa_table_match',
    reviewer_note: 'Verified against ingested Lipa transaction',
    payment_reference_id,
    raw_callback: { source: 'lipa_transaction_match', lipa_id: tx.id },
  });

  await supabase.from('lipa_transactions').update({
    claimed_borrower_id: borrower_id,
    claimed_loan_id: loan_id,
    claimed_at: new Date().toISOString(),
    payment_reference_id,
  }).eq('id', tx.id);

  return { resolved: true, result };
}

/**
 * SMS ingest: match payer phone to device.mpesa_phone and auto-apply (no app action).
 */
async function attemptAutoMatchIncomingLipa(txRow) {
  if (txRow.claimed_borrower_id) {
    return { matched: false, reason: 'already_claimed' };
  }

  const payerNorm = normalizeTzPhone(txRow.payer_phone);
  if (!payerNorm) return { matched: false, reason: 'no_payer_phone' };

  // Fast path: mpesa_phone is stored normalized (255...).
  const { data: direct, error: dErr } = await supabase
    .from('devices')
    .select('id, borrower_id, loan_id, mpesa_phone, status')
    .eq('mpesa_phone', payerNorm)
    .neq('status', 'admin_removed');

  if (dErr) throw dErr;

  let candidates = direct || [];

  // Legacy fallback: some devices may have mpesa_phone in a non-canonical format.
  if (candidates.length === 0) {
    const { data: devices, error } = await supabase
      .from('devices')
      .select('id, borrower_id, loan_id, mpesa_phone, status')
      .not('mpesa_phone', 'is', null);
    if (error) throw error;
    candidates = (devices || []).filter((d) => {
      const dn = normalizeTzPhone(d.mpesa_phone);
      return dn && dn === payerNorm && d.status !== 'admin_removed';
    });
  }

  if (candidates.length === 0) return { matched: false, reason: 'no_device_phone_match' };
  if (candidates.length > 1) {
    console.warn('[lipa] Multiple devices for phone', payerNorm, '— skipping auto-match');
    return { matched: false, reason: 'ambiguous_device' };
  }

  const dev = candidates[0];
  const ref = txRow.transaction_ref.toString().trim().toUpperCase();

  const { data: existingPay } = await supabase
    .from('payments')
    .select('mpesa_ref')
    .eq('mpesa_ref', ref)
    .maybeSingle();
  if (existingPay) return { matched: false, reason: 'already_applied' };

  const { ok, reason } = await validateTxAmountForLoan(dev.loan_id, txRow.amount);
  if (!ok) {
    console.warn('[lipa] Amount validation failed for auto-match:', reason);
    return { matched: false, reason: 'amount_validation', detail: reason };
  }

  await applyVerifiedMpesaAmount({
    borrower_id: dev.borrower_id,
    loan_id: dev.loan_id,
    mpesa_ref: ref,
    amount: txRow.amount,
    verified_by: 'sms_phone_match',
    reviewer_note: null,
    payment_reference_id: null,
    raw_callback: { source: 'lipa_sms_auto', payer_phone: payerNorm },
  });

  await supabase.from('lipa_transactions').update({
    claimed_borrower_id: dev.borrower_id,
    claimed_loan_id: dev.loan_id,
    claimed_at: new Date().toISOString(),
  }).eq('id', txRow.id);

  console.log(`[lipa] Auto-matched SMS tx ${ref} → borrower=${dev.borrower_id} loan=${dev.loan_id}`);
  return { matched: true, borrower_id: dev.borrower_id, loan_id: dev.loan_id };
}

module.exports = {
  normalizeTzPhone,
  applyVerifiedMpesaAmount,
  validateTxAmountForLoan,
  tryResolveFromLipaTable,
  attemptAutoMatchIncomingLipa,
};
