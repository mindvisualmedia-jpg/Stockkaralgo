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

// The service verifies with the baked production issuer key. Point it at our
// throwaway issuer for the duration of a test, exactly as a staging deployment
// would.
function stubCore() {
  const prev = process.env.STOCKKAR_ISSUER_PUBLIC_KEY;
  process.env.STOCKKAR_ISSUER_PUBLIC_KEY = PUB;
  return () => {
    if (prev === undefined) delete process.env.STOCKKAR_ISSUER_PUBLIC_KEY;
    else process.env.STOCKKAR_ISSUER_PUBLIC_KEY = prev;
  };
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

test('an active box asks at most once a day - and a fresh check stays quiet (contract updated 2026-08-21 for revocation)', async () => {
  const dir = tmpdir(), key = mint(base());
  // a record checked minutes ago: no call, no dependence on the service
  fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key,
    activation: { state: 'active', keyId: 'lic_test01', lastTry: new Date().toISOString() } }));
  let called = false;
  const r = await withService((_q, res) => { called = true; ok({ ok: false, state: 'claimed' })(_q, res); },
    url => activation.ensureActivated({ dir, key, keyId: 'lic_test01', url }));
  assert.strictEqual(called, false, 'inside the daily window the box never asks');
  assert.strictEqual(r.state, 'active');
  // a record from before the re-check era (no lastTry at all) re-confirms once
  fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key, activation: { state: 'active', keyId: 'lic_test01' } }));
  const r2 = await withService(ok({ ok: true, state: 'activated', first: false }),
    url => activation.ensureActivated({ dir, key, keyId: 'lic_test01', url }));
  assert.strictEqual(r2.state, 'active', 'migration: pre-recheck records simply confirm and carry on');
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

test('legacy lifetime outranks a refusal', async () => {
  const undo = stubCore();
  try {
    const dir = tmpdir(), key = mint(base());
    fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({
      key, activation: { state: 'refused', keyId: 'lic_test01' },
    }));
    const ent = lic.loadEntitlements({ dir, publicKey: PUB, legacyInstall: true, now: new Date('2026-08-15') });
    assert.ok(ent.features.length > 0, 'a grandfathered user keeps trading regardless');
    assert.strictEqual(ent.license.legacyLifetime, true);
  } finally { undo(); }
});

// ---- DRIFT GUARD ----------------------------------------------------------
// activation-server/verify.js is a deliberate copy of license.js's verifier,
// because Vercel cannot import from above the project root. That copy is only
// safe while the two agree. This test makes disagreement impossible to miss.

test('verify.js and license.js return identical verdicts for every key shape', () => {
  const verify = require('./activation-server/verify.js');

  const good = mint(base());
  const cases = {
    'valid': good,
    'expired': mint(base({ exp: '2020-01-01' })),
    'lifetime (no exp)': mint(base({ exp: null })),
    'bad expiry format': mint(base({ exp: '01-01-2027' })),
    'wrong version': mint({ ...base(), v: 9 }),
    'no features': mint({ ...base(), features: [] }),
    'forged signature': 'STK1.' + b64u(JSON.stringify(base())) + '.' + b64u('nope'),
    'tampered payload': (() => {
      const p = good.split('.');
      return 'STK1.' + b64u(JSON.stringify(base({ id: 'lic_HACKED' }))) + '.' + p[2];
    })(),
    'wrong prefix': good.replace('STK1.', 'STK9.'),
    'two segments': good.split('.').slice(0, 2).join('.'),
    'not base64 payload': 'STK1.@@@@.' + good.split('.')[2],
    'empty': '',
    'rubbish': 'hello',
  };

  for (const [label, key] of Object.entries(cases)) {
    const a = lic.verifyLicense(key, { publicKey: PUB, now: new Date('2026-08-02') });
    const b = verify.verifyLicense(key, { publicKey: PUB, now: new Date('2026-08-02') });
    assert.strictEqual(b.valid, a.valid, label + ': valid disagrees');
    assert.strictEqual(b.reason, a.reason, label + ': reason disagrees (' + a.reason + ' vs ' + b.reason + ')');
    assert.deepStrictEqual(b.payload, a.payload, label + ': payload disagrees');
  }
});

