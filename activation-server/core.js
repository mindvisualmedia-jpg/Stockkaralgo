/**
 * Activation core — all the decisions, no transport.
 *
 * Both front ends (the standalone Node server and the Vercel functions) call
 * these. Keeping the logic here is what stops the two deployments from quietly
 * disagreeing about what "claimed" means.
 */
'use strict';

const crypto = require('crypto');
const licensing = require('./verify.js');   // local copy - see verify.js for why
const grant = require('./grant.js');        // email grants (2026-09-10)

// Customer records share the store under their own prefix (the pool.js
// pattern): cust:<email> -> { email, name, product, features, suppress, exp, ... }
const CUST = 'cust:';
const isCustomerKey = (k) => String(k || '').startsWith(CUST);

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
  // verify.js already honours STOCKKAR_ISSUER_PUBLIC_KEY, which lets a staging
  // deployment verify against a throwaway issuer. Unset = the baked issuer key.
  const res = licensing.verifyLicense(String(key || ''));
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

  // REVOCATION (2026-08-21): a revoked key is refused BEFORE any claim logic,
  // so it answers 'revoked' to every install - the original box, a new box, a
  // box that never activated. This is the one explicit answer that takes a
  // licence away; everything else in the protocol still fails open.
  const pre = await store.get(keyId);
  if (pre && pre.revoked) {
    return { status: 200, body: { ok: false, state: 'revoked', revokedAt: pre.revokedAt || null, reason: clean(pre.revokedReason, 120) } };
  }

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

  // An existing record WITHOUT an installId is not a claim - it is metadata
  // (an imported issued key, or the stub left by revoke->unrevoke). Adopt it:
  // merge the claim in, keep the issued fields. Without this, such a key would
  // answer 'claimed' to everyone forever.
  if (pre && !pre.installId) {
    await store.put(keyId, { ...pre, ...fresh, firstSeen: pre.firstSeen || now });
    return { status: 200, body: { ok: true, state: 'activated', first: true, ...(await refreshedGrant(store, v.payload, installId, now, opts)) } };
  }

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
    // EMAIL GRANTS: the daily check also carries a freshly signed grant, so a
    // plan or expiry change in the customer list reaches the box without a
    // new key being sent. The box replaces its stored grant only if the new
    // one verifies and belongs to the same email id.
    return { status: 200, body: { ok: true, state: 'activated', first: false, ...(await refreshedGrant(store, v.payload, installId, now, opts)) } };
  }

  // A different install holds this key. The ONE thing this service exists to say.
  return {
    status: 200,
    body: { ok: false, state: 'claimed', claimedAt: (record && record.firstSeen) || null },
  };
}

async function listActivations(store) {
  const rows = (await store.list()).filter(r => !isCustomerKey(r.keyId));
  rows.sort((a, b) => String(b.firstSeen || '').localeCompare(String(a.firstSeen || '')));
  return { status: 200, body: { ok: true, count: rows.length, activations: rows } };
}

/** Import issued-key metadata from the OFFLINE issuing ledger, so the console
 *  can show every allotted key - not only the ones that have called home.
 *  Upsert by keyId; activation fields on an existing record are never touched
 *  (metadata can only annotate a claim, not disturb it). Contact details are
 *  deliberately not part of the shape - names travel, emails/phones stay local. */
async function importIssued(store, rows) {
  if (!Array.isArray(rows)) return { status: 400, body: { ok: false, error: 'rows must be an array' } };
  let added = 0, updated = 0, skipped = 0;
  for (const r of rows) {
    const id = clean(r && r.keyId, 64);
    if (!id) { skipped++; continue; }
    const meta = {
      to: clean(r.to, 120), product: clean(r.product, 40),
      exp: clean(r.exp, 20) || null, issued: true, issuedAt: clean(r.issuedAt, 40),
    };
    const existing = await store.get(id);
    if (existing) { await store.put(id, { ...existing, ...meta }); updated++; }
    else { await store.put(id, { keyId: id, ...meta }); added++; }
  }
  return { status: 200, body: { ok: true, added, updated, skipped } };
}

/** Revoke a key: every future activation check answers 'revoked'. Works even
 *  before the key was ever activated (a stub record is written), and keeps the
 *  claim data so an unrevoke lets the original box resume untouched. */
