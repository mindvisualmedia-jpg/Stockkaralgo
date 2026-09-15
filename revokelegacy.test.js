'use strict';
// REVOKING 336 PASTED KEYS AT ONCE (2026-09-15). The owner has imported every
// customer by mobile number and wants the old pasted-key scheme retired:
// "revoke all these keys and give 7 days to all users to add mobile number".
//
// A bulk revoke across a live fleet is the shape of action that ends badly, so
// this suite is written as the list of ways it could:
//   - it must NEVER touch an identity grant (mob_/eml_) - those are the scheme
//     the keys are being replaced BY, they sit in the SAME list, and sweeping
//     them up would cut off exactly the customers who already complied
//   - it must never touch the customer records themselves
//   - it must report before it acts
//   - it must be idempotent, and reversible one box at a time
const { test } = require('node:test');
const assert = require('node:assert');
const core = require('./activation-server/core.js');

// A tiny in-memory store with the same surface core.js uses.
function memStore(seed = {}) {
  const data = { ...seed };
  return {
    data,
    async get(k) { return data[k] ? JSON.parse(JSON.stringify(data[k])) : null; },
    async put(k, v) { data[k] = JSON.parse(JSON.stringify(v)); },
    async del(k) { delete data[k]; },
    async list() { return Object.entries(data).map(([keyId, v]) => ({ ...v, keyId })); },
  };
}

function fleet() {
  return memStore({
    // pasted keys: some live on a box, some never activated, one already revoked
    lic_df41a129: { to: 'Donald Lepcha', installId: 'ad86b10ba3a5', lastSeen: '2026-09-15T07:07:00Z' },
    lic_9d00c996: { to: 'Anoop Verma', installId: 'e275cdbf3abf', lastSeen: '2026-09-08T22:30:00Z' },
    lic_2330f527: { to: 'Meeinal Birari', installId: 'b67d6554954e', lastSeen: '2026-09-15T02:19:00Z' },
    lic_neverused: { to: 'Someone', installId: null },
    lic_already: { to: 'Old', installId: 'zzz', revoked: true, revokedAt: '2026-09-01T00:00:00Z' },
    // the NEW scheme - in the very same list
    mob_b3e8278ad7a2: { to: 'Monish2', installId: '405577378a64', lastSeen: '2026-09-14T20:30:00Z' },
    eml_aa11bb22cc33: { to: 'Ramesh K', installId: 'ffff1111' },
    // customer records
    'cust:+919876543210': { name: 'Ramesh K', mobile: '+919876543210', product: 'stockkar_only' },
  });
}

test('DRY RUN reports and changes NOTHING', async () => {
  const store = fleet();
  const before = JSON.stringify(store.data);
  const r = await core.revokeLegacyKeys(store, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.dryRun, true);
  assert.equal(r.body.wouldRevoke, 4, 'three live + one never used; the already-revoked one is not counted again');
  assert.equal(r.body.active, 3);
  assert.equal(r.body.neverActivated, 1);
  assert.equal(r.body.identityKeysUntouched, 2);
  assert.equal(JSON.stringify(store.data), before, 'nothing was written');
});

test('THE ONE THAT MATTERS: identity grants are never revoked', async () => {
  const store = fleet();
  await core.revokeLegacyKeys(store, { apply: true });
  assert.ok(!store.data.mob_b3e8278ad7a2.revoked, 'the mobile grant survives');
  assert.ok(!store.data.eml_aa11bb22cc33.revoked, 'the email grant survives');
  // and the customers themselves are untouched
  assert.deepEqual(store.data['cust:+919876543210'], { name: 'Ramesh K', mobile: '+919876543210', product: 'stockkar_only' });
});

test('every pasted key is revoked, with a reason, keeping the claim', async () => {
  const store = fleet();
  const r = await core.revokeLegacyKeys(store, { apply: true, reason: 'retired 2026-09-22' });
  assert.equal(r.body.revoked, 4);
  ['lic_df41a129', 'lic_9d00c996', 'lic_2330f527', 'lic_neverused'].forEach(k => {
    assert.equal(store.data[k].revoked, true, k);
    assert.equal(store.data[k].revokedReason, 'retired 2026-09-22');
    assert.ok(store.data[k].revokedAt);
  });
  // the claim survives, so unrevoke puts the box back with nothing to do
  assert.equal(store.data.lic_df41a129.installId, 'ad86b10ba3a5');
  assert.equal(store.data.lic_df41a129.to, 'Donald Lepcha');
});

test('a default reason is written when none is given - the customer is told WHY', async () => {
  const store = fleet();
  await core.revokeLegacyKeys(store, { apply: true });
  assert.match(store.data.lic_df41a129.revokedReason, /registered mobile number/);
});

test('running it twice changes nothing the second time', async () => {
  const store = fleet();
  await core.revokeLegacyKeys(store, { apply: true });
  const after = JSON.stringify(store.data);
  const again = await core.revokeLegacyKeys(store, { apply: true });
  assert.equal(again.body.revoked, 0);
  assert.equal(JSON.stringify(store.data), after);
});

test('it is reversible: unrevoke puts one box back, claim intact', async () => {
  const store = fleet();
  await core.revokeLegacyKeys(store, { apply: true });
  const u = await core.unrevoke(store, 'lic_df41a129');
  assert.equal(u.status, 200);
  assert.ok(!store.data.lic_df41a129.revoked);
  assert.equal(store.data.lic_df41a129.installId, 'ad86b10ba3a5', 'the box does not have to re-activate');
});

test('an empty ledger is not an error', async () => {
  const r = await core.revokeLegacyKeys(memStore(), {});
  assert.equal(r.body.wouldRevoke, 0);
  assert.equal(r.body.dryRun, true);
});
