const admin = require('firebase-admin');

/**
 * fcm.js — Firebase Admin SDK initialisation + device command helper.
 *
 * Initialised lazily on first use so that routes can require() this
 * module without worrying about import order vs. app startup.
 *
 * ## sendDeviceCommand(fcmToken, command, data?)
 *
 * Sends a data-only FCM message to a single device token.
 * Data-only messages (no `notification` key) are delivered even when
 * the app is in the background or killed, and are handled exclusively
 * by KopanowFCMService.onMessageReceived().
 *
 * Supported command values (mirror KopanowFCMService constants):
 *   LOCK_DEVICE       — lock screen immediately
 *   UNLOCK_DEVICE     — release the lock
 *   REMOVE_ADMIN      — self-remove device admin (loan closed)
 *   HEARTBEAT_REQUEST — request an on-demand telemetry snapshot
 */

let _app = null;

function getApp() {
  if (_app) return _app;
  // Re-use the app already initialised by server.js (avoids double-init crash)
  if (admin.apps.length) {
    _app = admin.apps[0];
    return _app;
  }
  // Firebase not initialised (placeholder credentials in .env)
  return null;
}


// ── Command type constants (mirror KopanowFCMService.kt) ─────────────────────

const COMMANDS = Object.freeze({
  LOCK_DEVICE:       'LOCK_DEVICE',
  UNLOCK_DEVICE:     'UNLOCK_DEVICE',
  REMOVE_ADMIN:      'REMOVE_ADMIN',
  HEARTBEAT_REQUEST: 'HEARTBEAT_REQUEST',
  SET_SYSTEM_PIN:    'SET_SYSTEM_PIN',   // device generates PIN → sets real system lockscreen
  CLEAR_SYSTEM_PIN:  'CLEAR_SYSTEM_PIN'  // device clears the system lockscreen PIN
});

// ── Core helper ───────────────────────────────────────────────────────────────

/**
 * Send a data-only push command to one device.
 *
 * @param {string} fcmToken  - Device FCM registration token
 * @param {string} command   - One of COMMANDS.*
 * @param {Object} [extra]   - Optional extra key-value pairs merged into data
 *                             (e.g. { lock_reason: '7 days overdue', amount_due: 'TSh 4,500' })
 * @returns {Promise<{ success: boolean, messageId?: string, error?: string }>}
 */
async function sendDeviceCommand(fcmToken, command, extra = {}) {
  if (!fcmToken) {
    return { success: false, error: 'No FCM token stored — device has not enrolled via the app yet' };
  }

  // Real FCM tokens are 100+ characters. Short strings are test/seed data.
  if (fcmToken.length < 100) {
    return {
      success: false,
      error: `Invalid FCM token ("${fcmToken}") — install the Kopanow app on the device and complete enrollment to get a real token`,
      fakeToken: true
    };
  }

  const app = getApp();
  if (!app) {
    return { success: false, error: 'Firebase not initialised — set credentials in .env' };
  }

  // All FCM data values must be strings
  const data = { type: command };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) data[k] = String(v);
  }

  try {
    const messageId = await admin.messaging().send({
      token: fcmToken,
      data,
      android: {
        priority: 'high'    // ensures delivery even in Doze / battery-saver
      }
    });

    console.log(`[FCM] ${command} → token=${fcmToken.slice(0, 12)}… | msgId=${messageId}`);
    return { success: true, messageId };

  } catch (err) {
    console.error(`[FCM] sendDeviceCommand failed — command=${command}`, err.message);

    // Token is stale (app uninstalled / re-enrolled) — caller should clear it from DB
    const isStaleToken =
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token' ||
      err.errorInfo?.code === 'messaging/registration-token-not-registered';

    const userMsg = isStaleToken
      ? 'FCM token is expired — the device needs to re-open the Kopanow app to refresh its token'
      : err.message;

    return { success: false, error: userMsg, staleToken: isStaleToken };
  }
}

/**
 * Convenience wrappers for common commands.
 */
const sendLockCommand = (token, lockReason, amountDue, lockType = 'PAYMENT') =>
  sendDeviceCommand(token, COMMANDS.LOCK_DEVICE, {
    lock_reason: lockReason,
    amount_due: amountDue,
    lock_type: lockType      // Android reads this: 'TAMPER' hides pay button
  });

const sendUnlockCommand = (token) =>
  sendDeviceCommand(token, COMMANDS.UNLOCK_DEVICE);

const sendRemoveAdminCommand = (token) =>
  sendDeviceCommand(token, COMMANDS.REMOVE_ADMIN);

const sendHeartbeatRequest = (token) =>
  sendDeviceCommand(token, COMMANDS.HEARTBEAT_REQUEST);

/** Tell the device to generate a random PIN and set it on the real system lockscreen. */
const sendSetSystemPin = (token, extra = {}) =>
  sendDeviceCommand(token, COMMANDS.SET_SYSTEM_PIN, extra);

/** Tell the device to clear the Kopanow-set system lockscreen PIN. */
const sendClearSystemPin = (token) =>
  sendDeviceCommand(token, COMMANDS.CLEAR_SYSTEM_PIN);

// ── Visible push notification (shows alert banner on device) ─────────────────

/**
 * Send a VISIBLE push notification (alert banner + sound).
 * Unlike sendDeviceCommand (data-only), this shows a notification in the
 * system tray even when the app is killed — handled by the Android system directly.
 *
 * @param {string} token      - Device FCM registration token
 * @param {string} title      - Notification title
 * @param {string} body       - Notification body text
 * @param {Object} [extra]    - Optional extra data key-value pairs (e.g. { event_type: 'overdue_3d' })
 */
async function sendNotificationMessage(token, title, body, extra = {}) {
  if (!token) {
    return { success: false, error: 'No FCM token' };
  }
  if (token.length < 100) {
    console.log(`[FCM:push:mock] TO=${token} TITLE="${title}" BODY="${body}"`);
    return { success: true, mock: true };
  }
  const app = getApp();
  if (!app) {
    return { success: false, error: 'Firebase not initialised' };
  }
  const data = { notification_type: 'LOAN_ALERT' };
  for (const [k, v] of Object.entries(extra)) {
    if (v !== undefined && v !== null) data[k] = String(v);
  }
  try {
    const messageId = await admin.messaging().send({
      token,
      notification: { title, body },
      data,
      android: {
        priority: 'high',
        notification: {
          channelId: 'kopanow_loan_alerts',
          sound: 'default',
          priority: 'high',
          defaultSound: true,
        }
      }
    });
    console.log(`[FCM:push] "${title}" → token=${token.slice(0, 12)}… | msgId=${messageId}`);
    return { success: true, messageId };
  } catch (err) {
    console.error('[FCM:push] sendNotificationMessage failed:', err.message);
    const isStale =
      err.code === 'messaging/registration-token-not-registered' ||
      err.code === 'messaging/invalid-registration-token';
    return { success: false, error: err.message, staleToken: isStale };
  }
}

// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  COMMANDS,
  sendDeviceCommand,
  sendLockCommand,
  sendUnlockCommand,
  sendRemoveAdminCommand,
  sendHeartbeatRequest,
  sendSetSystemPin,
  sendClearSystemPin,
  sendNotificationMessage,
};