test('verify.js ships the same issuer public key as license.js', () => {
  const verify = require('./activation-server/verify.js');
  // A mismatch here would mean the service rejects every real customer key
  // while every test that supplies its own key still passes. Rotating the
  // issuer key must therefore change both files or this goes red.
  assert.ok(lic.BAKED_PUBLIC_KEY, 'license.js must export its baked key for this check to mean anything');
  assert.strictEqual(verify.BAKED_PUBLIC_KEY, lic.BAKED_PUBLIC_KEY, 'issuer key drifted between the box and the service');
  assert.match(verify.BAKED_PUBLIC_KEY, /^MCowBQYDK2Vw/, 'must be an Ed25519 SPKI key');
});


// ---- upstash wire shape (2026-08-13) ---------------------------------------
// The activation service ran green in every test and returned 500 for every
// real activation. The tests exercised the FILE driver; the upstash driver's
// claim() was the only call that put an option (NX) in the path while sending
// the value in the body, a combination Upstash does not accept - and it is the
// one command an activation performs. These assert the REQUEST we build,
// which is the part that was never checked.
const { upstashStore } = require('./activation-server/store.js');

function recordingStore() {
  const calls = [];
  const https = require('https');
  const orig = https.request;
  https.request = (opts, cb) => {
    calls.push(opts);
    const res = { statusCode: 200, on: (ev, fn) => { if (ev === 'data') fn('{"result":"OK"}'); if (ev === 'end') fn(); } };
    setImmediate(() => cb(res));
    return { on() {}, write() {}, end() {}, destroy() {} };
  };
  return { calls, restore: () => { https.request = orig; } };
}

test('upstash claim sends SET key value NX as path segments, with no body', async () => {
  const rec = recordingStore();
  try {
    await upstashStore('https://example.upstash.io', 'tok').claim('lic_1', { installId: 'abc' });
  } finally { rec.restore(); }
  const path = decodeURIComponent(rec.calls[0].path);
  assert.ok(path.startsWith('/set/'), 'command and key in the path: ' + path);
  assert.ok(path.endsWith('/NX'), 'NX must be the LAST path segment: ' + path);
  assert.ok(path.includes('{"installId":"abc"}'), 'the value travels in the path, encoded once: ' + path);
  assert.equal(rec.calls[0].method, 'GET', 'no body -> GET; a body cannot carry a trailing NX');
});

test('upstash put JSON-encodes the record exactly once', async () => {
  const rec = recordingStore();
  let body = '';
  const https = require('https');
  const wrapped = https.request;
  https.request = (opts, cb) => { const r = wrapped(opts, cb); return { ...r, write(p) { body += p; }, on() {}, end() {}, destroy() {} }; };
  try {
    await upstashStore('https://example.upstash.io', 'tok').put('lic_1', { installId: 'abc' });
  } finally { rec.restore(); }
  assert.equal(body, '{"installId":"abc"}', 'double-encoding makes reads return a string, not a record');
});

// ---- REVOCATION (2026-08-21) ------------------------------------------------
// The one new answer that takes a licence away - and the fail-safe proofs that
// nothing else ever does.

test('revoke: every install gets "revoked" - the owner, a new box, and after unrevoke the owner resumes', async () => {
  const undo = stubCore();
  try {
    const s = store(), key = mint(base());
    await core.activate(s, { key, installId: INSTALL_A });
    const rev = await core.revoke(s, 'lic_test01', 'chargeback');
    assert.strictEqual(rev.body.ok, true);
    assert.strictEqual(rev.body.was, INSTALL_A, 'names who held it');

    const owner = await core.activate(s, { key, installId: INSTALL_A });
    assert.strictEqual(owner.body.state, 'revoked', 'the original box is told, not silently kept');
    const other = await core.activate(s, { key, installId: INSTALL_B });
    assert.strictEqual(other.body.state, 'revoked', 'a new box gets revoked, never "claimed"');

    await core.unrevoke(s, 'lic_test01');
    const back = await core.activate(s, { key, installId: INSTALL_A });
    assert.strictEqual(back.body.state, 'activated');
    assert.strictEqual(back.body.first, false, 'the original claim survived the revocation');
  } finally { undo(); }
});

test('revoke works PRE-EMPTIVELY on a key that was never activated', async () => {
  const undo = stubCore();
  try {
    const s = store(), key = mint(base());
    await core.revoke(s, 'lic_test01', 'issued in error');
    const first = await core.activate(s, { key, installId: INSTALL_A });
    assert.strictEqual(first.body.state, 'revoked', 'a stub record answers before any claim exists');
  } finally { undo(); }
});

