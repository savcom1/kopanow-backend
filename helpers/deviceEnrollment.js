'use strict';

const supabase = require('./supabase');

/**
 * One physical device (device_id) may only be linked to a single Kopanow enrollment
 * (borrower_id + loan_id). Re-syncing the same enrollment is allowed.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
async function assertDeviceFreeForEnrollment(device_id, borrower_id, loan_id) {
  const id = device_id != null ? String(device_id).trim() : '';
  if (!id) {
    return { ok: false, reason: 'Missing device identifier — cannot verify enrollment.' };
  }
  if (!borrower_id || !loan_id) {
    return { ok: false, reason: 'borrower_id and loan_id are required.' };
  }

  const { data: rows, error } = await supabase
    .from('devices')
    .select('borrower_id, loan_id')
    .eq('device_id', id);

  if (error) throw error;

  const conflict = (rows || []).find(
    (r) => r.borrower_id !== borrower_id || r.loan_id !== loan_id
  );
  if (conflict) {
    console.warn(
      `[enrollment] BLOCK device_id=${id} already linked to borrower=${conflict.borrower_id} loan=${conflict.loan_id}`
    );
    return {
      ok: false,
      reason:
        'This device is already enrolled in Kopanow under another loan. One device cannot be used for two loans.',
    };
  }
  return { ok: true };
}

module.exports = { assertDeviceFreeForEnrollment };
