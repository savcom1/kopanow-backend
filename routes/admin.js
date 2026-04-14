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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/devices
// ─────────────────────────────────────────────────────────────────────────────
router.get('/devices', async (req, res) => {
  try {
    const { status, search, page = 1, limit = 50 } = req.query;

    let query = supabase.from('devices').select('*', { count: 'exact' });
    if (status && status !== 'all') query = query.eq('status', status);
    if (search) {
      query = query.or(
        `borrower_id.ilike.%${search}%,loan_id.ilike.%${search}%,device_model.ilike.%${search}%`
      );
    }

    const from = (parseInt(page) - 1) * parseInt(limit);
    const to   = from + parseInt(limit) - 1;
    const { data: devices, error, count } = await query
      .order('updated_at', { ascending: false })
      .range(from, to);

    if (error) throw error;

    // Join loan data
    const loanIds = [...new Set(devices.map(d => d.loan_id))];
    let loanMap = {};
    if (loanIds.length) {
      const { data: loans } = await supabase.from('loans').select('*').in('loan_id', loanIds);
      loanMap = Object.fromEntries((loans || []).map(l => [l.loan_id, l]));
    }

    const enriched = devices.map(d => ({
      ...d,
      loan: loanMap[d.loan_id] ? {
        outstanding_amount: loanMap[d.loan_id].outstanding_amount,
        next_due_date:      loanMap[d.loan_id].next_due_date,
        days_overdue:       daysOverdue(loanMap[d.loan_id].next_due_date)
      } : null
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

    const [{ data: loan }, { data: tamperLogs }] = await Promise.all([
      supabase.from('loans').select('*').eq('loan_id', device.loan_id).maybeSingle(),
      supabase.from('tamper_logs').select('*')
        .eq('borrower_id', device.borrower_id).eq('loan_id', device.loan_id)
        .order('created_at', { ascending: false }).limit(20)
    ]);

    return res.json({ success: true, device, loan, tamperLogs });
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
    const { device_status, page = 1, limit = 50 } = req.query;
    const from = (parseInt(page) - 1) * parseInt(limit);
    const to   = from + parseInt(limit) - 1;

    let query = supabase.from('loans').select('*', { count: 'exact' });
    if (device_status && device_status !== 'all') query = query.eq('device_status', device_status);

    const { data: loans, error, count } = await query
      .order('next_due_date', { ascending: true, nullsFirst: false })
      .range(from, to);

    if (error) throw error;
    return res.json({ success: true, loans: (loans || []).map(l => ({
      ...l, days_overdue: daysOverdue(l.next_due_date)
    })), total: count || 0, page: parseInt(page) });
  } catch (err) {
    console.error('[admin:loans]', err.message);
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
      case 'LOCK_DEVICE':
        fcmResult   = await sendLockCommand(device.fcm_token, reason, amountStr);
        deviceUpdate = { is_locked: true, lock_reason: reason, amount_due: amountStr, status: 'locked' };
        loanUpdate   = { device_status: 'locked' };
        logType      = EVENT_TYPES.LOCK_SENT;
        break;
      case 'UNLOCK_DEVICE':
        fcmResult   = await sendUnlockCommand(device.fcm_token);
        deviceUpdate = { is_locked: false, lock_reason: null, status: 'active' };
        loanUpdate   = { device_status: 'active' };
        logType      = EVENT_TYPES.UNLOCK_SENT;
        break;
      case 'REMOVE_ADMIN':
        fcmResult   = await sendRemoveAdminCommand(device.fcm_token);
        deviceUpdate = { is_locked: false, status: 'admin_removed' };
        loanUpdate   = { device_status: 'admin_removed' };
        logType      = EVENT_TYPES.ADMIN_REMOVAL_SENT;
        break;
      case 'HEARTBEAT_REQUEST':
        fcmResult = await sendHeartbeatRequest(device.fcm_token);
        logType   = null;
        break;
    }

    deviceUpdate.updated_at = new Date().toISOString();

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
    await supabase.from('devices').update(deviceUpdate).eq('id', device.id);
    if (Object.keys(loanUpdate).length) {
      await supabase.from('loans').update({ ...loanUpdate, updated_at: new Date().toISOString() }).eq('loan_id', device.loan_id);
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

module.exports = router;
