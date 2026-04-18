'use strict';
const cron     = require('node-cron');
const supabase = require('../helpers/supabase');
const { logTamper, EVENT_TYPES } = require('../helpers/tamperLog');
const { sendLockCommand, sendHeartbeatRequest } = require('../helpers/fcm');
const { notify, EVENT } = require('../helpers/notify');
const { markOverdueInvoices } = require('../helpers/loanInvoices');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function fmt(amount) {
  return `TSh ${Number(amount).toLocaleString('en-TZ')}`;
}

/**
 * Fetch the borrower phone number from the registrations table.
 * Falls back to devices.mpesa_phone if no registration row found.
 */
async function getPhone(borrowerId, fallbackPhone) {
  const { data } = await supabase
    .from('registrations')
    .select('phone, full_name')
    .eq('borrower_id', borrowerId)
    .maybeSingle();
  return {
    phone:    data?.phone    || fallbackPhone || null,
    fullName: data?.full_name || 'Borrower',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron 1 — Pre-due reminders  (daily at 08:00 EAT)
//
// Sends friendly reminders BEFORE the payment falls due so borrowers have
// time to arrange funds. Stages: -3d, -1d, 0d (due today).
// ─────────────────────────────────────────────────────────────────────────────
async function runInvoiceOverdueSweep() {
  console.log('[cron:invoice-overdue] Marking unpaid past-due invoices…');
  try {
    await markOverdueInvoices();
    console.log('[cron:invoice-overdue] Done');
  } catch (err) {
    console.error('[cron:invoice-overdue] Error:', err.message);
  }
}

async function runPreDueReminders() {
  console.log('[cron:pre-due] Starting pre-due reminder sweep…');
  try {
    const now      = new Date();
    const todayStr = now.toISOString().slice(0, 10); // YYYY-MM-DD

    // Loans that are NOT yet overdue and have an upcoming due date
    const { data: loans, error } = await supabase
      .from('loans')
      .select('*')
      .gte('next_due_date', now.toISOString())          // not yet overdue
      .gt('outstanding_amount', 0)                       // still owes money
      .in('device_status', ['active', 'registered', 'locked']);

    if (error) throw error;

    let sent = 0;

    for (const loan of loans || []) {
      const dueDate  = new Date(loan.next_due_date);
      const daysLeft = Math.floor((dueDate - now) / 86400000); // days until due

      // Only act on -3, -1, 0
      if (![0, 1, 3].includes(daysLeft)) continue;

      const daysState = -daysLeft; // negative means "before due"

      const { data: device } = await supabase
        .from('devices')
        .select('fcm_token, mpesa_phone')
        .eq('loan_id', loan.loan_id)
        .maybeSingle();

      const { phone, fullName } = await getPhone(loan.borrower_id, device?.mpesa_phone);
      const amount = fmt(loan.outstanding_amount);
      const dueFmt = dueDate.toLocaleDateString('en-TZ', { day: 'numeric', month: 'short', year: 'numeric' });

      let eventType, smsMessage, pushTitle, pushBody;

      if (daysLeft === 3) {
        eventType  = EVENT.REMINDER_3D;
        pushTitle  = '📅 Loan Payment Reminder';
        pushBody   = `Hi ${fullName}, your loan payment of ${amount} is due in 3 days (${dueFmt}). Pay via M-Pesa to avoid penalties.`;
        smsMessage = `KOPANOW: Hi ${fullName}, your loan payment of ${amount} is due on ${dueFmt} (3 days). Please pay via M-Pesa on time to avoid your device being restricted. Thank you.`;
      } else if (daysLeft === 1) {
        eventType  = EVENT.REMINDER_1D;
        pushTitle  = '⚠️ Payment Due Tomorrow!';
        pushBody   = `${fullName}, your payment of ${amount} is due TOMORROW (${dueFmt}). Pay now to keep your device active.`;
        smsMessage = `KOPANOW: URGENT - Hi ${fullName}, your loan payment of ${amount} is due TOMORROW (${dueFmt}). Pay via M-Pesa now to avoid device restriction. Call us: +255XXXXXXXXX`;
      } else if (daysLeft === 0) {
        eventType  = EVENT.REMINDER_TODAY;
        pushTitle  = '🔔 Payment Due Today!';
        pushBody   = `${fullName}, your loan payment of ${amount} is due TODAY. Pay now to avoid device lock.`;
        smsMessage = `KOPANOW: Hi ${fullName}, your loan payment of ${amount} is DUE TODAY. Pay via M-Pesa now to avoid device lock. Questions? Call +255XXXXXXXXX`;
      }

      const result = await notify({
        borrowerId: loan.borrower_id,
        loanId:     loan.loan_id,
        phone,
        eventType,
        daysState,
        fcmToken:   device?.fcm_token,
        smsMessage,
        pushTitle,
        pushBody,
      });

      if (!result.skipped) {
        console.log(`[cron:pre-due] ${eventType} → borrower=${loan.borrower_id} sms=${result.smsSent} fcm=${result.fcmSent}`);
        sent++;
      }
    }

    console.log(`[cron:pre-due] Done — sent=${sent} reminders`);
  } catch (err) {
    console.error('[cron:pre-due] Error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron 2 — Overdue escalation  (daily at 09:00 EAT)
//
// Full 9-stage pipeline:
//   Day  1  → warning SMS + push
//   Day  3  → stronger warning
//   Day  5  → last chance before lock
//   Day  7  → LOCK device + SMS
//   Day 14  → SMS to guarantors
//   Day 30  → admin alert for field collection
// ─────────────────────────────────────────────────────────────────────────────
async function runOverdueEscalation() {
  console.log('[cron:overdue] Starting overdue escalation sweep…');
  try {
    const now = new Date();

    const { data: loans, error } = await supabase
      .from('loans')
      .select('*')
      .lt('next_due_date', now.toISOString())
      .gt('outstanding_amount', 0)
      .in('device_status', ['active', 'registered', 'locked']);

    if (error) throw error;

    let warned = 0, locked = 0, escalated = 0;

    for (const loan of loans || []) {
      const daysLate = Math.floor((now - new Date(loan.next_due_date)) / 86400000);

      const { data: device } = await supabase
        .from('devices')
        .select('id, fcm_token, is_locked, mpesa_phone, status')
        .eq('loan_id', loan.loan_id)
        .maybeSingle();

      const { phone, fullName } = await getPhone(loan.borrower_id, device?.mpesa_phone);
      const amount = fmt(loan.outstanding_amount);

      // Always update days_overdue in DB
      await supabase.from('loans')
        .update({ days_overdue: daysLate, updated_at: new Date().toISOString() })
        .eq('loan_id', loan.loan_id);

      // ── Day 30: admin field collection alert ──────────────────────────────
      if (daysLate === 30) {
        await logTamper(loan.borrower_id, loan.loan_id, 'FIELD_COLLECTION_ALERT', {
          source: 'cron',
          detail: `30 days overdue — field collection required. Outstanding: ${amount}`,
          auto_action: 'FIELD_COLLECTION'
        });
        await notify({
          borrowerId: loan.borrower_id, loanId: loan.loan_id,
          phone, eventType: EVENT.OVERDUE_30D, daysState: 30,
          fcmToken: device?.fcm_token,
          smsMessage: `KOPANOW: Hi ${fullName}, your loan account is 30 days overdue (${amount}). Our collection team will contact you shortly. Avoid further actions by paying now.`,
          pushTitle: '🚨 Loan Critically Overdue',
          pushBody:  `Your loan is 30 days overdue (${amount}). Field collection has been initiated. Pay now to resolve.`,
        });
        escalated++;
        continue;
      }

      // ── Day 14: guarantor SMS escalation ─────────────────────────────────
      if (daysLate === 14 && loan.guarantors?.length > 0) {
        for (const g of loan.guarantors) {
          if (!g.phone) continue;
          const { sendSms } = require('../helpers/sms');
          await sendSms(g.phone,
            `KOPANOW: Dear ${g.name || 'Guarantor'}, you are listed as guarantor for ${fullName}'s loan. The borrower is ${daysLate} days overdue on a payment of ${amount}. Please urge them to pay urgently to avoid further action.`
          );
          // Log the guarantor SMS
          await supabase.from('notifications_log').insert({
            borrower_id: loan.borrower_id,
            loan_id:     loan.loan_id,
            channel:     'sms',
            event_type:  EVENT.OVERDUE_14D_GTR,
            phone:       g.phone,
            message:     `Guarantor escalation to ${g.name}`,
            status:      'sent',
            days_state:  14,
          }).catch(() => {});
        }
        console.log(`[cron:overdue] Guarantor SMS sent: borrower=${loan.borrower_id}`);
        escalated++;
      }

      // ── Day 7: LOCK ───────────────────────────────────────────────────────
      if (daysLate >= 7 && !device?.is_locked) {
        const lockReason = `${daysLate} days overdue — Outstanding: ${amount}`;

        // Send FCM lock command
        if (device?.fcm_token) {
          await sendLockCommand(device.fcm_token, lockReason, amount, 'PAYMENT');
        }

        // Update device + loan in DB
        await supabase.from('devices').update({
          is_locked:   true,
          status:      'locked',
          lock_reason: lockReason,
          amount_due:  amount,
          updated_at:  new Date().toISOString(),
        }).eq('id', device.id);

        await supabase.from('loans').update({
          device_status: 'locked',
          days_overdue:  daysLate,
          updated_at:    new Date().toISOString(),
        }).eq('loan_id', loan.loan_id);

        await logTamper(loan.borrower_id, loan.loan_id, EVENT_TYPES.LOCK_SENT, {
          source: 'cron',
          detail: `Day ${daysLate} overdue — auto-lock triggered`,
          auto_action: 'LOCK_DEVICE',
        });

        // Also send SMS + push about the lock
        await notify({
          borrowerId: loan.borrower_id, loanId: loan.loan_id,
          phone, eventType: EVENT.OVERDUE_7D_LOCK, daysState: daysLate,
          fcmToken: device?.fcm_token,
          smsMessage: `KOPANOW: Hi ${fullName}, your device has been LOCKED due to ${daysLate} days overdue payment of ${amount}. Pay via M-Pesa immediately to unlock. Reference your loan ID: ${loan.loan_id}`,
          pushTitle:  '🔒 Device Locked — Payment Required',
          pushBody:   `Your device is locked due to ${daysLate} days overdue (${amount}). Pay now to unlock.`,
        });

        console.log(`[cron:overdue] LOCKED: borrower=${loan.borrower_id} day=${daysLate}`);
        locked++;
        continue;
      }

      // ── Days 1, 3, 5: Progressive warnings ───────────────────────────────
      const warningDays = [1, 3, 5];
      if (warningDays.includes(daysLate)) {
        let eventType, smsMessage, pushTitle, pushBody;

        if (daysLate === 1) {
          eventType  = EVENT.OVERDUE_1D;
          pushTitle  = '⚠️ Payment Overdue';
          pushBody   = `${fullName}, your loan payment of ${amount} is 1 day overdue. Pay now to avoid restrictions.`;
          smsMessage = `KOPANOW: Hi ${fullName}, your loan payment of ${amount} is 1 day overdue. Please pay via M-Pesa as soon as possible to avoid device restriction.`;
        } else if (daysLate === 3) {
          eventType  = EVENT.OVERDUE_3D;
          pushTitle  = '🚨 Loan 3 Days Overdue';
          pushBody   = `${fullName}, your loan of ${amount} is 3 days overdue. Pay now — device lock in 4 days.`;
          smsMessage = `KOPANOW: URGENT - Hi ${fullName}, your loan payment of ${amount} is 3 DAYS OVERDUE. Pay via M-Pesa NOW. Your device will be locked in 4 days if unpaid.`;
        } else if (daysLate === 5) {
          eventType  = EVENT.OVERDUE_5D;
          pushTitle  = '🚨 FINAL WARNING — 2 Days to Lock';
          pushBody   = `${fullName}, your loan of ${amount} is 5 days overdue. Your device will be LOCKED in 2 days!`;
          smsMessage = `KOPANOW: FINAL WARNING - Hi ${fullName}, your loan payment of ${amount} is 5 DAYS OVERDUE. Your device will be LOCKED in 2 days. Pay immediately via M-Pesa. ID: ${loan.loan_id}`;
        }

        // FCM heartbeat request so device checks in + sends push
        if (device?.fcm_token) {
          await sendHeartbeatRequest(device.fcm_token);
        }

        const result = await notify({
          borrowerId: loan.borrower_id, loanId: loan.loan_id,
          phone,      eventType, daysState: daysLate,
          fcmToken:   device?.fcm_token,
          smsMessage, pushTitle, pushBody,
        });

        if (!result.skipped) {
          console.log(`[cron:overdue] ${eventType}: borrower=${loan.borrower_id} sms=${result.smsSent} fcm=${result.fcmSent}`);
          warned++;
        }
      }
    }

    console.log(`[cron:overdue] Done — warned=${warned} locked=${locked} escalated=${escalated}`);
  } catch (err) {
    console.error('[cron:overdue] Error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cron 3 — Heartbeat monitor  (every 6 hours, unchanged)
//
// Device silent >25h → nudge via FCM HEARTBEAT_REQUEST
// Device silent >48h → HEARTBEAT_MISSING CRITICAL (possible factory reset)
// ─────────────────────────────────────────────────────────────────────────────
async function runHeartbeatMonitor() {
  console.log('[cron:heartbeat-monitor] Starting…');
  try {
    const now    = Date.now();
    const h25ago = new Date(now - 25 * 3600000).toISOString();

    const { data: devices, error } = await supabase
      .from('devices')
      .select('id, borrower_id, loan_id, fcm_token, last_seen, status')
      .not('fcm_token', 'is', null)
      .lt('last_seen', h25ago)
      .in('status', ['active', 'locked', 'registered']);

    if (error) throw error;

    let nudged = 0, critical = 0;

    for (const device of devices || []) {
      const silentMs  = now - new Date(device.last_seen || 0).getTime();
      const silentHrs = Math.floor(silentMs / 3600000);

      if (silentMs > 48 * 3600000) {
        await logTamper(device.borrower_id, device.loan_id, EVENT_TYPES.HEARTBEAT_MISSING, {
          source: 'cron',
          detail: `Device silent for ${silentHrs}h — possible factory reset (Scenario 2)`,
          auto_action: 'HEARTBEAT_REQUEST'
        });
        await sendHeartbeatRequest(device.fcm_token);
        console.warn(`[cron:heartbeat-monitor] CRITICAL ${silentHrs}h silent: borrower=${device.borrower_id}`);
        critical++;
      } else {
        await sendHeartbeatRequest(device.fcm_token);
        console.log(`[cron:heartbeat-monitor] Nudge (${silentHrs}h silent): borrower=${device.borrower_id}`);
        nudged++;
      }
    }

    console.log(`[cron:heartbeat-monitor] Done — nudged=${nudged} critical=${critical}`);
  } catch (err) {
    console.error('[cron:heartbeat-monitor] Error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule and export
// ─────────────────────────────────────────────────────────────────────────────
function startPaymentScheduler() {
  // 07:30 EAT — mark loan_invoices overdue before reminder sweep
  cron.schedule('30 4 * * *', runInvoiceOverdueSweep, { timezone: 'Africa/Nairobi' });
  console.log('[cron] Invoice overdue sweep scheduled: daily at 07:30 EAT');

  // 08:00 EAT daily — pre-due reminders (EAT = UTC+3, so 05:00 UTC)
  cron.schedule('0 5 * * *', runPreDueReminders, { timezone: 'Africa/Nairobi' });
  console.log('[cron] Pre-due reminders scheduled: daily at 08:00 EAT');

  // 09:00 EAT daily — overdue escalation (06:00 UTC)
  cron.schedule('0 6 * * *', runOverdueEscalation, { timezone: 'Africa/Nairobi' });
  console.log('[cron] Overdue escalation scheduled: daily at 09:00 EAT');

  // Every 6 hours — heartbeat monitor
  cron.schedule('0 */6 * * *', runHeartbeatMonitor);
  console.log('[cron] Heartbeat monitor scheduled: every 6 hours');

  // Startup sweep — catch stale devices immediately
  runHeartbeatMonitor().catch(console.error);
}

module.exports = {
  startPaymentScheduler,
  runInvoiceOverdueSweep,
  runPreDueReminders,
  runOverdueEscalation,
  runHeartbeatMonitor,
};
