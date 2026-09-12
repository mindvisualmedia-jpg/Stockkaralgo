'use strict';
// test/license.email.test.js - EMAIL ACTIVATION over the wire (2026-09-10): the
// REAL activation service (activation-server/server.js, file store, a test
// grant key) and the REAL box route POST /license/email (handleRequest). The
// customer types an email; the box ends up with a verified, bound grant in
// license.json and full entitlements; a second box is refused; a stranger's
// email activates nothing; a dead service is an error, never a half state.
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

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-eml-box-'));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
const svcFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-eml-svc-')), 'ledger.json');
Object.assign(process.env, {
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_TELEGRAM_DISABLED: '1',
  // the box trusts THIS test's grant key; the service signs with its private half
  STOCKKAR_GRANT_PUBKEY: PUB, STOCKKAR_GRANT_PRIVATE_KEY: PRIV_B64,
  STOCKKAR_ACTIVATION_STORE: 'file', STOCKKAR_ACTIVATION_FILE: svcFile,
  STOCKKAR_ACTIVATION_ADMIN_TOKEN: 'test-admin-token',
});

let S, app, appPort, svc, svcPort;

function call(port, method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(headers || {}) } }, (res) => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const box = (method, pathname, body) => call(appPort, method, pathname, body, { 'x-stockkar-internal': S.INTERNAL_SECRET });
const admin = (method, pathname, body) => call(svcPort, method, pathname, body, { authorization: 'Bearer test-admin-token' });

before(async () => {
  svc = require('../activation-server/server.js').server;
  await new Promise(res => svc.listen(0, '127.0.0.1', () => { svcPort = svc.address().port; res(); }));
  process.env.STOCKKAR_ACTIVATION_URL = 'http://127.0.0.1:' + svcPort + '/v1/activate';
  S = require('../server.js')._internals;
  app = http.createServer(S.handleRequest);
  await new Promise(res => app.listen(0, '127.0.0.1', () => { appPort = app.address().port; res(); }));
  const imp = await admin('POST', '/v1/admin/customers-import', { rows: [{ email: 'ramesh@example.com', name: 'Ramesh K', product: 'both', exp: 'lifetime' }] });
  assert.equal(imp.body.ok, true);
});
after(() => new Promise(res => app.close(() => svc.close(() => res()))));

test('a stranger\'s email activates nothing, with a plain message', async () => {
  const r = await box('POST', '/license/email', { email: 'nobody@example.com' });
  assert.equal(r.status, 400);
  assert.equal(r.body.state, 'unknown-email');
  assert.match(r.body.error, /not registered with Stockkar/);
  assert.ok(!fs.existsSync(path.join(dataDir, 'license.json')), 'nothing written');
});

test('a malformed email never leaves the box', async () => {
  const r = await box('POST', '/license/email', { email: 'ramesh at example' });
  assert.equal(r.status, 400);
  assert.equal(r.body.state, 'bad-identity');
});

test('INCIDENT-FREE PATH: the registered email activates this box - grant stored, verified, bound, entitled', async () => {
  const r = await box('POST', '/license/email', { email: ' Ramesh@Example.com ' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.ok, true);
  assert.equal(r.body.email, 'ramesh@example.com');
  assert.deepEqual(r.body.features, ['stockkar', 'gsheet']);
  assert.equal(r.body.license.valid, true);
  assert.equal(r.body.license.email, 'ramesh@example.com');
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'license.json'), 'utf8'));
  assert.equal(stored.email, 'ramesh@example.com');
  assert.equal(stored.source, 'identity');
  assert.ok(/^STK1\./.test(stored.key), 'the grant is an ordinary STK1 licence');
  assert.equal(stored.activation.state, 'active');
  assert.ok(/^eml_/.test(stored.activation.keyId));
  // the entitlements route tells the UI which email this box runs under
  const ent = await box('GET', '/entitlements');
  assert.equal(ent.body.license.valid, true);
  assert.equal(ent.body.license.email, 'ramesh@example.com');
  assert.equal(ent.body.license.lifetime, true);
  // the service ledger shows the claim under the email
  const cust = await admin('GET', '/v1/admin/customers');
  const row = cust.body.customers.find(c => c.email === 'ramesh@example.com');
  assert.equal(row.installId, stored.activation.installId);
});

test('activating again on the same box is idempotent', async () => {
  const r = await box('POST', '/license/email', { email: 'ramesh@example.com' });
  assert.equal(r.body.ok, true);
});

test('a SECOND box with the same email is refused by the service', async () => {
  const r = await call(svcPort, 'POST', '/v1/claim', { email: 'ramesh@example.com', installId: 'f'.repeat(32) });
  assert.equal(r.body.state, 'claimed');
  assert.equal(r.body.grant, undefined);
});

test('a dead licence server is an error the customer can read, and the stored licence is untouched', async () => {
  const prev = process.env.STOCKKAR_ACTIVATION_URL;
  process.env.STOCKKAR_ACTIVATION_URL = 'http://127.0.0.1:9/v1/activate';   // nothing listens on 9
  try {
    const before = fs.readFileSync(path.join(dataDir, 'license.json'), 'utf8');
    const r = await box('POST', '/license/email', { email: 'ramesh@example.com' });
    assert.equal(r.status, 503);
    assert.equal(r.body.state, 'unreachable');
    assert.match(r.body.error, /Could not reach/);
    assert.equal(fs.readFileSync(path.join(dataDir, 'license.json'), 'utf8'), before);
  } finally { process.env.STOCKKAR_ACTIVATION_URL = prev; }
});
