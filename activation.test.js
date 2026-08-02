/**
 * Activation tests.
 *
 * The important ones are not the happy path - they are the FAIL-SAFE proofs:
 * a dead service, a 500, a garbage reply and a timeout must all leave a paying
 * customer with full features. Those are the tests that stop a future change
 * from turning our downtime into their downtime.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const lic = require('./license.js');
const activation = require('./activation.js');
const core = require('./activation-server/core.js');
const { fileStore } = require('./activation-server/store.js');

// ---- a throwaway issuer, so tests never touch the real one -----------------
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function mint(payload) {
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.sign(null, Buffer.from(body), privateKey));
  return 'STK1.' + body + '.' + sig;
}
const base = (o = {}) => ({
  v: 1, id: o.id || 'lic_test01', to: o.to || 'Test Buyer',
  product: 'both', features: ['stockkar', 'gsheet'],
  iat: '2026-08-01', exp: o.exp === undefined ? '2027-08-01' : o.exp,
  maxAccounts: o.maxAccounts || 0,
});

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'stk-act-'));
const store = () => fileStore(path.join(tmpdir(), 'a.json'));
const INSTALL_A = 'a'.repeat(32), INSTALL_B = 'b'.repeat(32);

// Core verifies with the REAL baked public key, so tests drive it through a
// stub whose verifier accepts our throwaway issuer instead.
function stubCore() {
  const orig = lic.verifyLicense;
  lic.verifyLicense = (raw) => orig(raw, { publicKey: PUB });
  return () => { lic.verifyLicense = orig; };
}

// ---------------------------------------------------------------- core -----

test('first activation claims the key; the same box may re-ask forever', async () => {
  const undo = stubCore();
  try {
    const s = store(), key = mint(base());
    const first = await core.activate(s, { key, installId: INSTALL_A });
    assert.strictEqual(first.body.state, 'activated');
    assert.strictEqual(first.body.first, true);

    const again = await core.activate(s, { key, installId: INSTALL_A });
    assert.strictEqual(again.body.ok, true, 'restarts and reinstalls must not lock a customer out');
    assert.strictEqual(again.body.first, false);

    const rows = (await core.listActivations(s)).body.activations;
    assert.strictEqual(rows.length, 1, 'one key, one row');
    assert.strictEqual(rows[0].seenCount, 2);
  } finally { undo(); }
});

test('a DIFFERENT box is refused - the whole point of the service', async () => {
  const undo = stubCore();
  try {
    const s = store(), key = mint(base());
    await core.activate(s, { key, installId: INSTALL_A });
    const friend = await core.activate(s, { key, installId: INSTALL_B });
    assert.strictEqual(friend.body.ok, false);
    assert.strictEqual(friend.body.state, 'claimed');
    assert.ok(friend.body.claimedAt, 'tells support when the real owner claimed it');
  } finally { undo(); }
});

test('release frees the slot so a customer can move servers', async () => {
  const undo = stubCore();
  try {
    const s = store(), key = mint(base());
    await core.activate(s, { key, installId: INSTALL_A });
    const rel = await core.release(s, 'lic_test01');
    assert.strictEqual(rel.body.ok, true);
    const moved = await core.activate(s, { key, installId: INSTALL_B });
    assert.strictEqual(moved.body.state, 'activated', 'new server claims it cleanly');
  } finally { undo(); }
});

test('forged and malformed keys never reach the ledger', async () => {
  const undo = stubCore();
  try {
    const s = store();
    const forged = 'STK1.' + b64u(JSON.stringify(base())) + '.' + b64u('not-a-signature');
    assert.strictEqual((await core.activate(s, { key: forged, installId: INSTALL_A })).status, 400);
    assert.strictEqual((await core.activate(s, { key: 'rubbish', installId: INSTALL_A })).status, 400);
    assert.strictEqual((await core.activate(s, { key: mint(base()), installId: 'nope!' })).status, 400);
    assert.strictEqual((await core.listActivations(s)).body.count, 0);
  } finally { undo(); }
});

test('an expired but genuine key still activates', async () => {
  const undo = stubCore();
  try {
    const s = store();
    const out = await core.activate(s, { key: mint(base({ exp: '2020-01-01' })), installId: INSTALL_A });
    assert.strictEqual(out.body.state, 'activated', 'expiry is the box\'s business, not activation\'s');
  } finally { undo(); }
});

test('admin token is required and compared safely', () => {
  assert.strictEqual(core.adminOk('Bearer s3cret', 's3cret'), true);
  assert.strictEqual(core.adminOk('Bearer wrong', 's3cret'), false);
  assert.strictEqual(core.adminOk('Bearer anything', ''), false, 'unset token = admin DISABLED, never open');
  assert.strictEqual(core.adminOk('', 's3cret'), false);
});

// -------------------------------------------------------------- client -----

// A one-request stub service. `reply` decides what the box gets back.
function withService(reply, fn) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let d = ''; req.on('data', c => (d += c));
      req.on('end', () => reply(JSON.parse(d || '{}'), res));
    });
    srv.listen(0, '127.0.0.1', async () => {
      const url = 'http://127.0.0.1:' + srv.address().port + '/v1/activate';
      try { resolve(await fn(url)); } catch (e) { reject(e); } finally { srv.close(); }
    });
  });
}
const ok = (body) => (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

test('installId is stable across calls and survives a key change', () => {
  const dir = tmpdir();
  const a = activation.installId(dir);
  assert.match(a, /^[a-f0-9]{32}$/);
  assert.strictEqual(activation.installId(dir), a, 'must not churn - it is the box identity');
  fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key: 'STK1.whatever' }));
  assert.strictEqual(activation.installId(dir), a, 'replacing a key does not change who the box is');
});

test('a claimed answer records refused; license.js then withholds features', async () => {
  const undo = stubCore();
  try {
    const dir = tmpdir(), key = mint(base());
    fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key }));
    const r = await withService(ok({ ok: false, state: 'claimed', claimedAt: '2026-08-01T10:00:00Z' }),
      url => activation.ensureActivated({ dir, key, keyId: 'lic_test01', url }));
    assert.strictEqual(r.state, 'refused');

    const ent = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.deepStrictEqual(ent.features, [], 'a shared key grants nothing');
    assert.strictEqual(ent.license.reason, 'key-in-use');
  } finally { undo(); }
});

test('an activated answer records active, and license.js is unaffected', async () => {
  const undo = stubCore();
  try {
    const dir = tmpdir(), key = mint(base());
    fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key }));
    const r = await withService(ok({ ok: true, state: 'activated', first: true }),
      url => activation.ensureActivated({ dir, key, keyId: 'lic_test01', url }));
    assert.strictEqual(r.state, 'active');

    const ent = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.strictEqual(ent.has('gsheet'), true);
    assert.strictEqual(ent.license.reason, 'ok');
  } finally { undo(); }
});

// ---- THE FAIL-SAFE PROOFS --------------------------------------------------

test('FAIL-SAFE: an unreachable service leaves a customer with FULL features', async () => {
  const undo = stubCore();
  try {
    const dir = tmpdir(), key = mint(base());
    fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key }));
    // Port 1 on loopback: nothing is listening, connection refused immediately.
    const r = await activation.ensureActivated({ dir, key, keyId: 'lic_test01', url: 'http://127.0.0.1:1/v1/activate' });
    assert.strictEqual(r.state, 'provisional');

    const ent = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.strictEqual(ent.has('stockkar'), true, 'OUR downtime must never become THEIR downtime');
    assert.strictEqual(ent.has('gsheet'), true);
    assert.strictEqual(ent.license.valid, true);
  } finally { undo(); }
});

test('FAIL-SAFE: a 500 and a garbage reply both stay provisional', async () => {
  const undo = stubCore();
  try {
    for (const reply of [
      (_r, res) => { res.writeHead(500); res.end('boom'); },
      (_r, res) => { res.writeHead(200); res.end('<html>gateway</html>'); },
      ok({ something: 'unexpected' }),
    ]) {
      const dir = tmpdir(), key = mint(base());
      fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key }));
      const r = await withService(reply, url => activation.ensureActivated({ dir, key, keyId: 'lic_test01', url }));
      assert.strictEqual(r.state, 'provisional', 'only an explicit "claimed" may take features away');
      assert.strictEqual(lic.loadEntitlements({ dir, publicKey: PUB }).has('gsheet'), true);
    }
  } finally { undo(); }
});

test('FAIL-SAFE: no service configured means no call and no change', async () => {
  const dir = tmpdir(), key = mint(base());
  fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key }));
  const r = await activation.ensureActivated({ dir, key, keyId: 'lic_test01', url: '' });
  assert.strictEqual(r.reason, 'not-configured');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'license.json'), 'utf8'));
  assert.strictEqual(saved.activation, undefined, 'an unconfigured fleet writes nothing at all');
});

test('once active, the box never asks again', async () => {
  const dir = tmpdir(), key = mint(base());
  fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key, activation: { state: 'active', keyId: 'lic_test01' } }));
  let called = false;
  const r = await withService((_q, res) => { called = true; ok({ ok: false, state: 'claimed' })(_q, res); },
    url => activation.ensureActivated({ dir, key, keyId: 'lic_test01', url }));
  assert.strictEqual(called, false, 'an activated box is independent of the service forever');
  assert.strictEqual(r.state, 'active');
});

test('a provisional box backs off instead of hammering us', async () => {
  const dir = tmpdir(), key = mint(base());
  fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({
    key, activation: { state: 'provisional', keyId: 'lic_test01', lastTry: new Date().toISOString() },
  }));
  let called = false;
  await withService((_q, res) => { called = true; ok({ ok: true, state: 'activated' })(_q, res); },
    url => activation.ensureActivated({ dir, key, keyId: 'lic_test01', url }));
  assert.strictEqual(called, false, 'retries are daily, not per-boot');
});

test('a refusal earned by an OLD key does not stick to a new one', async () => {
  const undo = stubCore();
  try {
    const dir = tmpdir();
    const newKey = mint(base({ id: 'lic_new02' }));
    fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({
      key: newKey, activation: { state: 'refused', keyId: 'lic_OLD01' },
    }));
    // license.js must ignore a refusal recorded against a different key id.
    const ent = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.strictEqual(ent.has('gsheet'), true, 'buying a fresh key must fix the problem');
    assert.strictEqual(ent.license.reason, 'ok');
  } finally { undo(); }
});

test('legacy grace outranks a refusal', async () => {
  const undo = stubCore();
  try {
    const dir = tmpdir(), key = mint(base());
    fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({
      key, activation: { state: 'refused', keyId: 'lic_test01' },
    }));
    const ent = lic.loadEntitlements({ dir, publicKey: PUB, legacyInstall: true, now: new Date('2026-08-15') });
    assert.ok(ent.features.length > 0, 'an existing user in the grace window keeps trading');
    assert.strictEqual(ent.license.legacyGrace, true);
  } finally { undo(); }
});
