'use strict';
/**
 * Identity grants — a licence issued ONLINE to a registered customer, who
 * types either their EMAIL or their MOBILE NUMBER and nothing else.
 *
 * The customer types only that. The service looks the value up in its customer
 * list, signs a grant for THIS install id, and the box stores that grant
 * exactly as it would store a pasted key: the same STK1 format, the same
 * offline verification (license.js), the same daily activation check. Nothing
 * about how a box trades depends on this service being reachable.
 *
 * ONE CUSTOMER, ONE LICENCE, ONE BOX. A customer may be reachable by email and
 * by mobile, but both point at ONE record carrying ONE `licId`, so typing the
 * email on one box and the mobile on another is still the same claim — the
 * second box is refused.
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
// What a human might type in the console for each product.
const PRODUCT_ALIASES = {
  stockkar: 'stockkar_only', stockkar_only: 'stockkar_only', algo: 'stockkar_only',
  sheet: 'gsheet_only', gsheet: 'gsheet_only', gsheet_only: 'gsheet_only', sheetonly: 'gsheet_only',
  both: 'both', all: 'both', full: 'both',
};
const KNOWN_FEATURES = ['stockkar', 'gsheet', 'multibroker'];
const KNOWN_ADDONS = ['multibroker'];

const isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const todayStr = (now) => (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Digits from other scripts are TRANSLATED, never dropped: a phone keyboard set
// to Marathi / Hindi / Gujarati types digits that look exactly like 0-9. Same
// rule as broker-policy.foldDigits on the box (this folder imports nothing).
const DIGIT_ZEROS = [0x0660, 0x06F0, 0x0966, 0x09E6, 0x0A66, 0x0AE6, 0x0B66, 0x0BE6, 0x0C66, 0x0CE6, 0x0D66, 0x0E50, 0x0ED0, 0xFF10];
function foldDigits(str) {
  return String(str).replace(/\p{Nd}/gu, (ch) => {
    const code = ch.codePointAt(0);
    if (code >= 0x30 && code <= 0x39) return ch;
    const zero = DIGIT_ZEROS.find(z => code >= z && code <= z + 9);
    return zero === undefined ? ch : String(code - zero);
  });
}

/** Lower-cased, trimmed; '' when it is not an email at all. */
function normalizeEmail(v) {
  const e = String(v == null ? '' : v).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e) && e.length <= 254 ? e : '';
}

/**
 * A mobile number as we store it: '+<country><digits>'.
 *
 * Accepts what people actually type: 9876543210, 09876543210, +91 98765 43210,
 * 91-9876543210, (+91) 98765-43210, and digits from any keyboard script. A bare
 * number must be a valid Indian mobile (10 digits, 6-9 first); anything else
 * must carry its own '+<country code>', because a bare foreign number cannot be
 * told from a mistyped local one. '' when it is not a phone number.
 */
