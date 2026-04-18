'use strict';
const express = require('express');
const router = express.Router();
const supabase = require('../helpers/supabase');
const { assertDeviceFreeForEnrollment } = require('../helpers/deviceEnrollment');
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
// POST /api/device/enrollment-check
//
// Call from the app **before** showing the device-admin screen so the user is not
// asked for admin if Supabase already has this device_id on another loan.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/enrollment-check', async (req, res) => {
  try {
    const { device_id, borrower_id, loan_id } = req.body || {};
    const result = await assertDeviceFreeForEnrollment(device_id, borrower_id, loan_id);
    if (!result.ok) {
      return res.json({
        success: true,
        allowed: false,
        reason: result.reason,
      });
    }
    return res.json({ success: true, allowed: true });
  } catch (err) {
    console.error('[enrollment-check]', err.message);
    return res.status(500).json({
      success: false,
      allowed: false,
      reason: 'Server error while checking enrollment',
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/device/register
// Called by EnrollmentManager after device admin is granted.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const {
      borrower_id, loan_id, fcm_token, device_model, device_id, mpesa_phone,
      manufacturer, brand, android_version, sdk_version,
      screen_density, screen_width_dp, screen_height_dp,
      battery_pct, is_rooted, enrolled_at
    } = req.body;

    if (!borrower_id || !loan_id) {
      return res.status(400).json({ success: false, error: 'borrower_id and loan_id are required' });
    }

    const enrollment = await assertDeviceFreeForEnrollment(device_id, borrower_id, loan_id);
    if (!enrollment.ok) {
      return res.status(403).json({ success: false, error: enrollment.reason });
    }

    const { data: existingRow } = await supabase
      .from('devices')
      .select('device_info')
      .eq('borrower_id', borrower_id)
      .eq('loan_id', loan_id)
      .maybeSingle();

    const prevInfo =
      existingRow?.device_info && typeof existingRow.device_info === 'object'
        ? existingRow.device_info
        : {};

    const enrolledAtIso = enrolled_at ? new Date(enrolled_at).toISOString() : new Date().toISOString();

    // Merge so loan_registration snapshot (build_product, etc.) is not wiped at MDM enroll
    const device_info = {
      ...prevInfo,
      manufacturer: manufacturer ?? prevInfo.manufacturer ?? null,
      brand: brand ?? prevInfo.brand ?? null,
      android_version: android_version ?? prevInfo.android_version ?? null,
      sdk_version: sdk_version ?? prevInfo.sdk_version ?? null,
      screen_density: screen_density ?? prevInfo.screen_density ?? null,
      screen_width_dp: screen_width_dp ?? prevInfo.screen_width_dp ?? null,
      screen_height_dp: screen_height_dp ?? prevInfo.screen_height_dp ?? null,
      battery_pct: battery_pct ?? prevInfo.battery_pct ?? null,
      is_rooted: is_rooted ?? prevInfo.is_rooted ?? false,
      enrolled_at: enrolledAtIso,
      mdm_enrolled_at: enrolledAtIso
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
        dpc_active:   true,
        last_seen:    now,
        updated_at:   now
      }, { onConflict: 'borrower_id,loan_id' })
      .select()
      .single();

    if (devErr) throw devErr;

    // Sync loan device_status → registered
    await supabase.from('loans')
      .update({ device_status: 'registered', updated_at: new Date().toISOString() })
      .eq('loan_id', loan_id);

    console.log(`[register] borrower=${borrower_id} model=${device_model} registered successfully`);
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
// ─────────────────────────────────────────────────────────────────────────────
router.post('/heartbeat', async (req, res) => {
  try {
    const {
      borrower_id, loan_id, device_id, dpc_active, is_safe_mode, battery_pct, timestamp,
      mdm_compliance: mdmCompliance,
      /** When false, device reports no lock UI / passcode — reconcile stale DB `is_locked` + loan row. */
      app_lock_active: appLockActive,
    } = req.body;
    if (!borrower_id || !loan_id) {
      return res.status(400).json({ success: false, error: 'borrower_id and loan_id are required' });
    }

    const { data: device, error: devErr } = await supabase
      .from('devices')
      .select('*')
      .eq('borrower_id', borrower_id)
      .eq('loan_id', loan_id)
      .maybeSingle();

    if (devErr) throw devErr;
    if (!device) return res.status(404).json({ success: false, error: 'Device not registered' });

    let action = null;
    const receivedAt = new Date().toISOString();
    const lastHb = {
      dpc_active,
      is_safe_mode,
      battery_pct,
      received_at: receivedAt,
    };
    if (mdmCompliance && typeof mdmCompliance === 'object') {
      lastHb.mdm_compliance = mdmCompliance;
    }

    const updates = {
      last_seen: receivedAt,
      last_heartbeat: lastHb,
      dpc_active: dpc_active ?? true,
      updated_at: new Date().toISOString(),
    };
    if (mdmCompliance && typeof mdmCompliance === 'object') {
      updates.mdm_compliance = mdmCompliance;
    }

    if (device.device_id && device_id && device.device_id !== device_id) {
      updates.is_locked = true;
      updates.lock_reason = 'Device fingerprint mismatch — possible SIM swap / cloning';
      updates.status = 'locked';
      action = 'LOCK';

      if (device.fcm_token) await sendLockCommand(device.fcm_token, updates.lock_reason, device.amount_due, 'TAMPER');
      await logTamper(borrower_id, loan_id, EVENT_TYPES.DEVICE_MISMATCH, {
        source: 'heartbeat', device_id, auto_action: 'LOCK_DEVICE',
        detail: `Stored: ${device.device_id} | Received: ${device_id}`
      });
    }
    else if (is_safe_mode) {
      updates.is_locked = true;
      updates.lock_reason = 'Safe mode detected — possible bypass attempt';
      updates.status = 'locked';
      action = 'LOCK';

      if (device.fcm_token) await sendLockCommand(device.fcm_token, updates.lock_reason, device.amount_due, 'TAMPER');
      await logTamper(borrower_id, loan_id, EVENT_TYPES.SAFE_MODE_DETECTED, {
        source: 'heartbeat', device_id, auto_action: 'LOCK_DEVICE'
      });
    }
    else if (dpc_active === false && device.status !== 'admin_removed') {
      updates.status = 'suspended';
      await logTamper(borrower_id, loan_id, EVENT_TYPES.ADMIN_SILENT_REMOVE, {
        source: 'heartbeat', device_id, detail: 'DPC reported inactive but no REMOVE_ADMIN command sent'
      });
    }
    else if (dpc_active && device.status === 'registered') {
      updates.status = 'active';
    }

    // Reconcile: DB often stays `locked` after FCM unlock / Clear PIN because only passcode columns were cleared.
    // Trust the device when it reports no active lock and this request did not force a tamper lock.
    const serverForcedLock =
      (device.device_id && device_id && device.device_id !== device_id) || !!is_safe_mode;

    if (
      !serverForcedLock &&
      appLockActive === false &&
      dpc_active !== false &&
      device.status !== 'admin_removed'
    ) {
      updates.is_locked = false;
      updates.lock_reason = null;
      if (device.status === 'locked') {
        updates.status = 'active';
      }
      await supabase.from('loans').update({
        device_status: 'active',
        updated_at: new Date().toISOString(),
      }).eq('loan_id', loan_id);
    }

    await supabase.from('devices').update(updates).eq('id', device.id);

    if (!device.device_id && device_id) {
      await supabase.from('devices').update({ device_id }).eq('id', device.id);
    }

    const { data: invoices } = await supabase
      .from('loan_invoices')
      .select(
        'invoice_number, installment_index, borrower_name, amount_due, due_date, status, paid_at'
      )
      .eq('loan_id', loan_id)
      .order('installment_index', { ascending: true });

    const { data: rowAfter } = await supabase
      .from('devices')
      .select('is_locked, lock_reason, amount_due')
      .eq('id', device.id)
      .maybeSingle();

    const lockedOut = rowAfter?.is_locked ?? false;

    const isTamper = action === 'TAMPER_LOCK' ||
      (lockedOut && rowAfter?.lock_reason &&
        (rowAfter.lock_reason.includes('mismatch') ||
          rowAfter.lock_reason.includes('Safe mode') ||
          rowAfter.lock_reason.includes('tampering') ||
          rowAfter.lock_reason.includes('Unauthorized')));

    return res.json({
      success: true,
      action,
      locked: lockedOut,
      lock_type: lockedOut ? (isTamper ? 'TAMPER' : 'PAYMENT') : null,
      lock_reason: rowAfter?.lock_reason ?? null,
      amount_due: rowAfter?.amount_due ?? null,
      invoices: invoices || [],
      message: action ? `Action: ${action}` : 'Heartbeat recorded'
    });
  } catch (err) {
    console.error('[heartbeat]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/device/tamper
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/device/details
// ─────────────────────────────────────────────────────────────────────────────
router.get('/details', async (req, res) => {
  try {
    const { borrower_id, loan_id } = req.query;
    if (!borrower_id || !loan_id) {
      return res.status(400).json({ success: false, error: 'borrower_id and loan_id are required' });
    }

    const { data: loan, error } = await supabase
      .from('loans')
      .select('outstanding_amount, next_due_date, device_status')
      .eq('loan_id', loan_id)
      .maybeSingle();

    if (error) throw error;
    if (!loan) return res.status(404).json({ success: false, error: 'Loan not found' });

    const due = loan.next_due_date ? new Date(loan.next_due_date).toLocaleDateString('en-TZ', {
      day: 'numeric', month: 'short', year: 'numeric'
    }) : null;

    return res.json({
      success:       true,
      loan_status:   loan.device_status || 'active',
      balance:       loan.outstanding_amount != null
                       ? `TSh ${Number(loan.outstanding_amount).toLocaleString()}` : null,
      next_due_date: due,
      message:       'Loan details fetched'
    });
  } catch (err) {
    console.error('[device:details]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
