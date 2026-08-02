'use strict';

// Offline licence verification and entitlement resolution.
//
// Pure and dependency-free (node:crypto only) so it unit-tests without a
// server, a network, or a broker. server.js calls loadEntitlements() and gets
// back the list of features this box may use.
//
// KEY FORMAT   STK1.<base64url(payload JSON)>.<base64url(Ed25519 signature)>
// The signature covers the EXACT payload segment bytes, so re-encoding can
// never change what was signed.
//
// WHY Ed25519 AND NOT HMAC: customer boxes run the verifier. An HMAC secret
// would therefore have to ship to every box, and anyone holding it could mint
// their own keys. Ed25519 splits the pair - the private key lives only on the
// issuer's machine (scripts/license-admin.js); the repo carries just the public
// key, which cannot sign anything.
//
// FAIL-SAFE RULE: a missing, malformed, expired or foreign licence NEVER takes
// away the base product. The worst case is "you get exactly today's Stockkar",
// never a bricked app. Only a VALID licence can suppress a feature.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Base entitlement every box has, licence or not.
const BASE_FEATURES = ['stockkar'];
const KNOWN_FEATURES = ['stockkar', 'gsheet'];
const PREFIX = 'STK1';

// The three sellable products, defined ONCE so the issuer tool and the box can
// never disagree about what a product unlocks.
//   gsheet_only  - Sheet source only; Stockkar screeners hidden AND refused
//                  server-side (suppress beats the base entitlement).
//   stockkar_only- today's product, stated explicitly so a key exists for it.
//   both         - Stockkar plus the Sheet source.
const PRODUCTS = {
  gsheet_only:   { label: 'Google Sheet only',            features: ['gsheet'],              suppress: ['stockkar'] },
  stockkar_only: { label: 'Stockkar Algo only',           features: ['stockkar'],            suppress: [] },
  both:          { label: 'Google Sheet + Stockkar Algo', features: ['stockkar', 'gsheet'],  suppress: [] },
};

// Name the product a resolved entitlement set corresponds to (for UI copy).
function describeProduct(features) {
  const f = new Set(features || []);
  if (f.has('gsheet') && f.has('stockkar')) return PRODUCTS.both.label;
  if (f.has('gsheet')) return PRODUCTS.gsheet_only.label;
  if (f.has('stockkar')) return PRODUCTS.stockkar_only.label;
  return 'No product';
}

// The issuer's public key (SPKI, base64). Set at release time from
// `node scripts/license-admin.js --show-public-key`; the env var lets a box be
// pointed at a test issuer without touching the file.
const PUBLIC_KEY_B64 = process.env.STOCKKAR_LICENSE_PUBKEY || '';

