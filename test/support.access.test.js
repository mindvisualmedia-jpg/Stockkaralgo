'use strict';
// test/support.access.test.js — SUPPORT ACCESS end to end over a real http
// wire (handleRequest), against fake Dhan.
//
// Owner, 2026-09-13: "our aim is to debug user issues and solve them without
// logging into server AWS or Oracle" and "we don't want to pull data". So the
// customer opens a READ-ONLY, expiring pass to their own box and sends the
// link; nothing is shipped to us.
//
// This is a second door into a machine holding live broker credentials, so the
// suite is written as an attack list, not a feature list:
//   - the pass reads the diagnostics it exists for
//   - it cannot write ANYTHING (every POST refused, including the ones that
//     move money or change credentials)
//   - it cannot read a route nobody allow-listed
//   - it never yields a broker token, even from a route that holds one
//   - it cannot unlock the app, and the App Lock still guards everything else
//   - it dies at its expiry, and the owner can kill it instantly
//   - only an unlocked owner can mint one
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createFakeDhan } = require('./fake-dhan');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-support-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({
  clientId: 'FAKECLIENT', token: 'super-secret-dhan-token-value', savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), JSON.stringify([{
  id: 'row-1', broker: 'dhan', symbol: 'NSE:IFCI', action: 'BUY', qty: 102, entryPrice: 60, slPrice: 55, targetPrice: 70,
  status: 'DHAN ENTRY + FOREVER OCO', dhanProtection: 'forever', orderId: 'ENTRY:900001 | FOREVER:5000', dhanForeverId: '5000',
  recordedAt: new Date().toISOString(), time: new Date().toLocaleString('en-IN'),
}]));
Object.assign(process.env, {
  STOCKKAR_LICENCE_ENFORCE: '0', STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http', STOCKKAR_TELEGRAM_DISABLED: '1',
});

const fake = createFakeDhan({ securities: { 3: 'IFCI' }, marketPrice: 100 });
let S, app, appPort, TOKEN = '', ownerCookie = '';

function call(method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({ hostname: '127.0.0.1', port: appPort, path: pathname, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(headers || {}) } }, (res) => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, raw: d, headers: res.headers, body: (() => { try { return JSON.parse(d); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
// as the OWNER (unlocked with the PIN)
const owner = (m, p, b) => call(m, p, b, { cookie: ownerCookie });
// as SUPPORT (the granted pass, nothing else)
const support = (m, p, b) => call(m, p, b, { 'x-stockkar-support': TOKEN });

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  fake.holdSymbol('IFCI', 102);
  fake.seedForever('IFCI', 55, 70, 102);
  S = require('../server.js')._internals;
  app = http.createServer(S.handleRequest);
  await new Promise(res => app.listen(0, '127.0.0.1', () => { appPort = app.address().port; res(); }));
  const setup = await call('POST', '/app-lock/setup', { pin: '654321', dob: '1990-01-01' });
  assert.equal(setup.status, 200, setup.raw);
  ownerCookie = String(setup.headers['set-cookie'][0]).split(';')[0];
});
after(() => new Promise(res => app.close(() => fake.close(() => res()))));

// ---- only the owner can open the door ------------------------------------------
test('a locked stranger cannot mint a support pass', async () => {
  const r = await call('POST', '/support/grant', { hours: 2 });
  assert.equal(r.status, 401);
  assert.equal(r.body.locked, true);
  assert.ok(!r.body.token);
});

test('the unlocked owner mints one, and the token is shown exactly once', async () => {
  const r = await owner('POST', '/support/grant', { hours: 2 });
  assert.equal(r.status, 200, r.raw);
  assert.match(r.body.token, /^[a-f0-9]{48}$/);
  assert.equal(r.body.hours, 2);
  TOKEN = r.body.token;
  // stored HASHED: a stolen data dir yields no working pass
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'support_access.json'), 'utf8'));
  assert.ok(!JSON.stringify(stored).includes(TOKEN), 'the raw token is never written to disk');
  assert.ok(stored.hash && stored.salt);
  const again = await owner('GET', '/support/status');
  assert.equal(again.body.active, true);
  assert.ok(!JSON.stringify(again.body).includes(TOKEN), 'status never re-reveals it');
});

