'use strict';
const express  = require('express');
const router   = express.Router();
const supabase = require('../helpers/supabase');
const { logTamper, EVENT_TYPES } = require('../helpers/tamperLog');
const { sendLockCommand, sendUnlockCommand, sendRemoveAdminCommand, sendHeartbeatRequest } = require('../helpers/fcm');
const {
  applyVerifiedMpesaAmount,
  validateTxAmountForLoan,
  attemptAutoMatchIncomingLipa,
} = require('../helpers/lipaPayment');

// ── Helper: compute days overdue ─────────────────────────────────────────────
function daysOverdue(nextDueDate) {
  if (!nextDueDate) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(nextDueDate).getTime()) / 86400000));
}

/** PostgREST `in.(...)` values for Supabase `.or()` filters */
function quoteBorrowerIdsForInFilter(ids) {
  return ids.map((id) => {
    const s = String(id);
    return /^[a-zA-Z0-9_-]+$/.test(s) ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
}

/** PostgREST `in.(...)` values for Supabase `.or()` filters */
function quoteLoanIdsForInFilter(ids) {
  return ids.map((id) => {
    const s = String(id);
    return /^[a-zA-Z0-9_-]+$/.test(s) ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  });
}

/** Roll up loan_invoices rows for list views (counts + next unpaid due). */
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

async function fetchCompletedDisbursementLoanIdsSet(loanIds) {
  if (!loanIds?.length) return new Set();
  const { data, error } = await supabase
    .from('cash_disbursement_queue')
    .select('loan_id')
    .eq('status', 'completed')
    .in('loan_id', loanIds);
  if (error) throw error;
  return new Set((data || []).map((r) => r.loan_id).filter(Boolean));
}

async function fetchQueueLoanIdsByStatus(status, opts = {}) {
  const st = String(status || '').toLowerCase();
  if (st !== 'pending' && st !== 'completed') return [];
  let q = supabase
    .from('cash_disbursement_queue')
    .select('loan_id, updated_at')
    .eq('status', st)
    .limit(50000);
  if (opts.updatedAfterIso) q = q.gte('updated_at', opts.updatedAfterIso);
  const { data, error } = await q;
  if (error) throw error;
  return [...new Set((data || []).map((r) => r.loan_id).filter(Boolean))];
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/devices
// ─────────────────────────────────────────────────────────────────────────────
router.get('/devices', async (req, res) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;

    let query = supabase.from('devices').select('*', { count: 'exact' });
    if (status && status !== 'all') query = query.eq('status', status);

    const qRaw = search != null ? String(search).trim() : '';
    if (qRaw) {
      const q = qRaw.replace(/,/g, '');
      // Borrower display name lives on registrations — resolve name matches to borrower_ids
      // so the main query can include those devices alongside id/loan/device text matches.
      const { data: nameRows } = await supabase
        .from('registrations')
        .select('borrower_id')
        .ilike('full_name', `%${q}%`);
      const nameBorrowerIds = [...new Set((nameRows || []).map((r) => r.borrower_id).filter(Boolean))];

      const orParts = [
        `borrower_id.ilike.%${q}%`,
        `loan_id.ilike.%${q}%`,
        `device_model.ilike.%${q}%`,
        `device_id.ilike.%${q}%`,
      ];
      if (nameBorrowerIds.length) {
        orParts.push(`borrower_id.in.(${quoteBorrowerIdsForInFilter(nameBorrowerIds).join(',')})`);
      }
      query = query.or(orParts.join(','));
    }

    const from = (parseInt(page) - 1) * parseInt(limit);
    const to   = from + parseInt(limit) - 1;
    const { data: devices, error, count } = await query
      .order('updated_at', { ascending: false })
      .range(from, to);

    if (error) throw error;

    const borrowerIds = [...new Set((devices || []).map((d) => d.borrower_id).filter(Boolean))];
    let nameByBorrower = {};
    if (borrowerIds.length) {
      const { data: regs } = await supabase
        .from('registrations')
        .select('borrower_id, full_name')
        .in('borrower_id', borrowerIds);
      nameByBorrower = Object.fromEntries((regs || []).map((r) => [r.borrower_id, r.full_name]));
    }

    // Join loan data + per-loan invoice summary (status counts)
    const loanIds = [...new Set(devices.map(d => d.loan_id))];
    let loanMap = {};
    if (loanIds.length) {
      const { data: loans } = await supabase.from('loans').select('*').in('loan_id', loanIds);
      loanMap = Object.fromEntries((loans || []).map(l => [l.loan_id, l]));
    }
    const completedLoanIds = await fetchCompletedDisbursementLoanIdsSet(loanIds);

    let invByLoan = {};
    if (loanIds.length) {
      const { data: invRows } = await supabase
        .from('loan_invoices')
        .select('loan_id, status, due_date')
        .in('loan_id', loanIds);
      for (const r of invRows || []) {
        if (!invByLoan[r.loan_id]) invByLoan[r.loan_id] = [];
        invByLoan[r.loan_id].push(r);
      }
    }

    const enriched = devices.map(d => ({
      ...d,
      is_customer: completedLoanIds.has(d.loan_id),
      borrower_full_name: nameByBorrower[d.borrower_id] || null,
      loan: loanMap[d.loan_id]
        ? {
            ...loanMap[d.loan_id],
            days_overdue: daysOverdue(loanMap[d.loan_id].next_due_date),
            invoice_summary: summarizeInvoiceRows(invByLoan[d.loan_id] || []),
          }
        : null,
    }));

    // KPI summary
    const { data: all } = await supabase.from('devices').select('status');
    const summary = { total: count || 0, active: 0, locked: 0, registered: 0, admin_removed: 0, suspended: 0 };
    (all || []).forEach(d => { if (d.status in summary) summary[d.status]++; });

    return res.json({ success: true, summary, devices: enriched, page: parseInt(page), total: count || 0 });
  } catch (err) {
    console.error('[admin:devices]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/devices/:id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/devices/:id', async (req, res) => {
  try {
    const { data: device, error } = await supabase.from('devices').select('*').eq('id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    const [
      { data: loan },
      { data: tamperLogs },
      { data: registration },
      { data: invoices },
    ] = await Promise.all([
      supabase.from('loans').select('*').eq('loan_id', device.loan_id).maybeSingle(),
      supabase.from('tamper_logs').select('*')
        .eq('borrower_id', device.borrower_id).eq('loan_id', device.loan_id)
        .order('created_at', { ascending: false }).limit(20),
      supabase.from('registrations').select('*').eq('borrower_id', device.borrower_id).maybeSingle(),
      supabase.from('loan_invoices').select('*').eq('loan_id', device.loan_id)
        .order('installment_index', { ascending: true }),
    ]);

    const invoice_summary = summarizeInvoiceRows(invoices || []);

    return res.json({
      success: true,
      device,
      loan,
      registration: registration || null,
      invoices: invoices || [],
      invoice_summary,
      tamperLogs,
    });
  } catch (err) {
    console.error('[admin:device-detail]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/tamper-logs
// ─────────────────────────────────────────────────────────────────────────────
router.get('/tamper-logs', async (req, res) => {
  try {
    const { severity, reviewed, page = 1, limit = 100 } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);
    const to   = from + parseInt(limit) - 1;

    let query = supabase.from('tamper_logs').select('*', { count: 'exact' });
    if (severity && severity !== 'all') query = query.eq('severity', severity);
    if (reviewed !== undefined) query = query.eq('reviewed', reviewed === 'true');

    const { data: logs, error, count } = await query
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;
    return res.json({ success: true, logs, total: count || 0, page: parseInt(page) });
  } catch (err) {
    console.error('[admin:tamper-logs]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/loans
// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/disbursement-summary — pending cashier confirmation count
router.get('/disbursement-summary', async (req, res) => {
  try {
    const startUtc = new Date();
    startUtc.setUTCHours(0, 0, 0, 0);
    const startIso = startUtc.toISOString();

    const { count: pending, error: e1 } = await supabase
      .from('cash_disbursement_queue')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');
    if (e1) throw e1;

    const { count: confirmedToday, error: e2 } = await supabase
      .from('cash_disbursement_queue')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('updated_at', startIso);
    if (e2) throw e2;

    return res.json({
      success: true,
      pending_cash_disbursement: pending || 0,
      confirmed_today_count: confirmedToday || 0,
    });
  } catch (err) {
    console.error('[admin:disbursement-summary]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// Optional KPI: split pending cashout into ready vs needs setup
router.get('/stage-summary', async (req, res) => {
  try {
    const startUtc = new Date();
    startUtc.setUTCHours(0, 0, 0, 0);
    const startIso = startUtc.toISOString();

    const pendingLoanIds = await fetchQueueLoanIdsByStatus('pending');
    let readyLoanIds = new Set();
    if (pendingLoanIds.length) {
      const { data: readyRows, error: rErr } = await supabase
        .from('devices')
        .select('loan_id')
        .in('loan_id', pendingLoanIds)
        .not('protection_first_completed_at', 'is', null)
        .limit(50000);
      if (rErr) throw rErr;
      readyLoanIds = new Set((readyRows || []).map((r) => r.loan_id).filter(Boolean));
    }

    const pending_cashout_ready_count = pendingLoanIds.filter((id) => readyLoanIds.has(id)).length;
    const pending_cashout_not_ready_count = pendingLoanIds.length - pending_cashout_ready_count;

    const { count: cashoutSentToday, error: cErr } = await supabase
      .from('cash_disbursement_queue')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'completed')
      .gte('updated_at', startIso);
    if (cErr) throw cErr;

    return res.json({
      success: true,
      pending_cashout_ready_count,
      pending_cashout_not_ready_count,
      cashout_sent_today_count: cashoutSentToday || 0,
    });
  } catch (err) {
    console.error('[admin:stage-summary]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

router.get('/loans', async (req, res) => {
  try {
    const { device_status, page = 1, limit = 50, search, disbursement, protection } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);
    const to   = from + parseInt(limit) - 1;

    let query = supabase.from('loans').select('*', { count: 'exact' });
    if (device_status && device_status !== 'all') query = query.eq('device_status', device_status);
    const disb = disbursement != null ? String(disbursement).toLowerCase() : 'all';
    if (disb === 'pending' || disb === 'confirmed') {
      const wantCompleted = disb === 'confirmed';
      const loanIds = await fetchQueueLoanIdsByStatus(wantCompleted ? 'completed' : 'pending');
      if (!loanIds.length) {
        return res.json({ success: true, loans: [], total: 0, page: parseInt(page) });
      }
      query = query.in('loan_id', loanIds);
    }

    // protection filter: Customer = cash disbursement confirmed; Applicant = not yet (legacy query param name)
    const prot = protection != null ? String(protection).toLowerCase() : 'all';
    if (
      prot === 'customers' || prot === 'applicants' ||
      prot === 'complete' || prot === 'incomplete'
    ) {
      const wantCustomers = prot === 'customers' || prot === 'complete';
      const completedLoanIds = await fetchQueueLoanIdsByStatus('completed');
      if (!completedLoanIds.length) {
        if (wantCustomers) return res.json({ success: true, loans: [], total: 0, page: parseInt(page) });
      } else if (wantCustomers) {
        query = query.in('loan_id', completedLoanIds);
      } else {
        query = query.not('loan_id', 'in', `(${quoteLoanIdsForInFilter(completedLoanIds).join(',')})`);
      }
    }

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

    const loanIdList = (loans || []).map(l => l.loan_id);
    const completedLoanIds = await fetchCompletedDisbursementLoanIdsSet(loanIdList);
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

    // devices: mdm_compliance = current MDM snapshot; is_customer = cash disbursement confirmed on loan
    let deviceByLoan = {};
    if (loanIdList.length) {
      const { data: devices, error: dErr } = await supabase
        .from('devices')
        .select('loan_id, mdm_compliance, protection_first_completed_at')
        .in('loan_id', loanIdList);
      if (dErr) throw dErr;
      deviceByLoan = Object.fromEntries((devices || []).map((d) => [d.loan_id, d]));
    }

    return res.json({
      success: true,
      loans: (loans || []).map((l) => {
        const dev = deviceByLoan[l.loan_id];
        const mdm = dev?.mdm_compliance;
        return {
        is_customer: completedLoanIds.has(l.loan_id),
        protection_all_required_ok:
          (mdm && typeof mdm === 'object' && mdm.all_required_ok === true) || false,
        ...l,
        borrower_full_name: loanNameByBorrower[l.borrower_id] || null,
        days_overdue: daysOverdue(l.next_due_date),
        invoice_summary: summarizeInvoiceRows(invByLoan[l.loan_id] || []),
      };
      }),
      total: count || 0,
      page: parseInt(page),
    });
  } catch (err) {
    console.error('[admin:loans]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/loans/:loanId/invoices
// Full installment list + registration snippet (for admin tools / refresh).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/loans/:loanId/invoices', async (req, res) => {
  try {
    const loanId = req.params.loanId;
    const { data: loan, error: loanErr } = await supabase
      .from('loans')
      .select('loan_id, borrower_id, principal_amount, outstanding_amount, installment_weeks, total_repayment_amount, weekly_installment_amount, loan_schedule_start, next_due_date')
      .eq('loan_id', loanId)
      .maybeSingle();
    if (loanErr) throw loanErr;
    if (!loan) return res.status(404).json({ success: false, error: 'Loan not found' });

    const [{ data: invoices, error: invErr }, { data: registration }] = await Promise.all([
      supabase.from('loan_invoices').select('*').eq('loan_id', loanId).order('installment_index', { ascending: true }),
      supabase.from('registrations').select('full_name, phone, national_id, region, address').eq('borrower_id', loan.borrower_id).maybeSingle(),
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
    console.error('[admin:loan-invoices]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/loans/:loanId/approve-disbursement
// Explicitly allow disbursement queueing when tamper state blocks it.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/loans/:loanId/approve-disbursement', async (req, res) => {
  try {
    const loanId = String(req.params.loanId || '').trim();
    const actor = req.body?.actor != null ? String(req.body.actor).trim() : '';
    const reason = req.body?.reason != null ? String(req.body.reason).trim() : '';

    if (!loanId) return res.status(400).json({ success: false, error: 'loanId is required' });
    if (!actor) return res.status(400).json({ success: false, error: 'actor is required' });
    if (!reason) return res.status(400).json({ success: false, error: 'reason is required' });

    const nowIso = new Date().toISOString();

    const [{ data: loan, error: loanErr }, { data: queueRow, error: qPeekErr }] = await Promise.all([
      supabase
        .from('loans')
        .select('loan_id, borrower_id, cash_disbursement_confirmed_at, repaid_at, outstanding_amount, principal_amount')
        .eq('loan_id', loanId)
        .maybeSingle(),
      supabase
        .from('cash_disbursement_queue')
        .select('loan_id, status')
        .eq('loan_id', loanId)
        .maybeSingle(),
    ]);
    if (loanErr) throw loanErr;
    if (qPeekErr) throw qPeekErr;
    if (!loan) return res.status(404).json({ success: false, error: 'Loan not found' });

    if (queueRow?.status === 'completed') {
      return res.status(409).json({ success: false, error: 'Loan already completed in cash_disbursement_queue' });
    }

    const eligible =
      !loan.cash_disbursement_confirmed_at &&
      !loan.repaid_at &&
      Number(loan.outstanding_amount) > 0;
    if (!eligible) {
      return res.status(409).json({ success: false, error: 'Loan is not eligible for disbursement queueing' });
    }

    const { data: device, error: devErr } = await supabase
      .from('devices')
      .select('*')
      .eq('loan_id', loanId)
      .eq('borrower_id', loan.borrower_id)
      .maybeSingle();
    if (devErr) throw devErr;
    if (!device) return res.status(404).json({ success: false, error: 'Device not found for loan' });

    const { data: regRow, error: regErr } = await supabase
      .from('registrations')
      .select('phone')
      .eq('borrower_id', loan.borrower_id)
      .maybeSingle();
    if (regErr) throw regErr;
    const phoneRaw =
      (regRow?.phone && String(regRow.phone).trim()) ||
      (device.mpesa_phone && String(device.mpesa_phone).trim()) ||
      '';
    const phone = phoneRaw ? phoneRaw : null;

    const { error: updErr } = await supabase
      .from('devices')
      .update({
        disbursement_admin_override_at: nowIso,
        disbursement_admin_override_by: actor,
        disbursement_blocked_at: null,
        disbursement_block_reason: null,
        updated_at: nowIso,
      })
      .eq('id', device.id);
    if (updErr) throw updErr;

    const principalAmount =
      loan?.principal_amount != null ? Number(loan.principal_amount) : null;

    const { error: upsertErr } = await supabase
      .from('cash_disbursement_queue')
      .upsert(
        {
          loan_id: loanId,
          borrower_id: loan.borrower_id,
          enqueued_at: nowIso,
          status: 'pending',
          phone,
          principal_amount: principalAmount,
        },
        { onConflict: 'loan_id' },
      );
    if (upsertErr) throw upsertErr;

    await logTamper(loan.borrower_id, loanId, EVENT_TYPES.MANUAL_FLAG, {
      source: 'ops',
      device_id: device.device_id,
      auto_action: 'APPROVE_DISBURSEMENT',
      detail: `Admin disbursement approval: actor=${actor}; reason=${reason}`,
    });

    return res.json({ success: true, loan_id: loanId, borrower_id: loan.borrower_id, enqueued: true });
  } catch (err) {
    console.error('[admin:approve-disbursement]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/command
// ─────────────────────────────────────────────────────────────────────────────
router.post('/command', async (req, res) => {
  try {
    const { device_id, command, lock_reason, amount_due } = req.body;
    if (!device_id || !command) {
      return res.status(400).json({ success: false, error: 'device_id and command are required' });
    }
    const VALID = ['LOCK_DEVICE', 'UNLOCK_DEVICE', 'REMOVE_ADMIN', 'HEARTBEAT_REQUEST'];
    if (!VALID.includes(command)) {
      return res.status(400).json({ success: false, error: `Invalid command. Must be: ${VALID.join(', ')}` });
    }

    const { data: device, error } = await supabase.from('devices').select('*').eq('id', device_id).maybeSingle();
    if (error) throw error;
    if (!device)           return res.status(404).json({ success: false, error: 'Device not found' });
    if (!device.fcm_token) return res.status(400).json({ success: false, error: 'Device has no FCM token' });

    const { data: loan } = await supabase.from('loans').select('outstanding_amount').eq('loan_id', device.loan_id).maybeSingle();
    const amountStr = amount_due || (loan ? `TSh ${Number(loan.outstanding_amount).toLocaleString()}` : '');
    const reason    = lock_reason || device.lock_reason || 'Admin action';

    let fcmResult, logType, deviceUpdate = {}, loanUpdate = {};

    switch (command) {
      case 'LOCK_DEVICE': {
        const lockType = req.body.lock_type || 'PAYMENT';
        fcmResult   = await sendLockCommand(device.fcm_token, reason, amountStr, lockType);
        deviceUpdate = {
          is_locked: true, lock_reason: reason, amount_due: amountStr,
          lock_type: lockType, status: 'locked'
        };
        loanUpdate   = { device_status: 'locked' };
        logType      = EVENT_TYPES.LOCK_SENT;
        break;
      }
      case 'UNLOCK_DEVICE':
        fcmResult   = await sendUnlockCommand(device.fcm_token);
        // Fully wipe ALL lock-related fields so the admin modal shows clean state
        deviceUpdate = {
          is_locked:       false,
          lock_reason:     null,
          amount_due:      null,
          lock_type:       'PAYMENT',   // reset to default
          passcode_active: false,       // clear any active PIN session
          status:          'active'
        };
        loanUpdate   = { device_status: 'active' };
        logType      = EVENT_TYPES.UNLOCK_SENT;
        break;
      case 'REMOVE_ADMIN':
        fcmResult   = await sendRemoveAdminCommand(device.fcm_token);
        deviceUpdate = {
          is_locked:       false,
          lock_reason:     null,
          amount_due:      null,
          lock_type:       'PAYMENT',
          passcode_active: false,
          status:          'admin_removed'
        };
        loanUpdate   = { device_status: 'admin_removed' };
        logType      = EVENT_TYPES.ADMIN_REMOVAL_SENT;
        break;
      case 'HEARTBEAT_REQUEST':
        fcmResult = await sendHeartbeatRequest(device.fcm_token);
        logType   = null;
        break;
    }

    deviceUpdate.updated_at = new Date().toISOString();

    const persistCommandToDb = async () => {
      await supabase.from('devices').update(deviceUpdate).eq('id', device.id);
      if (Object.keys(loanUpdate).length) {
        await supabase.from('loans').update({ ...loanUpdate, updated_at: new Date().toISOString() }).eq('loan_id', device.loan_id);
      }
    };

    // UNLOCK / REMOVE_ADMIN: always persist dashboard state so devices + loans show Active / Removed
    // even when FCM fails (token invalid, Firebase down). Push is best-effort; DB is ops truth.
    const persistRegardlessOfFcm = command === 'UNLOCK_DEVICE' || command === 'REMOVE_ADMIN';

    if (persistRegardlessOfFcm && Object.keys(deviceUpdate).length) {
      await persistCommandToDb();
    }

    // ── Short-circuit on invalid / fake tokens ────────────────────────────────
    if (fcmResult && !fcmResult.success) {
      // Auto-clear stale (expired) tokens so the dashboard shows the device needs re-enrollment
      if (fcmResult.staleToken) {
        await supabase.from('devices')
          .update({ fcm_token: null, updated_at: new Date().toISOString() })
          .eq('id', device.id);
        return res.status(400).json({
          success: false,
          command,
          error: fcmResult.error,
          hint: 'FCM token cleared. Ask the borrower to open the Kopanow app — it will auto-refresh the token.'
        });
      }
      // Fake token (seed data) or Firebase not ready — return clear message, don't update DB
      if (fcmResult.fakeToken || command !== 'LOCK_DEVICE') {
        return res.status(400).json({ success: false, command, error: fcmResult.error });
      }
    }

    // Update device + loan state in DB (command was sent or is a lock we persist regardless)
    if (!persistRegardlessOfFcm) {
      await persistCommandToDb();
    }

    if (logType) {
      await logTamper(device.borrower_id, device.loan_id, logType, {
        source: 'ops', device_id: device.device_id, auto_action: command,
        detail: 'Manual command from admin dashboard'
      });
    }

    return res.json({ success: fcmResult?.success ?? true, command, messageId: fcmResult?.messageId, error: fcmResult?.error });
  } catch (err) {
    console.error('[admin:command]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/tamper-logs/:id/review
// ─────────────────────────────────────────────────────────────────────────────
router.post('/tamper-logs/:id/review', async (req, res) => {
  try {
    const { error } = await supabase.from('tamper_logs').update({
      reviewed: true, reviewed_at: new Date().toISOString(),
      reviewed_by: req.body.reviewed_by || 'admin'
    }).eq('id', req.params.id);
    if (error) throw error;
    return res.json({ success: true });
  } catch (err) {
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/seed  (DEV ONLY)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/seed', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'Seed not available in production' });
  }
  try {
    const now = Date.now();
    const seeds = [
      {
        loan: { loan_id:'loan_001', borrower_id:'borrower_001', principal_amount:10000, outstanding_amount:4500,
                interest_amount:500, disbursed_at:new Date(now-30*86400000), next_due_date:new Date(now-7*86400000),
                days_overdue:7, device_status:'locked' },
        device: { borrower_id:'borrower_001', loan_id:'loan_001', device_id:'androidid_abc123',
                  fcm_token:'fcm_test_001', device_model:'Samsung Galaxy A52', status:'locked',
                  dpc_active:true, is_locked:true, lock_reason:'7 days overdue', amount_due:'TSh 4,500',
                  mpesa_phone:'254712345678', last_seen:new Date(now-2*3600000) }
      },
      {
        loan: { loan_id:'loan_002', borrower_id:'borrower_002', principal_amount:5000, outstanding_amount:2000,
                interest_amount:200, disbursed_at:new Date(now-15*86400000), next_due_date:new Date(now+5*86400000),
                days_overdue:0, device_status:'active' },
        device: { borrower_id:'borrower_002', loan_id:'loan_002', device_id:'androidid_xyz789',
                  fcm_token:'fcm_test_002', device_model:'Xiaomi Redmi Note 10', status:'active',
                  dpc_active:true, is_locked:false, mpesa_phone:'254798765432', last_seen:new Date(now-30*60000) }
      },
      {
        loan: { loan_id:'loan_003', borrower_id:'borrower_003', principal_amount:8000, outstanding_amount:8000,
                interest_amount:800, disbursed_at:new Date(now-2*86400000), next_due_date:new Date(now+28*86400000),
                days_overdue:0, device_status:'registered' },
        device: { borrower_id:'borrower_003', loan_id:'loan_003', device_id:null, fcm_token:null,
                  device_model:'Tecno Spark 8', status:'registered', dpc_active:false, is_locked:false }
      },
      {
        loan: { loan_id:'loan_004', borrower_id:'borrower_004', principal_amount:3000, outstanding_amount:0,
                interest_amount:150, disbursed_at:new Date(now-60*86400000), next_due_date:new Date(now-5*86400000),
                repaid_at:new Date(now-86400000), days_overdue:0, device_status:'admin_removed' },
        device: { borrower_id:'borrower_004', loan_id:'loan_004', device_id:'androidid_pqr345',
                  fcm_token:'fcm_test_004', device_model:'Tecno Camon 19', status:'admin_removed',
                  dpc_active:false, is_locked:false, last_seen:new Date(now-24*3600000) }
      }
    ];

    for (const { loan, device } of seeds) {
      await supabase.from('loans').upsert(loan, { onConflict: 'loan_id' });
      await supabase.from('devices').upsert(device, { onConflict: 'borrower_id,loan_id' });
    }
    return res.json({ success: true, message: `Seeded ${seeds.length} loan+device pairs` });
  } catch (err) {
    console.error('[admin:seed]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/admin/seed  — clear test data
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/seed', async (req, res) => {
  if (process.env.NODE_ENV === 'production') {
    return res.status(403).json({ success: false, error: 'Not available in production' });
  }
  const ids = ['loan_001','loan_002','loan_003','loan_004'];
  await supabase.from('devices').delete().in('loan_id', ids);
  await supabase.from('loans').delete().in('loan_id', ids);
  return res.json({ success: true, message: 'Seed data cleared' });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/lipa-transactions  — list + search (SMS / till ingest)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/lipa-transactions', async (req, res) => {
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
          `till_contract_name.ilike.${pat}`,
          `payer_display_name.ilike.${pat}`,
          `lipa_channel.ilike.${pat}`,
        ].join(',')
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
    console.error('[admin:lipa-transactions]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/lipa-transactions/:id/retry-match  — phone auto-match (SMS flow)
// ─────────────────────────────────────────────────────────────────────────────
router.post('/lipa-transactions/:id/retry-match', async (req, res) => {
  try {
    const { data: tx, error } = await supabase
      .from('lipa_transactions')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!tx) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (tx.claimed_borrower_id) {
      return res.status(409).json({ success: false, error: 'Already claimed / applied' });
    }

    const result = await attemptAutoMatchIncomingLipa(tx);
    return res.json({ success: true, match: result });
  } catch (err) {
    console.error('[admin:lipa-retry-match]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/lipa-transactions/:id/confirm  — manual apply to borrower + loan
// ─────────────────────────────────────────────────────────────────────────────
router.post('/lipa-transactions/:id/confirm', async (req, res) => {
  try {
    const borrower_id = req.body?.borrower_id != null ? String(req.body.borrower_id).trim() : '';
    const loan_id = req.body?.loan_id != null ? String(req.body.loan_id).trim() : '';
    if (!borrower_id || !loan_id) {
      return res.status(400).json({ success: false, error: 'borrower_id and loan_id are required' });
    }

    const { data: tx, error } = await supabase
      .from('lipa_transactions')
      .select('*')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!tx) return res.status(404).json({ success: false, error: 'Transaction not found' });
    if (tx.claimed_borrower_id) {
      return res.status(409).json({ success: false, error: 'This Lipa row is already linked to a loan' });
    }

    const ref = tx.transaction_ref.toString().trim().toUpperCase();
    const { ok, reason } = await validateTxAmountForLoan(loan_id, tx.amount);
    if (!ok) return res.status(400).json({ success: false, error: reason || 'Amount validation failed' });

    const result = await applyVerifiedMpesaAmount({
      borrower_id,
      loan_id,
      mpesa_ref: ref,
      amount: tx.amount,
      verified_by: 'admin_lipa_confirm',
      reviewer_note: 'Confirmed from admin Lipa transactions view',
      payment_reference_id: null,
      raw_callback: { source: 'admin_lipa_confirm', lipa_id: tx.id },
    });

    await supabase.from('lipa_transactions').update({
      claimed_borrower_id: borrower_id,
      claimed_loan_id: loan_id,
      claimed_at: new Date().toISOString(),
      payment_reference_id: null,
    }).eq('id', tx.id);

    return res.json({ success: true, result });
  } catch (err) {
    console.error('[admin:lipa-confirm]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

module.exports = router;
