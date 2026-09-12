'use strict';
// ACTIVATION BY MOBILE NUMBER (2026-09-12). Owner: "can we do mobile number
// instead of email id for licence?" and "one mobile number is restricted to one
// box only right?" - yes: the identity is what the customer types, the licence
// is one per customer, and the first box to claim it holds it.
//
// What must hold:
//   - a number typed any way a person types it resolves to ONE stored form
//   - an unregistered number activates nothing
//   - the first box wins; a second box is refused
//   - a customer reachable by BOTH email and mobile is ONE licence: typing the
//     other identity on a second box is still refused
//   - a pasted customer line is understood whatever order its fields are in
//   - the grant carries the mobile and verifies on the box, bound to that box

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

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const opts = { privateKey };
const store = () => fileStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stk-mob-')), 'a.json'));
const BOX_A = 'a'.repeat(32), BOX_B = 'b'.repeat(32);
const verifyOn = (key, installId) => {
  const v = lic.verifyLicense(key, { publicKey: PUB });
  if (!v.valid) return v;
  return { ...v, bind: lic.checkBinding(v.payload, { installId }) };
};

// ---- the number itself -------------------------------------------------------------

test('a mobile number typed any way a person types it becomes ONE stored form', () => {
  const want = '+919876543210';
  ['9876543210', '09876543210', '+91 98765 43210', '91-9876543210', '(+91) 98765-43210',
    ' 98765 43210 ', '+919876543210',
  ].forEach(v => assert.equal(grant.normalizeMobile(v), want, JSON.stringify(v)));
  // digits typed on a Marathi / Hindi keyboard are folded, never dropped
  assert.equal(grant.normalizeMobile('९८७६५४३२१०'), want);
  assert.equal(grant.normalizeMobile('+91 ९८७६५ 43210'), want, 'half one script, half the other');
});

test('what is NOT a mobile number', () => {
  ['', '   ', 'ramesh@example.com', 'Ramesh K', '12345', '1234567890', '00000000000', 'lifetime', '2027-03-31']
    .forEach(v => assert.equal(grant.normalizeMobile(v), '', JSON.stringify(v)));
  assert.equal(grant.normalizeMobile('+1 415 555 0123'), '+14155550123', 'a foreign number must carry its own +country');
});

test('identityKind tells an email from a number, and the licence id follows the customer', () => {
  assert.equal(grant.identityKind('ramesh@example.com'), 'email');
  assert.equal(grant.identityKind('98765 43210'), 'mobile');
  assert.equal(grant.identityKind('Ramesh K'), '');
  assert.ok(/^mob_[0-9a-f]{12}$/.test(grant.mobileKeyId('9876543210')));
  assert.equal(grant.mobileKeyId('+91 98765 43210'), grant.mobileKeyId('09876543210'), 'one number, one id');
  // a customer with an email keeps the email's id even after a mobile is added
  assert.equal(grant.licenceIdFor({ email: 'r@x.io', mobile: '+919876543210' }), grant.emailKeyId('r@x.io'));
  assert.equal(grant.licenceIdFor({ mobile: '+919876543210' }), grant.mobileKeyId('+919876543210'));
  assert.equal(grant.licenceIdFor({ licId: 'eml_keepme', mobile: '+919876543210' }), 'eml_keepme', 'a stored id is never recomputed');
});

// ---- pasted lines ------------------------------------------------------------------

test('a pasted line is understood whatever order its fields are in', () => {
  assert.deepEqual(grant.parseCustomerLine('9876543210, Ramesh K, stockkar, lifetime'),
    { addons: '', mobile: '+919876543210', name: 'Ramesh K', product: 'stockkar_only', exp: '', expSeen: true });
  assert.deepEqual(grant.parseCustomerLine('Priya S, priya@example.com, both, 31-03-2027'),
    { addons: '', email: 'priya@example.com', name: 'Priya S', product: 'both', exp: '2027-03-31', expSeen: true });
  const full = grant.parseCustomerLine('+91 90000 11111, sonu@x.io, Sonu Kumar, gsheet, multibroker, 2027-12-31');
  assert.equal(full.mobile, '+919000011111');
  assert.equal(full.email, 'sonu@x.io');
  assert.equal(full.name, 'Sonu Kumar');
  assert.equal(full.product, 'gsheet_only');
  assert.equal(full.addons, 'multibroker');
  assert.equal(full.exp, '2027-12-31');
  assert.equal(grant.parseCustomerLine('# a comment'), null);
  assert.equal(grant.parseCustomerLine('Ramesh K, lifetime'), null, 'no identity, no customer');
});

// ---- claiming ----------------------------------------------------------------------

async function seeded() {
  const s = store();
  const r = await core.importCustomers(s, null, [
    '9876543210, Ramesh K, stockkar, lifetime',
    'priya@example.com, 90000 11111, Priya S, both, 2027-03-31',
  ].join('\n'));
  assert.deepEqual([r.body.added, r.body.updated, r.body.skipped], [2, 0, 0]);
  return s;
}

test('an unregistered number activates nothing', async () => {
  const s = await seeded();
  const r = await core.claimByIdentity(s, { identity: '9111122222', installId: BOX_A }, opts);
  assert.equal(r.body.state, 'unknown-email');
  assert.equal(r.body.grant, undefined);
});

test('FIRST CLAIM by mobile: a grant that verifies on the box, bound to it, carrying the number', async () => {
  const s = await seeded();
  const r = await core.claimByIdentity(s, { identity: '+91 98765 43210', installId: BOX_A, meta: { host: 'ip-10-0-0-9', version: '3.24.0' } }, opts);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.first, true);
  assert.equal(r.body.mobile, '+919876543210');
  assert.equal(r.body.email, '');
  assert.ok(/^mob_/.test(r.body.keyId), 'a mobile-only customer gets a mob_ licence id');
  const v = verifyOn(r.body.grant, BOX_A);
  assert.equal(v.valid, true);
  assert.equal(v.bind.ok, true);
  assert.equal(v.payload.mobile, '+919876543210');
  assert.equal(v.payload.email, undefined);
  assert.equal(v.payload.to, 'Ramesh K');
  assert.deepEqual(v.payload.features, ['stockkar']);
  assert.equal(v.payload.exp, undefined, 'lifetime');
  assert.equal(verifyOn(r.body.grant, BOX_B).bind.ok, false, 'useless on another box');
});

test('ONE NUMBER, ONE BOX: the same number on a second box is refused', async () => {
  const s = await seeded();
  await core.claimByIdentity(s, { identity: '9876543210', installId: BOX_A }, opts);
  const second = await core.claimByIdentity(s, { identity: '098765 43210', installId: BOX_B }, opts);
  assert.equal(second.body.ok, false);
  assert.equal(second.body.state, 'claimed');
  assert.equal(second.body.grant, undefined);
  // the same box may re-ask forever
  const again = await core.claimByIdentity(s, { identity: '+919876543210', installId: BOX_A }, opts);
  assert.equal(again.body.state, 'activated');
  assert.equal(again.body.first, false);
});

test('ONE CUSTOMER, ONE LICENCE: email and mobile are the same seat, not two', async () => {
  const s = await seeded();
  const byMobile = await core.claimByIdentity(s, { identity: '90000 11111', installId: BOX_A }, opts);
  assert.equal(byMobile.body.ok, true);
  assert.ok(/^eml_/.test(byMobile.body.keyId), 'a customer with an email keeps the email id');
  const byEmail = await core.claimByIdentity(s, { identity: 'priya@example.com', installId: BOX_B }, opts);
  assert.equal(byEmail.body.state, 'claimed', 'the other identity on another box is still the same licence');
  // and on the SAME box, either identity works
  const sameBox = await core.claimByIdentity(s, { identity: 'PRIYA@example.com', installId: BOX_A }, opts);
  assert.equal(sameBox.body.state, 'activated');
  const v = verifyOn(sameBox.body.grant, BOX_A);
  assert.equal(v.payload.email, 'priya@example.com');
  assert.equal(v.payload.mobile, '+919000011111');
  assert.deepEqual(v.payload.features, ['stockkar', 'gsheet']);
});