test('the requested window is clamped to the maximum', async () => {
  const r = await owner('POST', '/support/grant', { hours: 999 });
  assert.equal(r.body.hours, 8);
  TOKEN = r.body.token;                       // the new pass replaces the old
});

// ---- what the pass is FOR --------------------------------------------------------
test('support reads the diagnostics it exists for: the audit, the order log, the plan', async () => {
  const audit = await support('GET', '/debug/audit?broker=dhan');
  assert.equal(audit.status, 200, audit.raw);
  assert.equal(audit.body.ok, true);
  assert.equal(audit.body.brokers[0].positions[0].symbol, 'NSE:IFCI');

  const log = await support('GET', '/order-log');
  assert.equal(log.status, 200);
  assert.equal(log.body.data[0].id, 'row-1');

  const extra = await support('GET', '/protection/extra');
  assert.equal(extra.status, 200);

  const tok = await support('GET', '/broker-token-status');
  assert.equal(tok.status, 200, 'the token STATUS is exactly what a dead-broker incident needs');
});

test('/debug/broker answers the whole support question in ONE call', async () => {
  const r = await support('GET', '/debug/broker');
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.ok, true);
  assert.ok(Array.isArray(r.body.problems), 'a plain-words problem list');
  assert.ok(typeof r.body.summary === 'string' && r.body.summary.length > 10, r.body.summary);
  const dhan = r.body.brokers.find(b => b.broker === 'dhan');
  assert.equal(dhan.canRead, true);
  // the position, what it claims, and what the broker actually shows
  const pos = dhan.positions.find(p => p.symbol === 'NSE:IFCI');
  assert.equal(pos.rowQty, 102);
  assert.equal(pos.heldAtBroker, 102);
  assert.equal(pos.verdict, 'protected');
  assert.equal(pos.brokerStop, 55);
  // the token answer that used to live in no diagnostic at all - and it must
  // SURVIVE the credential redactor, which blanks any field called 'token'
  assert.notEqual(dhan.tokenHealth, '[redacted]', 'the redactor must not eat the diagnostic');
  assert.ok(dhan.tokenHealth && dhan.tokenHealth.status, JSON.stringify(dhan.tokenHealth));
  assert.ok('why' in dhan.tokenHealth && 'whatToDo' in dhan.tokenHealth);
  assert.ok(!r.raw.includes('super-secret-dhan-token-value'), 'still no credential');
});

// ---- what it must never do -------------------------------------------------------
test('ATTACK: every write is refused, including the ones that move money or change credentials', async () => {
  const writes = [
    ['POST', '/protection/extra/cancel', { broker: 'dhan', ids: ['5000'] }],
    ['POST', '/order-log', [{ symbol: 'NSE:INFY' }]],
    ['POST', '/holdings/adopt', { broker: 'dhan', symbol: 'IFCI', qty: 1, entryPrice: 60, slPrice: 55 }],
    ['POST', '/algo-schedule', { name: 'x' }],
    ['POST', '/algo-scan', {}],
    ['POST', '/update/start', {}],
    ['POST', '/app-lock/reconfigure', { pin: '111111' }],
    ['POST', '/support/grant', { hours: 8 }],
    ['POST', '/support/revoke', {}],
  ];
  for (const [m, p, b] of writes) {
    const r = await support(m, p, b);
    assert.ok(r.status === 403 || r.status === 401, m + ' ' + p + ' should be refused, got ' + r.status + ' ' + r.raw.slice(0, 120));
    if (r.status === 403) assert.equal(r.body.supportReadOnly, true, p);
  }
  // nothing moved at the broker
  assert.equal(fake.liveForevers().length, 1);
  // and the pass still cannot mint itself a new one
  const st = await owner('GET', '/support/status');
  assert.equal(st.body.active, true);
});

test('ATTACK: the Angel OCO PROBE is refused - it is a GET that places a real rule', async () => {
  // The allow-list said '/debug/' for one day. /debug/angelone/oco-probe
  // creates AND modifies a live GTT rule at the customer's broker, over GET.
  // A prefix promises something about every route added under it later.
  const r = await support('GET', '/debug/angelone/oco-probe?confirm=yes');
  assert.equal(r.status, 403, 'the probe must never be reachable with a read-only pass');
  assert.equal(r.body.supportReadOnly, true);
  // the diagnostics either side of it still work
  assert.equal((await support('GET', '/debug/angelone')).status, 200);
  assert.equal((await support('GET', '/debug/broker')).status, 200);
});

