'use strict';
const supabase = require('./supabase');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Create weekly installment invoices (Day 7, 14, 21, … from schedule start).
 * Updates the loan row with totals and next_due_date = first installment due.
 */
async function createInvoicesForLoan({
  loan_id,
  borrower_id,
  borrower_name,
  principal_amount,
  weeks,
  total_repayment,
  schedule_start,
}) {
  const w = Math.max(1, Math.min(52, parseInt(weeks, 10) || 5));
  const total = Number(total_repayment);
  const weekly = Math.round((total / w) * 100) / 100;
  const start = new Date(schedule_start || Date.now());
  const rows = [];
  for (let i = 1; i <= w; i++) {
    const due = new Date(start.getTime() + i * WEEK_MS);
    rows.push({
      loan_id,
      borrower_id,
      borrower_name: borrower_name || null,
      invoice_number: `${loan_id}-${String(i).padStart(2, '0')}`,
      installment_index: i,
      amount_due: weekly,
      due_date: due.toISOString(),
      status: 'pending',
    });
  }

  const { error: insErr } = await supabase.from('loan_invoices').insert(rows);
  if (insErr) throw insErr;

  const firstDue = rows[0].due_date;
  const interest = Math.max(0, total - Number(principal_amount));

  const { error: upErr } = await supabase
    .from('loans')
    .update({
      total_repayment_amount: total,
      weekly_installment_amount: weekly,
      installment_weeks: w,
      loan_schedule_start: start.toISOString(),
      outstanding_amount: total,
      interest_amount: interest,
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
 * Apply a verified payment to oldest unpaid installments first (full installments only).
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
  let count = 0;
  for (const inv of invs || []) {
    if (remaining <= 0) break;
    const due = Number(inv.amount_due);
    if (remaining >= due) {
      await supabase
        .from('loan_invoices')
        .update({ status: 'paid', paid_at: now, updated_at: now })
        .eq('id', inv.id);
      remaining -= due;
      count++;
    }
  }
  return { applied: Number(amount_paid) - remaining, invoices_paid: count };
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
  createInvoicesForLoan,
  markOverdueInvoices,
  applyPaymentToInvoices,
  refreshLoanNextDueDate,
};
