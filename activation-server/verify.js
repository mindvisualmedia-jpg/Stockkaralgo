/**
 * Licence verification — a STANDALONE copy for the activation service.
 *
 * WHY THIS IS DUPLICATED, deliberately:
 *
 * The service deploys to Vercel with this folder as the project root. Vercel
 * does not upload files above the root, so `require('../license.js')` cannot
 * work. The alternative — deploying from the repo root — would publish
 * index.html and server.js as static assets on a public URL. Copying ~50 lines
 * of verification is far cheaper than exposing the trading app.
 *
 * DRIFT IS A TEST FAILURE, not a hope: activation.test.js mints valid, expired,
 * forged, tampered and malformed keys and asserts this module and license.js
 * return the SAME verdict for every one. If the key format ever changes and
 * only one side is updated, that test goes red.
 *
 * This file must have no dependencies and must never import from the parent.
 */
'use strict';

const crypto = require('crypto');

const PREFIX = 'STK1';

// The issuer's PUBLIC key. Safe to publish - it can only check signatures,
// never create them. The private half never leaves the issuer's laptop.
const BAKED_PUBLIC_KEY = 'MCowBQYDK2VwAyEAhp9jgHQm7Nc9OLWmmDkQNi2MBUzOyD+7RT+0JJUM6wI=';

function b64urlDecode(s) {
  return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function publicKeyObject(b64) {
  if (!b64) return null;
  try {
    return crypto.createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  } catch { return null; }
}

const isDateStr = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
const todayStr = (now) => (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);

/**
 * Mirror of license.js verifyLicense. Same reasons, same order, same verdicts.
 * @returns {{valid:boolean, reason:string, payload:object|null}}
 */
function verifyLicense(keyString, opts = {}) {
  const fail = (reason, payload = null) => ({ valid: false, reason, payload });
  const key = String(keyString || '').trim();
  if (!key) return fail('absent');

  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return fail('bad-format');

  const pub = publicKeyObject(opts.publicKey || process.env.STOCKKAR_ISSUER_PUBLIC_KEY || BAKED_PUBLIC_KEY);
  if (!pub) return fail('no-public-key');

  let payload;
  try { payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8')); }
  catch { return fail('bad-payload'); }
  if (!payload || typeof payload !== 'object') return fail('bad-payload');

  // The signature covers the payload SEGMENT exactly as it appears in the key,
  // so re-encoding the JSON can never change what was signed.
  let sigOk = false;
  try {
    sigOk = crypto.verify(null, Buffer.from(parts[1], 'utf8'), pub, b64urlDecode(parts[2]));
  } catch { sigOk = false; }
  if (!sigOk) return fail('bad-signature');

  if (Number(payload.v) !== 1) return fail('unsupported-version', payload);
  if (!Array.isArray(payload.features) || !payload.features.length) return fail('no-features', payload);
  if (payload.exp && !isDateStr(payload.exp)) return fail('bad-expiry', payload);

  const today = todayStr(opts.now);
  if (payload.exp && daysBetween(today, payload.exp) < 0) return fail('expired', payload);

  return { valid: true, reason: 'ok', payload };
}

module.exports = { verifyLicense, BAKED_PUBLIC_KEY, PREFIX };
