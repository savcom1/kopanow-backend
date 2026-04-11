'use strict';
const router   = require('express').Router();
const supabase = require('../helpers/supabase');
const { sendDeviceCommand, COMMANDS } = require('../helpers/fcm');
const crypto   = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Generate a cryptographically random N-digit numeric PIN. */
function generatePin(digits = 6) {
  const max = Math.pow(10, digits);
  const min = Math.pow(10, digits - 1);
  return String(crypto.randomInt(min, max));
}

/** SHA-256 hash of a string (hex). Stored in DB — raw PIN is never persisted. */
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/pin/set
//
// Generate a PIN for a device, push it via FCM, and store the hash in Supabase.
// The raw PIN is returned ONCE to the admin dashboard so support staff can
// read it out to the borrower.  It is NEVER stored in plain text.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/set', async (req, res) => {
  try {
    const { device_id } = req.body;
    if (!device_id) {
      return res.status(400).json({ success: false, error: 'device_id is required' });
    }

    // Fetch device record
    const { data: device, error } = await supabase
      .from('devices')
      .select('id, fcm_token, borrower_id, loan_id, is_locked')
      .eq('id', device_id)
      .maybeSingle();

    if (error) throw error;
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    if (!device.fcm_token) {
      return res.status(400).json({ success: false, error: 'Device has no FCM token — not enrolled via app' });
    }

    // Generate PIN
    const rawPin  = generatePin(6);
    const pinHash = sha256(rawPin);

    // Send via FCM — type = SET_PASSCODE, data includes raw PIN (in transit only)
    const fcmResult = await sendDeviceCommand(device.fcm_token, COMMANDS.SET_PASSCODE, {
      pin: rawPin
    });

    if (!fcmResult.success) {
      return res.status(502).json({ success: false, error: `FCM delivery failed: ${fcmResult.error}` });
    }

    // Persist hash (NOT the raw PIN) in Supabase
    const now = new Date().toISOString();
    await supabase.from('devices').update({
      passcode_hash:      pinHash,
      passcode_active:    true,
      passcode_set_at:    now,
      updated_at:         now
    }).eq('id', device.id);

    // Log the action for audit trail
    await supabase.from('tamper_logs').insert({
      borrower_id: device.borrower_id,
      loan_id:     device.loan_id,
      event_type:  'PASSCODE_SET',
      severity:    'medium',
      detail:      'Admin issued a 6-digit passcode to the device',
      reviewed:    false,
      created_at:  now
    });

    console.log(`[pin:set] PIN issued — device=${device.id} borrower=${device.borrower_id}`);

    // Return raw PIN ONCE — admin shows this to support staff
    return res.json({
      success:   true,
      pin:       rawPin,          // shown once in admin UI, then discarded
      message:   `PIN sent to device via FCM. Give the PIN to the borrower after confirming payment arrangements.`
    });

  } catch (err) {
    console.error('[pin:set]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/admin/pin/clear
//
// Remove the PIN from the device and update Supabase.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/clear', async (req, res) => {
  try {
    const { device_id } = req.body;
    if (!device_id) {
      return res.status(400).json({ success: false, error: 'device_id is required' });
    }

    const { data: device, error } = await supabase
      .from('devices')
      .select('id, fcm_token, borrower_id, loan_id')
      .eq('id', device_id)
      .maybeSingle();

    if (error) throw error;
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    if (!device.fcm_token) {
      return res.status(400).json({ success: false, error: 'No FCM token — cannot deliver command' });
    }

    // Send CLEAR_PASSCODE via FCM
    const fcmResult = await sendDeviceCommand(device.fcm_token, COMMANDS.CLEAR_PASSCODE, {});

    // Clear DB record regardless of FCM result (next heartbeat will sync)
    await supabase.from('devices').update({
      passcode_hash:   null,
      passcode_active: false,
      updated_at:      new Date().toISOString()
    }).eq('id', device.id);

    console.log(`[pin:clear] PIN cleared — device=${device.id} fcm=${fcmResult.success}`);

    return res.json({
      success: true,
      fcm:     fcmResult.success,
      message: fcmResult.success
        ? 'Passcode removed from device'
        : `DB cleared but FCM delivery failed (${fcmResult.error}) — will sync on next heartbeat`
    });

  } catch (err) {
    console.error('[pin:clear]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/admin/pin/status/:deviceId
//
// Returns whether a passcode is currently active on a device.
// Does NOT return the hash or the raw PIN.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status/:deviceId', async (req, res) => {
  try {
    const { data: device, error } = await supabase
      .from('devices')
      .select('id, borrower_id, passcode_active, passcode_set_at')
      .eq('id', req.params.deviceId)
      .maybeSingle();

    if (error) throw error;
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    return res.json({
      success:         true,
      passcode_active: device.passcode_active ?? false,
      passcode_set_at: device.passcode_set_at ?? null
    });
  } catch (err) {
    console.error('[pin:status]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
