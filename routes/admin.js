'use strict';
const express  = require('express');
const router   = express.Router();
const supabase = require('../helpers/supabase');
const { logTamper, EVENT_TYPES } = require('../helpers/tamperLog');
const { sendLockCommand, sendUnlockCommand, sendRemoveAdminCommand, sendHeartbeatRequest } = require('../helpers/fcm');

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

const LOAN_DEVICE_STATUSES = new Set([
  'unregistered', 'registered', 'active', 'locked', 'admin_removed', 'suspended',
]);
const INVOICE_STATUSES = new Set(['pending', 'paid', 'overdue']);

/** Sum amount_due for invoices on this loan that are not paid (matches app “remaining balance” logic). */
async function sumUnpaidInvoiceAmounts(loanId) {
  const { data: rows, error } = await supabase
    .from('loan_invoices')
    .select('amount_due, status')
    .eq('loan_id', loanId);
  if (error) throw error;
  return (rows || [])
    .filter((r) => String(r.status || '').toLowerCase().trim() !== 'paid')
    .reduce((s, r) => s + Number(r.amount_due || 0), 0);
}

/** Set loans.outstanding_amount = sum of unpaid invoice amounts (accounting alignment). */
async function reconcileOutstandingFromInvoices(loanId) {
  const sum = await sumUnpaidInvoiceAmounts(loanId);
  const rounded = Math.max(0, Math.round(sum * 100) / 100);
  const { error } = await supabase
    .from('loans')
    .update({ outstanding_amount: rounded, updated_at: new Date().toISOString() })
    .eq('loan_id', loanId);
  if (error) throw error;
  return rounded;
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
router.get('/loans', async (req, res) => {
  try {
    const { device_status, page = 1, limit = 50, search } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);
    const to   = from + parseInt(limit) - 1;

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

    const loanIdList = (loans || []).map(l => l.loan_id);
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
        days_overdue: daysOverdue(l.next_due_date),
        invoice_summary: summarizeInvoiceRows(invByLoan[l.loan_id] || []),
      })),
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
// PATCH /api/admin/accounting/registration/:borrowerId
// Updates registrations row (customer profile). Columns match Supabase schema.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/accounting/registration/:borrowerId', async (req, res) => {
  try {
    const borrowerId = String(req.params.borrowerId || '').trim();
    if (!borrowerId) return res.status(400).json({ success: false, error: 'borrower_id required' });

    const b = req.body || {};
    const payload = {};
    if (b.full_name != null) payload.full_name = String(b.full_name).trim();
    if (b.phone != null) payload.phone = String(b.phone).trim();
    if (b.national_id != null) payload.national_id = String(b.national_id).trim();
    if (b.region != null) payload.region = String(b.region).trim();
    if (b.address != null) payload.address = String(b.address).trim();

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ success: false, error: 'No updatable fields' });
    }

    for (const k of Object.keys(payload)) {
      if (payload[k] === '') {
        return res.status(400).json({ success: false, error: `${k} cannot be empty` });
      }
    }

    const { data, error } = await supabase
      .from('registrations')
      .update(payload)
      .eq('borrower_id', borrowerId)
      .select('borrower_id, full_name, phone, national_id, region, address, updated_at')
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.status(404).json({ success: false, error: 'Registration not found' });

    return res.json({ success: true, registration: data });
  } catch (err) {
    console.error('[admin:accounting:registration]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/accounting/loan/:loanId
// Updates loans row. Optional reconcile_outstanding_from_invoices: true syncs outstanding_amount
// to sum(unpaid invoice amount_due).
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/accounting/loan/:loanId', async (req, res) => {
  try {
    const loanId = String(req.params.loanId || '').trim();
    if (!loanId) return res.status(400).json({ success: false, error: 'loan_id required' });

    const b = req.body || {};
    const payload = {};

    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    if (b.principal_amount != null) {
      const n = num(b.principal_amount);
      if (n == null) return res.status(400).json({ success: false, error: 'principal_amount invalid' });
      payload.principal_amount = n;
    }
    if (b.outstanding_amount != null) {
      const n = num(b.outstanding_amount);
      if (n == null) return res.status(400).json({ success: false, error: 'outstanding_amount invalid' });
      payload.outstanding_amount = Math.max(0, n);
    }
    if (b.interest_amount != null) {
      const n = num(b.interest_amount);
      if (n == null) return res.status(400).json({ success: false, error: 'interest_amount invalid' });
      payload.interest_amount = Math.max(0, n);
    }
    if (b.installment_weeks != null) {
      const w = parseInt(b.installment_weeks, 10);
      if (!Number.isFinite(w) || w < 1) {
        return res.status(400).json({ success: false, error: 'installment_weeks must be a positive integer' });
      }
      payload.installment_weeks = w;
    }
    if (b.total_repayment_amount != null) {
      const n = num(b.total_repayment_amount);
      if (n == null) return res.status(400).json({ success: false, error: 'total_repayment_amount invalid' });
      payload.total_repayment_amount = Math.max(0, n);
    }
    if (b.weekly_installment_amount != null) {
      const n = num(b.weekly_installment_amount);
      if (n == null) return res.status(400).json({ success: false, error: 'weekly_installment_amount invalid' });
      payload.weekly_installment_amount = Math.max(0, n);
    }
    if (b.loan_schedule_start != null) {
      const t = String(b.loan_schedule_start).trim();
      payload.loan_schedule_start = t ? new Date(t).toISOString() : null;
    }
    if (b.next_due_date != null) {
      const t = String(b.next_due_date).trim();
      payload.next_due_date = t ? new Date(t).toISOString() : null;
    }
    if (b.disbursed_at != null) {
      const t = String(b.disbursed_at).trim();
      payload.disbursed_at = t ? new Date(t).toISOString() : null;
    }
    if (b.device_status != null) {
      const ds = String(b.device_status).trim();
      if (!LOAN_DEVICE_STATUSES.has(ds)) {
        return res.status(400).json({ success: false, error: `device_status must be one of: ${[...LOAN_DEVICE_STATUSES].join(', ')}` });
      }
      payload.device_status = ds;
    }

    const doReconcile = b.reconcile_outstanding_from_invoices === true;

    if (!doReconcile && Object.keys(payload).length === 0) {
      return res.status(400).json({ success: false, error: 'No updatable fields' });
    }

    if (Object.keys(payload).length > 0) {
      payload.updated_at = new Date().toISOString();
      const { error } = await supabase.from('loans').update(payload).eq('loan_id', loanId);
      if (error) throw error;
    }

    if (doReconcile) {
      await reconcileOutstandingFromInvoices(loanId);
    }

    const { data: loan, error: fetchErr } = await supabase.from('loans').select('*').eq('loan_id', loanId).maybeSingle();
    if (fetchErr) throw fetchErr;

    return res.json({ success: true, loan, reconciled_outstanding: doReconcile });
  } catch (err) {
    console.error('[admin:accounting:loan]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/accounting/loan/:loanId/reconcile-outstanding
// Sets loans.outstanding_amount = sum of unpaid loan_invoices.amount_due
// ─────────────────────────────────────────────────────────────────────────────
router.post('/accounting/loan/:loanId/reconcile-outstanding', async (req, res) => {
  try {
    const loanId = String(req.params.loanId || '').trim();
    if (!loanId) return res.status(400).json({ success: false, error: 'loan_id required' });

    const rounded = await reconcileOutstandingFromInvoices(loanId);
    const { data: loan, error } = await supabase.from('loans').select('*').eq('loan_id', loanId).maybeSingle();
    if (error) throw error;

    return res.json({ success: true, loan, outstanding_amount: rounded });
  } catch (err) {
    console.error('[admin:accounting:reconcile]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/admin/accounting/invoice/:invoiceId  (invoiceId = UUID)
// Updates loan_invoices row. After update, optional reconcile_loan_outstanding syncs loans row.
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/accounting/invoice/:invoiceId', async (req, res) => {
  try {
    const invoiceId = String(req.params.invoiceId || '').trim();
    if (!invoiceId) return res.status(400).json({ success: false, error: 'invoice id required' });

    const b = req.body || {};
    const payload = {};

    if (b.invoice_number != null) payload.invoice_number = String(b.invoice_number).trim();
    if (b.installment_index != null) {
      const ix = parseInt(b.installment_index, 10);
      if (!Number.isFinite(ix) || ix < 0) {
        return res.status(400).json({ success: false, error: 'installment_index invalid' });
      }
      payload.installment_index = ix;
    }
    if (b.borrower_name != null) payload.borrower_name = String(b.borrower_name).trim() || null;
    if (b.amount_due != null) {
      const n = Number(b.amount_due);
      if (!Number.isFinite(n) || n < 0) {
        return res.status(400).json({ success: false, error: 'amount_due invalid' });
      }
      payload.amount_due = n;
    }
    if (b.due_date != null) {
      const t = String(b.due_date).trim();
      payload.due_date = t ? new Date(t).toISOString() : null;
    }
    if (b.status != null) {
      const st = String(b.status).trim().toLowerCase();
      if (!INVOICE_STATUSES.has(st)) {
        return res.status(400).json({ success: false, error: `status must be one of: ${[...INVOICE_STATUSES].join(', ')}` });
      }
      payload.status = st;
      if (st === 'paid') {
        const t = b.paid_at != null && String(b.paid_at).trim();
        payload.paid_at = t ? new Date(t).toISOString() : new Date().toISOString();
      } else {
        payload.paid_at = null;
      }
    } else if (b.paid_at !== undefined) {
      const t = String(b.paid_at || '').trim();
      payload.paid_at = t ? new Date(t).toISOString() : null;
    }

    if (Object.keys(payload).length === 0) {
      return res.status(400).json({ success: false, error: 'No updatable fields' });
    }

    payload.updated_at = new Date().toISOString();

    const { data: before, error: e0 } = await supabase
      .from('loan_invoices')
      .select('loan_id')
      .eq('id', invoiceId)
      .maybeSingle();
    if (e0) throw e0;
    if (!before) return res.status(404).json({ success: false, error: 'Invoice not found' });

    const { data: row, error } = await supabase
      .from('loan_invoices')
      .update(payload)
      .eq('id', invoiceId)
      .select('*')
      .maybeSingle();

    if (error) throw error;
    if (!row) return res.status(404).json({ success: false, error: 'Invoice update failed' });

    let loan = null;
    if (b.reconcile_loan_outstanding !== false) {
      await reconcileOutstandingFromInvoices(row.loan_id);
      const { data: l } = await supabase.from('loans').select('*').eq('loan_id', row.loan_id).maybeSingle();
      loan = l;
    }

    return res.json({ success: true, invoice: row, loan });
  } catch (err) {
    console.error('[admin:accounting:invoice]', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
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

module.exports = router;