async function revoke(store, keyId, reason) {
  const id = clean(keyId, 64);
  if (!id) return { status: 400, body: { ok: false, error: 'keyId is required' } };
  const existing = (await store.get(id)) || { keyId: id, firstSeen: new Date().toISOString() };
  await store.put(id, { ...existing, revoked: true, revokedAt: new Date().toISOString(), revokedReason: clean(reason, 120) });
  return { status: 200, body: { ok: true, revoked: id, was: existing.installId || null } };
}

/** Lift a revocation. The original claim survives, so the box that held the
 *  key resumes on its next daily re-check with nothing else to do. */
async function unrevoke(store, keyId) {
  const id = clean(keyId, 64);
  if (!id) return { status: 400, body: { ok: false, error: 'keyId is required' } };
  const existing = await store.get(id);
  if (!existing) return { status: 404, body: { ok: false, error: 'no record for ' + id } };
  const next = { ...existing };
  delete next.revoked; delete next.revokedAt; delete next.revokedReason;
  await store.put(id, next);
  return { status: 200, body: { ok: true, unrevoked: id } };
}

async function release(store, keyId) {
  const id = clean(keyId, 64);
  if (!id) return { status: 400, body: { ok: false, error: 'keyId is required' } };
  const existing = await store.get(id);
  if (!existing) return { status: 404, body: { ok: false, error: 'no activation for ' + id } };
  await store.del(id);
  return { status: 200, body: { ok: true, released: id, was: existing.installId } };
}

// ---- EMAIL ACTIVATION (2026-09-10) ------------------------------------------
// The customer types only their email. Registered email + this install id ->
// a signed grant (the same STK1 shape a pasted key has). First box to claim
// an email holds it; another box is refused exactly like a claimed key; the
// console releases / revokes by the email's key id (eml_...).

async function refreshedGrant(store, payload, installId, now, opts) {
  try {
    const email = grant.normalizeEmail(payload && payload.email);
    if (!email || !/^eml_/.test(String(payload && payload.id || ''))) return {};
    const cust = await store.get(CUST + email);
    if (!cust) return {};
    const priv = (opts && opts.privateKey) || grant.loadPrivateKey(process.env);
    if (!priv) return {};
    return { grant: grant.signGrant(grant.customerPayload(cust, installId, new Date(now)), priv) };
  } catch { return {}; }
}

async function claimByEmail(store, input, opts = {}) {
  const email = grant.normalizeEmail(input && input.email);
  const installId = clean(input && input.installId, 64);
  const meta = (input && input.meta) || {};
  if (!email) return { status: 400, body: { ok: false, error: 'a valid email address is required' } };
  if (!/^[a-f0-9]{16,64}$/i.test(installId)) {
    return { status: 400, body: { ok: false, error: 'installId must be 16-64 hex characters' } };
  }
  const cust = await store.get(CUST + email);
  if (!cust) return { status: 200, body: { ok: false, state: 'unknown-email' } };
  const priv = opts.privateKey || grant.loadPrivateKey(process.env);
  if (!priv) return { status: 500, body: { ok: false, error: 'grant signing is not configured on the licence server (STOCKKAR_GRANT_PRIVATE_KEY)' } };

  const keyId = grant.emailKeyId(email);
  const now = (opts.now instanceof Date ? opts.now : new Date()).toISOString();
  const pre = await store.get(keyId);
  if (pre && pre.revoked) {
    return { status: 200, body: { ok: false, state: 'revoked', revokedAt: pre.revokedAt || null, reason: clean(pre.revokedReason, 120) } };
  }
  const key = grant.signGrant(grant.customerPayload(cust, installId, new Date(now)), priv);
  const fresh = {
    installId, keyId, email, source: 'email',
    product: cust.product, to: cust.name || cust.email, exp: cust.exp || null,
    firstSeen: now, lastSeen: now, host: clean(meta.host, 80), version: clean(meta.version, 40), seenCount: 1,
  };
  if (pre && !pre.installId) {
    await store.put(keyId, { ...pre, ...fresh, firstSeen: pre.firstSeen || now });
    return { status: 200, body: { ok: true, state: 'activated', first: true, grant: key, email, keyId } };
  }
  const { record, created } = await store.claim(keyId, fresh);
  if (created) return { status: 200, body: { ok: true, state: 'activated', first: true, grant: key, email, keyId } };
  if (record && record.installId === installId) {
    await store.put(keyId, { ...record, lastSeen: now, seenCount: (Number(record.seenCount) || 1) + 1,
      host: fresh.host || record.host, version: fresh.version || record.version, email, source: 'email' });
    return { status: 200, body: { ok: true, state: 'activated', first: false, grant: key, email, keyId } };
  }
  return { status: 200, body: { ok: false, state: 'claimed', claimedAt: (record && record.firstSeen) || null } };
}