test('ATTACK: a read nobody allow-listed is refused, even though it is a GET', async () => {
  for (const p of ['/broker/zerodha/login', '/order-log/refresh-status', '/dhan-token', '/settings']) {
    const r = await support('GET', p);
    assert.ok(r.status !== 200 || r.body === null, 'GET ' + p + ' must not be served to support: ' + r.status);
  }
});

test('ATTACK: no broker credential leaves the box, even from routes that hold one', async () => {
  const secret = 'super-secret-dhan-token-value';
  for (const p of ['/debug/audit?broker=dhan', '/debug/protection', '/broker-token-status', '/entitlements', '/order-log']) {
    const r = await support('GET', p);
    assert.ok(!r.raw.includes(secret), 'the Dhan token appeared in ' + p);
  }
  // the owner's own view is NOT redacted - this is a support-session rule only
  const asOwner = await owner('GET', '/broker-token-status');
  assert.equal(asOwner.status, 200);
});

test('ATTACK: the pass cannot unlock the app, and the App Lock still guards everything else', async () => {
  const r = await call('GET', '/order-log', null, { 'x-stockkar-support': 'f'.repeat(48) });
  assert.equal(r.status, 401, 'a made-up token is just a locked stranger');
  // holding a pass earns NO credit at the PIN prompt: it is not a half-login
  const wrong = await support('POST', '/app-lock/login', { pin: '000000' });
  assert.ok(wrong.status >= 400, 'a pass plus a wrong PIN is still refused');
  assert.ok(!(wrong.headers['set-cookie'] || []).some(c => /stockkar_app_session/.test(c)), 'no session is handed out');
  // and a pass on its own never carries an app session either
  const read = await support('GET', '/order-log');
  assert.ok(!(read.headers['set-cookie'] || []).some(c => /stockkar_app_session/.test(c)), 'reading with a pass does not unlock the app');
  const bare = await call('GET', '/order-log');
  assert.equal(bare.status, 401, 'no pass, no data');
});

test('ATTACK: a tampered or truncated token is rejected', async () => {
  for (const bad of [TOKEN.slice(0, -1), TOKEN.toUpperCase() + 'a', TOKEN + '0', '', 'not-hex-at-all']) {
    const r = await call('GET', '/order-log', null, { 'x-stockkar-support': bad });
    assert.equal(r.status, 401, 'token ' + JSON.stringify(bad.slice(0, 8)) + ' must not work');
  }
});

// ---- it is temporary, and the owner is in control --------------------------------
test('the box records what support looked at, and the owner can see it', async () => {
  const st = await owner('GET', '/support/status');
  assert.ok(st.body.uses > 0);
  assert.ok(st.body.recent.some(u => /debug|order-log/.test(u.path)), JSON.stringify(st.body.recent));
});

test('support can ask what it is allowed to do, and is told read-only', async () => {
  const s = await support('GET', '/support/session');
  assert.equal(s.body.support, true);
  assert.equal(s.body.readOnly, true);
  assert.ok(s.body.expiresAt);
});

test('ENDING it is instant: the link stops working the moment the owner says so', async () => {
  const end = await owner('POST', '/support/revoke', { confirm: true });
  assert.equal(end.body.ended, true);
  const after = await support('GET', '/order-log');
  assert.equal(after.status, 401, 'the pass is dead');
  assert.equal((await owner('GET', '/support/status')).body.active, false);
});

test('EXPIRY is enforced by the box, not by the link: a past expiry is dead on arrival', async () => {
  const r = await owner('POST', '/support/grant', { hours: 1 });
  const live = r.body.token;
  assert.equal((await call('GET', '/order-log', null, { 'x-stockkar-support': live })).status, 200);
  // wind the clock forward the only way that matters: the stored window
  const f = path.join(dataDir, 'support_access.json');
  const g = JSON.parse(fs.readFileSync(f, 'utf8'));
  fs.writeFileSync(f, JSON.stringify({ ...g, expiresAt: Date.now() - 1000 }));
  assert.equal((await call('GET', '/order-log', null, { 'x-stockkar-support': live })).status, 401, 'expired means expired');
  assert.equal((await owner('GET', '/support/status')).body.active, false);
});
