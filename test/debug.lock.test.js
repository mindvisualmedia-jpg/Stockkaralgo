'use strict';
// test/debug.lock.test.js — THE PROXY MADE EVERYONE LOOPBACK (2026-09-17).
//
// Proven from outside on a live box that reported {unlocked:false}: every
// /debug/* route answered 200 with raw broker payloads. scripts/install.sh puts
// nginx in front of Node on every box (proxy_pass http://127.0.0.1:PORT), so
// the socket address of an INTERNET request is 127.0.0.1 - and the "curl on
// the box itself" exemption opened the diagnostics, and the Angel One
// oco-probe that places a real rule, to anyone with the URL.
//
// Written as the attack, over the real wire (handleRequest), with the App Lock
// configured: what nginx forwards must be refused, what a shell on the box
// sends must still work, and the support pass must still pass THROUGH nginx.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createFakeDhan } = require('./fake-dhan');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-debuglock-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({
  clientId: 'FAKECLIENT', token: 'super-secret-dhan-token-value', savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
Object.assign(process.env, {
  STOCKKAR_LICENCE_ENFORCE: '0', STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http', STOCKKAR_TELEGRAM_DISABLED: '1',
});

const fake = createFakeDhan({ securities: { 3: 'IFCI' }, marketPrice: 100 });
let S, app, appPort, ownerCookie = '';

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
// exactly what nginx on the box hands Node for a request from the internet
// (scripts/install.sh: proxy_pass 127.0.0.1, X-Forwarded-For, X-Forwarded-Proto)
const VIA_NGINX = { host: 'sonu-algo.16.16.249.119.nip.io', 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' };
const internet = (p, extra) => call('GET', p, null, { ...VIA_NGINX, ...(extra || {}) });
// a shell on the box: curl http://127.0.0.1:PORT/... - nothing forwarded
const boxShell = (p) => call('GET', p, null, { host: '127.0.0.1:' + appPort });

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  app = http.createServer(S.handleRequest);
  await new Promise(res => app.listen(0, '127.0.0.1', () => { appPort = app.address().port; res(); }));
  const setup = await call('POST', '/app-lock/setup', { pin: '654321', dob: '1990-01-01' });
  assert.equal(setup.status, 200, setup.raw);
  ownerCookie = String(setup.headers['set-cookie'][0]).split(';')[0];
});
after(() => new Promise(res => app.close(() => fake.close(() => res()))));

test('INCIDENT: a locked box refuses /debug/* to the internet, even though nginx makes the socket loopback', async () => {
  for (const p of ['/debug/broker', '/debug/zerodha', '/debug/audit', '/debug/protection', '/debug/sync', '/debug/ledger']) {
    const r = await internet(p);
    assert.equal(r.status, 401, p + ' answered ' + r.status + ': ' + r.raw.slice(0, 160));
    assert.equal(r.body && r.body.locked, true, p);
    assert.ok(!/FAKECLIENT|super-secret/.test(r.raw), p + ' leaked broker data');
  }
});

test('and the Angel One probe that PLACES a rule is refused the same way', async () => {
  const r = await internet('/debug/angelone/oco-probe');
  assert.equal(r.status, 401, r.raw.slice(0, 160));
});

test('any single proxy mark is enough: X-Forwarded-For alone, X-Forwarded-Proto alone, X-Real-IP alone, a public Host alone', async () => {
  const cases = [
    { host: '127.0.0.1:' + 1, 'x-forwarded-for': '203.0.113.9' },
    { host: '127.0.0.1:' + 1, 'x-forwarded-proto': 'https' },
    { host: '127.0.0.1:' + 1, 'x-real-ip': '203.0.113.9' },
    { host: 'sonu-algo.16.16.249.119.nip.io' },
  ];
  for (const h of cases) {
    const r = await call('GET', '/debug/broker', null, h);
    assert.equal(r.status, 401, JSON.stringify(h) + ' answered ' + r.status);
  }
});

test('a shell on the box itself still reads the diagnostics (nothing forwarded, loopback Host)', async () => {
  const r = await boxShell('/debug/broker');
  assert.equal(r.status, 200, r.raw.slice(0, 160));
  assert.equal(r.body && r.body.ok, true);
});

test('the support pass still works THROUGH nginx - that is the door support is meant to use', async () => {
  const g = await call('POST', '/support/grant', { hours: 1 }, { cookie: ownerCookie });
  assert.equal(g.status, 200, g.raw);
  const r = await internet('/debug/broker', { 'x-stockkar-support': g.body.token });
  assert.equal(r.status, 200, r.raw.slice(0, 160));
  assert.equal(r.body && r.body.ok, true);
  assert.ok(!/super-secret/.test(r.raw), 'and it still never yields the broker token');
});

test('the unlocked owner reads them through nginx too', async () => {
  const r = await internet('/debug/broker', { cookie: ownerCookie });
  assert.equal(r.status, 200, r.raw.slice(0, 160));
});
