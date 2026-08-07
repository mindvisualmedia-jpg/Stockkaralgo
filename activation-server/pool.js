/**
 * Key pool — bulk-issued keys handed out to boxes automatically.
 *
 * Keys are still signed OFFLINE on the issuer's laptop (license-admin --bulk).
 * The private key never comes near this service; all that is uploaded here is
 * a list of already-signed key strings. This service only decides WHO gets
 * which one, and remembers that decision.
 *
 * Records share one store with activations, so every id is namespaced:
 *
 *   pool:<keyId>   an issued key available for hand-out   { key, product, ... }
 *   taken:<keyId>  that key has been given to an install  { installId, at }
 *   box:<installId> what this install owns                { keyId, key, ... }
 *   <keyId>        the ACTIVATION record (core.js, unprefixed)
 *
 * TWO separate races have to be impossible here, and they need two separate
 * atomic claims:
 *
 *   1. one box asking twice must not consume two keys   -> claim box:<installId>
 *   2. two boxes must not be handed the SAME key        -> claim taken:<keyId>
 *
 * Both ride the store's existing create-if-absent `claim`, which is a write
 * chain on the file driver and SET NX on Upstash. No new driver methods.
 */
'use strict';

const core = require('./core.js');

const POOL = 'pool:';
const TAKEN = 'taken:';
const BOX = 'box:';

/** True for the unprefixed ids that are real activation records. */
function isActivationId(id) {
  const s = String(id || '');
  return !s.startsWith(POOL) && !s.startsWith(TAKEN) && !s.startsWith(BOX);
}

const clean = (v, max = 200) => String(v == null ? '' : v).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max);
const validInstallId = (id) => /^[a-f0-9]{16,64}$/i.test(String(id || ''));

/**
 * Add signed keys to the pool. Verified before storage for the same reason
 * activation verifies: junk must never enter the ledger, and a typo in a bulk
 * upload should fail loudly here rather than silently hand a box a dead key.
 */
async function addKeys(store, keys, opts = {}) {
  const list = Array.isArray(keys) ? keys : [];
  if (!list.length) return { status: 400, body: { ok: false, error: 'keys[] is required' } };

  const now = (opts.now instanceof Date ? opts.now : new Date()).toISOString();
  const added = [], skipped = [], rejected = [];

  for (const raw of list) {
    const key = String(raw || '').trim();
    if (!key) continue;
    const v = core.verifyForActivation(key);
    if (!v.ok) { rejected.push({ reason: v.reason, tail: key.slice(-8) }); continue; }

    const keyId = clean(v.payload.id, 64);
    if (!keyId) { rejected.push({ reason: 'no-id', tail: key.slice(-8) }); continue; }

    // claim, not put: re-uploading the same batch must not resurrect a key
    // that has already been handed out and possibly released since.
    const { created } = await store.claim(POOL + keyId, {
      key, keyId, product: clean(v.payload.product, 40), to: clean(v.payload.to, 120),
      exp: v.payload.exp || null, addedAt: now,
    });
    (created ? added : skipped).push(keyId);
  }

  return { status: 200, body: { ok: true, added: added.length, skipped: skipped.length, rejected, addedIds: added } };
}

/** Counts for the admin view: how many keys are left before the pool runs dry. */
async function status(store) {
  const rows = await store.list();
  let total = 0, assigned = 0;
  for (const r of rows) {
    if (String(r.keyId).startsWith(POOL)) total++;
    else if (String(r.keyId).startsWith(TAKEN)) assigned++;
  }
  return { status: 200, body: { ok: true, pool: { total, assigned, available: total - assigned } } };
}

/**
 * Hand this install a key, creating the assignment if it does not have one.
 *
 * Idempotent: the same box asking again always gets the SAME key back. That is
 * what stops a customer who rebuilds their instance from draining the pool, and
 * it is why the assignment is keyed by installId rather than by request.
 */
async function assign(store, input, opts = {}) {
  const installId = clean(input && input.installId, 64);
  if (!validInstallId(installId)) {
    return { status: 400, body: { ok: false, error: 'installId must be 16-64 hex characters' } };
  }

  const now = (opts.now instanceof Date ? opts.now : new Date()).toISOString();
  const meta = (input && input.meta) || {};

  // (1) One assignment per install. `claim` both reserves the slot for a first
  // caller and tells a second one that somebody got here first.
  const mine = await store.claim(BOX + installId, { installId, pending: true, at: now });
  if (!mine.created) {
    const rec = mine.record || {};
    if (rec.key) {
      return { status: 200, body: { ok: true, state: 'assigned', first: false, key: rec.key, keyId: rec.keyId } };
    }
    // Pending. Either a concurrent request is mid-flight, or a previous one
    // died between winning a key and recording it. Look for a key already
    // marked taken by us and finish the job rather than consuming a second.
    const orphan = (await store.list()).find(r =>
      String(r.keyId).startsWith(TAKEN) && r.installId === installId);
    if (orphan) {
      const keyId = String(orphan.keyId).slice(TAKEN.length);
      const entry = await store.get(POOL + keyId);
      if (entry && entry.key) {
        await store.put(BOX + installId, { installId, keyId, key: entry.key, assignedAt: orphan.at || now,
          host: clean(meta.host, 80), version: clean(meta.version, 40) });
        return { status: 200, body: { ok: true, state: 'assigned', first: false, key: entry.key, keyId } };
      }
    }
    return { status: 409, body: { ok: false, state: 'in-progress', error: 'assignment already in progress' } };
  }

  // (2) One key per box. Walk the pool oldest-first and take the first key
  // nobody has won yet; `claim` makes "nobody has won it yet" atomic.
  const rows = await store.list();
  const candidates = rows
    .filter(r => String(r.keyId).startsWith(POOL) && r.key)
    .sort((a, b) => String(a.addedAt || '').localeCompare(String(b.addedAt || '')));

  for (const c of candidates) {
    const keyId = String(c.keyId).slice(POOL.length);
    const won = await store.claim(TAKEN + keyId, { installId, at: now });
    if (!won.created) continue;                       // another box took it first
    await store.put(BOX + installId, { installId, keyId, key: c.key, assignedAt: now,
      host: clean(meta.host, 80), version: clean(meta.version, 40) });
    return { status: 200, body: { ok: true, state: 'assigned', first: true, key: c.key, keyId } };
  }

  // Nothing left. Release the pending marker so a top-up works without an
  // admin having to clear it by hand.
  await store.del(BOX + installId);
  return { status: 409, body: { ok: false, state: 'pool-empty', error: 'no keys available' } };
}

/**
 * Undo an assignment: the key returns to the pool and the box may claim again.
 * The activation record is a separate concern - core.release handles that.
 */
async function unassign(store, installId) {
  const id = clean(installId, 64);
  if (!id) return { status: 400, body: { ok: false, error: 'installId is required' } };
  const rec = await store.get(BOX + id);
  if (!rec) return { status: 404, body: { ok: false, error: 'no assignment for ' + id } };
  if (rec.keyId) await store.del(TAKEN + rec.keyId);
  await store.del(BOX + id);
  return { status: 200, body: { ok: true, unassigned: id, keyId: rec.keyId || null } };
}

module.exports = { addKeys, assign, unassign, status, isActivationId, POOL, TAKEN, BOX };
