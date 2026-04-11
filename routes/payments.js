'use strict';
const express  = require('express');
const router   = express.Router();
const supabase = require('../helpers/supabase');
const { logTamper, EVENT_TYPES } = require('../helpers/tamperLog');
const { sendUnlockCommand, sendRemoveAdminCommand } = require('../helpers/fcm');

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/mpesa/stk-push
// Initiate M-Pesa STK push to borrower's phone.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/stk-push', async (req, res) => {
  try {
    const { borrower_id, loan_id, amount } = req.body;
    if (!borrower_id || !loan_id || !amount) {
      return res.status(400).json({ success: false, error: 'borrower_id, loan_id and amount are required' });
    }

    // Fetch device for M-Pesa phone
    const { data: device } = await supabase
      .from('devices')
      .select('mpesa_phone, last_checkout_request_id')
      .eq('borrower_id', borrower_id)
      .eq('loan_id', loan_id)
      .maybeSingle();

    const phone = device?.mpesa_phone;
    if (!phone) {
      return res.status(400).json({ success: false, error: 'No M-Pesa phone registered for this device' });
    }

    // TODO: Replace stub with live Vodacom M-Pesa Tanzania API call
    const checkoutRequestId = `ws_CO_${Date.now()}_${borrower_id}`;

    // Store checkout request ID for callback matching
    await supabase.from('devices')
      .update({ last_checkout_request_id: checkoutRequestId, updated_at: new Date().toISOString() })
      .eq('borrower_id', borrower_id)
      .eq('loan_id', loan_id);

    console.log(`[stk-push] borrower=${borrower_id} phone=${phone} amount=${amount} ckReqId=${checkoutRequestId}`);
    return res.json({
      success: true,
      checkout_request_id: checkoutRequestId,
      message: `STK push sent to ${phone} for TZS ${amount}`
    });
  } catch (err) {
    console.error('[stk-push]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/mpesa/callback
// Idempotent M-Pesa callback handler.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/callback', async (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) return res.status(400).json({ success: false, error: 'Invalid callback format' });

    // Non-zero ResultCode = cancelled / failed — no action
    if (callback.ResultCode !== 0) {
      console.log(`[callback] STK failed: ${callback.ResultDesc}`);
      return res.json({ success: true, message: 'Callback acknowledged (non-zero result)' });
    }

    const items = callback.CallbackMetadata?.Item || [];
    const get   = (name) => items.find(i => i.Name === name)?.Value;

    const mpesaRef = get('MpesaReceiptNumber');
    const amount   = get('Amount');
    const phone    = String(get('PhoneNumber') || '');

    if (!mpesaRef || !amount) {
      return res.status(400).json({ success: false, error: 'Missing MpesaReceiptNumber or Amount' });
    }

    // Idempotency check
    const { data: existing } = await supabase
      .from('payments')
      .select('id, is_processed')
      .eq('mpesa_ref', mpesaRef)
      .maybeSingle();

    if (existing?.is_processed) {
      console.log(`[callback] Duplicate payment ${mpesaRef} — skipped`);
      return res.json({ success: true, message: 'Already processed' });
    }

    // Match device by phone number (Tanzania format: 255...)
    const { data: device } = await supabase
      .from('devices')
      .select('id, borrower_id, loan_id, fcm_token, is_locked, amount_due')
      .eq('mpesa_phone', `255${phone.toString().slice(-9)}`)
      .maybeSingle();

    if (!device) {
      console.warn(`[callback] No device found for phone ${phone}`);
      return res.json({ success: true, message: 'Device not found — payment logged only' });
    }

    // Fetch loan
    const { data: loan } = await supabase
      .from('loans')
      .select('id, outstanding_amount')
      .eq('loan_id', device.loan_id)
      .maybeSingle();

    // Record payment
    const newOutstanding = Math.max(0, (loan?.outstanding_amount || 0) - amount);
    await supabase.from('payments').upsert({
      mpesa_ref:    mpesaRef,
      loan_id:      device.loan_id,
      borrower_id:  device.borrower_id,
      amount,
      paid_at:      new Date().toISOString(),
      is_processed: true,
      raw_callback: callback
    }, { onConflict: 'mpesa_ref' });

    // Update loan outstanding
    if (loan) {
      await supabase.from('loans').update({
        outstanding_amount: newOutstanding,
        device_status: newOutstanding <= 0 ? 'admin_removed' : 'active',
        updated_at: new Date().toISOString()
      }).eq('id', loan.id);
    }

    // FCM action
    if (newOutstanding <= 0) {
      // Fully paid — remove device admin
      if (device.fcm_token) await sendRemoveAdminCommand(device.fcm_token);
      await supabase.from('devices').update({
        is_locked: false, status: 'admin_removed',
        lock_reason: null, amount_due: null,
        updated_at: new Date().toISOString()
      }).eq('id', device.id);
      await logTamper(device.borrower_id, device.loan_id, EVENT_TYPES.PAYMENT_RECEIVED, {
        source: 'mpesa', detail: `Full repayment TZS ${amount} (ref: ${mpesaRef})`, auto_action: 'REMOVE_ADMIN'
      });
    } else {
      // Partial payment — unlock if locked
      if (device.is_locked && device.fcm_token) await sendUnlockCommand(device.fcm_token);
      await supabase.from('devices').update({
        is_locked: false, status: 'active',
        amount_due: `TZS ${newOutstanding.toLocaleString()}`,
        updated_at: new Date().toISOString()
      }).eq('id', device.id);
      await logTamper(device.borrower_id, device.loan_id, EVENT_TYPES.PAYMENT_RECEIVED, {
        source: 'mpesa', detail: `Partial TZS ${amount}, remaining TZS ${newOutstanding} (ref: ${mpesaRef})`,
        auto_action: 'UNLOCK_DEVICE'
      });
    }

    console.log(`[callback] ✓ ${mpesaRef} TZS ${amount} → borrower=${device.borrower_id} remaining=${newOutstanding}`);
    return res.json({ success: true, mpesa_ref: mpesaRef, remaining: newOutstanding });
  } catch (err) {
    console.error('[callback]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
