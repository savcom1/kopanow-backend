'use strict';

/**
 * sms.js — Africa's Talking SMS dispatch helper.
 *
 * Set in .env:
 *   AT_USERNAME=sandbox        (use 'sandbox' for free testing)
 *   AT_API_KEY=your_key_here
 *   AT_SENDER_ID=Kopanow       (optional, leave blank for short-code)
 *
 * Docs: https://developers.africastalking.com/docs/sms/sending
 */

let _at = null;

function getClient() {
  if (_at) return _at;

  const username = process.env.AT_USERNAME;
  const apiKey   = process.env.AT_API_KEY;

  if (!username || !apiKey || apiKey === 'your_key_here') {
    return null; // not configured — run in log-only mode
  }

  try {
    const AfricasTalking = require('africastalking');
    const at = AfricasTalking({ username, apiKey });
    _at = at.SMS;
    return _at;
  } catch (e) {
    console.warn('[sms] africastalking package not installed or failed to init:', e.message);
    return null;
  }
}

/**
 * Send an SMS to one or more phone numbers.
 *
 * @param {string|string[]} to     - Phone number(s) in international format e.g. '+255712345678'
 * @param {string}          message - Plain text message body (max 160 chars per SMS part)
 * @returns {Promise<{ success: boolean, data?: any, error?: string }>}
 */
async function sendSms(to, message) {
  const recipients = Array.isArray(to) ? to : [to];

  // Normalise phone numbers: ensure + prefix
  const phones = recipients
    .filter(Boolean)
    .map(p => {
      const s = String(p).replace(/\s+/g, '');
      if (s.startsWith('+')) return s;
      if (s.startsWith('0'))  return '+255' + s.slice(1);   // Tanzania local
      if (s.startsWith('255')) return '+' + s;
      if (s.startsWith('254')) return '+' + s;              // Kenya
      return '+' + s;
    });

  if (phones.length === 0) {
    return { success: false, error: 'No valid phone numbers provided' };
  }

  const sender = process.env.AT_SENDER_ID || undefined;
  const sms    = getClient();

  // ── Dev / sandbox log-only mode ──────────────────────────────────────────
  if (!sms) {
    console.log(`[sms:mock] TO=${phones.join(',')} | MSG="${message}"`);
    return { success: true, data: { mock: true, phones, message } };
  }

  // ── Real send ─────────────────────────────────────────────────────────────
  try {
    const opts = { to: phones, message };
    if (sender) opts.from = sender;

    const result = await sms.send(opts);
    console.log(`[sms] Sent to ${phones.join(',')} — status:`, JSON.stringify(result?.SMSMessageData?.Recipients || result));
    return { success: true, data: result };
  } catch (err) {
    console.error('[sms] Send failed:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendSms };
