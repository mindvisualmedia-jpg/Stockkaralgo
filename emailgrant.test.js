'use strict';
// EMAIL ACTIVATION (2026-09-10). The customer types only their registered
// email; the activation service signs a grant for THIS box; the box stores it
// as its licence and verifies it offline like any pasted key.
//
// Owner's decisions: email-only (no code), legacy boxes untouched, existing
// keys keep working. What must hold:
//   - an email that is not on the customer list activates nothing
//   - the first box to claim an email holds it; a second box is refused
//   - the grant verifies on the box with the GRANT key and is bound to the
//     install id it was issued for
//   - revoke / release work on the email's eml_ id like any key
//   - the daily check carries a refreshed grant when the plan changes
//   - customer records never leak into the key ledger

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const core = require('./activation-server/core.js');
const grant = require('./activation-server/grant.js');
const { fileStore } = require('./activation-server/store.js');
const lic = require('./license.js');
const verify = require('./activation-server/verify.js');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PRIV_B64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');

const store = () => fileStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stk-eml-')), 'a.json'));
const BOX_A = 'a'.repeat(32), BOX_B = 'b'.repeat(32);
const opts = { privateKey };
const verifyOn = (key, installId) => {
  const v = lic.verifyLicense(key, { publicKey: PUB });
  if (!v.valid) return v;
  return { ...v, bind: lic.checkBinding(v.payload, { installId }) };
};

async function seeded(rows) {
  const s = store();
  const r = await core.importCustomers(s, rows || [
    { email: 'Ramesh@Example.com ', name: 'Ramesh K', product: 'stockkar_only', exp: 'lifetime' },
    { email: 'priya@example.com', name: 'Priya S', product: 'both', exp: '2027-03-31', addons: 'multibroker' },
  ]);
  assert.equal(r.body.ok, true);
  return s;
}

test('customer import: normalises emails, maps products, validates dates, skips junk', async () => {
  const s = store();
  const r = await core.importCustomers(s, [
    { email: 'A@X.io', name: 'A', product: 'both', exp: '2027-01-01' },
    { email: 'b@x.io', product: 'gsheet_only' },
    { email: 'not-an-email', name: 'junk' },
    { email: 'c@x.io', exp: '31-01-2027' },          // bad date
    { email: 'a@x.io', name: 'A again', exp: 'lifetime' },   // update
  ]);
  assert.deepEqual([r.body.added, r.body.updated, r.body.skipped], [2, 1, 2]);
  const a = await s.get('cust:a@x.io');
  assert.equal(a.name, 'A again');
  assert.equal(a.exp, '', 'lifetime = no expiry');
  assert.deepEqual(a.features, ['stockkar', 'gsheet']);
  const b = await s.get('cust:b@x.io');
  assert.deepEqual([b.features, b.suppress], [['gsheet'], ['stockkar']], 'sheet-only suppresses stockkar');
  assert.equal(a.keyId, undefined, 'a customer record carries no keyId (the store would read it as a claim)');
  assert.ok(/^eml_[0-9a-f]{12}$/.test(grant.emailKeyId(a.email)));
});

test('an email that is not a customer activates nothing', async () => {
  const s = await seeded();
  const r = await core.claimByEmail(s, { email: 'stranger@example.com', installId: BOX_A }, opts);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: false, state: 'unknown-email' });
  assert.equal((await s.list()).filter(x => /^eml_/.test(x.keyId)).length, 0, 'nothing written');
});

test('bad input is refused before any lookup', async () => {
  const s = await seeded();
  assert.equal((await core.claimByEmail(s, { email: 'nope', installId: BOX_A }, opts)).status, 400);
  assert.equal((await core.claimByEmail(s, { email: 'ramesh@example.com', installId: 'zz' }, opts)).status, 400);
});

test('signing not configured -> 500, never a half claim', async () => {
  const s = await seeded();
  const prev = process.env.STOCKKAR_GRANT_PRIVATE_KEY; delete process.env.STOCKKAR_GRANT_PRIVATE_KEY;
  try {
    const r = await core.claimByEmail(s, { email: 'ramesh@example.com', installId: BOX_A });
    assert.equal(r.status, 500);
    assert.equal(await s.get(grant.emailKeyId('ramesh@example.com')), null);
  } finally { if (prev !== undefined) process.env.STOCKKAR_GRANT_PRIVATE_KEY = prev; }
});

test('FIRST CLAIM: a registered email on a fresh box -> a grant that verifies on the box and binds to it', async () => {
  const s = await seeded();
  const r = await core.claimByEmail(s, { email: 'RAMESH@example.com', installId: BOX_A, meta: { host: 'ip-10-0-0-4', version: '3.23.0' } }, opts);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.state, 'activated');
  assert.equal(r.body.first, true);
  assert.equal(r.body.email, 'ramesh@example.com');
  const v = verifyOn(r.body.grant, BOX_A);
  assert.equal(v.valid, true, 'license.js accepts the grant');
  assert.equal(v.bind.ok, true, 'bound to this box');
  assert.equal(v.payload.id, r.body.keyId);
  assert.equal(v.payload.email, 'ramesh@example.com');
  assert.equal(v.payload.to, 'Ramesh K');
  assert.deepEqual(v.payload.features, ['stockkar']);
  assert.equal(v.payload.exp, undefined, 'lifetime');
  assert.deepEqual(v.payload.bind, { type: 'installId', value: BOX_A });
  // the ledger record looks like any activation, plus the email
  const rec = await s.get(r.body.keyId);
  assert.equal(rec.installId, BOX_A);
  assert.equal(rec.email, 'ramesh@example.com');
  assert.equal(rec.host, 'ip-10-0-0-4');
});

test('the grant is useless on ANOTHER box: binding fails there', async () => {
  const s = await seeded();
  const r = await core.claimByEmail(s, { email: 'ramesh@example.com', installId: BOX_A }, opts);
  const v = verifyOn(r.body.grant, BOX_B);
  assert.equal(v.valid, true, 'signature is genuine');
  assert.equal(v.bind.ok, false);
  assert.equal(v.bind.reason, 'bound-mismatch');
});

test('a plan with expiry and an addon carries both', async () => {
  const s = await seeded();
  const r = await core.claimByEmail(s, { email: 'priya@example.com', installId: BOX_A }, opts);
  const v = verifyOn(r.body.grant, BOX_A);
  assert.equal(v.payload.exp, '2027-03-31');
  assert.deepEqual(v.payload.features, ['stockkar', 'gsheet', 'multibroker']);
  assert.equal(v.payload.product, 'both');
});

test('the SAME box may claim again forever (restart, retry) and always gets a grant', async () => {
  const s = await seeded();
  const a = await core.claimByEmail(s, { email: 'ramesh@example.com', installId: BOX_A }, opts);
  const b = await core.claimByEmail(s, { email: 'ramesh@example.com', installId: BOX_A }, opts);
  assert.equal(b.body.state, 'activated');
  assert.equal(b.body.first, false);
  assert.ok(b.body.grant);
  assert.equal((await s.get(a.body.keyId)).seenCount, 2);
});

test('A DIFFERENT box is refused: the email is held by the first one', async () => {
  const s = await seeded();
  await core.claimByEmail(s, { email: 'ramesh@example.com', installId: BOX_A }, opts);
  const r = await core.claimByEmail(s, { email: 'ramesh@example.com', installId: BOX_B }, opts);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.state, 'claimed');
  assert.ok(r.body.claimedAt);
  assert.equal(r.body.grant, undefined, 'no grant leaks to the second box');
});

test('release moves the email to a new box; revoke refuses every box until unrevoked', async () => {
  const prevPub = process.env.STOCKKAR_GRANT_PUBKEY;
  process.env.STOCKKAR_GRANT_PUBKEY = PUB;
  try {
  const s = await seeded();
  const first = await core.claimByEmail(s, { email: 'ramesh@example.com', installId: BOX_A }, opts);
  const keyId = first.body.keyId;
  await core.release(s, keyId);
  const moved = await core.claimByEmail(s, { email: 'ramesh@example.com', installId: BOX_B }, opts);
  assert.equal(moved.body.state, 'activated');
  assert.equal((await s.get(keyId)).installId, BOX_B);

  await core.revoke(s, keyId, 'payment failed');
  const rv = await core.claimByEmail(s, { email: 'ramesh@example.com', installId: BOX_B }, opts);
  assert.equal(rv.body.state, 'revoked');
  assert.equal(rv.body.reason, 'payment failed');
  // the daily activation check with the stored grant answers revoked too
  const act = await core.activate(s, { key: moved.body.grant, installId: BOX_B }, opts);
  assert.equal(act.body.state, 'revoked');
  await core.unrevoke(s, keyId);
  assert.equal((await core.claimByEmail(s, { email: 'ramesh@example.com', installId: BOX_B }, opts)).body.state, 'activated');
  } finally { if (prevPub === undefined) delete process.env.STOCKKAR_GRANT_PUBKEY; else process.env.STOCKKAR_GRANT_PUBKEY = prevPub; }
});

test('DAILY CHECK: the stored grant activates like any key, and carries a refreshed grant when the plan changed', async () => {
  const prevPub = process.env.STOCKKAR_GRANT_PUBKEY;
  process.env.STOCKKAR_GRANT_PUBKEY = PUB;    // the service verifies the grant with the grant key
  try {
    const s = await seeded();
    const first = await core.claimByEmail(s, { email: 'ramesh@example.com', installId: BOX_A }, opts);
    const same = await core.activate(s, { key: first.body.grant, installId: BOX_A, meta: { version: '3.23.1' } }, opts);
    assert.equal(same.body.state, 'activated');
    assert.equal(same.body.first, false);
    assert.ok(same.body.grant, 'a fresh grant rides along');
    // the plan changes in the customer list: lifetime -> expiring, plus gsheet
    await core.importCustomers(s, [{ email: 'ramesh@example.com', name: 'Ramesh K', product: 'both', exp: '2027-12-31' }]);
    const next = await core.activate(s, { key: first.body.grant, installId: BOX_A }, opts);
    const v = verifyOn(next.body.grant, BOX_A);
    assert.equal(v.valid, true);
    assert.equal(v.payload.exp, '2027-12-31');
    assert.deepEqual(v.payload.features, ['stockkar', 'gsheet']);
    assert.equal(v.payload.id, first.body.keyId, 'same email id, so the box accepts the refresh');
    // another box presenting the SAME grant is refused - the grant is bound anyway, but the ledger says so too
    assert.equal((await core.activate(s, { key: first.body.grant, installId: BOX_B }, opts)).body.state, 'claimed');
  } finally { if (prevPub === undefined) delete process.env.STOCKKAR_GRANT_PUBKEY; else process.env.STOCKKAR_GRANT_PUBKEY = prevPub; }
});

test('a pasted (issuer-signed) key gets NO grant on its daily check', async () => {
  const issuer = crypto.generateKeyPairSync('ed25519');
  const prev = process.env.STOCKKAR_ISSUER_PUBLIC_KEY;
  process.env.STOCKKAR_ISSUER_PUBLIC_KEY = issuer.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  try {
    const s = await seeded();
    const key = grant.signGrant({ v: 1, id: 'lic_abc123', to: 'Key Buyer', features: ['stockkar'], iat: '2026-09-01' }, issuer.privateKey);
    const r = await core.activate(s, { key, installId: BOX_A }, opts);
    assert.equal(r.body.state, 'activated');
    assert.equal(r.body.grant, undefined);
  } finally { if (prev === undefined) delete process.env.STOCKKAR_ISSUER_PUBLIC_KEY; else process.env.STOCKKAR_ISSUER_PUBLIC_KEY = prev; }
});

