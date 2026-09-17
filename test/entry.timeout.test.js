'use strict';
// test/entry.timeout.test.js — "Entry failed in Algo, but live on Dhan"
// (owner, 2026-09-17, ROSSTECH on a customer box).
//
// 7/9 12:46:45 the box POSTed a BUY to Dhan; the reply never came; after 30 s
// the app wrote "Dhan entry order failed: Dhan request timed out". Dhan had
// ACCEPTED the order - the shares filled - and one minute later the next scan
// placed it AGAIN (the in-flight guard is cleared by the failure callback).
// 16 shares sat at the broker for ten days with no stop and no row watching
// them. A timeout is a LOST REPLY, not a rejection: every entry carries a tag
// the broker hands back, so the order book can answer what the socket did not.
//
// Against the REAL placeBrokerSuperOrder and a fake Dhan that accepts an order
// and never answers (exactly the incident):
//   1. the order is found by its tag and the entry is reported as PLACED -
//      protect-after-fill takes it from there; ONE order at the broker
//   2. a second scan inside the hold window is refused, not re-placed
//   3. a timeout where the order never reached Dhan is reported as NOT placed
//      in plain words, and the symbol is held back for the same window
//   4. an already-damaged box: a "timed out" failure row for a symbol the
//      broker holds is the top problem in /debug/broker, with the way out
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createFakeDhan } = require('./fake-dhan');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-timeout-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({ clientId: 'FAKECLIENT', token: 'fake-token', savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'active_broker.json'), JSON.stringify({ broker: 'dhan', setAt: new Date().toISOString() }));
Object.assign(process.env, {
  STOCKKAR_LICENCE_ENFORCE: '0',
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1',
  STOCKKAR_BROKER_HTTP_TIMEOUT_MS: '1500',          // the socket gives up fast in the test (loose enough for a loaded runner)
  STOCKKAR_DHAN_ENTRY_RECOVER_GAP_MS: '150',       // and the order book is re-read quickly
  STOCKKAR_ENTRY_TIMEOUT_HOLD_MS: '4000',          // the hold window, shortened so test 3 can outlive it
});

const fake = createFakeDhan({ securities: { '9001': 'ROSSTECH', '9002': 'NPST', '11536': 'TCS' }, marketPrice: 1142.9 });
let S, app, appPort;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const order = (sym, secId) => ({ symbol: sym, action: 'BUY', exchange: 'NSE', segment: 'CNC', qty: 16, securityId: secId,
  entryPrice: 1142.9, slPrice: 1100, targetPrice: 1830, entryOrderType: 'market', exitOrderType: 'market', slMethod: 'pct' });
const place = (o) => new Promise(r => S.placeBrokerSuperOrder({ broker: 'dhan', credentials: {}, order: o }, (err, res) => r({ err, res })));
const buys = (sym) => fake.st.orders.filter(o => o.tradingSymbol === sym && String(o.transactionType).toUpperCase() === 'BUY');

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  app = http.createServer(S.handleRequest);
  await new Promise(res => app.listen(0, '127.0.0.1', () => { appPort = app.address().port; res(); }));
});
after(() => new Promise(res => app.close(() => fake.close(() => res()))));

test('INCIDENT: Dhan accepts the entry and never answers -> found by its tag, reported as PLACED, one order at the broker', async () => {
  fake.st.hangNext = { path: '/v2/orders', record: true, holdMs: 3000 };
  const t0 = Date.now();
  const { err, res } = await place(order('ROSSTECH', '9001'));
  assert.ifError(err);
  assert.equal(res.recoveredAfterTimeout, true, JSON.stringify(res).slice(0, 300));
  assert.ok(res.dhanEntryOrderId, 'the broker\'s own order id, read back from the book');
  assert.equal(String(res.dhanEntryOrderId), String(buys('ROSSTECH')[0].orderId));
  assert.equal(buys('ROSSTECH').length, 1, 'exactly ONE buy at the broker');
  assert.ok(res.awaitingFill, 'protect-after-fill owns it from here');
  assert.ok(Date.now() - t0 >= 1500, 'the socket really timed out first');
  assert.ok(res.orderTag && buys('ROSSTECH')[0].correlationId === res.orderTag, 'the tag is what identified it');
});

test('a second scan inside the hold window is REFUSED, not placed again', async () => {
  const { err } = await place(order('ROSSTECH', '9001'));
  assert.ok(err, 'refused');
  assert.match(String(err), /timed out|held back/i, err);
  assert.equal(buys('ROSSTECH').length, 1, 'still one buy at the broker');
});

test('a timeout where the order never reached Dhan: NOT placed, said plainly, and held back for the window', async () => {
  fake.st.hangNext = { path: '/v2/orders', record: false, holdMs: 3000 };
  const { err } = await place(order('NPST', '9002'));
  assert.ok(err, 'reported as a failure');
  assert.match(String(err), /timed out/i, err);
  assert.match(String(err), /NOT placed|not placed/, 'the words say the book was checked: ' + err);
  assert.equal(buys('NPST').length, 0);
  const again = await place(order('NPST', '9002'));
  assert.ok(again.err && /held back/i.test(String(again.err)), 'the next scan is held back: ' + again.err);
  await wait(4300);                                   // the hold expires
  const later = await place(order('NPST', '9002'));
  assert.ifError(later.err);
  assert.equal(buys('NPST').length, 1, 'after the window a fresh attempt goes through once');
});

test('an already-damaged box: a "timed out" failure row for a symbol the broker holds is the TOP problem in /debug/broker', async () => {
  fake.holdSymbol('TCS', 5);
  S.mutateOrderLog(all => [...all, {
    id: 'row-tcs-timeout', broker: 'dhan', symbol: 'TCS', action: 'BUY', qty: 5, price: 3100, entryPrice: 3100, slPrice: 3000, targetPrice: 3300,
    securityId: '11536', exchange: 'NSE', segment: 'CNC', source: 'auto', orderId: 'N/A',
    status: 'Dhan entry order failed: Dhan request timed out', rejectionReason: 'Dhan entry order failed: Dhan request timed out',
    time: new Date().toLocaleString(), recordedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(),
  }]);
  const setup = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: appPort, path: '/app-lock/setup', method: 'POST', headers: { 'content-type': 'application/json' } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve({ status: r.statusCode, cookie: String((r.headers['set-cookie'] || [''])[0]).split(';')[0] }));
    });
    req.on('error', reject); req.end(JSON.stringify({ pin: '654321', dob: '1990-01-01' }));
  });
  assert.equal(setup.status, 200);
  const body = await new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: appPort, path: '/debug/broker?broker=dhan', headers: { cookie: setup.cookie, host: '127.0.0.1:' + appPort } }, r => {
      let d = ''; r.on('data', c => d += c); r.on('end', () => resolve(JSON.parse(d)));
    }).on('error', reject);
  });
  assert.ok(body.ok, JSON.stringify(body).slice(0, 200));
  const top = body.problems[0];
  assert.ok(top, 'a problem is listed');
  assert.equal(top.kind, 'naked', JSON.stringify(body.problems));
  assert.match(top.text, /TCS/);
  assert.match(top.text, /timed out/i);
  assert.match(top.text, /Holdings/i, 'and it says where the way out is: ' + top.text);
});