function b64urlDecode(s) {
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function publicKeyObject(b64) {
  const raw = String(b64 || '').trim();
  if (!raw) return null;
  try {
    return crypto.createPublicKey({
      key: Buffer.from(raw, 'base64'), format: 'der', type: 'spki',
    });
  } catch { return null; }
}

// ---- date helpers ---------------------------------------------------------
// Dates are plain YYYY-MM-DD. Expiry is INCLUSIVE of its last day, and compared
// against the box's own date - a box with a badly wrong clock is the user's
// problem to notice, not something to fail open on.
function todayStr(now) {
  const d = now instanceof Date ? now : new Date();
  return d.toISOString().slice(0, 10);
}
function isDateStr(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function daysBetween(fromStr, toStr) {
  return Math.round((Date.parse(toStr + 'T00:00:00Z') - Date.parse(fromStr + 'T00:00:00Z')) / 86400000);
}

/**
 * Verify a licence key string.
 * @returns {{valid:boolean, reason:string, payload:object|null}}
 *   reason is a short machine-ish token ('ok', 'expired', 'bad-signature', ...)
 */
function verifyLicense(keyString, opts = {}) {
  const fail = (reason, payload = null) => ({ valid: false, reason, payload });
  const key = String(keyString || '').trim();
  if (!key) return fail('absent');

  const parts = key.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return fail('bad-format');

  const pub = publicKeyObject(opts.publicKey || PUBLIC_KEY_B64);
  if (!pub) return fail('no-public-key');           // build shipped without one

  let payload;
  try { payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8')); }
  catch { return fail('bad-payload'); }
  if (!payload || typeof payload !== 'object') return fail('bad-payload');

  // Signature covers the payload SEGMENT exactly as it appears in the key.
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

// A binding value may be ONE id or SEVERAL - traders legitimately run more than
// one account, and a second id up front saves a support round-trip when they
// switch brokers. Accepts a string, a comma/space separated string, or an array.
function bindValues(bind) {
  const raw = bind && (bind.values !== undefined ? bind.values : bind.value);
  const list = Array.isArray(raw) ? raw : String(raw || '').split(/[,;\s]+/);
  return list.map(v => String(v || '').trim().toUpperCase()).filter(Boolean);
}

/**
 * Check the licence's binding against this box.
 *
 * BROKER-AGNOSTIC: ctx.brokerClientIds carries the client-id of EVERY connected
 * broker (Dhan, Zerodha, FYERS, Angel One...), and a match against any one of
 * them passes. 'dhanClientId' survives only as a legacy alias for the type.
 *
 * A licence bound to a broker client-id can't be checked before any broker is
 * connected - that gets a GRACE pass (the box is useless without a broker
 * anyway, and re-checks the moment one is connected).
 */
function checkBinding(payload, ctx = {}) {
  const bind = payload && payload.bind;
  if (!bind || !bind.type || bind.type === 'none') return { ok: true, reason: 'unbound' };
  const want = bindValues(bind);
  if (!want.length) return { ok: true, reason: 'unbound' };

  if (bind.type === 'brokerClientId' || bind.type === 'dhanClientId') {
    const ids = (ctx.brokerClientIds || []).map(v => String(v || '').trim().toUpperCase()).filter(Boolean);
    if (!ids.length) return { ok: true, reason: 'grace-no-broker' };
    return ids.some(id => want.includes(id)) ? { ok: true, reason: 'bound-ok' } : { ok: false, reason: 'bound-mismatch' };
  }
  if (bind.type === 'installId') {
    const id = String(ctx.installId || '').trim().toUpperCase();
    if (!id) return { ok: true, reason: 'grace-no-install-id' };
    return want.includes(id) ? { ok: true, reason: 'bound-ok' } : { ok: false, reason: 'bound-mismatch' };
  }
  return { ok: false, reason: 'unknown-bind-type' };
}

/**
 * Account slots: the licence says HOW MANY broker accounts it covers; the BOX
 * decides WHICH, by locking in the ones it actually sees (trust on first use).
 * Nothing is ever asked of the customer.
 *
 * Pure: given the already-locked ids and the currently connected ones, return
 * the new locked list and whether this box is still covered.
 *   - room left  -> unseen ids claim free slots
 *   - slots full -> a connected id that is not locked grants nothing new; the
 *                   licence still works as long as ONE locked account is
 *                   connected, so a user can keep trading on the accounts they
 *                   registered but cannot add a third.
 * @returns {{accounts:string[], added:string[], covered:boolean, full:boolean}}
 */
function reconcileAccounts(known, connected, max) {
  const norm = a => [...new Set((a || []).map(v => String(v || '').trim().toUpperCase()).filter(Boolean))];
  const locked = norm(known);
  const live = norm(connected);
  const limit = Number(max) > 0 ? Number(max) : 0;
  if (!limit) return { accounts: locked, added: [], covered: true, full: false };
  const added = [];
  live.forEach(id => {
    if (locked.includes(id) || locked.length >= limit) return;
    locked.push(id); added.push(id);
  });
  const covered = !live.length || live.some(id => locked.includes(id));
  return { accounts: locked, added, covered, full: locked.length >= limit };
}

const HUMAN = {
  absent: 'No licence key installed.',
  'bad-format': 'That does not look like a Stockkar licence key.',
  'bad-payload': 'Licence key is corrupt.',
  'bad-signature': 'Licence key failed verification - it was not issued by Stockkar, or it was edited.',
  'no-public-key': 'This build cannot verify licences (no issuer key). Update Stockkar.',
  'unsupported-version': 'Licence key is from a newer scheme. Update Stockkar.',
  'no-features': 'Licence key grants nothing.',
  'bad-expiry': 'Licence key has an invalid expiry date.',
  expired: 'Licence expired.',
  'bound-mismatch': 'This licence is registered to a different trading account.',
  'account-limit': 'This licence already covers its allowed broker accounts. Reconnect one of the registered accounts, or contact support to move the licence.',
  'unknown-bind-type': 'Licence uses a binding this version does not understand.',
  ok: 'Licence active.',
};

/**
 * The single entry point server.js uses.
 *
 * @param {object} opts
 *   dir             DATA_DIR (licence.json lives here, so it survives updates)
 *   brokerClientIds ids of connected brokers, for binding checks
 *   installId       this box's install id, for installId-bound licences
 *   now             Date (tests)
 *   publicKey       override issuer key (tests)
 * @returns {{features:string[], has:(f:string)=>boolean, license:object}}
 */
function loadEntitlements(opts = {}) {
  const dir = opts.dir || '.';
  let raw = '', stored = {};
  try { stored = JSON.parse(fs.readFileSync(path.join(dir, 'license.json'), 'utf8')) || {}; raw = String(stored.key || ''); }
  catch { stored = {}; raw = ''; }

  const state = { installed: !!raw, valid: false, reason: 'absent', id: null, to: null,
    expires: null, daysLeft: null, expiringSoon: false, bind: null, message: HUMAN.absent,
    maxAccounts: 0, accounts: Array.isArray(stored.accounts) ? stored.accounts : [], accountsFull: false };

  if (!raw) return finish(state, BASE_FEATURES);

  const res = verifyLicense(raw, { now: opts.now, publicKey: opts.publicKey });
  state.reason = res.reason;
  state.message = HUMAN[res.reason] || 'Licence could not be verified.';
  if (res.payload) {
    state.id = res.payload.id || null;
    state.to = res.payload.to || null;
    state.expires = res.payload.exp || null;
    state.bind = res.payload.bind || null;
  }
  // A licence that fails for ANY reason leaves the base product intact.
  if (!res.valid) return finish(state, BASE_FEATURES);

  const bindCheck = checkBinding(res.payload, opts);
  if (!bindCheck.ok) {
    state.reason = bindCheck.reason;
    state.message = HUMAN[bindCheck.reason] || 'Licence binding failed.';
    return finish(state, BASE_FEATURES);
  }

  // Account slots (only when the licence sets a limit).
  state.maxAccounts = Number(res.payload.maxAccounts) > 0 ? Number(res.payload.maxAccounts) : 0;
  if (state.maxAccounts) {
    const rec = reconcileAccounts(stored.accounts, opts.brokerClientIds, state.maxAccounts);
    state.accounts = rec.accounts;
    state.accountsFull = rec.full;
    if (rec.added.length && opts.persist !== false) {
      // Remember the claim, so the slots survive restarts and updates.
      try {
        fs.writeFileSync(path.join(dir, 'license.json'),
          JSON.stringify({ ...stored, key: raw, accounts: rec.accounts, accountsUpdatedAt: new Date().toISOString() }, null, 2),
          { mode: 0o600 });
      } catch (e) { /* a read-only disk must not break trading */ }
    }
    if (!rec.covered) {
      state.reason = 'account-limit';
      state.message = HUMAN['account-limit'];
      return finish(state, BASE_FEATURES);
    }
  }

  state.valid = true;
  state.reason = bindCheck.reason === 'grace-no-broker' ? 'ok-grace' : 'ok';
  state.message = HUMAN.ok;
  if (state.expires) {
    state.daysLeft = daysBetween(todayStr(opts.now), state.expires);
    state.expiringSoon = state.daysLeft <= 7;
  }

  // Grants + suppressions, from a VALID licence only.
  const granted = res.payload.features.filter(f => KNOWN_FEATURES.includes(f));
  const suppressed = (Array.isArray(res.payload.suppress) ? res.payload.suppress : [])
    .filter(f => KNOWN_FEATURES.includes(f));
  const features = [...new Set([...BASE_FEATURES, ...granted])].filter(f => !suppressed.includes(f));
  // Never leave a box with nothing to trade from.
  return finish(state, features.length ? features : granted.length ? granted : BASE_FEATURES);
}

function finish(state, features) {
  const list = [...new Set(features)];
  return { features: list, has: f => list.includes(f), license: state };
}

module.exports = {
  BASE_FEATURES, KNOWN_FEATURES, PREFIX, PRODUCTS, describeProduct,
  verifyLicense, checkBinding, bindValues, reconcileAccounts, loadEntitlements,
  b64urlEncode, b64urlDecode,
};