test('client loop: an ACTIVE box re-checks after a day, honours "revoked", and license.js withholds features', async () => {
  const undo = stubCore();
  try {
    const dir = tmpdir(), key = mint(base());
    fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key }));
    const a = await withService(ok({ ok: true, state: 'activated', first: true }),
      url => activation.ensureActivated({ dir, key, keyId: 'lic_test01', url }));
    assert.strictEqual(a.state, 'active');

    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    const r = await withService(ok({ ok: false, state: 'revoked', revokedAt: '2026-08-21T10:00:00Z', reason: 'chargeback' }),
      url => activation.ensureActivated({ dir, key, keyId: 'lic_test01', url, now: later }));
    assert.strictEqual(r.state, 'revoked');
    assert.strictEqual(r.changed, true);

    const ent = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.deepStrictEqual(ent.features, [], 'a revoked key grants nothing');
    assert.strictEqual(ent.license.reason, 'revoked');
    assert.match(ent.license.message, /open positions stay fully managed/i, 'the message promises exits keep running');
  } finally { undo(); }
});

test('FAIL-SAFE: a dead service can NEVER demote an active box - even at re-check time', async () => {
  const undo = stubCore();
  try {
    const dir = tmpdir(), key = mint(base());
    fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key }));
    await withService(ok({ ok: true, state: 'activated', first: true }),
      url => activation.ensureActivated({ dir, key, keyId: 'lic_test01', url }));

    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await activation.ensureActivated({ dir, key, keyId: 'lic_test01', url: 'http://127.0.0.1:1/v1/activate', now: later });
    const rec = JSON.parse(fs.readFileSync(path.join(dir, 'license.json'), 'utf8'));
    assert.strictEqual(rec.activation.state, 'active', 'our downtime is our problem, never the customer\'s');
    const ent = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.ok(ent.features.length > 0, 'full features throughout');
  } finally { undo(); }
});

test('an active box does NOT call home inside the 24h window', async () => {
  const undo = stubCore();
  try {
    const dir = tmpdir(), key = mint(base());
    fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key }));
    await withService(ok({ ok: true, state: 'activated', first: true }),
      url => activation.ensureActivated({ dir, key, keyId: 'lic_test01', url }));

    let calls = 0;
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    const r = await withService((_b, res) => { calls++; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); },
      url => activation.ensureActivated({ dir, key, keyId: 'lic_test01', url, now: soon }));
    assert.strictEqual(r.reason, 'already');
    assert.strictEqual(calls, 0, 'quiet between re-checks - no chatty fleet');
  } finally { undo(); }
});

test('a legacy-lifetime box with a revoked key keeps its grandfathered features', async () => {
  const undo = stubCore();
  try {
    const dir = tmpdir(), key = mint(base());
    fs.writeFileSync(path.join(dir, 'license.json'),
      JSON.stringify({ key, activation: { state: 'revoked', keyId: 'lic_test01' } }));
    const ent = lic.loadEntitlements({ dir, publicKey: PUB, legacyInstall: true });
    assert.strictEqual(ent.license.reason, 'revoked', 'the state is still named honestly');
    assert.ok(ent.features.length > 0, 'grandfathered access is never taken away');
  } finally { undo(); }
});

// ---- issued-ledger import (2026-08-24) --------------------------------------
// The console shows every ALLOTTED key, not just the activated ones: the
// offline issuing ledger is imported as metadata records, and a metadata
// record must never block - or be mistaken for - a real claim.

test('import lists issued keys; activation ADOPTS the record instead of answering "claimed"', async () => {
  const undo = stubCore();
  try {
    const s = store(), key = mint(base());
    const imp = await core.importIssued(s, [
      { keyId: 'lic_test01', to: 'Test Buyer', product: 'both', exp: '2027-08-01', issuedAt: '2026-08-04T01:54:04.808Z' },
      { keyId: 'lic_other99', to: 'Someone Else', product: 'stockkar_only', exp: null, issuedAt: '2026-08-04T01:54:04.808Z' },
      { to: 'no keyId - junk' },
    ]);
    assert.deepStrictEqual(imp.body, { ok: true, added: 2, updated: 0, skipped: 1 });

    const rows = (await core.listActivations(s)).body.activations;
    assert.strictEqual(rows.length, 2, 'both issued keys are listed before any box exists');
    assert.ok(rows.every(r => !r.installId), 'metadata rows carry no claim');

    // The customer finally installs: the issued record is adopted, not refused.
    const act = await core.activate(s, { key, installId: INSTALL_A });
    assert.strictEqual(act.body.state, 'activated', 'an issued record must never answer "claimed"');
    assert.strictEqual(act.body.first, true);
    const rec = (await core.listActivations(s)).body.activations.find(r => r.keyId === 'lic_test01');
    assert.strictEqual(rec.installId, INSTALL_A);
    assert.strictEqual(rec.issued, true, 'the issued annotation survives the claim');

    // Re-import is an idempotent annotate - the claim is untouched.
    const again = await core.importIssued(s, [{ keyId: 'lic_test01', to: 'Test Buyer', product: 'both' }]);
    assert.strictEqual(again.body.updated, 1);
    const rec2 = (await core.listActivations(s)).body.activations.find(r => r.keyId === 'lic_test01');
    assert.strictEqual(rec2.installId, INSTALL_A, 're-sync never disturbs an activation');
  } finally { undo(); }
});

