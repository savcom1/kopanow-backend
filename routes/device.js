'use strict';
const express = require('express');
const router = express.Router();
const supabase = require('../helpers/supabase');
const { logTamper, EVENT_TYPES } = require('../helpers/tamperLog');
const { sendLockCommand, sendUnlockCommand, sendRemoveAdminCommand } = require('../helpers/fcm');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function daysOverdue(nextDueDate) {
  if (!nextDueDate) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(nextDueDate).getTime()) / 86400000));
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/device/register
// Called by EnrollmentManager after device admin is granted.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const {
      borrower_id, loan_id, fcm_token, device_model, device_id, mpesa_phone,
      // Rich telemetry fields sent by the expanded RegisterDeviceRequest
      manufacturer, brand, android_version, sdk_version,
      screen_density, screen_width_dp, screen_height_dp,
      battery_pct, is_rooted, enrolled_at
    } = req.body;

    if (!borrower_id || !loan_id) {
      return res.status(400).json({ success: false, error: 'borrower_id and loan_id are required' });
    }

    // Bundle all extra device info into a JSONB object
    const device_info = {
      manufacturer: manufacturer || null,
      brand: brand || null,
      android_version: android_version || null,
      sdk_version: sdk_version || null,
      screen_density: screen_density || null,
      screen_width_dp: screen_width_dp || null,
      screen_height_dp: screen_height_dp || null,
      battery_pct: battery_pct ?? null,
      is_rooted: is_rooted ?? false,
      enrolled_at: enrolled_at ? new Date(enrolled_at).toISOString() : new Date().toISOString()
    };

    // Upsert device — onConflict resolves by borrower_id + loan_id
    const now = new Date().toISOString();
    const { data: device, error: devErr } = await supabase
      .from('devices')
      .upsert({
        borrower_id,
        loan_id,
        device_id:    device_id    || null,
        fcm_token:    fcm_token    || null,
        device_model: device_model || null,
        mpesa_phone:  mpesa_phone  || null,
        device_info,
        status:       'registered',
        last_seen:    now,          // ← ensures new device appears at top of admin panel
        updated_at:   now
      }, { onConflict: 'borrower_id,loan_id' })
      .select()
      .single();

    if (devErr) throw devErr;

    // Sync loan device_status → registered
    await supabase.from('loans')
      .update({ device_status: 'registered', updated_at: new Date().toISOString() })
      .eq('loan_id', loan_id);

    console.log(`[register] borrower=${borrower_id} model=${device_model} manufacturer=${manufacturer} android=${android_version} battery=${battery_pct}%`);
    return res.json({
      success: true,
      message: 'Device registered',
      is_locked: device.is_locked,
      lock_reason: device.lock_reason,
      amount_due: device.amount_due
    });
  } catch (err) {
    console.error('[register]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/device/heartbeat
// Core security endpoint: Scenario 3 (fingerprint check) + Scenario 4 (safe mode).
// ─────────────────────────────────────────────────────────────────────────────
router.post('/heartbeat', async (req, res) => {
  try {
    const { borrower_id, loan_id, device_id, dpc_active, is_safe_mode, battery_pct, timestamp } = req.body;
    if (!borrower_id || !loan_id) {
      return res.status(400).json({ success: false, error: 'borrower_id and loan_id are required' });
    }

    // Fetch current device record
    const { data: device, error: devErr } = await supabase
      .from('devices')
      .select('*')
      .eq('borrower_id', borrower_id)
      .eq('loan_id', loan_id)
      .maybeSingle();

    if (devErr) throw devErr;
    if (!device) return res.status(404).json({ success: false, error: 'Device not registered' });

    let action = null;
    const updates = {
      last_seen: new Date().toISOString(),
      last_heartbeat: { dpc_active, is_safe_mode, battery_pct, received_at: new Date().toISOString() },
      dpc_active: dpc_active ?? true,
      updated_at: new Date().toISOString()
    };

    // ── Scenario 3: device_id mismatch ──────────────────────────────────────
    if (device.device_id && device_id && device.device_id !== device_id) {
      console.warn(`[heartbeat] S3 MISMATCH: borrower=${borrower_id} stored=${device.device_id} got=${device_id}`);
      updates.is_locked = true;
      updates.lock_reason = 'Device fingerprint mismatch — possible SIM swap / cloning';
      updates.status = 'locked';
      action = 'TAMPER_LOCK';   // ← tells Android: TAMPER lock, no pay button

      if (device.fcm_token) await sendLockCommand(device.fcm_token, updates.lock_reason, device.amount_due, 'TAMPER');
      await logTamper(borrower_id, loan_id, EVENT_TYPES.DEVICE_MISMATCH, {
        source: 'heartbeat', device_id, auto_action: 'LOCK_DEVICE',
        detail: `Stored: ${device.device_id} | Received: ${device_id}`
      });
    }
    // ── Scenario 4: safe mode boot ───────────────────────────────────────────
    else if (is_safe_mode) {
      console.warn(`[heartbeat] S4 SAFE_MODE: borrower=${borrower_id}`);
      updates.is_locked = true;
      updates.lock_reason = 'Safe mode detected — possible bypass attempt';
      updates.status = 'locked';
      action = 'TAMPER_LOCK';   // ← tamper lock

      if (device.fcm_token) await sendLockCommand(device.fcm_token, updates.lock_reason, device.amount_due, 'TAMPER');
      await logTamper(borrower_id, loan_id, EVENT_TYPES.SAFE_MODE_DETECTED, {
        source: 'heartbeat', device_id, auto_action: 'LOCK_DEVICE'
      });
    }
    // ── Silent DPC removal ───────────────────────────────────────────────────
    else if (dpc_active === false && device.status !== 'admin_removed') {
      console.warn(`[heartbeat] Silent DPC removal: borrower=${borrower_id}`);
      updates.status = 'suspended';
      await logTamper(borrower_id, loan_id, EVENT_TYPES.ADMIN_SILENT_REMOVE, {
        source: 'heartbeat', device_id, detail: 'DPC reported inactive but no REMOVE_ADMIN command sent'
      });
    }

    // Persist heartbeat data
    await supabase.from('devices').update(updates).eq('id', device.id);

    // Also store device_id on first heartbeat if not already set
    if (!device.device_id && device_id) {
      await supabase.from('devices').update({ device_id }).eq('id', device.id);
    }

    // Derive lock_type for Android: explicit tamper action = TAMPER, else check lock_reason
    const isTamper = action === 'TAMPER_LOCK' ||
      (device.is_locked && device.lock_reason &&
        (device.lock_reason.includes('mismatch') ||
          device.lock_reason.includes('Safe mode') ||
          device.lock_reason.includes('tampering') ||
          device.lock_reason.includes('Unauthorized')));

    return res.json({
      success: true,
      action,
      locked: updates.is_locked ?? device.is_locked,
      lock_type: (updates.is_locked ?? device.is_locked)
        ? (isTamper ? 'TAMPER' : 'PAYMENT')
        : null,
      lock_reason: updates.lock_reason ?? device.lock_reason,
      amount_due: device.amount_due,
      message: action ? `Action: ${action}` : 'Heartbeat recorded'
    });
  } catch (err) {
    console.error('[heartbeat]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/device/tamper
// Called by TamperReportWorker for on-device detected events.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/tamper', async (req, res) => {
  try {
    const { borrower_id, loan_id, device_id, event_type, detail } = req.body;
    if (!borrower_id || !loan_id || !event_type) {
      return res.status(400).json({ success: false, error: 'borrower_id, loan_id and event_type are required' });
    }

    const { data: device } = await supabase
      .from('devices')
      .select('id, fcm_token, is_locked, amount_due, status')
      .eq('borrower_id', borrower_id)
      .eq('loan_id', loan_id)
      .maybeSingle();

    let action = null;

    if (event_type === EVENT_TYPES.ADMIN_REVOKED && device && !device.is_locked) {
      // Immediately re-lock on admin removal
      await supabase.from('devices').update({
        is_locked: true, status: 'locked',
        lock_reason: 'Device admin was manually removed',
        updated_at: new Date().toISOString()
      }).eq('id', device.id);

      await supabase.from('loans').update({
        device_status: 'locked', updated_at: new Date().toISOString()
      }).eq('loan_id', loan_id);

      if (device.fcm_token) {
        await sendLockCommand(device.fcm_token, 'Device admin was manually removed', device.amount_due);
      }
      action = 'LOCK_DEVICE';
    }

    await logTamper(borrower_id, loan_id, event_type, {
      source: 'device', device_id, detail: detail || null, auto_action: action
    });

    return res.json({ success: true, action, message: `Tamper event ${event_type} logged` });
  } catch (err) {
    console.error('[tamper]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/device/status
// Device acknowledges a status change.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/status', async (req, res) => {
  try {
    const { borrower_id, loan_id, status } = req.body;
    const VALID = ['registered', 'active', 'locked', 'admin_removed', 'suspended'];
    if (!VALID.includes(status)) {
      return res.status(400).json({ success: false, error: `Invalid status. Must be one of: ${VALID.join(', ')}` });
    }
    await supabase.from('devices')
      .update({ status, updated_at: new Date().toISOString() })
      .eq('borrower_id', borrower_id)
      .eq('loan_id', loan_id);

    await supabase.from('loans')
      .update({ device_status: status, updated_at: new Date().toISOString() })
      .eq('loan_id', loan_id);

    return res.json({ success: true, message: `Status updated to ${status}` });
  } catch (err) {
    console.error('[status]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/device/fcm-token
// Called when KopanowFCMService.onNewToken() fires.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/fcm-token', async (req, res) => {
  try {
    const { borrower_id, fcm_token } = req.body;
    if (!borrower_id || !fcm_token) {
      return res.status(400).json({ success: false, error: 'borrower_id and fcm_token are required' });
    }
    const { error } = await supabase.from('devices')
      .update({ fcm_token, updated_at: new Date().toISOString() })
      .eq('borrower_id', borrower_id);

    if (error) throw error;
    return res.json({ success: true, message: 'FCM token updated' });
  } catch (err) {
    console.error('[fcm-token]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;

