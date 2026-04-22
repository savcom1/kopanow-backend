/**
 * Canonicalize noisy Android build model strings into stable families.
 *
 * Goal: group close variants so they get the same MKOPO logic and consistent reporting.
 * Example: SM-A0556 / SM-A0567 -> "Samsung A05"
 */
'use strict';

function canonicalizeDeviceModel({ manufacturer, brand, model }) {
  const mo = (model || '').toString().trim();
  if (!mo) return '';

  const man = (manufacturer || '').toString();
  const br = (brand || '').toString();

  const isSamsung =
    /^SM-/i.test(mo) || /samsung/i.test(man) || /samsung/i.test(br);
  if (isSamsung) {
    const m = mo.match(/^SM-([A-Z])(\d{2}).*/i);
    if (m) {
      const letter = String(m[1]).toUpperCase();
      const two = String(m[2]);
      return `Samsung ${letter}${two}`;
    }
  }

  return '';
}

module.exports = { canonicalizeDeviceModel };