test('adding a mobile to an existing email customer keeps their box and their licence id', async () => {
  const s = store();
  await core.importCustomers(s, [{ email: 'solo@x.io', name: 'Solo', product: 'stockkar_only', exp: 'lifetime' }]);
  const first = await core.claimByIdentity(s, { identity: 'solo@x.io', installId: BOX_A }, opts);
  const licId = first.body.keyId;
  const imp = await core.importCustomers(s, null, 'solo@x.io, 9000000001');
  assert.deepEqual([imp.body.added, imp.body.updated], [0, 1], 'an update, not a new customer');
  const byMobile = await core.claimByIdentity(s, { identity: '9000000001', installId: BOX_A }, opts);
  assert.equal(byMobile.body.keyId, licId, 'same licence id, so the claim survived');
  assert.equal(byMobile.body.state, 'activated');
  assert.equal((await core.claimByIdentity(s, { identity: '9000000001', installId: BOX_B }, opts)).body.state, 'claimed');
  assert.equal((await core.listCustomers(s)).body.count, 1, 'one customer, not two');
});

test('an update line changes only what it states; lifetime clears an expiry', async () => {
  const s = await seeded();
  await core.importCustomers(s, null, '9876543210, 2027-06-30');
  let cust = (await core.resolveCustomer(s, '9876543210')).cust;
  assert.equal(cust.exp, '2027-06-30');
  assert.equal(cust.name, 'Ramesh K', 'the name survived');
  assert.deepEqual(cust.features, ['stockkar'], 'the plan survived');
  await core.importCustomers(s, null, '9876543210, both, lifetime');
  cust = (await core.resolveCustomer(s, '9876543210')).cust;
  assert.equal(cust.exp, '');
  assert.deepEqual(cust.features, ['stockkar', 'gsheet']);
});

test('the console list shows one row per customer with both identities, and remove takes the aliases with it', async () => {
  const s = await seeded();
  await core.claimByIdentity(s, { identity: '9876543210', installId: BOX_A, meta: { host: 'box-a' } }, opts);
  const list = await core.listCustomers(s);
  assert.equal(list.body.count, 2, 'two customers, no alias rows');
  const ramesh = list.body.customers.find(c => c.mobile === '+919876543210');
  assert.equal(ramesh.installId, BOX_A);
  assert.equal(ramesh.host, 'box-a');
  const priya = list.body.customers.find(c => c.email === 'priya@example.com');
  assert.equal(priya.mobile, '+919000011111');
  assert.equal(priya.installId, null);
  const rm = await core.removeCustomer(s, '90000 11111');
  assert.ok(rm.body.ok);
  assert.equal((await core.listCustomers(s)).body.count, 1);
  assert.equal((await core.claimByIdentity(s, { identity: 'priya@example.com', installId: BOX_B }, opts)).body.state, 'unknown-email', 'the alias went too');
});

test('revoke and release work on a mobile licence exactly like any other', async () => {
  const s = await seeded();
  const first = await core.claimByIdentity(s, { identity: '9876543210', installId: BOX_A }, opts);
  await core.revoke(s, first.body.keyId, 'payment failed');
  const rv = await core.claimByIdentity(s, { identity: '9876543210', installId: BOX_A }, opts);
  assert.equal(rv.body.state, 'revoked');
  assert.equal(rv.body.reason, 'payment failed');
  await core.unrevoke(s, first.body.keyId);
  await core.release(s, first.body.keyId);
  assert.equal((await core.claimByIdentity(s, { identity: '9876543210', installId: BOX_B }, opts)).body.state, 'activated', 'released: a new box may take it');
});

// ---- the box's own reading of a typed identity -------------------------------------

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('the box normalises what the customer typed the same way the service does', () => {
  assert.ok(src.includes('function normalizeActivationIdentity(v) {'));
  assert.ok(src.includes("return /^[6-9]\\d{9}$/.test(d) ? '+91' + d : '';"));
  assert.ok(src.includes("if (parsedUrl.pathname === '/license/email' && req.method === 'POST') {"));
  assert.ok(src.includes("return getBody(({ identity, email, mobile }) => {"));
  assert.ok(src.includes("activation.claimByIdentity({ dir: DATA_DIR, identity: em, version: String(PACKAGE.version || '') })"));
});
