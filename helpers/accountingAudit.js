'use strict';

const supabase = require('./supabase');

/**
 * @param {object} opts
 * @param {string} opts.actor
 * @param {string} opts.entity_type registration | loan | loan_invoice
 * @param {string} opts.entity_id
 * @param {string} opts.action
 * @param {object|null} [opts.before]
 * @param {object|null} [opts.after]
 * @param {string|null} [opts.reason]
 */
async function logAccountingAudit(opts) {
  const { actor, entity_type, entity_id, action, before, after, reason } = opts;
  const { error } = await supabase.from('accounting_audit_log').insert({
    actor: String(actor || 'unknown').slice(0, 200),
    entity_type: String(entity_type).slice(0, 80),
    entity_id: String(entity_id).slice(0, 200),
    action: String(action).slice(0, 120),
    before_json: before ?? null,
    after_json: after ?? null,
    reason: reason != null ? String(reason).slice(0, 2000) : null,
  });
  if (error) console.error('[accountingAudit]', error.message);
}

module.exports = { logAccountingAudit };
