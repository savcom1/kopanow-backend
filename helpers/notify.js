'use strict';

/**
 * notify.js — Central notification dispatcher.
 *
 * Combines SMS + FCM visible push into one call.
 * Every notification is logged to the `notifications_log` table for auditing
 * and deduplication (same event_type won't fire twice on the same day).
 *
 * Usage:
 *   const { notify } = require('./notify');
 *   await notify({
 *     borrowerId, loanId, phone,
 *     eventType: 'reminder_3d',
 *     daysState: -3,
 *     fcmToken,                       // optional — skip FCM if null
 *     smsMessage: 'Your loan...',
 *     pushTitle: 'Loan Reminder',
 *     pushBody: 'Your loan...'
 *   });
 */

const supabase          = require('./supabase');
const { sendSms }       = require('./sms');
const { sendNotificationMessage } = require('./fcm');

// ─────────────────────────────────────────────────────────────────────────────
// Event type catalogue — keeps event names consistent everywhere
// ─────────────────────────────────────────────────────────────────────────────
const EVENT = Object.freeze({
  REMINDER_3D:      'reminder_3d',      // 3 days before due
  REMINDER_1D:      'reminder_1d',      // 1 day before due
  REMINDER_TODAY:   'reminder_today',   // due today
  OVERDUE_1D:       'overdue_1d',
  OVERDUE_3D:       'overdue_3d',
  OVERDUE_5D:       'overdue_5d',
  OVERDUE_7D_LOCK:  'overdue_7d_lock',  // lock event
  OVERDUE_14D_GTR:  'overdue_14d_gtr',  // guarantor escalation
  OVERDUE_30D:      'overdue_30d',      // field collection alert
  MANUAL:           'manual',           // admin-triggered
});

// ─────────────────────────────────────────────────────────────────────────────
// Deduplication: was this event already sent today for this loan?
// ─────────────────────────────────────────────────────────────────────────────
async function alreadySentToday(borrowerId, loanId, eventType) {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data } = await supabase
    .from('notifications_log')
    .select('id')
    .eq('borrower_id', borrowerId)
    .eq('loan_id', loanId)
    .eq('event_type', eventType)
    .eq('status', 'sent')
    .gte('created_at', startOfDay.toISOString())
    .limit(1);

  return Array.isArray(data) && data.length > 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Log to notifications_log
// ─────────────────────────────────────────────────────────────────────────────
async function logNotification({ borrowerId, loanId, channel, eventType, phone, message, status, error, daysState }) {
  try {
    await supabase.from('notifications_log').insert({
      borrower_id: borrowerId,
      loan_id:     loanId,
      channel,
      event_type:  eventType,
      phone:       phone || null,
      message:     message || null,
      status,
      error:       error  || null,
      days_state:  daysState ?? null,
    });
  } catch (e) {
    console.error('[notify] Failed to write to notifications_log:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main dispatch function
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {Object} opts
 * @param {string}  opts.borrowerId
 * @param {string}  opts.loanId
 * @param {string}  [opts.phone]        - Borrower phone in international format
 * @param {string}  opts.eventType      - One of EVENT.*
 * @param {number}  [opts.daysState]    - Negative = days before due, positive = overdue
 * @param {string}  [opts.fcmToken]     - FCM token for push (skip if null)
 * @param {string}  [opts.smsMessage]   - SMS text body (skip SMS if null)
 * @param {string}  [opts.pushTitle]    - Push notification title (skip FCM if null)
 * @param {string}  [opts.pushBody]     - Push notification body
 * @param {boolean} [opts.deduplicate]  - Default true; set false to force re-send
 * @returns {Promise<{ smsSent: boolean, fcmSent: boolean, skipped: boolean }>}
 */
async function notify({
  borrowerId, loanId, phone,
  eventType,  daysState,
  fcmToken,   smsMessage,
  pushTitle,  pushBody,
  deduplicate = true,
}) {
  // ── Deduplication check ──────────────────────────────────────────────────
  if (deduplicate && eventType !== EVENT.MANUAL) {
    const already = await alreadySentToday(borrowerId, loanId, eventType);
    if (already) {
      console.log(`[notify] SKIP (already sent today): borrower=${borrowerId} event=${eventType}`);
      return { smsSent: false, fcmSent: false, skipped: true };
    }
  }

  let smsSent = false;
  let fcmSent = false;

  // ── SMS ──────────────────────────────────────────────────────────────────
  if (phone && smsMessage) {
    const result = await sendSms(phone, smsMessage);
    smsSent = result.success;
    await logNotification({
      borrowerId, loanId,
      channel:   'sms',
      eventType,
      phone,
      message:   smsMessage,
      status:    result.success ? 'sent' : 'failed',
      error:     result.error,
      daysState,
    });
    if (!result.success) {
      console.warn(`[notify] SMS failed: borrower=${borrowerId} err=${result.error}`);
    }
  }

  // ── FCM visible push ─────────────────────────────────────────────────────
  if (fcmToken && pushTitle && pushBody) {
    const result = await sendNotificationMessage(fcmToken, pushTitle, pushBody, { event_type: eventType });
    fcmSent = result.success;
    await logNotification({
      borrowerId, loanId,
      channel:   'fcm',
      eventType,
      message:   `${pushTitle}: ${pushBody}`,
      status:    result.success ? 'sent' : 'failed',
      error:     result.error,
      daysState,
    });
    if (!result.success) {
      console.warn(`[notify] FCM push failed: borrower=${borrowerId} err=${result.error}`);
    }
  }

  return { smsSent, fcmSent, skipped: false };
}

module.exports = { notify, EVENT };
