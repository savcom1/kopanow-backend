'use strict';

const express = require('express');
const router = express.Router();
const supabase = require('../helpers/supabase');
const { logAccountingAudit } = require('../helpers/accountingAudit');

function quoteBorrowerIdsForInFilter(ids) {
  return ids.map((id) => {
    const s = String(id);
    return /^[a-zA-Z0-9_-]+$/.test(s) ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
}

function summarizeInvoiceRows(rows) {
  if (!rows?.length) return null;
  const counts = { pending: 0, paid: 0, overdue: 0 };
  for (const r of rows) {
    if (counts[r.status] != null) counts[r.status]++;
  }
  const nextUnpaid = rows.find((i) => i.status === 'pending' || i.status === 'overdue');
  return {
    ...counts,
    total: rows.length,
    next_due_date: nextUnpaid?.due_date || null,
  };
}

function requireAccountingAuth(req, res, next) {
  const secret = process.env.ACCOUNTING_API_SECRET;
  if (!secret) return next();
  const key = req.headers['x-accounting-key'] || '';
  if (key !== secret) {
    return res.status(401).json({ success: false, error: 'Invalid or missing x-accounting-key header' });
  }
  next();
}

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsvRow(cols) {
  return cols.map(csvEscape).join(',');
}

// ── GET /api/accounting/health (no auth — load balancers) ───────────────────
router.get('/health', (req, res) => {
  res.json({ ok: true, module: 'accounting' });
});

router.use(requireAccountingAuth);

// ── GET /api/accounting/borrowers ────────────────────────────────────────────
router.get('/borrowers', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const qRaw = req.query.search != null ? String(req.query.search).trim() : '';
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabase.from('registrations').select('*', { count: 'exact' });
    if (qRaw) {
      const q = qRaw.replace(/,/g, '');
      query = query.or(
        [
          `borrower_id.ilike.%${q}%`,
          `full_name.ilike.%${q}%`,
          `phone.ilike.%${q}%`,
          `national_id.ilike.%${q}%`,
        ].join(','),
      );
    }
    const { data: rows, error, count } = await query
      .order('updated_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    return res.json({
      success: true,
      borrowers: rows || [],
      total: count || 0,
      page,
      limit,
    });
  } catch (err) {
    console.error('[accounting:borrowers]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/borrowers/:borrowerId ────────────────────────────────
router.get('/borrowers/:borrowerId', async (req, res) => {
  try {
    const borrowerId = req.params.borrowerId;
    const { data: reg, error: rErr } = await supabase
      .from('registrations')
      .select('*')
      .eq('borrower_id', borrowerId)
      .maybeSingle();
    if (rErr) throw rErr;
    if (!reg) return res.status(404).json({ success: false, error: 'Borrower not found' });

    const { data: loans } = await supabase.from('loans').select('*').eq('borrower_id', borrowerId);
    return res.json({ success: true, registration: reg, loans: loans || [] });
  } catch (err) {
    console.error('[accounting:borrower-detail]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── PATCH /api/accounting/borrowers/:borrowerId ──────────────────────────────
router.patch('/borrowers/:borrowerId', async (req, res) => {
  try {
    const borrowerId = req.params.borrowerId;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required for audited edits' });
    }

    const { data: before, error: bErr } = await supabase
      .from('registrations')
      .select('*')
      .eq('borrower_id', borrowerId)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!before) return res.status(404).json({ success: false, error: 'Borrower not found' });

    const allowed = ['full_name', 'phone', 'national_id', 'region', 'address'];
    const patch = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) patch[k] = String(req.body[k]).trim();
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ success: false, error: `Provide one of: ${allowed.join(', ')}` });
    }

    patch.updated_at = new Date().toISOString();
    const { data: after, error: uErr } = await supabase
      .from('registrations')
      .update(patch)
      .eq('borrower_id', borrowerId)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'registration',
      entity_id: borrowerId,
      action: 'patch_registration',
      before,
      after,
      reason,
    });

    return res.json({ success: true, registration: after });
  } catch (err) {
    console.error('[accounting:patch-borrower]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/loans ────────────────────────────────────────────────
router.get('/loans', async (req, res) => {
  try {
    const { device_status, page = 1, limit = 50, search } = req.query;
    const from = (parseInt(page, 10) - 1) * parseInt(limit, 10);
    const to = from + parseInt(limit, 10) - 1;

    let query = supabase.from('loans').select('*', { count: 'exact' });
    if (device_status && device_status !== 'all') query = query.eq('device_status', device_status);

    const qRaw = search != null ? String(search).trim() : '';
    if (qRaw) {
      const q = qRaw.replace(/,/g, '');
      const { data: nameRows } = await supabase
        .from('registrations')
        .select('borrower_id')
        .ilike('full_name', `%${q}%`);
      const nameBorrowerIds = [...new Set((nameRows || []).map((r) => r.borrower_id).filter(Boolean))];
      const orParts = [`loan_id.ilike.%${q}%`, `borrower_id.ilike.%${q}%`];
      if (nameBorrowerIds.length) {
        orParts.push(`borrower_id.in.(${quoteBorrowerIdsForInFilter(nameBorrowerIds).join(',')})`);
      }
      query = query.or(orParts.join(','));
    }

    const { data: loans, error, count } = await query
      .order('next_due_date', { ascending: true, nullsFirst: false })
      .range(from, to);
    if (error) throw error;

    const loanBorrowerIds = [...new Set((loans || []).map((l) => l.borrower_id).filter(Boolean))];
    let loanNameByBorrower = {};
    if (loanBorrowerIds.length) {
      const { data: regs } = await supabase
        .from('registrations')
        .select('borrower_id, full_name')
        .in('borrower_id', loanBorrowerIds);
      loanNameByBorrower = Object.fromEntries((regs || []).map((r) => [r.borrower_id, r.full_name]));
    }

    const loanIdList = (loans || []).map((l) => l.loan_id);
    let invByLoan = {};
    if (loanIdList.length) {
      const { data: invRows } = await supabase
        .from('loan_invoices')
        .select('loan_id, status, due_date')
        .in('loan_id', loanIdList);
      for (const r of invRows || []) {
        if (!invByLoan[r.loan_id]) invByLoan[r.loan_id] = [];
        invByLoan[r.loan_id].push(r);
      }
    }

    return res.json({
      success: true,
      loans: (loans || []).map((l) => ({
        ...l,
        borrower_full_name: loanNameByBorrower[l.borrower_id] || null,
        invoice_summary: summarizeInvoiceRows(invByLoan[l.loan_id] || []),
      })),
      total: count || 0,
      page: parseInt(page, 10),
    });
  } catch (err) {
    console.error('[accounting:loans]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── GET /api/accounting/loans/:loanId ────────────────────────────────────────
router.get('/loans/:loanId', async (req, res) => {
  try {
    const loanId = req.params.loanId;
    const { data: loan, error: loanErr } = await supabase
      .from('loans')
      .select('*')
      .eq('loan_id', loanId)
      .maybeSingle();
    if (loanErr) throw loanErr;
    if (!loan) return res.status(404).json({ success: false, error: 'Loan not found' });

    const [{ data: invoices, error: invErr }, { data: registration }] = await Promise.all([
      supabase.from('loan_invoices').select('*').eq('loan_id', loanId).order('installment_index', { ascending: true }),
      supabase.from('registrations').select('*').eq('borrower_id', loan.borrower_id).maybeSingle(),
    ]);
    if (invErr) throw invErr;

    return res.json({
      success: true,
      loan,
      registration: registration || null,
      invoices: invoices || [],
      invoice_summary: summarizeInvoiceRows(invoices || []),
    });
  } catch (err) {
    console.error('[accounting:loan-detail]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/invoices/:invoiceId/adjust ──────────
router.post('/loans/:loanId/invoices/:invoiceId/adjust', async (req, res) => {
  try {
    const { loanId, invoiceId } = req.params;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }
    const status = req.body?.status != null ? String(req.body.status).trim() : '';
    const valid = ['pending', 'paid', 'overdue'];
    if (!valid.includes(status)) {
      return res.status(400).json({ success: false, error: `status must be one of: ${valid.join(', ')}` });
    }

    const { data: inv, error: iErr } = await supabase
      .from('loan_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('loan_id', loanId)
      .maybeSingle();
    if (iErr) throw iErr;
    if (!inv) return res.status(404).json({ success: false, error: 'Invoice not found for this loan' });

    const before = { ...inv };
    const updates = {
      status,
      updated_at: new Date().toISOString(),
    };
    if (status === 'paid') {
      updates.paid_at = req.body.paid_at ? new Date(req.body.paid_at).toISOString() : new Date().toISOString();
    } else {
      updates.paid_at = null;
    }

    const { data: after, error: uErr } = await supabase
      .from('loan_invoices')
      .update(updates)
      .eq('id', inv.id)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan_invoice',
      entity_id: invoiceId,
      action: 'adjust_invoice_status',
      before,
      after,
      reason,
    });

    return res.json({ success: true, invoice: after });
  } catch (err) {
    console.error('[accounting:invoice-adjust]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/adjust-outstanding ────────────────────
router.post('/loans/:loanId/adjust-outstanding', async (req, res) => {
  try {
    const loanId = req.params.loanId;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }
    const raw = req.body?.outstanding_amount;
    if (raw === undefined || raw === null || Number.isNaN(Number(raw))) {
      return res.status(400).json({ success: false, error: 'outstanding_amount (number) is required' });
    }
    const outstanding_amount = Number(raw);
    if (outstanding_amount < 0) {
      return res.status(400).json({ success: false, error: 'outstanding_amount must be >= 0' });
    }

    const { data: before, error: bErr } = await supabase
      .from('loans')
      .select('*')
      .eq('loan_id', loanId)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!before) return res.status(404).json({ success: false, error: 'Loan not found' });

    const { data: after, error: uErr } = await supabase
      .from('loans')
      .update({
        outstanding_amount,
        updated_at: new Date().toISOString(),
      })
      .eq('loan_id', loanId)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan',
      entity_id: loanId,
      action: 'adjust_outstanding',
      before,
      after,
      reason,
    });

    return res.json({ success: true, loan: after });
  } catch (err) {
    console.error('[accounting:outstanding-adjust]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/cash-receipts/lipa (read-only; Lipa = borrower cash-in) ─
router.get('/cash-receipts/lipa', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const claim = String(req.query.claim || 'all').toLowerCase();
    const qRaw = req.query.search != null ? String(req.query.search).trim() : '';
    const q = qRaw.replace(/,/g, '').replace(/%/g, '').replace(/_/g, '').slice(0, 120);

    let query = supabase.from('lipa_transactions').select('*', { count: 'exact' });
    if (claim === 'unclaimed') query = query.is('claimed_borrower_id', null);
    else if (claim === 'claimed') query = query.not('claimed_borrower_id', 'is', null);

    if (q) {
      const pat = `%${q}%`;
      query = query.or(
        [
          `transaction_ref.ilike.${pat}`,
          `payer_phone.ilike.${pat}`,
          `claimed_loan_id.ilike.${pat}`,
          `claimed_borrower_id.ilike.${pat}`,
        ].join(','),
      );
    }

    const from = (page - 1) * limit;
    const to = from + limit - 1;
    const { data: rows, error, count } = await query
      .order('transaction_occurred_at', { ascending: false, nullsFirst: false })
      .order('ingested_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    return res.json({
      success: true,
      transactions: rows || [],
      total: count || 0,
      page,
      limit,
    });
  } catch (err) {
    console.error('[accounting:lipa-list]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/reports/collections — Lipa-only rollups (ingested_at window)
router.get('/reports/collections', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from).toISOString() : null;
    const to = req.query.to ? new Date(req.query.to).toISOString() : null;
    if (!from || !to || Number.isNaN(new Date(from).getTime()) || Number.isNaN(new Date(to).getTime())) {
      return res.status(400).json({ success: false, error: 'from and to (ISO dates) are required' });
    }
    const format = String(req.query.format || 'json').toLowerCase();

    const { data: rows, error } = await supabase
      .from('lipa_transactions')
      .select('amount, ingested_at, transaction_ref, claimed_loan_id, claimed_borrower_id, payer_phone, transaction_occurred_at')
      .gte('ingested_at', from)
      .lte('ingested_at', to)
      .limit(50000);
    if (error) throw error;

    const list = rows || [];
    let totalAmount = 0;
    let claimedCount = 0;
    let unclaimedCount = 0;
    for (const r of list) {
      totalAmount += Number(r.amount) || 0;
      if (r.claimed_borrower_id) claimedCount++;
      else unclaimedCount++;
    }

    const summary = {
      basis: 'lipa_transactions.ingested_at',
      from,
      to,
      row_count: list.length,
      total_amount: Math.round(totalAmount * 100) / 100,
      claimed_rows: claimedCount,
      unclaimed_rows: unclaimedCount,
    };

    if (format === 'csv') {
      const header = toCsvRow([
        'ingested_at',
        'amount',
        'transaction_ref',
        'payer_phone',
        'claimed_loan_id',
        'claimed_borrower_id',
      ]);
      const lines = [header];
      for (const r of list) {
        lines.push(
          toCsvRow([
            r.ingested_at,
            r.amount,
            r.transaction_ref,
            r.payer_phone,
            r.claimed_loan_id,
            r.claimed_borrower_id,
          ]),
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="collections-lipa.csv"');
      return res.send(lines.join('\n'));
    }

    return res.json({ success: true, summary, rows: list });
  } catch (err) {
    console.error('[accounting:collections]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/reports/aging ────────────────────────────────────────
router.get('/reports/aging', async (req, res) => {
  try {
    const format = String(req.query.format || 'json').toLowerCase();
    const { data: invoices, error } = await supabase
      .from('loan_invoices')
      .select('id, loan_id, borrower_id, invoice_number, amount_due, due_date, status')
      .in('status', ['pending', 'overdue']);
    if (error) throw error;

    const now = Date.now();
    const dayMs = 86400000;
    const buckets = {
      upcoming: { label: 'Not yet due', amount: 0, count: 0 },
      days_1_30: { label: '1–30 days past due', amount: 0, count: 0 },
      days_31_60: { label: '31–60 days past due', amount: 0, count: 0 },
      days_61_90: { label: '61–90 days past due', amount: 0, count: 0 },
      days_90_plus: { label: '90+ days past due', amount: 0, count: 0 },
    };

    for (const inv of invoices || []) {
      const due = new Date(inv.due_date).getTime();
      const amt = Number(inv.amount_due) || 0;
      if (due > now) {
        buckets.upcoming.amount += amt;
        buckets.upcoming.count++;
        continue;
      }
      const daysPast = Math.floor((now - due) / dayMs);
      if (daysPast <= 30) {
        buckets.days_1_30.amount += amt;
        buckets.days_1_30.count++;
      } else if (daysPast <= 60) {
        buckets.days_31_60.amount += amt;
        buckets.days_31_60.count++;
      } else if (daysPast <= 90) {
        buckets.days_61_90.amount += amt;
        buckets.days_61_90.count++;
      } else {
        buckets.days_90_plus.amount += amt;
        buckets.days_90_plus.count++;
      }
    }

    const totalReceivable = Object.values(buckets).reduce((s, b) => s + b.amount, 0);

    if (format === 'csv') {
      const lines = [toCsvRow(['bucket', 'label', 'count', 'amount'])];
      for (const [key, b] of Object.entries(buckets)) {
        lines.push(toCsvRow([key, b.label, b.count, Math.round(b.amount * 100) / 100]));
      }
      lines.push(toCsvRow(['total', 'All buckets', '', Math.round(totalReceivable * 100) / 100]));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="ar-aging.csv"');
      return res.send(lines.join('\n'));
    }

    return res.json({
      success: true,
      generated_at: new Date().toISOString(),
      buckets,
      total_receivable: Math.round(totalReceivable * 100) / 100,
    });
  } catch (err) {
    console.error('[accounting:aging]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/queues/unmatched-lipa ────────────────────────────────
router.get('/queues/unmatched-lipa', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data: rows, error, count } = await supabase
      .from('lipa_transactions')
      .select('*', { count: 'exact' })
      .is('claimed_borrower_id', null)
      .order('ingested_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    return res.json({
      success: true,
      transactions: rows || [],
      total: count || 0,
      page,
      limit,
    });
  } catch (err) {
    console.error('[accounting:unmatched-lipa]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/queues/pending-refs ──────────────────────────────────
router.get('/queues/pending-refs', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data: rows, error, count } = await supabase
      .from('payment_references')
      .select('*', { count: 'exact' })
      .eq('status', 'pending')
      .order('submitted_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    return res.json({
      success: true,
      references: rows || [],
      total: count || 0,
      page,
      limit,
    });
  } catch (err) {
    console.error('[accounting:pending-refs]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/audit-log ────────────────────────────────────────────
router.get('/audit-log', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    const { data: rows, error, count } = await supabase
      .from('accounting_audit_log')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);
    if (error) throw error;

    return res.json({
      success: true,
      entries: rows || [],
      total: count || 0,
      page,
      limit,
    });
  } catch (err) {
    console.error('[accounting:audit-log]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

module.exports = router;