test('REGRESSION: revoke -> unrevoke of a never-activated key leaves it activatable (the stub is adopted)', async () => {
  const undo = stubCore();
  try {
    const s = store(), key = mint(base());
    await core.revoke(s, 'lic_test01', 'issued in error');
    await core.unrevoke(s, 'lic_test01');
    const act = await core.activate(s, { key, installId: INSTALL_A });
    assert.strictEqual(act.body.state, 'activated', 'the unrevoke stub must not answer "claimed" forever');
  } finally { undo(); }
});

// ---- the standalone front end + licence console (2026-08-24) ----------------
// The Vercel functions and this server must never disagree about what admin
// can do. This boots the REAL server.js and drives revoke/unrevoke/console
// over actual HTTP - the same wire the console page uses.

test('standalone server: console page served; revoke/unrevoke wired end-to-end over HTTP', async () => {
  const undo = stubCore();
  process.env.STOCKKAR_ACTIVATION_ADMIN_TOKEN = 'console-test-token';
  process.env.STOCKKAR_ACTIVATION_STORE = 'file';
  process.env.STOCKKAR_ACTIVATION_FILE = path.join(tmpdir(), 'ledger.json');
  const { server } = require('./activation-server/server.js');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const B = 'http://127.0.0.1:' + server.address().port;
  const AUTH = { Authorization: 'Bearer console-test-token' };
  const post = (p, body, hdrs) => fetch(B + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(hdrs || {}) }, body: JSON.stringify(body) });
  try {
    // the console is a static page - safe to serve, every API call it makes is token-gated
    const page = await fetch(B + '/console');
    assert.strictEqual(page.status, 200);
    assert.match(await page.text(), /Licence Console/, 'the console page is served at /console');

    // no token -> the admin plane does not exist
    assert.strictEqual((await post('/v1/admin/revoke', { keyId: 'lic_test01' })).status, 401, 'revoke without a token is refused');

    // claim -> revoke -> the box is told -> unrevoke -> the box resumes
    const key = mint(base());
    const claim = await (await post('/v1/activate', { key, installId: INSTALL_A })).json();
    assert.strictEqual(claim.state, 'activated');
    const rev = await (await post('/v1/admin/revoke', { keyId: 'lic_test01', reason: 'test chargeback' }, AUTH)).json();
    assert.strictEqual(rev.ok, true);
    assert.strictEqual(rev.was, INSTALL_A, 'names who held it');

    const ledger = await (await fetch(B + '/v1/admin/activations', { headers: AUTH })).json();
    assert.strictEqual(ledger.activations[0].revoked, true, 'the console sees the mark on the record');
    assert.strictEqual(ledger.activations[0].revokedReason, 'test chargeback');

    const told = await (await post('/v1/activate', { key, installId: INSTALL_A })).json();
    assert.strictEqual(told.state, 'revoked', 'the owner box is told at its next check');

    const un = await (await post('/v1/admin/unrevoke', { keyId: 'lic_test01' }, AUTH)).json();
    assert.strictEqual(un.ok, true);
    const back = await (await post('/v1/activate', { key, installId: INSTALL_A })).json();
    assert.strictEqual(back.state, 'activated');
    assert.strictEqual(back.first, false, 'the original claim survived the round trip');
  } finally {
    if (server.closeAllConnections) server.closeAllConnections();   // fetch keep-alive would wedge close()
    await new Promise(r => server.close(r));
    delete process.env.STOCKKAR_ACTIVATION_ADMIN_TOKEN;
    delete process.env.STOCKKAR_ACTIVATION_STORE;
    delete process.env.STOCKKAR_ACTIVATION_FILE;
    undo();
  }
});
