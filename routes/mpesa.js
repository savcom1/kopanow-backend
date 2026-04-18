'use strict';

/**
 * POST /api/mpesa/stk-push
 *
 * Initiates an AzamPay MNO checkout (mobile money prompt on the borrower's phone).
 * Replaces legacy direct M-Pesa STK; client app URL path is unchanged for compatibility.
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const supabase = require('../helpers/supabase');
const azampay = require('../helpers/azampay');

router.post('/stk-push', async (req, res) => {
  try {
    if (!azampay.isConfigured()) {
      console.warn('[mpesa/stk-push] AzamPay env vars missing');
      return res.status(503).json({
        success: false,
        message: 'Payment gateway is not configured on the server.',
      });
    }

    const { borrower_id, loan_id, amount, timestamp } = req.body;

    if (!borrower_id || !loan_id || amount == null) {
      return res.status(400).json({
        success: false,
        message: 'borrower_id, loan_id and amount are required',
      });
    }

    const amountNum = Math.round(Number(amount));
    if (!Number.isFinite(amountNum) || amountNum < 100) {
      return res.status(400).json({
        success: false,
        message: 'amount must be at least 100 TZS',
      });
    }

    const { data: device, error: devErr } = await supabase
      .from('devices')
      .select('id, mpesa_phone, borrower_id, loan_id')
      .eq('borrower_id', borrower_id)
      .eq('loan_id', loan_id)
      .maybeSingle();

    if (devErr) throw devErr;
    if (!device) {
      return res.status(404).json({ success: false, message: 'Device not registered for this loan' });
    }

    let phone = device.mpesa_phone || null;
    if (!phone) {
      const { data: reg } = await supabase
        .from('registrations')
        .select('phone')
        .eq('borrower_id', borrower_id)
        .maybeSingle();
      phone = reg?.phone || null;
    }

    const msisdn = azampay.normalizeMsisdn(phone);
    if (!msisdn) {
      return res.status(400).json({
        success: false,
        message:
          'No valid phone number on file. Complete device registration with an M-Pesa / mobile money number (255…).',
      });
    }

    const externalId = `kw-${loan_id}-${timestamp || Date.now()}-${crypto.randomBytes(4).toString('hex')}`.slice(
      0,
      128
    );

    const provider = (req.body.provider || process.env.AZAMPAY_DEFAULT_PROVIDER || 'Mpesa').toString();

    const result = await azampay.mnoCheckout({
      accountNumber: msisdn,
      amountTzs: String(amountNum),
      externalId,
      provider,
    });

    const ok = result.success || !!result.transactionId;
    if (!ok) {
      return res.status(502).json({
        success: false,
        message: result.message || 'AzamPay checkout did not return success',
      });
    }

    console.log(
      `[mpesa/stk-push] AzamPay OK borrower=${borrower_id} loan=${loan_id} ext=${externalId} tx=${result.transactionId}`
    );

    return res.json({
      success: true,
      checkout_request_id: result.transactionId || externalId,
      message: result.message || 'Payment prompt sent. Approve on your phone.',
    });
  } catch (err) {
    console.error('[mpesa/stk-push]', err.message);
    return res.status(500).json({
      success: false,
      message: err.message || 'Payment initiation failed',
    });
  }
});

module.exports = router;
