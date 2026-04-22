'use strict';
const supabase = require('./supabase');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

const MIN_MONTHS = 1;
const MAX_MONTHS = 3;

/**
 * Total repayment = principal × this fraction (principal + interest).
 * 1 mo → 120%, 2 mo → 140%, 3 mo → 160%.
 */
const TOTAL_REPAYMENT_MULTIPLIER_BY_MONTHS = {
  1: 1.2,
  2: 1.4,
  3: 1.6,
};

/**
 * Resolve 1–3 month repayment term from request body (explicit months, 4/8/12 weeks, or tenor_days≈30).
 */
function parseRepaymentMonths(body = {}) {
  const { repayment_months, installment_weeks, tenor_days } = body;
  const rm = repayment_months != null ? parseInt(repayment_months, 10) : NaN;
  if (Number.isFinite(rm) && rm >= MIN_MONTHS && rm <= MAX_MONTHS) return rm;
  const w = installment_weeks != null ? parseInt(installment_weeks, 10) : NaN;
  if (Number.isFinite(w) && w >= 4 && w <= 12 && w % 4 === 0) return w / 4;
  const td = Number(tenor_days);
  if (Number.isFinite(td) && td > 0) {
    const approx = Math.round(td / 30);
    return Math.min(MAX_MONTHS, Math.max(MIN_MONTHS, approx || 1));
  }
  return 1;
}

/**
 * Product rule:
 * - Total repayment = principal × (120% / 140% / 160%) for 1 / 2 / 3 months.
 * - Interest = total − principal.
 * - Weeks = 4 per month; weekly_installment = total ÷ weeks (equal split, last invoice absorbs rounding).
 */
function computeRepaymentSchedule(principal, months) {
  const m = Math.min(MAX_MONTHS, Math.max(MIN_MONTHS, parseInt(months, 10) || 1));
  const weeks = 4 * m;
  const p = Math.round(Number(principal) * 100) / 100;
  const mult = TOTAL_REPAYMENT_MULTIPLIER_BY_MONTHS[m] ?? 1.2;
  const totalRepayment = Math.round(p * mult * 100) / 100;
  const interest_amount = Math.round((totalRepayment - p) * 100) / 100;
  const weekly = Math.round((totalRepayment / weeks) * 100) / 100;
  return {
    months: m,
    weeks,
    principal: p,
    interest_amount,
    totalRepayment,
    weekly,
  };
}

/**
 * Create weekly installment invoices (first due = schedule_start + 7 days, then every 7 days).
 * Updates the loan row with totals and next_due_date = first installment due.
 */
async function createInvoicesForLoan({
  loan_id,
  borrower_id,
  borrower_name,
  principal_amount,
  repayment_months,
  schedule_start,
}) {
  const {
    weeks,
    weekly,
    totalRepayment: total,
    interest_amount: interestAmount,
  } = computeRepaymentSchedule(principal_amount, repayment_months);

  const start = new Date(schedule_start || Date.now());
  const rows = [];
  let accrued = 0;
  for (let i = 1; i <= weeks; i++) {
    const due = new Date(start.getTime() + i * WEEK_MS);
    const amountDue =
      i === weeks
        ? Math.round((total - accrued) * 100) / 100
        : weekly;
    accrued += amountDue;
    rows.push({
      loan_id,
      borrower_id,
      borrower_name: borrower_name || null,
      invoice_number: `${loan_id}-${String(i).padStart(2, '0')}`,
      installment_index: i,
      amount_due: amountDue,
      due_date: due.toISOString(),
      status: 'pending',
    });
  }

  const { error: insErr } = await supabase.from('loan_invoices').insert(rows);
  if (insErr) throw insErr;

  const firstDue = rows[0].due_date;

  const { error: upErr } = await supabase
    .from('loans')
    .update({
      total_repayment_amount: total,
      weekly_installment_amount: weekly,
      installment_weeks: weeks,
      loan_schedule_start: start.toISOString(),
      outstanding_amount: total,
      interest_amount: interestAmount,
      next_due_date: firstDue,
      updated_at: new Date().toISOString(),
    })
    .eq('loan_id', loan_id);
  if (upErr) throw upErr;
}

/**
 * Mark pending invoices as overdue when due_date has passed.
 */
async function markOverdueInvoices() {
  const now = new Date().toISOString();
  const { error } = await supabase
    .from('loan_invoices')
    .update({ status: 'overdue', updated_at: now })
    .eq('status', 'pending')
    .lt('due_date', now);
  if (error) throw error;
}

/**
 * Apply a verified payment to oldest unpaid installments first.
 *
 * Business rule:
 * - Partial payments reduce the oldest unpaid invoice amount_due (remaining due).
 * - Overpayments spill to the next invoice(s).
 *
 * Note: We treat loan_invoices.amount_due as the *remaining* amount due for that installment.
 */
async function applyPaymentToInvoices(loan_id, amount_paid) {
  let remaining = Number(amount_paid);
  if (remaining <= 0) return { applied: 0, invoices_paid: 0 };

  const { data: invs, error } = await supabase
    .from('loan_invoices')
    .select('id, amount_due, status')
    .eq('loan_id', loan_id)
    .in('status', ['pending', 'overdue'])
    .order('installment_index', { ascending: true });

  if (error) throw error;

  const now = new Date().toISOString();
  let countPaid = 0;
  for (const inv of invs || []) {
    if (remaining <= 0) break;

    const due = Math.max(0, Number(inv.amount_due) || 0);
    if (due <= 0) {
      // Defensive: if an unpaid invoice has 0 due, mark paid.
      await supabase
        .from('loan_invoices')
        .update({ status: 'paid', paid_at: now, updated_at: now })
        .eq('id', inv.id);
      countPaid++;
      continue;
    }

    const apply = Math.min(remaining, due);
    const newDue = Math.round((due - apply) * 100) / 100;

    if (newDue <= 0) {
      await supabase
        .from('loan_invoices')
        .update({ status: 'paid', paid_at: now, amount_due: 0, updated_at: now })
        .eq('id', inv.id);
      countPaid++;
    } else {
      await supabase
        .from('loan_invoices')
        .update({ amount_due: newDue, status: 'pending', paid_at: null, updated_at: now })
        .eq('id', inv.id);
    }

    remaining -= apply;
  }

  return { applied: Number(amount_paid) - remaining, invoices_paid: countPaid };
}

/**
 * Refresh loans.next_due_date from the next unpaid invoice (if any).
 */
async function refreshLoanNextDueDate(loan_id) {
  const { data: next } = await supabase
    .from('loan_invoices')
    .select('due_date')
    .eq('loan_id', loan_id)
    .in('status', ['pending', 'overdue'])
    .order('installment_index', { ascending: true })
    .limit(1)
    .maybeSingle();

  await supabase
    .from('loans')
    .update({
      next_due_date: next?.due_date || null,
      updated_at: new Date().toISOString(),
    })
    .eq('loan_id', loan_id);
}

module.exports = {
  TOTAL_REPAYMENT_MULTIPLIER_BY_MONTHS,
  parseRepaymentMonths,
  computeRepaymentSchedule,
  createInvoicesForLoan,
  markOverdueInvoices,
  applyPaymentToInvoices,
  refreshLoanNextDueDate,
};
