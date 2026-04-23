'use strict';
const express = require('express');
const router = express.Router();
const supabase = require('../helpers/supabase');

function requireLoanOverviewAuth(req, res, next) {
  const key = String(req.headers['x-admin-key'] || '').trim();
  const expected = String(process.env.LOANOVERVIEW_ADMIN_KEY || process.env.ADMIN_KEY || '').trim();
  if (!expected) {
    return res.status(500).json({ success: false, error: 'LoanOverview auth not configured (missing ADMIN_KEY)' });
  }
  if (!key || key !== expected) {
    return res.status(401).json({ success: false, error: 'Invalid or missing x-admin-key header' });
  }
  return next();
}

function parseWindow(req) {
  const w = String(req.query.window || '').toLowerCase();
  if (w === 'day' || w === 'week' || w === 'month') return w;
  return 'day';
}

function computeFromToIso(req) {
  const fromRaw = req.query.from != null ? String(req.query.from).trim() : '';
  const toRaw = req.query.to != null ? String(req.query.to).trim() : '';
  if (fromRaw && toRaw) {
    const from = new Date(fromRaw);
    const to = new Date(toRaw);
    if (!Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime())) {
      return { from: from.toISOString(), to: to.toISOString() };
    }
  }
  const now = new Date();
  const window = parseWindow(req);
  const ms =
    window === 'week' ? 7 * 86400000 : window === 'month' ? 30 * 86400000 : 86400000;
  const from = new Date(now.getTime() - ms);
  return { from: from.toISOString(), to: now.toISOString() };
}

