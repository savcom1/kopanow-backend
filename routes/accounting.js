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

/** When false (default), portfolio reports only include cashier-confirmed loans. */
function includeIncompleteLoans(req) {
  const v = req.query.include_incomplete;
  return v === '1' || v === 'true' || v === 'yes';
}

async function fetchConfirmedLoanIdsSet() {
  const { data, error } = await supabase
    .from('loans')
    .select('loan_id')
    .not('cash_disbursement_confirmed_at', 'is', null)
    .limit(50000);
  if (error) throw error;
  return new Set((data || []).map((r) => r.loan_id));
}

// ── Borrower app: loan application (no auth — same as /api/loan/* when server mounts it) ──
// Mounted here so Render deployments that only wire /api/accounting still accept registrations.
const loanRouter = require('./loan');
router.use('/loan', loanRouter);

// ── GET /api/accounting/health (no auth — load balancers) ───────────────────
router.get('/health', (req, res) => {
  res.json({ ok: true, module: 'accounting' });
});

router.use(requireAccountingAuth);

// ── GET /api/accounting/borrowers/lookup-for-purge ──────────────────────────
// Search registrations directly (no confirmed-loan filter).
router.get('/borrowers/lookup-for-purge', async (req, res) => {
  try {
    const qRaw = req.query.search != null ? String(req.query.search).trim() : '';
    const q = qRaw.replace(/,/g, '');
    if (q.length < 2) {
      return res.status(400).json({ success: false, error: 'search must be at least 2 characters' });
    }

    const { data: rows, error } = await supabase
      .from('registrations')
      .select('borrower_id, full_name, phone, national_id, region, created_at')
      .or(
        [
          `borrower_id.ilike.%${q}%`,
          `full_name.ilike.%${q}%`,
          `phone.ilike.%${q}%`,
          `national_id.ilike.%${q}%`,
        ].join(','),
      )
      .order('created_at', { ascending: false })
      .limit(50);
    if (error) throw error;

    return res.json({ success: true, matches: rows || [] });
  } catch (err) {
    console.error('[accounting:lookup-for-purge]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/borrowers ────────────────────────────────────────────
// Only borrowers with at least one loan where cash disbursement was confirmed (principal sent).
router.get('/borrowers', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const qRaw = req.query.search != null ? String(req.query.search).trim() : '';
    const from = (page - 1) * limit;

    const { data: loanRows, error: loanErr } = await supabase
      .from('loans')
      .select('borrower_id, cash_disbursement_confirmed_at')
      .not('cash_disbursement_confirmed_at', 'is', null)
      .order('cash_disbursement_confirmed_at', { ascending: false })
      .limit(5000);
    if (loanErr) throw loanErr;

    const seen = new Set();
    const orderedBorrowerIds = [];
    for (const row of loanRows || []) {
      const bid = row.borrower_id;
      if (!bid || seen.has(bid)) continue;
      seen.add(bid);
      orderedBorrowerIds.push(bid);
    }

    const customerSet = new Set(orderedBorrowerIds);
    const orderIndex = new Map(orderedBorrowerIds.map((id, i) => [id, i]));
    let candidateIds = orderedBorrowerIds;
    if (qRaw) {
      const q = qRaw.replace(/,/g, '');
      const { data: nameRows, error: sErr } = await supabase
        .from('registrations')
        .select('borrower_id')
        .or(
          [
            `borrower_id.ilike.%${q}%`,
            `full_name.ilike.%${q}%`,
            `phone.ilike.%${q}%`,
            `national_id.ilike.%${q}%`,
          ].join(','),
        );
      if (sErr) throw sErr;
      const matched = [
        ...new Set(
          (nameRows || [])
            .map((r) => r.borrower_id)
            .filter((id) => id && customerSet.has(id)),
        ),
      ];
      matched.sort((a, b) => (orderIndex.get(a) - orderIndex.get(b)));
      candidateIds = matched;
    }

    const total = candidateIds.length;
    const pageIds = candidateIds.slice(from, from + limit);
    if (!pageIds.length) {
      return res.json({ success: true, borrowers: [], total: 0, page, limit });
    }

    const { data: rows, error } = await supabase
      .from('registrations')
      .select('*')
      .in('borrower_id', pageIds);
    if (error) throw error;

    const byId = Object.fromEntries((rows || []).map((r) => [r.borrower_id, r]));
    const borrowers = pageIds.map((id) => byId[id]).filter(Boolean);

    return res.json({
      success: true,
      borrowers,
      total,
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

function isMissingRelationError(err, relationName) {
  const msg = String(err?.message || '');
  if (String(err?.code || '') === '42P01') return true;
  return relationName ? msg.toLowerCase().includes(`relation "${relationName}" does not exist`) : msg.toLowerCase().includes('does not exist');
}

async function safeDeleteIfTableExists(tableName, whereFn) {
  try {
    const q = supabase.from(tableName).delete();
    const res = await whereFn(q);
    if (res?.error) throw res.error;
    return { ok: true };
  } catch (err) {
    if (isMissingRelationError(err, tableName)) return { ok: true, skipped: true, skipped_reason: 'missing_table' };
    throw err;
  }
}

// ── POST /api/accounting/borrowers/:borrowerId/purge ─────────────────────────
router.post('/borrowers/:borrowerId/purge', async (req, res) => {
  try {
    const borrowerId = String(req.params.borrowerId || '').trim();
    const actor = req.body?.actor != null ? String(req.body.actor).trim() : '';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    const confirmBorrowerId = req.body?.confirm_borrower_id != null ? String(req.body.confirm_borrower_id).trim() : '';

    if (!borrowerId) return res.status(400).json({ success: false, error: 'borrowerId is required' });
    if (!actor) return res.status(400).json({ success: false, error: 'actor is required' });
    if (!reason) return res.status(400).json({ success: false, error: 'reason is required' });
    if (confirmBorrowerId !== borrowerId) {
      return res.status(400).json({ success: false, error: 'confirm_borrower_id must exactly match borrowerId' });
    }

    const { data: reg, error: rErr } = await supabase
      .from('registrations')
      .select('*')
      .eq('borrower_id', borrowerId)
      .maybeSingle();
    if (rErr) throw rErr;
    if (!reg) return res.status(404).json({ success: false, error: 'Borrower not found' });

    const { data: loans, error: lErr } = await supabase
      .from('loans')
      .select('loan_id, borrower_id, principal_amount, outstanding_amount, disbursed_at, cash_disbursement_confirmed_at')
      .eq('borrower_id', borrowerId);
    if (lErr) throw lErr;

    const loanIds = [...new Set((loans || []).map((l) => l.loan_id).filter(Boolean))];

    const snapshot = {
      borrower_id: borrowerId,
      registration: {
        full_name: reg.full_name,
        phone: reg.phone,
        national_id: reg.national_id,
        region: reg.region,
        address: reg.address,
        created_at: reg.created_at,
      },
      loans: (loans || []).map((l) => ({
        loan_id: l.loan_id,
        principal_amount: l.principal_amount,
        outstanding_amount: l.outstanding_amount,
        disbursed_at: l.disbursed_at,
        cash_disbursement_confirmed_at: l.cash_disbursement_confirmed_at,
      })),
    };

    await logAccountingAudit({
      actor,
      entity_type: 'borrower',
      entity_id: borrowerId,
      action: 'borrower_purge_start',
      before: snapshot,
      after: null,
      reason,
    });

    // Children first. For optional tables, treat missing relation as a skip.
    await safeDeleteIfTableExists('contract_acceptances', (q) => q.eq('borrower_id', borrowerId));

    await safeDeleteIfTableExists('payment_references', (q) => q.eq('borrower_id', borrowerId));

    if (loanIds.length) {
      await safeDeleteIfTableExists('payments', (q) => q.in('loan_id', loanIds));
    } else {
      await safeDeleteIfTableExists('payments', (q) => q.eq('borrower_id', borrowerId));
    }

    await safeDeleteIfTableExists('notifications_log', (q) => q.eq('borrower_id', borrowerId));
    await safeDeleteIfTableExists('tamper_logs', (q) => q.eq('borrower_id', borrowerId));

    if (loanIds.length) {
      await safeDeleteIfTableExists('loan_invoices', (q) => q.in('loan_id', loanIds));
      await safeDeleteIfTableExists('cash_disbursement_queue', (q) => q.in('loan_id', loanIds));
      await safeDeleteIfTableExists('loan_requests', (q) => q.in('loan_id', loanIds));
    } else {
      await safeDeleteIfTableExists('loan_invoices', (q) => q.eq('borrower_id', borrowerId));
      await safeDeleteIfTableExists('cash_disbursement_queue', (q) => q.eq('borrower_id', borrowerId));
      await safeDeleteIfTableExists('loan_requests', (q) => q.eq('borrower_id', borrowerId));
    }

    await safeDeleteIfTableExists('devices', (q) => q.eq('borrower_id', borrowerId));

    // Preserve raw till/SMS history: unclaim links to the borrower/loan.
    const { error: unclaimErr } = await supabase
      .from('lipa_transactions')
      .update({
        claimed_borrower_id: null,
        claimed_loan_id: null,
        claimed_at: null,
        payment_reference_id: null,
      })
      .eq('claimed_borrower_id', borrowerId);
    if (unclaimErr) throw unclaimErr;

    await safeDeleteIfTableExists('loans', (q) => q.eq('borrower_id', borrowerId));
    await safeDeleteIfTableExists('registrations', (q) => q.eq('borrower_id', borrowerId));

    await logAccountingAudit({
      actor,
      entity_type: 'borrower',
      entity_id: borrowerId,
      action: 'borrower_purge_complete',
      before: snapshot,
      after: { borrower_id: borrowerId, purged_loan_ids: loanIds, loans_count: loanIds.length },
      reason,
    });

    return res.json({ success: true, borrower_id: borrowerId, purged_loan_ids: loanIds });
  } catch (err) {
    console.error('[accounting:purge-borrower]', err.message);
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

// ── GET /api/accounting/loans/pending-disbursement (before :loanId route) ───
router.get('/loans/pending-disbursement', async (req, res) => {
  try {
    const { data: queueRows, error: qErr } = await supabase
      .from('cash_disbursement_queue')
      .select('loan_id, borrower_id, enqueued_at, phone, principal_amount')
      .eq('status', 'pending')
      .order('enqueued_at', { ascending: true })
      .limit(500);
    if (qErr) throw qErr;

    const loanIds = [...new Set((queueRows || []).map((r) => r.loan_id).filter(Boolean))];
    if (!loanIds.length) {
      return res.json({ success: true, stage: 'customers', loans: [], count: 0 });
    }

    const { data: loans, error } = await supabase
      .from('loans')
      .select('*')
      .in('loan_id', loanIds)
      .is('cash_disbursement_confirmed_at', null)
      .is('repaid_at', null)
      .gt('outstanding_amount', 0);
    if (error) throw error;

    const loanById = Object.fromEntries((loans || []).map((l) => [l.loan_id, l]));
    const orderedLoans = [];
    for (const q of queueRows || []) {
      const l = loanById[q.loan_id];
      if (l) orderedLoans.push({ loan: l, queue: q });
    }

    const outLoanIds = orderedLoans.map((x) => x.loan.loan_id);
    let deviceByLoan = {};
    if (outLoanIds.length) {
      const { data: devices, error: dErr } = await supabase
        .from('devices')
        .select('loan_id, mdm_compliance, protection_first_completed_at')
        .in('loan_id', outLoanIds);
      if (dErr) throw dErr;
      deviceByLoan = Object.fromEntries((devices || []).map((d) => [d.loan_id, d]));
    }

    const borrowerIds = [...new Set(orderedLoans.map((x) => x.loan.borrower_id).filter(Boolean))];
    let nameByBorrower = {};
    if (borrowerIds.length) {
      const { data: regs } = await supabase
        .from('registrations')
        .select('borrower_id, full_name, phone')
        .in('borrower_id', borrowerIds);
      nameByBorrower = Object.fromEntries((regs || []).map((r) => [r.borrower_id, r]));
    }

    const enriched = orderedLoans.map(({ loan: l, queue: q }) => {
      const dev = deviceByLoan[l.loan_id] || null;
      const mdm = dev?.mdm_compliance && typeof dev.mdm_compliance === 'object' ? dev.mdm_compliance : null;
      const allOk = mdm?.all_required_ok === true;
      const okCount = Number.isFinite(mdm?.ok_count) ? Number(mdm.ok_count) : null;
      const requiredCount = Number.isFinite(mdm?.required_count) ? Number(mdm.required_count) : null;
      return {
        ...l,
        borrower_full_name: nameByBorrower[l.borrower_id]?.full_name || null,
        borrower_phone: nameByBorrower[l.borrower_id]?.phone || null,
        queue_phone: q.phone != null ? String(q.phone) : null,
        queue_principal_amount: q.principal_amount != null ? Number(q.principal_amount) : null,
        queue_enqueued_at: q.enqueued_at || null,
        is_customer: !!dev?.protection_first_completed_at,
        protection_all_required_ok: allOk,
        protection_ok_count: okCount,
        protection_required_count: requiredCount,
      };
    });

    return res.json({
      success: true,
      stage: 'customers',
      loans: enriched,
      count: enriched.length,
    });
  } catch (err) {
    console.error('[accounting:pending-disbursement]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/confirm-cash-disbursement ─────────────
router.post('/loans/:loanId/confirm-cash-disbursement', async (req, res) => {
  try {
    const loanId = req.params.loanId;
    const actor = req.body?.actor != null ? String(req.body.actor).trim() : '';
    const notes = req.body?.notes != null ? String(req.body.notes).trim() : '';
    if (!actor) {
      return res.status(400).json({ success: false, error: 'actor is required' });
    }

    const { data: before, error: bErr } = await supabase
      .from('loans')
      .select('*')
      .eq('loan_id', loanId)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!before) return res.status(404).json({ success: false, error: 'Loan not found' });

    if (before.cash_disbursement_confirmed_at) {
      await supabase
        .from('cash_disbursement_queue')
        .update({ status: 'completed', updated_at: new Date().toISOString() })
        .eq('loan_id', loanId)
        .eq('status', 'pending');
      return res.json({ success: true, loan: before, idempotent: true });
    }

    const ts = new Date().toISOString();
    const patch = {
      cash_disbursement_confirmed_at: ts,
      cash_disbursement_confirmed_by: actor.slice(0, 200),
      cash_disbursement_notes: notes || null,
      updated_at: ts,
    };
    if (!before.disbursed_at) patch.disbursed_at = ts;

    const { data: after, error: uErr } = await supabase
      .from('loans')
      .update(patch)
      .eq('loan_id', loanId)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan',
      entity_id: loanId,
      action: 'cash_disbursement_confirm',
      before,
      after,
      reason: notes || 'Cash disbursement confirmed (principal sent to borrower)',
    });

    await supabase
      .from('cash_disbursement_queue')
      .update({ status: 'completed', updated_at: ts })
      .eq('loan_id', loanId)
      .eq('status', 'pending');

    return res.json({ success: true, loan: after });
  } catch (err) {
    console.error('[accounting:confirm-disbursement]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
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

// ── POST /api/accounting/loans/:loanId/invoices/:invoiceId/adjust-fields ──────
router.post('/loans/:loanId/invoices/:invoiceId/adjust-fields', async (req, res) => {
  try {
    const { loanId, invoiceId } = req.params;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }

    const patch = {};
    if (req.body?.amount_due !== undefined) {
      const raw = req.body?.amount_due;
      if (raw === null || Number.isNaN(Number(raw))) {
        return res.status(400).json({ success: false, error: 'amount_due must be a number' });
      }
      const v = Number(raw);
      if (v < 0) return res.status(400).json({ success: false, error: 'amount_due must be >= 0' });
      patch.amount_due = v;
    }
    if (req.body?.due_date !== undefined) {
      const raw = req.body?.due_date;
      const d = new Date(raw);
      if (!raw || Number.isNaN(d.getTime())) {
        return res.status(400).json({ success: false, error: 'due_date must be a valid date string' });
      }
      patch.due_date = d.toISOString();
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ success: false, error: 'Provide amount_due and/or due_date' });
    }
    patch.updated_at = new Date().toISOString();

    const { data: inv, error: iErr } = await supabase
      .from('loan_invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('loan_id', loanId)
      .maybeSingle();
    if (iErr) throw iErr;
    if (!inv) return res.status(404).json({ success: false, error: 'Invoice not found for this loan' });

    const before = { ...inv };
    const { data: after, error: uErr } = await supabase
      .from('loan_invoices')
      .update(patch)
      .eq('id', inv.id)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan_invoice',
      entity_id: invoiceId,
      action: 'adjust_invoice_fields',
      before,
      after,
      reason,
    });

    return res.json({ success: true, invoice: after });
  } catch (err) {
    console.error('[accounting:invoice-adjust-fields]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/invoices/:invoiceId/delete ─────────────
router.post('/loans/:loanId/invoices/:invoiceId/delete', async (req, res) => {
  try {
    const { loanId, invoiceId } = req.params;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
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
    const { error: dErr } = await supabase.from('loan_invoices').delete().eq('id', inv.id);
    if (dErr) throw dErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan_invoice',
      entity_id: invoiceId,
      action: 'delete_invoice',
      before,
      after: null,
      reason,
    });

    return res.json({ success: true, deleted: true });
  } catch (err) {
    console.error('[accounting:invoice-delete]', err.message);
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

// ── POST /api/accounting/loans/:loanId/adjust-principal ───────────────────────
router.post('/loans/:loanId/adjust-principal', async (req, res) => {
  try {
    const loanId = req.params.loanId;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }
    const raw = req.body?.principal_amount;
    if (raw === undefined || raw === null || Number.isNaN(Number(raw))) {
      return res.status(400).json({ success: false, error: 'principal_amount (number) is required' });
    }
    const principal_amount = Number(raw);
    if (principal_amount < 0) {
      return res.status(400).json({ success: false, error: 'principal_amount must be >= 0' });
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
        principal_amount,
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
      action: 'adjust_principal',
      before,
      after,
      reason,
    });

    return res.json({ success: true, loan: after });
  } catch (err) {
    console.error('[accounting:principal-adjust]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── POST /api/accounting/loans/:loanId/adjust (principal/outstanding) ─────────
router.post('/loans/:loanId/adjust', async (req, res) => {
  try {
    const loanId = req.params.loanId;
    const actor = req.body?.actor || req.headers['x-actor'] || 'accounting';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';
    if (!reason) {
      return res.status(400).json({ success: false, error: 'reason is required' });
    }

    const patch = {};
    if (req.body?.principal_amount !== undefined) {
      const raw = req.body?.principal_amount;
      if (raw === null || Number.isNaN(Number(raw))) {
        return res.status(400).json({ success: false, error: 'principal_amount must be a number' });
      }
      const v = Number(raw);
      if (v < 0) return res.status(400).json({ success: false, error: 'principal_amount must be >= 0' });
      patch.principal_amount = v;
    }
    if (req.body?.outstanding_amount !== undefined) {
      const raw = req.body?.outstanding_amount;
      if (raw === null || Number.isNaN(Number(raw))) {
        return res.status(400).json({ success: false, error: 'outstanding_amount must be a number' });
      }
      const v = Number(raw);
      if (v < 0) return res.status(400).json({ success: false, error: 'outstanding_amount must be >= 0' });
      patch.outstanding_amount = v;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ success: false, error: 'Provide principal_amount and/or outstanding_amount' });
    }

    const { data: before, error: bErr } = await supabase
      .from('loans')
      .select('*')
      .eq('loan_id', loanId)
      .maybeSingle();
    if (bErr) throw bErr;
    if (!before) return res.status(404).json({ success: false, error: 'Loan not found' });

    patch.updated_at = new Date().toISOString();
    const { data: after, error: uErr } = await supabase
      .from('loans')
      .update(patch)
      .eq('loan_id', loanId)
      .select()
      .single();
    if (uErr) throw uErr;

    await logAccountingAudit({
      actor,
      entity_type: 'loan',
      entity_id: loanId,
      action: 'adjust_loan_fields',
      before,
      after,
      reason,
    });

    return res.json({ success: true, loan: after });
  } catch (err) {
    console.error('[accounting:loan-adjust]', err.message);
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
    let lipaOnCompleteLoans = 0;
    let confirmedSet = new Set();
    try {
      confirmedSet = await fetchConfirmedLoanIdsSet();
    } catch (_) {
      /* columns may not exist before migration */
    }
    for (const r of list) {
      totalAmount += Number(r.amount) || 0;
      if (r.claimed_borrower_id) claimedCount++;
      else unclaimedCount++;
      const lid = r.claimed_loan_id != null ? String(r.claimed_loan_id) : '';
      if (lid && confirmedSet.has(lid)) lipaOnCompleteLoans += Number(r.amount) || 0;
    }

    const summary = {
      basis: 'lipa_transactions.ingested_at',
      from,
      to,
      row_count: list.length,
      total_amount: Math.round(totalAmount * 100) / 100,
      lipa_amount_on_complete_loans: Math.round(lipaOnCompleteLoans * 100) / 100,
      note:
        'total_amount is all ingested Lipa; lipa_amount_on_complete_loans sums rows whose claimed_loan_id has cashier confirmation (complete book).',
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

    return res.json({
      success: true,
      summary,
      rows: list,
      definition: { complete_loans_only_metric: 'lipa_amount_on_complete_loans' },
    });
  } catch (err) {
    console.error('[accounting:collections]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/reports/aging ────────────────────────────────────────
router.get('/reports/aging', async (req, res) => {
  try {
    const format = String(req.query.format || 'json').toLowerCase();
    const incAll = includeIncompleteLoans(req);
    const { data: invoices, error } = await supabase
      .from('loan_invoices')
      .select('id, loan_id, borrower_id, invoice_number, amount_due, due_date, status')
      .in('status', ['pending', 'overdue']);
    if (error) throw error;

    let invList = invoices || [];
    if (!incAll) {
      const confirmedSet = await fetchConfirmedLoanIdsSet();
      invList = invList.filter((inv) => confirmedSet.has(inv.loan_id));
    }

    const now = Date.now();
    const dayMs = 86400000;
    const buckets = {
      upcoming: { label: 'Not yet due', amount: 0, count: 0 },
      days_1_30: { label: '1–30 days past due', amount: 0, count: 0 },
      days_31_60: { label: '31–60 days past due', amount: 0, count: 0 },
      days_61_90: { label: '61–90 days past due', amount: 0, count: 0 },
      days_90_plus: { label: '90+ days past due', amount: 0, count: 0 },
    };

    for (const inv of invList) {
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
      definition: {
        complete_loans_only: !incAll,
        include_incomplete: incAll,
      },
      buckets,
      total_receivable: Math.round(totalReceivable * 100) / 100,
    });
  } catch (err) {
    console.error('[accounting:aging]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

/**
 * PAR (Portfolio at Risk): balance-weighted % of gross portfolio with worst unpaid installment
 * at least N days past due (as of `asOf`). Numerator = full loans.outstanding_amount for those loans.
 * Denominator = sum(outstanding_amount) for all loans with outstanding_amount > 0.
 */
// ── GET /api/accounting/reports/par?asOf=ISO ───────────────────────────────
router.get('/reports/par', async (req, res) => {
  try {
    const incAll = includeIncompleteLoans(req);
    const asOfRaw = req.query.asOf != null ? String(req.query.asOf).trim() : '';
    const asOf = asOfRaw ? new Date(asOfRaw) : new Date();
    if (Number.isNaN(asOf.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid asOf date' });
    }
    const asOfMs = asOf.getTime();
    const dayMs = 86400000;

    let loanQuery = supabase
      .from('loans')
      .select('loan_id, borrower_id, outstanding_amount, device_status')
      .gt('outstanding_amount', 0);
    if (!incAll) {
      loanQuery = loanQuery.not('cash_disbursement_confirmed_at', 'is', null);
    }
    const { data: loans, error: le } = await loanQuery;
    if (le) throw le;

    const { data: invs, error: ie } = await supabase
      .from('loan_invoices')
      .select('loan_id, due_date, status')
      .in('status', ['pending', 'overdue']);
    if (ie) throw ie;

    const loanIdSet = new Set((loans || []).map((l) => l.loan_id));
    /** @type {Map<string, number>} max calendar days past due for any unpaid installment */
    const loanMaxDaysPast = new Map();
    for (const inv of invs || []) {
      if (!incAll && !loanIdSet.has(inv.loan_id)) continue;
      const due = new Date(inv.due_date).getTime();
      if (due >= asOfMs) continue;
      const daysPast = Math.floor((asOfMs - due) / dayMs);
      const cur = loanMaxDaysPast.get(inv.loan_id) || 0;
      loanMaxDaysPast.set(inv.loan_id, Math.max(cur, daysPast));
    }

    let portfolioGross = 0;
    let balancePar1 = 0;
    let balancePar30 = 0;
    let balancePar90 = 0;
    const loanIdsPar30 = [];

    for (const l of loans || []) {
      const o = Number(l.outstanding_amount) || 0;
      if (o <= 0) continue;
      portfolioGross += o;
      const maxD = loanMaxDaysPast.get(l.loan_id) || 0;
      if (maxD >= 1) balancePar1 += o;
      if (maxD >= 30) {
        balancePar30 += o;
        loanIdsPar30.push(l.loan_id);
      }
      if (maxD >= 90) balancePar90 += o;
    }

    const pct = (num, den) => (den > 0 ? Math.round((num / den) * 10000) / 100 : 0);

    return res.json({
      success: true,
      as_of: asOf.toISOString(),
      definition: {
        complete_loans_only: !incAll,
        include_incomplete: incAll,
        denominator:
          incAll
            ? 'Sum of loans.outstanding_amount for all loans with outstanding_amount > 0.'
            : 'Same, but only loans with cash_disbursement_confirmed_at set (cashier sent principal).',
        numerator:
          'For each such loan, max days past due = longest delay among pending/overdue installments with due_date < asOf. If max >= N, add full loan outstanding to PARn balance.',
        par_pct: 'PARn balance / denominator * 100',
      },
      portfolio_gross_outstanding: Math.round(portfolioGross * 100) / 100,
      par: {
        par1: { balance: Math.round(balancePar1 * 100) / 100, pct: pct(balancePar1, portfolioGross) },
        par30: { balance: Math.round(balancePar30 * 100) / 100, pct: pct(balancePar30, portfolioGross) },
        par90: { balance: Math.round(balancePar90 * 100) / 100, pct: pct(balancePar90, portfolioGross) },
      },
      loan_count_in_par30: loanIdsPar30.length,
    });
  } catch (err) {
    console.error('[accounting:par]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

/**
 * Expected = sum(amount_due) for installments with due_date in [from,to].
 * Actual = sum(lipa_transactions.amount) with ingested_at in [from,to] (borrower cash-in truth).
 * Per-loan: expected from invoices; actual from Lipa rows with claimed_loan_id.
 */
// ── GET /api/accounting/reports/expected-vs-actual ─────────────────────────
router.get('/reports/expected-vs-actual', async (req, res) => {
  try {
    const incAll = includeIncompleteLoans(req);
    const from = req.query.from ? new Date(req.query.from).toISOString() : null;
    const to = req.query.to ? new Date(req.query.to).toISOString() : null;
    if (!from || !to || Number.isNaN(new Date(from).getTime()) || Number.isNaN(new Date(to).getTime())) {
      return res.status(400).json({ success: false, error: 'from and to (ISO dates) are required' });
    }
    const format = String(req.query.format || 'json').toLowerCase();

    const confirmedSet = incAll ? null : await fetchConfirmedLoanIdsSet();

    const { data: invs, error: ie } = await supabase
      .from('loan_invoices')
      .select('loan_id, borrower_id, amount_due, due_date, status, installment_index')
      .gte('due_date', from)
      .lte('due_date', to)
      .limit(100000);
    if (ie) throw ie;

    let expectedTotal = 0;
    const expectedByLoan = new Map();
    for (const inv of invs || []) {
      if (!incAll && !confirmedSet.has(inv.loan_id)) continue;
      const a = Number(inv.amount_due) || 0;
      expectedTotal += a;
      const lid = inv.loan_id;
      expectedByLoan.set(lid, (expectedByLoan.get(lid) || 0) + a);
    }

    const { data: lipaRows, error: le } = await supabase
      .from('lipa_transactions')
      .select('amount, claimed_loan_id, ingested_at, transaction_ref')
      .gte('ingested_at', from)
      .lte('ingested_at', to)
      .limit(50000);
    if (le) throw le;

    let actualTotal = 0;
    const actualByLoan = new Map();
    for (const row of lipaRows || []) {
      const lid = row.claimed_loan_id;
      if (!incAll && lid && !confirmedSet.has(lid)) continue;
      const a = Number(row.amount) || 0;
      actualTotal += a;
      if (lid) {
        actualByLoan.set(lid, (actualByLoan.get(lid) || 0) + a);
      }
    }

    const allLoanIds = new Set([...expectedByLoan.keys(), ...actualByLoan.keys()]);
    const perLoan = [];
    for (const loanId of allLoanIds) {
      const exp = expectedByLoan.get(loanId) || 0;
      const act = actualByLoan.get(loanId) || 0;
      perLoan.push({
        loan_id: loanId,
        expected_due_in_period: Math.round(exp * 100) / 100,
        lipa_claimed_in_period: Math.round(act * 100) / 100,
        shortfall: Math.round((exp - act) * 100) / 100,
      });
    }
    perLoan.sort((a, b) => Math.abs(b.shortfall) - Math.abs(a.shortfall));

    const summary = {
      complete_loans_only: !incAll,
      basis_expected: 'loan_invoices.due_date in [from,to] (installments scheduled in period)',
      basis_actual: 'lipa_transactions.ingested_at in [from,to]; amounts summed by claimed_loan_id',
      from,
      to,
      expected_total: Math.round(expectedTotal * 100) / 100,
      lipa_cash_total: Math.round(actualTotal * 100) / 100,
      portfolio_shortfall: Math.round((expectedTotal - actualTotal) * 100) / 100,
    };

    if (format === 'csv') {
      const lines = [
        toCsvRow(['loan_id', 'expected_due_in_period', 'lipa_claimed_in_period', 'shortfall']),
      ];
      for (const r of perLoan) {
        lines.push(toCsvRow([r.loan_id, r.expected_due_in_period, r.lipa_claimed_in_period, r.shortfall]));
      }
      lines.push(toCsvRow(['TOTAL', summary.expected_total, summary.lipa_cash_total, summary.portfolio_shortfall]));
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="expected-vs-actual.csv"');
      return res.send(lines.join('\n'));
    }

    return res.json({
      success: true,
      summary,
      per_loan: perLoan,
      definition: { complete_loans_only: !incAll, include_incomplete: incAll },
    });
  } catch (err) {
    console.error('[accounting:expected-vs-actual]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/reports/disbursements?from=&to=&format= ─────────────
router.get('/reports/disbursements', async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from).toISOString() : null;
    const to = req.query.to ? new Date(req.query.to).toISOString() : null;
    if (!from || !to) {
      return res.status(400).json({ success: false, error: 'from and to (ISO dates) are required' });
    }
    const format = String(req.query.format || 'json').toLowerCase();

    const { data: rows, error } = await supabase
      .from('loans')
      .select('loan_id, borrower_id, principal_amount, outstanding_amount, disbursed_at, device_status')
      .not('disbursed_at', 'is', null)
      .gte('disbursed_at', from)
      .lte('disbursed_at', to)
      .order('disbursed_at', { ascending: false })
      .limit(10000);
    if (error) throw error;

    const list = rows || [];
    let principalSum = 0;
    for (const r of list) principalSum += Number(r.principal_amount) || 0;

    if (format === 'csv') {
      const header = toCsvRow(['disbursed_at', 'loan_id', 'borrower_id', 'principal_amount', 'outstanding_amount', 'device_status']);
      const lines = [header];
      for (const r of list) {
        lines.push(
          toCsvRow([
            r.disbursed_at,
            r.loan_id,
            r.borrower_id,
            r.principal_amount,
            r.outstanding_amount,
            r.device_status,
          ]),
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="disbursements.csv"');
      return res.send(lines.join('\n'));
    }

    return res.json({
      success: true,
      from,
      to,
      count: list.length,
      principal_total: Math.round(principalSum * 100) / 100,
      loans: list,
    });
  } catch (err) {
    console.error('[accounting:disbursements]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ── GET /api/accounting/reports/maturity?withinDays=30 ──────────────────────
router.get('/reports/maturity', async (req, res) => {
  try {
    const incAll = includeIncompleteLoans(req);
    const withinDays = Math.min(365, Math.max(1, parseInt(req.query.withinDays, 10) || 30));
    const format = String(req.query.format || 'json').toLowerCase();
    const now = new Date();
    const end = new Date(now.getTime() + withinDays * 86400000);

    const { data: invs, error } = await supabase
      .from('loan_invoices')
      .select('loan_id, borrower_id, installment_index, amount_due, due_date, status, invoice_number')
      .in('status', ['pending', 'overdue'])
      .gte('due_date', now.toISOString())
      .lte('due_date', end.toISOString())
      .order('due_date', { ascending: true })
      .limit(10000);
    if (error) throw error;

    let list = invs || [];
    if (!incAll) {
      const confirmedSet = await fetchConfirmedLoanIdsSet();
      list = list.filter((inv) => confirmedSet.has(inv.loan_id));
    }
    if (format === 'csv') {
      const header = toCsvRow(['due_date', 'loan_id', 'borrower_id', 'installment_index', 'amount_due', 'status', 'invoice_number']);
      const lines = [header];
      for (const r of list) {
        lines.push(
          toCsvRow([
            r.due_date,
            r.loan_id,
            r.borrower_id,
            r.installment_index,
            r.amount_due,
            r.status,
            r.invoice_number,
          ]),
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="maturity-upcoming-installments.csv"');
      return res.send(lines.join('\n'));
    }

    let amountSum = 0;
    for (const r of list) amountSum += Number(r.amount_due) || 0;

    return res.json({
      success: true,
      definition: { complete_loans_only: !incAll, include_incomplete: incAll },
      within_days: withinDays,
      window_end: end.toISOString(),
      installment_count: list.length,
      amount_due_total: Math.round(amountSum * 100) / 100,
      installments: list,
    });
  } catch (err) {
    console.error('[accounting:maturity]', err.message);
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
