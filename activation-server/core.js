/**
 * Activation core — all the decisions, no transport.
 *
 * Both front ends (the standalone Node server and the Vercel functions) call
 * these. Keeping the logic here is what stops the two deployments from quietly
 * disagreeing about what "claimed" means.
 */
'use strict';

const crypto = require('crypto');
const licensing = require('../license.js');

const MAX_META = 200;   // customer-supplied strings are trimmed, never trusted

// Strip control characters (log injection, broken JSON); keep ordinary text.
const clean = (v, max = MAX_META) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);

/**
 * Verify the key the box sent us.
 *
 * We accept a correctly signed key even when it has EXPIRED. Expiry is the
 * box's business and it already handles it; failing activation as well would
 * show a renewing customer a second, confusing error for the same cause.
 */
function verifyForActivation(key) {
  // STOCKKAR_ISSUER_PUBLIC_KEY lets a staging deployment of this service verify
  // against a throwaway issuer. Unset (production) = the baked issuer key.
  const publicKey = process.env.STOCKKAR_ISSUER_PUBLIC_KEY || undefined;
  const res = licensing.verifyLicense(String(key || ''), { publicKey });
  if (res.valid || res.reason === 'expired') return { ok: true, payload: res.payload };
  return { ok: false, reason: res.reason };
}

/**
 * Claim a key for an install.
 *
 * @returns {Promise<{status:number, body:object}>}
 */
async function activate(store, input, opts = {}) {
  const key = String(input && input.key || '');
  const installId = clean(input && input.installId, 64);
  const meta = (input && input.meta) || {};

  if (!key) return { status: 400, body: { ok: false, error: 'key is required' } };
  if (!/^[a-f0-9]{16,64}$/i.test(installId)) {
    return { status: 400, body: { ok: false, error: 'installId must be 16-64 hex characters' } };
  }

  const v = verifyForActivation(key);
  if (!v.ok) {
    // Junk never reaches the ledger. This is also why the service needs no
    // secret of its own: the issuer's public key is enough to tell real from fake.
    return { status: 400, body: { ok: false, error: 'licence key failed verification', reason: v.reason } };
  }

  const keyId = clean(v.payload.id, 64) || crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
  const now = (opts.now instanceof Date ? opts.now : new Date()).toISOString();

  const fresh = {
    installId,
    keyId,
    product: clean(v.payload.product, 40),
    to: clean(v.payload.to, 120),
    exp: v.payload.exp || null,
    firstSeen: now,
    lastSeen: now,
    host: clean(meta.host, 80),
    version: clean(meta.version, 40),
    seenCount: 1,
  };

  const { record, created } = await store.claim(keyId, fresh);

  if (created) return { status: 200, body: { ok: true, state: 'activated', first: true } };

  if (record && record.installId === installId) {
    // Same box asking again — a restart, a reinstall, a retry after our own
    // downtime. Idempotent by design; refresh the heartbeat for the ledger.
    await store.put(keyId, {
      ...record,
      lastSeen: now,
      seenCount: (Number(record.seenCount) || 1) + 1,
      host: fresh.host || record.host,
      version: fresh.version || record.version,
    });
    return { status: 200, body: { ok: true, state: 'activated', first: false } };
  }

  // A different install holds this key. The ONE thing this service exists to say.
  return {
    status: 200,
    body: { ok: false, state: 'claimed', claimedAt: (record && record.firstSeen) || null },
  };
}

async function listActivations(store) {
  const rows = await store.list();
  rows.sort((a, b) => String(b.firstSeen || '').localeCompare(String(a.firstSeen || '')));
  return { status: 200, body: { ok: true, count: rows.length, activations: rows } };
}

async function release(store, keyId) {
  const id = clean(keyId, 64);
  if (!id) return { status: 400, body: { ok: false, error: 'keyId is required' } };
  const existing = await store.get(id);
  if (!existing) return { status: 404, body: { ok: false, error: 'no activation for ' + id } };
  await store.del(id);
  return { status: 200, body: { ok: true, released: id, was: existing.installId } };
}

/** Constant-time bearer check, so the token cannot be guessed a byte at a time. */
function adminOk(header, expected) {
  if (!expected) return false;                       // unset token = admin disabled
  const got = String(header || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got), b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { activate, listActivations, release, adminOk, verifyForActivation };
