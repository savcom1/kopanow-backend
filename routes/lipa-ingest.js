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
 *   lipa_channel, transaction_occurred_at, payer_display_name, till_contract_name,
 *   transaction_id_alt, field_details_text, sms_concatenated_body, new_balance_after_tzs,
 *   provider_tail, parsed_payload (optional) — see lipa_transactions columns / migrations
 */
router.post('/transactions', async (req, res) => {
  try {
    const secret = req.headers['x-lipa-ingest-secret'] || '';
    const expected = process.env.LIPA_INGEST_SECRET || '';
    if (!expected || secret !== expected) {
      return res.status(401).json({ success: false, error: 'Invalid or missing X-Lipa-Ingest-Secret' });
    }

    const b = req.body || {};
    const {
      transaction_ref,
      amount,
      payer_phone,
      till_number,
      raw_sms,
      lipa_channel,
      transaction_occurred_at,
      payer_display_name,
      till_contract_name,
      transaction_id_alt,
      field_details_text,
      sms_concatenated_body,
      new_balance_after_tzs,
      provider_tail,
      parsed_payload,
    } = b;
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
    const extraFields = () => ({
      lipa_channel: lipa_channel != null ? String(lipa_channel).trim() : null,
      transaction_occurred_at: transaction_occurred_at
        ? new Date(transaction_occurred_at).toISOString()
        : null,
      payer_display_name: payer_display_name != null ? String(payer_display_name).trim() : null,
      till_contract_name: till_contract_name != null ? String(till_contract_name).trim() : null,
      transaction_id_alt: transaction_id_alt != null ? String(transaction_id_alt).trim() : null,
      field_details_text: field_details_text != null ? String(field_details_text) : null,
      sms_concatenated_body: sms_concatenated_body != null ? String(sms_concatenated_body) : null,
      new_balance_after_tzs:
        new_balance_after_tzs != null && Number.isFinite(Number(new_balance_after_tzs))
          ? Number(new_balance_after_tzs)
          : null,
      provider_tail: provider_tail != null ? String(provider_tail).trim() : null,
      parsed_payload:
        parsed_payload != null && typeof parsed_payload === 'object'
          ? parsed_payload
          : {},
    });

    if (existing) {
      const { data: upd, error: uErr } = await supabase
        .from('lipa_transactions')
        .update({
          amount: amt,
          payer_phone: String(payer_phone).trim(),
          till_number: till_number != null ? String(till_number) : null,
          raw_sms: raw_sms != null ? String(raw_sms) : null,
          ingested_at: new Date().toISOString(),
          ...extraFields(),
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
          ...extraFields(),
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