test('the customer list joins each email with the box that holds it; the key ledger never shows customer records', async () => {
  const s = await seeded();
  await core.claimByEmail(s, { email: 'ramesh@example.com', installId: BOX_A, meta: { host: 'box-a' } }, opts);
  const list = await core.listCustomers(s);
  assert.equal(list.body.count, 2);
  const ramesh = list.body.customers.find(c => c.email === 'ramesh@example.com');
  assert.equal(ramesh.installId, BOX_A);
  assert.equal(ramesh.host, 'box-a');
  assert.ok(/^eml_/.test(ramesh.keyId));
  const priya = list.body.customers.find(c => c.email === 'priya@example.com');
  assert.equal(priya.installId, null, 'not yet activated');
  const ledger = await core.listActivations(s);
  assert.ok(ledger.body.activations.every(r => !/^cust:/.test(r.keyId)), 'cust: records hidden');
  assert.equal(ledger.body.activations.length, 1, 'only the eml_ claim');
  const rm = await core.removeCustomer(s, 'PRIYA@example.com');
  assert.equal(rm.body.removed, 'priya@example.com');
  assert.equal((await core.listCustomers(s)).body.count, 1);
  assert.equal((await core.claimByEmail(s, { email: 'priya@example.com', installId: BOX_B }, opts)).body.state, 'unknown-email');
});

test('the grant private key loads from PEM or one-line base64; junk is null', () => {
  assert.ok(grant.loadPrivateKey({ STOCKKAR_GRANT_PRIVATE_KEY: PRIV_B64 }));
  assert.ok(grant.loadPrivateKey({ STOCKKAR_GRANT_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  assert.equal(grant.loadPrivateKey({ STOCKKAR_GRANT_PRIVATE_KEY: 'garbage' }), null);
  assert.equal(grant.loadPrivateKey({}), null);
});

test('license.js and verify.js ship the SAME baked grant key, distinct from the issuer key, and both accept a grant-signed key', () => {
  assert.ok(lic.BAKED_GRANT_PUBLIC_KEY && /^MCowBQYDK2Vw/.test(lic.BAKED_GRANT_PUBLIC_KEY));
  assert.strictEqual(verify.BAKED_GRANT_PUBLIC_KEY, lic.BAKED_GRANT_PUBLIC_KEY, 'grant key drifted between box and service');
  assert.notStrictEqual(lic.BAKED_GRANT_PUBLIC_KEY, lic.BAKED_PUBLIC_KEY, 'the issuer key stays offline; grants use their own');
  // a key signed with THIS test's grant key verifies on both sides when they trust it
  const prev = process.env.STOCKKAR_GRANT_PUBKEY;
  process.env.STOCKKAR_GRANT_PUBKEY = PUB;
  try {
    const key = grant.signGrant(grant.customerPayload({ email: 'x@y.io', product: 'stockkar_only', features: ['stockkar'], suppress: [], exp: '' }, BOX_A), privateKey);
    const issuerFake = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const a = lic.verifyLicense(key, { publicKey: issuerFake });      // issuer key is NOT the signer; the grant key is
    const b = verify.verifyLicense(key, { publicKey: issuerFake });
    assert.equal(a.valid, true); assert.equal(b.valid, true);
    assert.deepStrictEqual(b.payload, a.payload);
    const tampered = key.split('.'); tampered[1] = tampered[1].slice(0, -2) + 'AA';
    assert.equal(lic.verifyLicense(tampered.join('.'), { publicKey: issuerFake }).valid, false);
  } finally { if (prev === undefined) delete process.env.STOCKKAR_GRANT_PUBKEY; else process.env.STOCKKAR_GRANT_PUBKEY = prev; }
});

test('an existing pasted key is NOT accepted by the grant key alone: two issuers, each only signs its own', () => {
  // a key signed by a random third key is rejected by both trusted keys
  const rogue = crypto.generateKeyPairSync('ed25519');
  const key = grant.signGrant({ v: 1, id: 'lic_rogue', features: ['stockkar'] }, rogue.privateKey);
  assert.equal(lic.verifyLicense(key, {}).valid, false);
  assert.equal(verify.verifyLicense(key, {}).valid, false);
});
