'use strict';
const express = require('express');
const router = express.Router();
const supabase = require('../helpers/supabase');
const { attemptAutoMatchIncomingLipa } = require('../helpers/lipaPayment');

/**
 * POST /api/lipa/transactions
 *
 * Called by your SMS-fetcher app when a new M-Pesa Lipa message is parsed.
 * Header: X-Lipa-Ingest-Secret: <LIPA_INGEST_SECRET> (set in Render/.env)
 *
 * Body JSON:
 *   transaction_ref  (required) — M-Pesa confirmation / receipt ID
 *   amount            (required) — TZS
 *   payer_phone       (required) — payer MSISDN (any format; normalized to 255…)
 *   till_number       (optional) — e.g. 8681154
 *   raw_sms           (optional) — full SMS text for audit
 */
router.post('/transactions', async (req, res) => {
  try {
    const secret = req.headers['x-lipa-ingest-secret'] || '';
    const expected = process.env.LIPA_INGEST_SECRET || '';
    if (!expected || secret !== expected) {
      return res.status(401).json({ success: false, error: 'Invalid or missing X-Lipa-Ingest-Secret' });
    }

    const { transaction_ref, amount, payer_phone, till_number, raw_sms } = req.body || {};
    if (!transaction_ref || amount == null || !payer_phone) {
      return res.status(400).json({
        success: false,
        error: 'transaction_ref, amount, and payer_phone are required',
      });
    }

    const ref = String(transaction_ref).trim().toUpperCase();
    if (!/^[A-Z0-9]{6,20}$/.test(ref)) {
      return res.status(400).json({ success: false, error: 'Invalid transaction_ref format' });
    }

    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: 'Invalid amount' });
    }

    const { data: existing } = await supabase
      .from('lipa_transactions')
      .select('*')
      .eq('transaction_ref', ref)
      .maybeSingle();

    if (existing?.claimed_borrower_id) {
      return res.json({
        success: true,
        duplicate: true,
        message: 'Transaction already processed',
        auto_matched: false,
      });
    }

    let row;
    if (existing) {
      const { data: upd, error: uErr } = await supabase
        .from('lipa_transactions')
        .update({
          amount: amt,
          payer_phone: String(payer_phone).trim(),
          till_number: till_number != null ? String(till_number) : null,
          raw_sms: raw_sms != null ? String(raw_sms) : null,
          ingested_at: new Date().toISOString(),
        })
        .eq('id', existing.id)
        .select()
        .single();
      if (uErr) throw uErr;
      row = upd;
    } else {
      const { data: ins, error: iErr } = await supabase
        .from('lipa_transactions')
        .insert({
          transaction_ref: ref,
          amount: amt,
          payer_phone: String(payer_phone).trim(),
          till_number: till_number != null ? String(till_number) : null,
          raw_sms: raw_sms != null ? String(raw_sms) : null,
          source: 'sms',
        })
        .select()
        .single();
      if (iErr) throw iErr;
      row = ins;
    }

    const match = await attemptAutoMatchIncomingLipa(row);

    return res.json({
      success: true,
      transaction_ref: ref,
      auto_matched: match.matched === true,
      match_detail: match.matched ? { borrower_id: match.borrower_id, loan_id: match.loan_id } : match,
    });
  } catch (err) {
    console.error('[lipa/transactions]', err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

module.exports = router;