/** Upsert customer rows (email, name, product|features, exp, maxAccounts, notes). A row's
 *  claim (which box holds it) is never touched here - that lives on the eml_ record. */
async function importCustomers(store, rows) {
  if (!Array.isArray(rows)) return { status: 400, body: { ok: false, error: 'rows must be an array' } };
  let added = 0, updated = 0, skipped = 0;
  const now = new Date().toISOString();
  for (const r of rows) {
    // An UPDATE row changes only what it states: a line with just the email and
    // a new expiry keeps the customer's plan; a new product replaces the plan.
    const email = grant.normalizeEmail(r && r.email);
    const existing = email ? await store.get(CUST + email) : null;
    const given = {};
    Object.keys(r || {}).forEach(k => { const v = r[k]; if (v !== undefined && v !== null && String(v).trim() !== '') given[k] = v; });
    const merged = !existing ? r
      : (given.product || given.features) ? { ...existing, ...given, features: given.features, suppress: given.suppress }
      : { ...existing, ...given };
    const c = grant.customerFromRow(merged);
    if (!c) { skipped++; continue; }
    await store.put(CUST + c.email, { ...c, addedAt: (existing && existing.addedAt) || now, updatedAt: now });
    if (existing) updated++; else added++;
  }
  return { status: 200, body: { ok: true, added, updated, skipped } };
}

/** Every customer, joined with the claim (box) that holds their email, if any. */
async function listCustomers(store) {
  const rows = await store.list();
  const byId = {};
  rows.forEach(r => { if (!isCustomerKey(r.keyId)) byId[r.keyId] = r; });
  const customers = rows.filter(r => isCustomerKey(r.keyId)).map(r => {
    const rec = byId[grant.emailKeyId(r.email)] || null;
    const { keyId: _k, ...cust } = r;   // list() reports the storage key as keyId; the customer's id is its eml_ hash
    return { ...cust, keyId: grant.emailKeyId(r.email),
      installId: rec ? rec.installId || null : null, host: rec ? rec.host || '' : '', version: rec ? rec.version || '' : '',
      firstSeen: rec ? rec.firstSeen || null : null, lastSeen: rec ? rec.lastSeen || null : null, seenCount: rec ? rec.seenCount || 0 : 0,
      revoked: !!(rec && rec.revoked), revokedAt: rec ? rec.revokedAt || null : null, revokedReason: rec ? rec.revokedReason || '' : '' };
  });
  customers.sort((a, b) => String(a.email).localeCompare(String(b.email)));
  return { status: 200, body: { ok: true, count: customers.length, customers } };
}

/** Remove a customer from the list. The box that holds the grant keeps it until
 *  it expires; revoke the eml_ id as well to stop it now. */
async function removeCustomer(store, email) {
  const e = grant.normalizeEmail(email);
  if (!e) return { status: 400, body: { ok: false, error: 'a valid email address is required' } };
  const existing = await store.get(CUST + e);
  if (!existing) return { status: 404, body: { ok: false, error: 'no customer ' + e } };
  await store.del(CUST + e);
  return { status: 200, body: { ok: true, removed: e, keyId: grant.emailKeyId(e) } };
}

/** Constant-time bearer check, so the token cannot be guessed a byte at a time. */
function adminOk(header, expected) {
  if (!expected) return false;                       // unset token = admin disabled
  const got = String(header || '').replace(/^Bearer\s+/i, '');
  const a = Buffer.from(got), b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { activate, listActivations, release, revoke, unrevoke, importIssued, adminOk, verifyForActivation,
  claimByEmail, importCustomers, listCustomers, removeCustomer, CUST };
