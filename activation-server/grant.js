'use strict';
/**
 * Email grants — a licence issued ONLINE to a registered email address.
 *
 * The customer types only their email. The service looks the email up in its
 * customer list, signs a grant for THIS install id, and the box stores that
 * grant exactly as it would store a pasted key: the same STK1 format, the same
 * offline verification (license.js), the same daily activation check. Nothing
 * about how a box trades depends on this service being reachable.
 *
 * The grant is signed with a DEDICATED key pair, never the offline issuer key:
 * only its PUBLIC half is baked into license.js / verify.js. If the private
 * half ever leaked, one key is rotated, not the fleet.
 *
 * This file must have no dependencies and must never import from the parent.
 */

const crypto = require('crypto');

const PREFIX = 'STK1';

// Product names the customer list uses - mirrors license.js PRODUCTS.
const PRODUCTS = {
  gsheet_only:   { features: ['gsheet'],             suppress: ['stockkar'] },
  stockkar_only: { features: ['stockkar'],           suppress: [] },
  both:          { features: ['stockkar', 'gsheet'], suppress: [] },
};
const KNOWN_FEATURES = ['stockkar', 'gsheet', 'multibroker'];

const isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const todayStr = (now) => (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Lower-cased, trimmed; '' when it is not an email at all. */
function normalizeEmail(v) {
  const e = String(v == null ? '' : v).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254 ? e : '';
}

/** The licence id an email maps to - stable, so revoke / release / activate all key on it. */
function emailKeyId(email) {
  return 'eml_' + crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 12);
}

/** The signing key from STOCKKAR_GRANT_PRIVATE_KEY: PEM, or one-line base64 PKCS8 DER. Null when unset or unusable. */
function loadPrivateKey(env = process.env) {
  const raw = String((env && env.STOCKKAR_GRANT_PRIVATE_KEY) || '').trim();
  if (!raw) return null;
  try {
    if (/^-----BEGIN/.test(raw)) return crypto.createPrivateKey({ key: raw, format: 'pem' });
    return crypto.createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' });
  } catch { return null; }
}

/** One customer-list row -> a stored customer record. Returns null when the row is unusable. */
function customerFromRow(r) {
  const email = normalizeEmail(r && r.email);
  if (!email) return null;
  const product = PRODUCTS[String(r.product || '').trim()] ? String(r.product).trim() : 'stockkar_only';
  const explicit = Array.isArray(r.features) ? r.features : String(r.features || '').split(/[,;\s]+/).filter(Boolean);
  const addons = Array.isArray(r.addons) ? r.addons : String(r.addons || '').split(/[,;\s]+/).filter(Boolean);
  const base = explicit.length ? explicit : PRODUCTS[product].features;
  const features = [...new Set([...base, ...addons])].filter(f => KNOWN_FEATURES.includes(f));
  if (!features.length) return null;
  const suppress = (Array.isArray(r.suppress) ? r.suppress : (explicit.length ? [] : PRODUCTS[product].suppress))
    .filter(f => KNOWN_FEATURES.includes(f) && !features.includes(f));
  const expRaw = String(r.exp || '').trim();
  const exp = /^(lifetime|none|never|)$/i.test(expRaw) ? '' : expRaw;
  if (exp && !isDateStr(exp)) return null;
  const maxAccounts = Number(r.maxAccounts) > 0 ? Math.floor(Number(r.maxAccounts)) : 0;
  return {
    email, name: String(r.name || '').trim().slice(0, 120), product, features, suppress, exp, maxAccounts,
    notes: String(r.notes || '').trim().slice(0, 200),
  };
}

/** The signed payload for one customer on one box. Same shape as an issued key, plus the email. */
function customerPayload(cust, installId, now) {
  const p = {
    v: 1,
    id: emailKeyId(cust.email),
    to: cust.name || cust.email,
    email: cust.email,
    product: cust.product,
    features: cust.features.slice(),
    suppress: (cust.suppress || []).slice(),
    bind: { type: 'installId', value: String(installId || '') },
    iat: todayStr(now),
    grant: 'email',
  };
  if (cust.exp) p.exp = cust.exp;                      // absent = lifetime
  if (cust.maxAccounts) p.maxAccounts = cust.maxAccounts;
  return p;
}

function signGrant(payload, privateKey) {
  const seg = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(seg, 'utf8'), privateKey);
  return PREFIX + '.' + seg + '.' + b64urlEncode(sig);
}

module.exports = { PRODUCTS, KNOWN_FEATURES, normalizeEmail, emailKeyId, loadPrivateKey, customerFromRow, customerPayload, signGrant, todayStr };
