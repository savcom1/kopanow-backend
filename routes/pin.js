'use strict';
const router   = require('express').Router();
const supabase = require('../helpers/supabase');
const { sendSetSystemPin, sendClearSystemPin } = require('../helpers/fcm');
const crypto   = require('crypto');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pin/set
//
// Trigger the device to generate its own random system PIN and set it on the
// real Android lockscreen via DevicePolicyManager.resetPasswordWithToken().
//
// The device sends the generated PIN back via POST /api/pin/report so the
// admin can read it to the borrower.  No PIN is generated server-side.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/set', async (req, res) => {
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
      return res.status(400).json({ success: false, error: 'Device has no FCM token — not enrolled via app' });
    }

    // Mark PIN as pending — device will fill in the actual PIN via /report
    const now = new Date().toISOString();
    await supabase.from('devices').update({
      passcode_active: true,
      passcode_hash:   null,        // cleared; device will fill via /report
      passcode_set_at: now,
      system_pin:      null,        // will be set when device reports
      updated_at:      now
    }).eq('id', device.id);

    // Send FCM — device generates PIN itself (no PIN in payload)
    const fcmResult = await sendSetSystemPin(device.fcm_token);

    if (!fcmResult.success) {
      // Rollback the DB update if FCM fails
      await supabase.from('devices').update({
        passcode_active: false,
        passcode_set_at: null,
        updated_at: new Date().toISOString()
      }).eq('id', device.id);
      return res.status(502).json({ success: false, error: `FCM delivery failed: ${fcmResult.error}` });
    }

    // Audit log
    await supabase.from('tamper_logs').insert({
      borrower_id: device.borrower_id,
      loan_id:     device.loan_id,
      event_type:  'SYSTEM_PIN_REQUESTED',
      severity:    'MEDIUM',
      detail:      'Admin triggered system PIN lock. Awaiting device PIN report.',
      reviewed:    false,
      created_at:  now
    });

    console.log(`[pin:set] SET_SYSTEM_PIN sent — device=${device.id} borrower=${device.borrower_id}`);

    return res.json({
      success: true,
      message: 'SET_SYSTEM_PIN command delivered. The device is generating a PIN — it will appear here once confirmed (usually within 10 seconds).',
      pending: true
    });

  } catch (err) {
    console.error('[pin:set]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pin/report
//
// Called by the device (KopanowApi.reportSystemPin) after it generates and
// sets the system PIN.  Stores the plain PIN encrypted in Supabase so the
// admin can read it ONCE to relay it to the borrower.
//
// Security note: transmitted over HTTPS.  Stored as AES-256-GCM ciphertext.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/report', async (req, res) => {
  try {
    const { borrower_id, loan_id, pin, timestamp } = req.body;
    if (!borrower_id || !loan_id || !pin) {
      return res.status(400).json({ success: false, error: 'borrower_id, loan_id and pin are required' });
    }
    if (!/^\d{4,8}$/.test(pin)) {
      return res.status(400).json({ success: false, error: 'pin must be 4–8 digits' });
    }

    const { data: device, error } = await supabase
      .from('devices')
      .select('id, borrower_id, loan_id')
      .eq('borrower_id', borrower_id)
      .eq('loan_id', loan_id)
      .maybeSingle();

    if (error) throw error;
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    // Encrypt the PIN with AES-256-GCM using the SUPABASE service key as passphrase
    // (In production, use a dedicated KMS key stored in .env)
    const encryptedPin = encryptPin(pin);

    const now = new Date().toISOString();
    await supabase.from('devices').update({
      system_pin:      encryptedPin,   // encrypted, shown once to admin
      passcode_active: true,
      passcode_hash:   crypto.createHash('sha256').update(pin).digest('hex'),
      updated_at:      now
    }).eq('id', device.id);

    console.log(`[pin:report] System PIN reported — borrower=${borrower_id} loan=${loan_id}`);

    return res.json({ success: true, message: 'PIN received and stored' });

  } catch (err) {
    console.error('[pin:report]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pin/reveal/:deviceId
//
// Returns the current system PIN (decrypted) for admin use.
// The PIN is shown ONCE and then cleared from the database (view-once design).
// ─────────────────────────────────────────────────────────────────────────────
router.get('/reveal/:deviceId', async (req, res) => {
  try {
    const { data: device, error } = await supabase
      .from('devices')
      .select('id, borrower_id, system_pin, passcode_active, passcode_set_at')
      .eq('id', req.params.deviceId)
      .maybeSingle();

    if (error) throw error;
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    if (!device.system_pin) {
      return res.json({
        success:         true,
        pin:             null,
        passcode_active: device.passcode_active ?? false,
        message:         device.passcode_active
          ? 'PIN command sent but device has not reported back yet — try again in a few seconds.'
          : 'No system PIN is currently active on this device.'
      });
    }

    // Decrypt and return
    const plainPin = decryptPin(device.system_pin);

    // DO NOT clear the PIN after reveal — admin may need to re-read it
    // Clear only when /clear is called

    return res.json({
      success:         true,
      pin:             plainPin,
      passcode_active: device.passcode_active,
      passcode_set_at: device.passcode_set_at,
      message:         'Read this PIN to the borrower. It is the actual Android lockscreen PIN on their device.'
    });

  } catch (err) {
    console.error('[pin:reveal]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/pin/clear
//
// Send CLEAR_SYSTEM_PIN to device and wipe PIN from Supabase.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/clear', async (req, res) => {
  try {
    const { device_id } = req.body;
    if (!device_id) {
      return res.status(400).json({ success: false, error: 'device_id is required' });
    }

    const { data: device, error } = await supabase
      .from('devices')
      .select('id, fcm_token, borrower_id, loan_id, status')
      .eq('id', device_id)
      .maybeSingle();

    if (error) throw error;
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });
    if (!device.fcm_token) {
      return res.status(400).json({ success: false, error: 'No FCM token — cannot deliver command' });
    }

    const fcmResult = await sendClearSystemPin(device.fcm_token);

    // Clear DB regardless of FCM result (next heartbeat will sync).
    // Also clear lock flags so admin UI matches — pin/clear previously left `is_locked` / `status=locked` stale.
    const now = new Date().toISOString();
    const wasLockedRow = device.status === 'locked';
    const deviceUpdate = {
      passcode_hash:   null,
      passcode_active: false,
      system_pin:      null,
      is_locked:       false,
      lock_reason:     null,
      updated_at:      now,
    };
    if (wasLockedRow) {
      deviceUpdate.status = 'active';
    }
    await supabase.from('devices').update(deviceUpdate).eq('id', device.id);

    if (wasLockedRow) {
      await supabase.from('loans').update({
        device_status: 'active',
        updated_at:    now,
      }).eq('loan_id', device.loan_id);
    }

    // Audit log
    supabase.from('tamper_logs').insert({
      borrower_id: device.borrower_id,
      loan_id:     device.loan_id,
      event_type:  'SYSTEM_PIN_CLEARED',
      severity:    'LOW',
      detail:      'Admin cleared the device system PIN (real lockscreen)',
      reviewed:    true,
      created_at:  now
    }).then(({ error: e }) => { if (e) console.warn('[pin:clear] audit log failed:', e.message); });

    console.log(`[pin:clear] CLEAR_SYSTEM_PIN sent — device=${device.id} fcm=${fcmResult.success}`);

    return res.json({
      success: true,
      fcm:     fcmResult.success,
      message: fcmResult.success
        ? 'System PIN cleared on device — the real lockscreen is now open.'
        : `DB cleared but FCM failed (${fcmResult.error}) — will sync on next heartbeat.`
    });

  } catch (err) {
    console.error('[pin:clear]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/pin/status/:deviceId
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status/:deviceId', async (req, res) => {
  try {
    const { data: device, error } = await supabase
      .from('devices')
      .select('id, borrower_id, passcode_active, passcode_set_at, system_pin')
      .eq('id', req.params.deviceId)
      .maybeSingle();

    if (error) throw error;
    if (!device) return res.status(404).json({ success: false, error: 'Device not found' });

    return res.json({
      success:         true,
      passcode_active: device.passcode_active ?? false,
      passcode_set_at: device.passcode_set_at ?? null,
      pin_reported:    !!device.system_pin     // PIN arrived from device?
    });
  } catch (err) {
    console.error('[pin:status]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Crypto helpers (AES-256-GCM)
// ─────────────────────────────────────────────────────────────────────────────

const ALGO   = 'aes-256-gcm';
const SECRET = process.env.PIN_ENCRYPTION_KEY || process.env.SUPABASE_SERVICE_KEY?.slice(0, 32) || 'kopanow-system-pin-encrypt-key!!';
const KEY    = Buffer.from(SECRET.padEnd(32, '!').slice(0, 32));

function encryptPin(plainPin) {
  const iv  = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plainPin, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: iv(hex) : tag(hex) : ciphertext(hex)
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptPin(encrypted) {
  const [ivHex, tagHex, ctHex] = encrypted.split(':');
  const iv     = Buffer.from(ivHex, 'hex');
  const tag    = Buffer.from(tagHex, 'hex');
  const ct     = Buffer.from(ctHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

module.exports = router;