function normalizeMobile(v) {
  const raw = foldDigits(String(v == null ? '' : v).normalize('NFKC')).trim();
  if (!raw || /[a-z@]/i.test(raw)) return '';          // an email or a name, not a number
  const explicit = /^\(?\+/.test(raw);
  let d = raw.replace(/\D/g, '');
  if (!d) return '';
  if (explicit) return d.length >= 8 && d.length <= 15 ? '+' + d : '';
  d = d.replace(/^0+/, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  return /^[6-9]\d{9}$/.test(d) ? '+91' + d : '';
}

/** 'email' | 'mobile' | '' — what the customer typed. */
function identityKind(v) {
  if (normalizeEmail(v)) return 'email';
  if (normalizeMobile(v)) return 'mobile';
  return '';
}
/** The normalised form of whichever it is ('' when neither). */
function normalizeIdentity(v) {
  return normalizeEmail(v) || normalizeMobile(v) || '';
}

/** The licence id an email maps to - stable, so revoke / release / activate all key on it. */
function emailKeyId(email) {
  return 'eml_' + crypto.createHash('sha256').update(normalizeEmail(email)).digest('hex').slice(0, 12);
}
/** The licence id a mobile maps to, when the customer has no email on record. */
function mobileKeyId(mobile) {
  return 'mob_' + crypto.createHash('sha256').update(normalizeMobile(mobile)).digest('hex').slice(0, 12);
}
/** ONE id per customer: the email's when there is an email, else the mobile's. Never recomputed once stored. */
function licenceIdFor(cust) {
  if (cust && cust.licId) return String(cust.licId);
  const email = normalizeEmail(cust && cust.email);
  if (email) return emailKeyId(email);
  const mobile = normalizeMobile(cust && cust.mobile);
  return mobile ? mobileKeyId(mobile) : '';
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
  const mobile = normalizeMobile(r && r.mobile);
  if (!email && !mobile) return null;                  // a customer must be reachable by something
  const productRaw = String((r && r.product) || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const product = PRODUCT_ALIASES[productRaw] || 'stockkar_only';
  const explicit = Array.isArray(r.features) ? r.features : String(r.features || '').split(/[,;\s]+/).filter(Boolean);
  const addons = Array.isArray(r.addons) ? r.addons : String(r.addons || '').split(/[,;\s]+/).filter(Boolean);
  const base = explicit.length ? explicit : PRODUCTS[product].features;
  const features = [...new Set([...base, ...addons])].filter(f => KNOWN_FEATURES.includes(f));
  if (!features.length) return null;
  const suppress = (Array.isArray(r.suppress) ? r.suppress : (explicit.length ? [] : PRODUCTS[product].suppress))
    .filter(f => KNOWN_FEATURES.includes(f) && !features.includes(f));
  const expRaw = String((r && r.exp) || '').trim();
  const exp = /^(lifetime|none|never|)$/i.test(expRaw) ? '' : expRaw;
  if (exp && !isDateStr(exp)) return null;
  const maxAccounts = Number(r && r.maxAccounts) > 0 ? Math.floor(Number(r.maxAccounts)) : 0;
  const out = {
    email, mobile, name: String((r && r.name) || '').trim().slice(0, 120), product, features, suppress, exp, maxAccounts,
    notes: String((r && r.notes) || '').trim().slice(0, 200),
  };
  out.licId = (r && r.licId) ? String(r.licId) : licenceIdFor(out);
  return out;
}

/**
 * One pasted line -> a customer row, by RECOGNISING each field rather than
 * trusting its position: "ramesh@x.com, Ramesh K, both, lifetime" and
 * "Ramesh K, 98765 43210, lifetime" both work, in any order. This is what the
 * console sends, so a list pasted from a spreadsheet needs no column rules.
 */
function parseCustomerLine(line) {
  const text = String(line || '').trim();
  if (!text || /^#/.test(text)) return null;
  const parts = text.split(/\s*[,;\t|]\s*/).map(s => s.trim()).filter(Boolean);
  const row = { addons: [] };
  const names = [];
  parts.forEach(p => {
    const email = normalizeEmail(p);
    if (email && !row.email) { row.email = email; return; }
    const mobile = normalizeMobile(p);
    if (mobile && !row.mobile) { row.mobile = mobile; return; }
    const key = p.toLowerCase().replace(/[\s-]+/g, '_');
    if (PRODUCT_ALIASES[key] && !row.product) { row.product = PRODUCT_ALIASES[key]; return; }
    if (KNOWN_ADDONS.includes(key)) { row.addons.push(key); return; }
    if (/^(lifetime|never|none)$/i.test(p)) { row.exp = ''; row.expSeen = true; return; }
    if (isDateStr(p)) { row.exp = p; row.expSeen = true; return; }
    const dmy = p.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);          // 31-03-2027, 31/03/2027
    if (dmy) { row.exp = dmy[3] + '-' + dmy[2] + '-' + dmy[1]; row.expSeen = true; return; }
    names.push(p);
  });
  if (!row.email && !row.mobile) return null;
  if (names.length) row.name = names.join(' ').slice(0, 120);
  row.addons = row.addons.join(' ');
  return row;
}

/** The signed payload for one customer on one box. Same shape as an issued key, plus the identity. */
function customerPayload(cust, installId, now) {
  const email = normalizeEmail(cust && cust.email);
  const mobile = normalizeMobile(cust && cust.mobile);
  const p = {
    v: 1,
    id: licenceIdFor(cust),
    to: (cust && cust.name) || email || mobile,
    product: cust.product,
    features: (cust.features || []).slice(),
    suppress: (cust.suppress || []).slice(),
    bind: { type: 'installId', value: String(installId || '') },
    iat: todayStr(now),
    grant: 'identity',
  };
  if (email) p.email = email;
  if (mobile) p.mobile = mobile;
  if (cust.exp) p.exp = cust.exp;                      // absent = lifetime
  if (cust.maxAccounts) p.maxAccounts = cust.maxAccounts;
  return p;
}

function signGrant(payload, privateKey) {
  const seg = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.sign(null, Buffer.from(seg, 'utf8'), privateKey);
  return PREFIX + '.' + seg + '.' + b64urlEncode(sig);
}

module.exports = {
  PRODUCTS, PRODUCT_ALIASES, KNOWN_FEATURES, KNOWN_ADDONS,
  foldDigits, normalizeEmail, normalizeMobile, normalizeIdentity, identityKind,
  emailKeyId, mobileKeyId, licenceIdFor,
  loadPrivateKey, customerFromRow, parseCustomerLine, customerPayload, signGrant, todayStr,
};
