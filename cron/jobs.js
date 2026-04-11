'use strict';
const cron     = require('node-cron');
const supabase = require('../helpers/supabase');
const { logTamper, EVENT_TYPES } = require('../helpers/tamperLog');
const { sendLockCommand, sendHeartbeatRequest } = require('../helpers/fcm');

// ─────────────────────────────────────────────────────────────────────────────
// Cron 1 — Overdue check  (daily at midnight EAT, which is UTC+3)
//
// Day 1, 3, 5 → warning via FCM (no lock)
// Day 7+      → LOCK_DEVICE
// ─────────────────────────────────────────────────────────────────────────────
async function runOverdueCheck() {
  console.log('[cron:overdue] Starting overdue sweep…');
  try {
    const now = new Date();

    // Fetch all active/registered loans that are past due
    const { data: loans, error } = await supabase
      .from('loans')
      .select('*')
      .lt('next_due_date', now.toISOString())
      .gt('outstanding_amount', 0)
      .in('device_status', ['active', 'registered', 'locked']);

    if (error) throw error;

    let warned = 0, locked = 0;

    for (const loan of loans || []) {
      const daysLate = Math.floor((now - new Date(loan.next_due_date)) / 86400000);

      const { data: device } = await supabase
        .from('devices')
        .select('id, fcm_token, is_locked, status, amount_due')
        .eq('loan_id', loan.loan_id)
        .maybeSingle();

      if (!device?.fcm_token) continue;

      const amountStr = `KES ${Number(loan.outstanding_amount).toLocaleString()}`;

      if (daysLate >= 7 && !device.is_locked) {
        // Lock the device
        await sendLockCommand(device.fcm_token, `${daysLate} days overdue`, amountStr);
        await supabase.from('devices').update({
          is_locked: true, status: 'locked',
          lock_reason: `${daysLate} days overdue`,
          amount_due: amountStr, updated_at: new Date().toISOString()
        }).eq('id', device.id);
        await supabase.from('loans').update({
          device_status: 'locked', days_overdue: daysLate, updated_at: new Date().toISOString()
        }).eq('loan_id', loan.loan_id);
        await logTamper(loan.borrower_id, loan.loan_id, EVENT_TYPES.LOCK_SENT, {
          source: 'cron', detail: `Day ${daysLate} overdue — auto-lock`, auto_action: 'LOCK_DEVICE'
        });
        locked++;

      } else if ([1, 3, 5].includes(daysLate)) {
        // Warning nudge via heartbeat request
        await sendHeartbeatRequest(device.fcm_token);
        await supabase.from('loans').update({
          days_overdue: daysLate, updated_at: new Date().toISOString()
        }).eq('loan_id', loan.loan_id);
        console.log(`[cron:overdue] Warning Day ${daysLate}: borrower=${loan.borrower_id}`);
        warned++;

      } else {
        // Just update days_overdue count
        await supabase.from('loans').update({
          days_overdue: daysLate, updated_at: new Date().toISOString()
        }).eq('loan_id', loan.loan_id);
      }
    }

    console.log(`[cron:overdue] Done — warned=${warned} locked=${locked}`);
  } catch (err) {
    console.error('[cron:overdue] Error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron 2 — Heartbeat monitor  (every 6 hours)
//
// Device silent >25h  → nudge via FCM HEARTBEAT_REQUEST
// Device silent >48h  → HEARTBEAT_MISSING CRITICAL (Scenario 2 — possible factory reset)
// ─────────────────────────────────────────────────────────────────────────────
async function runHeartbeatMonitor() {
  console.log('[cron:heartbeat-monitor] Starting…');
  try {
    const now        = Date.now();
    const h25ago     = new Date(now - 25 * 3600000).toISOString();
    const h48ago     = new Date(now - 48 * 3600000).toISOString();

    // Devices that have been silent — enrolled (have fcm_token) but not seen recently
    const { data: devices, error } = await supabase
      .from('devices')
      .select('id, borrower_id, loan_id, fcm_token, last_seen, status')
      .not('fcm_token', 'is', null)
      .lt('last_seen', h25ago)
      .in('status', ['active', 'locked', 'registered']);

    if (error) throw error;

    let nudged = 0, critical = 0;

    for (const device of devices || []) {
      const silentMs   = now - new Date(device.last_seen || 0).getTime();
      const silentHrs  = Math.floor(silentMs / 3600000);

      if (silentMs > 48 * 3600000) {
        // Critical — possible factory reset (Scenario 2)
        await logTamper(device.borrower_id, device.loan_id, EVENT_TYPES.HEARTBEAT_MISSING, {
          source: 'cron',
          detail: `Device silent for ${silentHrs}h — possible factory reset (Scenario 2)`,
          auto_action: 'HEARTBEAT_REQUEST'
        });
        await sendHeartbeatRequest(device.fcm_token);
        console.warn(`[cron:heartbeat-monitor] CRITICAL ${silentHrs}h silent: borrower=${device.borrower_id}`);
        critical++;
      } else {
        // Nudge only
        await sendHeartbeatRequest(device.fcm_token);
        console.log(`[cron:heartbeat-monitor] Nudge (${silentHrs}h silent): borrower=${device.borrower_id}`);
        nudged++;
      }
    }

    console.log(`[cron:heartbeat-monitor] Run complete — nudged=${nudged} critical=${critical}`);
  } catch (err) {
    console.error('[cron:heartbeat-monitor] Error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule and export
// ─────────────────────────────────────────────────────────────────────────────
function startPaymentScheduler() {
  // Midnight daily (EAT = UTC+3, so 21:00 UTC)
  cron.schedule('0 21 * * *', runOverdueCheck, { timezone: 'Africa/Nairobi' });
  console.log('[cron] Overdue check scheduled: daily at 00:00 EAT');

  // Every 6 hours
  cron.schedule('0 */6 * * *', runHeartbeatMonitor);
  console.log('[cron] Heartbeat monitor scheduled: every 6 hours');

  // Run heartbeat monitor on startup to catch stale devices immediately
  runHeartbeatMonitor().catch(console.error);
}

module.exports = { startPaymentScheduler, runOverdueCheck, runHeartbeatMonitor };
