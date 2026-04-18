'use strict';

/**
 * AzamPay — OAuth token + MNO checkout (Vodacom M-Pesa, Tigo, Airtel, etc.)
 *
 * Credentials MUST be set via environment variables (never commit .env).
 * @see https://developers.azampay.co.tz
 */

const SANDBOX_DEFAULT = process.env.AZAMPAY_SANDBOX !== 'false';

const AUTH_URL =
  process.env.AZAMPAY_AUTH_URL ||
  (SANDBOX_DEFAULT
    ? 'https://authenticator-sandbox.azampay.co.tz/AppRegistration/GenerateToken'
    : 'https://authenticator.azampay.co.tz/AppRegistration/GenerateToken');

const CHECKOUT_BASE =
  process.env.AZAMPAY_CHECKOUT_BASE ||
  (SANDBOX_DEFAULT ? 'https://sandbox.azampay.co.tz' : 'https://checkout.azampay.co.tz');

const MNO_PATH = '/azampay/mno/checkout';

/** In-memory token cache */
let cachedAccessToken = null;
let tokenExpiresAtMs = 0;

function isConfigured() {
  return !!(
    process.env.AZAMPAY_APP_NAME &&
    process.env.AZAMPAY_CLIENT_ID &&
    process.env.AZAMPAY_CLIENT_SECRET &&
    process.env.AZAMPAY_API_KEY
  );
}

function configError() {
  return new Error(
    'AzamPay is not configured. Set AZAMPAY_APP_NAME, AZAMPAY_CLIENT_ID, AZAMPAY_CLIENT_SECRET, AZAMPAY_API_KEY (and optionally AZAMPAY_SANDBOX=false for production).'
  );
}

/**
 * @returns {Promise<string>}
 */
async function getAccessToken() {
  if (!isConfigured()) throw configError();

  const now = Date.now();
  if (cachedAccessToken && now < tokenExpiresAtMs - 60_000) {
    return cachedAccessToken;
  }

  const body = JSON.stringify({
    appName: process.env.AZAMPAY_APP_NAME,
    clientId: process.env.AZAMPAY_CLIENT_ID,
    clientSecret: process.env.AZAMPAY_CLIENT_SECRET,
  });

  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body,
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(
      json.message || json.error || `AzamPay token HTTP ${res.status}: ${JSON.stringify(json)}`
    );
  }

  const token = json.data?.accessToken;
  if (!token) {
    throw new Error(json.message || 'AzamPay token response missing data.accessToken');
  }

  cachedAccessToken = token;

  const exp = json.data?.expire;
  if (exp) {
    const t = new Date(exp).getTime();
    tokenExpiresAtMs = Number.isFinite(t) ? t : now + 50 * 60_000;
  } else {
    tokenExpiresAtMs = now + 50 * 60_000;
  }

  return token;
}

/**
 * Normalize Tanzania MSISDN to digits starting with 255 (no +).
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeMsisdn(raw) {
  if (raw == null || raw === '') return null;
  let p = String(raw).replace(/\D/g, '');
  if (p.startsWith('0')) p = '255' + p.slice(1);
  if (p.length === 9) p = '255' + p;
  if (!p.startsWith('255') || p.length < 12) return null;
  return p;
}

/**
 * Trigger mobile-money STK-style push (AzamPay MNO checkout).
 *
 * @param {object} opts
 * @param {string} opts.accountNumber - 2557XXXXXXXXX
 * @param {string} opts.amountTzs - integer amount as string (API expects string)
 * @param {string} opts.externalId - unique id (max 128 chars)
 * @param {string} [opts.provider] - e.g. Mpesa, Tigo, Airtel, Halopesa, Azampesa
 * @returns {Promise<{ success: boolean, transactionId?: string, message?: string, raw?: object }>}
 */
async function mnoCheckout({ accountNumber, amountTzs, externalId, provider = 'Mpesa' }) {
  if (!isConfigured()) throw configError();

  const token = await getAccessToken();
  const url = `${CHECKOUT_BASE}${MNO_PATH}`;

  const payload = {
    accountNumber,
    amount: String(amountTzs),
    currency: 'TZS',
    externalId: externalId.slice(0, 128),
    provider,
    additionalProperties: {},
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'X-API-Key': process.env.AZAMPAY_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  const json = await res.json().catch(() => ({}));

  if (!res.ok) {
    const msg =
      json.message ||
      json.title ||
      json.error ||
      (json.errors && JSON.stringify(json.errors)) ||
      `AzamPay checkout HTTP ${res.status}`;
    throw new Error(msg);
  }

  return {
    success: !!json.success,
    transactionId: json.transactionId || json.transactionID || null,
    message: json.message || null,
    raw: json,
  };
}

module.exports = {
  isConfigured,
  getAccessToken,
  normalizeMsisdn,
  mnoCheckout,
  AUTH_URL,
  CHECKOUT_BASE,
};
