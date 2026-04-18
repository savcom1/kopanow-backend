'use strict';
const express  = require('express');
const router   = express.Router();
const supabase = require('../helpers/supabase');
const { notify, EVENT } = require('../helpers/notify');
const { runPreDueReminders, runOverdueEscalation } = require('../cron/jobs');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/notify/send
//
// Manually send a notification to a specific borrower from the admin panel.
// Body: { borrower_id, loan_id, channel ('sms'|'fcm'|'both'), message, title }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/send', async (req, res) => {
  try {
    const { borrower_id, loan_id, channel = 'both', message, title } = req.body;

    if (!borrower_id || !loan_id || !message) {
      return res.status(400).json({
        success: false,
        error: 'borrower_id, loan_id and message are required'
      });
    }

    // Fetch device
    const { data: device } = await supabase
      .from('devices')
      .select('fcm_token, mpesa_phone')
      .eq('borrower_id', borrower_id)
      .eq('loan_id', loan_id)
      .maybeSingle();

    // Fetch phone from registrations
    const { data: reg } = await supabase
      .from('registrations')
      .select('phone, full_name')
      .eq('borrower_id', borrower_id)
      .maybeSingle();

    const phone = reg?.phone || device?.mpesa_phone || null;

    const result = await notify({
      borrowerId:  borrower_id,
      loanId:      loan_id,
      phone:       channel !== 'fcm' ? phone : null,
      eventType:   EVENT.MANUAL,
      fcmToken:    channel !== 'sms' ? device?.fcm_token : null,
      smsMessage:  channel !== 'fcm' ? `KOPANOW: ${message}` : null,
      pushTitle:   title || 'Kopanow Message',
      pushBody:    message,
      deduplicate: false,  // manual sends always go through
    });

    return res.json({
      success: true,
      smsSent: result.smsSent,
      fcmSent: result.fcmSent,
      phone:   phone || null,
    });
  } catch (err) {
    console.error('[notify:send]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notify/log
//
// Get notification history for a borrower/loan.
// Query: ?loan_id=...&borrower_id=...&limit=50
// ─────────────────────────────────────────────────────────────────────────────
router.get('/log', async (req, res) => {
  try {
    const { loan_id, borrower_id, limit = 100, page = 1 } = req.query;

    const from = (parseInt(page) - 1) * parseInt(limit);
    const to   = from + parseInt(limit) - 1;

    let query = supabase
      .from('notifications_log')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(from, to);

    if (loan_id)     query = query.eq('loan_id', loan_id);
    if (borrower_id) query = query.eq('borrower_id', borrower_id);

    const { data: logs, error, count } = await query;
    if (error) throw error;

    return res.json({ success: true, logs, total: count || 0, page: parseInt(page) });
  } catch (err) {
    console.error('[notify:log]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/notify/run-sweep
//
// Manually trigger the cron sweeps (useful for testing from admin panel).
// Body: { sweep: 'pre_due' | 'overdue' | 'both' }
// ─────────────────────────────────────────────────────────────────────────────
router.post('/run-sweep', async (req, res) => {
  const { sweep = 'both' } = req.body;
  try {
    const results = {};
    if (sweep === 'pre_due' || sweep === 'both') {
      await runPreDueReminders();
      results.pre_due = 'done';
    }
    if (sweep === 'overdue' || sweep === 'both') {
      await runOverdueEscalation();
      results.overdue = 'done';
    }
    return res.json({ success: true, results });
  } catch (err) {
    console.error('[notify:run-sweep]', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/notify/summary
//
// Dashboard summary of notifications sent in the last 24h / 7d.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/summary', async (req, res) => {
  try {
    const h24 = new Date(Date.now() - 86400000).toISOString();
    const d7  = new Date(Date.now() - 7 * 86400000).toISOString();

    const [{ data: last24h }, { data: last7d }] = await Promise.all([
      supabase.from('notifications_log').select('channel, status, event_type').gte('created_at', h24),
      supabase.from('notifications_log').select('channel, status, event_type').gte('created_at', d7),
    ]);

    function summarise(rows) {
      const out = { total: 0, sms: 0, fcm: 0, sent: 0, failed: 0, byEvent: {} };
      for (const r of (rows || [])) {
        out.total++;
        if (r.channel === 'sms') out.sms++;
        else out.fcm++;
        if (r.status === 'sent')   out.sent++;
        else out.failed++;
        out.byEvent[r.event_type] = (out.byEvent[r.event_type] || 0) + 1;
      }
      return out;
    }

    return res.json({
      success: true,
      last_24h: summarise(last24h),
      last_7d:  summarise(last7d),
    });
  } catch (err) {
    console.error('[notify:summary]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
