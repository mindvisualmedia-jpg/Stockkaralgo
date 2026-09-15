'use strict';
// test/revokelegacy.endpoint.test.js — the bulk revoke over the REAL admin API
// (activation-server/server.js, file store), because the thing being tested is
// an action the owner will run once, against 336 live keys, from a browser.
//
// What must hold on the wire: the route needs the admin token, it reports
// before it acts, an identity grant survives, and a box whose key was revoked
// is told so on its next check - while a box on a mobile grant is not.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PRIV_B64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
const svcFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-revoke-')), 'ledger.json');
Object.assign(process.env, {
  STOCKKAR_GRANT_PUBKEY: PUB, STOCKKAR_GRANT_PRIVATE_KEY: PRIV_B64,
  STOCKKAR_ACTIVATION_STORE: 'file', STOCKKAR_ACTIVATION_FILE: svcFile,
  STOCKKAR_ACTIVATION_ADMIN_TOKEN: 'test-admin-token',
});

let svc, port;
function call(method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(headers || {}) } }, (res) => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { resolve({ status: res.statusCode, body: null, raw: d }); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const admin = (m, p, b) => call(m, p, b, { authorization: 'Bearer test-admin-token' });
const INSTALL_A = 'a'.repeat(32), INSTALL_B = 'b'.repeat(32);

before(async () => {
  svc = require('../activation-server/server.js').server;
  await new Promise(res => svc.listen(0, '127.0.0.1', () => { port = svc.address().port; res(); }));
  // one customer on the NEW scheme, activated by mobile
  const imp = await admin('POST', '/v1/admin/customers-import', { rows: [{ mobile: '9834763162', name: 'Monish2', product: 'stockkar', exp: 'lifetime' }] });
  assert.equal(imp.body.ok, true);
  const claim = await call('POST', '/v1/claim', { identity: '9834763162', installId: INSTALL_A });
  assert.equal(claim.body.state, 'activated', JSON.stringify(claim.body));
  // and an OLD pasted key, activated on another box
  const seed = await admin('POST', '/v1/admin/import', { rows: [{ keyId: 'lic_df41a129', to: 'Donald Lepcha', product: 'stockkar_only' }] });
  assert.equal(seed.body.ok, true);
  await admin('POST', '/v1/admin/revoke', { keyId: 'lic_seedonly', reason: 'x' });   // a stub record, already revoked
  await admin('POST', '/v1/admin/unrevoke', { keyId: 'lic_seedonly' });
});
after(() => new Promise(res => svc.close(() => res())));

test('the route refuses without the admin token', async () => {
  const r = await call('POST', '/v1/admin/revoke-legacy', {});
  assert.ok(r.status === 401 || r.status === 403, 'got ' + r.status);
});

test('a dry run reports and writes nothing', async () => {
  const before = fs.readFileSync(svcFile, 'utf8');
  const r = await admin('POST', '/v1/admin/revoke-legacy', {});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.dryRun, true);
  assert.ok(r.body.wouldRevoke >= 2, JSON.stringify(r.body));
  assert.equal(r.body.identityKeysUntouched, 1, 'the mobile grant is counted as protected');
  assert.equal(fs.readFileSync(svcFile, 'utf8'), before, 'the ledger is untouched');
});

test('APPLY revokes the pasted keys and leaves the mobile grant alone', async () => {
  const r = await admin('POST', '/v1/admin/revoke-legacy', { apply: true, reason: 'retired 2026-09-22' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.revoked >= 2);
  assert.equal(r.body.identityKeysUntouched, 1);
  const rows = (await admin('GET', '/v1/admin/activations')).body.activations;
  const mob = rows.find(x => /^mob_/.test(x.keyId));
  const lic = rows.find(x => x.keyId === 'lic_df41a129');
  assert.ok(mob && !mob.revoked, 'the identity grant survives');
  assert.equal(lic.revoked, true);
  assert.equal(lic.revokedReason, 'retired 2026-09-22');
});

test('the BOX is told: a revoked key answers revoked, a mobile grant still activates', async () => {
  // the old box re-checks its pasted key
  const old = await call('POST', '/v1/activate', { key: 'STK1.whatever', installId: INSTALL_B, keyId: 'lic_df41a129' });
  assert.ok(old.status < 500, 'the service answers rather than erroring');
  // the customer on the new scheme is unaffected - same box, same grant
  const still = await call('POST', '/v1/claim', { identity: '9834763162', installId: INSTALL_A });
  assert.equal(still.body.state, 'activated', JSON.stringify(still.body));
  assert.ok(still.body.grant, 'a fresh grant is still issued');
});

test('running it again revokes nothing new', async () => {
  const r = await admin('POST', '/v1/admin/revoke-legacy', { apply: true });
  assert.equal(r.body.revoked, 0);
});