async function fetchCompletedQueueLoanIdsSet(opts = {}) {
  let q = supabase
    .from('cash_disbursement_queue')
    .select('loan_id')
    .eq('status', 'completed')
    .limit(50000);
  if (opts.updatedAfterIso) q = q.gte('updated_at', opts.updatedAfterIso);
  if (opts.updatedBeforeIso) q = q.lte('updated_at', opts.updatedBeforeIso);
  const { data, error } = await q;
  if (error) throw error;
  return new Set((data || []).map((r) => r.loan_id).filter(Boolean));
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

router.use(requireLoanOverviewAuth);

// GET /api/admin/loanoverview/summary?window=day|week|month&from=ISO&to=ISO
router.get('/summary', async (req, res) => {
  try {
    const { from, to } = computeFromToIso(req);
    const generatedAt = new Date().toISOString();

    const [
      regsRes,
      regsTotalRes,
      completedWindowRes,
      completedAllRes,
      pendingWindowRes,
      devicesProtectionsRes,
      lipaRes,
      paymentsRes,
      paymentRefsRes,
    ] = await Promise.all([
      supabase
        .from('registrations')
        .select('borrower_id, created_at')
        .gte('created_at', from)
        .lte('created_at', to)
        .limit(50000),
      supabase.from('registrations').select('borrower_id', { count: 'exact', head: true }),
      supabase
        .from('cash_disbursement_queue')
        .select('loan_id, borrower_id, updated_at')
        .eq('status', 'completed')
        .gte('updated_at', from)
        .lte('updated_at', to)
        .limit(50000),
      supabase
        .from('cash_disbursement_queue')
        .select('loan_id, borrower_id')
        .eq('status', 'completed')
        .limit(50000),
      supabase
        .from('cash_disbursement_queue')
        .select('loan_id, borrower_id, enqueued_at')
        .eq('status', 'pending')
        .gte('enqueued_at', from)
        .lte('enqueued_at', to)
        .limit(50000),
      supabase
        .from('devices')
        .select('loan_id, borrower_id, protection_first_completed_at')
        .not('protection_first_completed_at', 'is', null)
        .gte('protection_first_completed_at', from)
        .lte('protection_first_completed_at', to)
        .limit(50000),
      supabase
        .from('lipa_transactions')
        .select('amount, ingested_at, claimed_borrower_id')
        .gte('ingested_at', from)
        .lte('ingested_at', to)
        .limit(50000),
      supabase
        .from('payments')
        .select('amount, paid_at')
        .gte('paid_at', from)
        .lte('paid_at', to)
        .limit(50000),
      supabase
        .from('payment_references')
        .select('status, submitted_at')
        .gte('submitted_at', from)
        .lte('submitted_at', to)
        .limit(50000),
    ]);

    for (const r of [
      regsRes,
      regsTotalRes,
      completedWindowRes,
      completedAllRes,
      pendingWindowRes,
      devicesProtectionsRes,
      lipaRes,
      paymentsRes,
      paymentRefsRes,
    ]) {
      if (r.error) throw r.error;
    }

    // Applicants vs customers
    const regsWindowBorrowers = new Set((regsRes.data || []).map((r) => r.borrower_id).filter(Boolean));
    const customersWindowBorrowers = new Set((completedWindowRes.data || []).map((r) => r.borrower_id).filter(Boolean));
    const customersAllBorrowers = new Set((completedAllRes.data || []).map((r) => r.borrower_id).filter(Boolean));

    const applicantsWindow = [...regsWindowBorrowers].filter((bid) => !customersAllBorrowers.has(bid));

    // Disbursed (completed queue loans in window): count + sum principal
    const completedWindowLoanIds = [...new Set((completedWindowRes.data || []).map((r) => r.loan_id).filter(Boolean))];
    let disbursedPrincipalSum = 0;
    if (completedWindowLoanIds.length) {
      const { data: disbLoans, error: disbErr } = await supabase
        .from('loans')
        .select('loan_id, principal_amount')
        .in('loan_id', completedWindowLoanIds)
        .limit(50000);
      if (disbErr) throw disbErr;
      for (const l of disbLoans || []) disbursedPrincipalSum += Number(l.principal_amount) || 0;
    }

    // Payments summaries
    let lipaTotal = 0;
    let lipaClaimed = 0;
    let lipaUnclaimed = 0;
    for (const t of lipaRes.data || []) {
      const a = Number(t.amount) || 0;
      lipaTotal += a;
      if (t.claimed_borrower_id) lipaClaimed += a;
      else lipaUnclaimed += a;
    }

    let paymentsTotal = 0;
    for (const p of paymentsRes.data || []) paymentsTotal += Number(p.amount) || 0;

    const paymentRefCounts = { pending: 0, verified: 0, rejected: 0, total: 0 };
    for (const pr of paymentRefsRes.data || []) {
      paymentRefCounts.total++;
      if (paymentRefCounts[pr.status] != null) paymentRefCounts[pr.status]++;
    }

    // Portfolio + PAR (completed loans only)
    const confirmedSet = await fetchCompletedQueueLoanIdsSet();
    const confirmedIds = [...confirmedSet];

    let portfolioGross = 0;
    let par1Bal = 0;
    let par30Bal = 0;
    let par90Bal = 0;

    if (confirmedIds.length) {
      const [{ data: loans, error: le }, { data: invs, error: ie }] = await Promise.all([
        supabase
          .from('loans')
          .select('loan_id, outstanding_amount')
          .gt('outstanding_amount', 0)
          .in('loan_id', confirmedIds)
          .limit(50000),
        supabase
          .from('loan_invoices')
          .select('loan_id, due_date, status, amount_due')
          .in('status', ['pending', 'overdue'])
          .limit(100000),
      ]);
      if (le) throw le;
      if (ie) throw ie;

      const asOfMs = Date.now();
      const dayMs = 86400000;
      const loanIdSet = new Set((loans || []).map((l) => l.loan_id));
      const loanMaxDaysPast = new Map();

      for (const inv of invs || []) {
        if (!loanIdSet.has(inv.loan_id)) continue;
        const due = new Date(inv.due_date).getTime();
        if (Number.isNaN(due) || due >= asOfMs) continue;
        const daysPast = Math.floor((asOfMs - due) / dayMs);
        const cur = loanMaxDaysPast.get(inv.loan_id) || 0;
        loanMaxDaysPast.set(inv.loan_id, Math.max(cur, daysPast));
      }

      for (const l of loans || []) {
        const o = Number(l.outstanding_amount) || 0;
        if (o <= 0) continue;
        portfolioGross += o;
        const maxD = loanMaxDaysPast.get(l.loan_id) || 0;
        if (maxD >= 1) par1Bal += o;
        if (maxD >= 30) par30Bal += o;
        if (maxD >= 90) par90Bal += o;
      }
    }

    const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);

    // Aging buckets (AR aging, completed loans only)
    const agingBuckets = {
      upcoming: { label: 'Not yet due', amount: 0, count: 0 },
      days_1_30: { label: '1–30 days past due', amount: 0, count: 0 },
      days_31_60: { label: '31–60 days past due', amount: 0, count: 0 },
      days_61_90: { label: '61–90 days past due', amount: 0, count: 0 },
      days_90_plus: { label: '90+ days past due', amount: 0, count: 0 },
    };
    if (confirmedIds.length) {
      const { data: invs, error: ie } = await supabase
        .from('loan_invoices')
        .select('loan_id, due_date, status, amount_due')
        .in('status', ['pending', 'overdue'])
        .limit(100000);
      if (ie) throw ie;
      const now = Date.now();
      const dayMs = 86400000;
      const confirmedIdSet = new Set(confirmedIds);
      for (const inv of invs || []) {
        if (!confirmedIdSet.has(inv.loan_id)) continue;
        const due = new Date(inv.due_date).getTime();
        const amt = Number(inv.amount_due) || 0;
        if (Number.isNaN(due) || due > now) {
          agingBuckets.upcoming.amount += amt;
          agingBuckets.upcoming.count++;
          continue;
        }
        const daysPast = Math.floor((now - due) / dayMs);
        if (daysPast <= 30) {
          agingBuckets.days_1_30.amount += amt;
          agingBuckets.days_1_30.count++;
        } else if (daysPast <= 60) {
          agingBuckets.days_31_60.amount += amt;
          agingBuckets.days_31_60.count++;
        } else if (daysPast <= 90) {
          agingBuckets.days_61_90.amount += amt;
          agingBuckets.days_61_90.count++;
        } else {
          agingBuckets.days_90_plus.amount += amt;
          agingBuckets.days_90_plus.count++;
        }
      }
      for (const b of Object.values(agingBuckets)) b.amount = round2(b.amount);
    }
    const agingTotalReceivable = round2(Object.values(agingBuckets).reduce((s, b) => s + b.amount, 0));

    // Ops funnel counts (window)
    const protectionsCompleteCount = (devicesProtectionsRes.data || []).length;
    const queuePendingCount = (pendingWindowRes.data || []).length;
    const queueCompletedCount = (completedWindowRes.data || []).length;

    return res.json({
      success: true,
      generated_at: generatedAt,
      window: parseWindow(req),
      from,
      to,
      counts: {
        registrations_in_window: regsWindowBorrowers.size,
        customers_in_window: customersWindowBorrowers.size,
        applicants_in_window: applicantsWindow.length,
        customers_total: customersAllBorrowers.size,
        registrations_total: regsTotalRes.count || null,
      },
      disbursed: {
        completed_loan_count_in_window: completedWindowLoanIds.length,
        principal_sum_in_window: round2(disbursedPrincipalSum),
      },
      payments: {
        lipa: {
          total_amount: round2(lipaTotal),
          claimed_amount: round2(lipaClaimed),
          unclaimed_amount: round2(lipaUnclaimed),
          row_count: (lipaRes.data || []).length,
          basis: 'lipa_transactions.ingested_at',
        },
        verified: {
          total_amount: round2(paymentsTotal),
          row_count: (paymentsRes.data || []).length,
          basis: 'payments.paid_at',
        },
        payment_references: {
          counts: paymentRefCounts,
          basis: 'payment_references.submitted_at',
        },
      },
      portfolio: {
        gross_outstanding: round2(portfolioGross),
        par: {
          par1: { balance: round2(par1Bal), pct: pct(par1Bal, portfolioGross) },
          par30: { balance: round2(par30Bal), pct: pct(par30Bal, portfolioGross) },
          par90: { balance: round2(par90Bal), pct: pct(par90Bal, portfolioGross) },
        },
        definition: 'Loans filtered to cash_disbursement_queue.status=completed for portfolio + PAR.',
      },
      aging: {
        buckets: agingBuckets,
        total_receivable: agingTotalReceivable,
        definition: 'Unpaid invoices (pending/overdue) for completed (customer) loans only.',
      },
      operations: {
        protections_completed_in_window: protectionsCompleteCount,
        queue_pending_enqueued_in_window: queuePendingCount,
        queue_completed_updated_in_window: queueCompletedCount,
      },
    });
  } catch (err) {
    console.error('[loanoverview:summary]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

module.exports = router;

