'use strict';
// test/adopt.stopvsmarket.test.js — CMRGREEN, 2026-09-15.
//
// The customer opened Protect this holding on a Dhan holding of 41 CMRGREEN
// bought at 257.76, chose a 3% stop and no target, and got:
//
//   "Protection could not be armed: Dhan SL re-place failed:
//    Incorrect request for order and cannot be processed"
//
// 3% below the BUY price is 250.05. The stock was trading BELOW that, so the
// SELL trigger sat at/above the market - an order that would fire the instant
// it is placed, which every broker refuses and Dhan refuses with a sentence
// that names no field. The engine has enforced "never a stop at/above the
// market" for cost moves since August; the adopt path never did, and the
// dialog was never even given the live price.
//
// Pinned here: the guard, its words, the target twin, that a sane stop still
// adopts, and that a failed arm now leaves an artefact support can read.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createFakeDhan } = require('./fake-dhan');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-adopt-mkt-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({ clientId: 'FAKECLIENT', token: 'fake-token', savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'active_broker.json'), JSON.stringify({ broker: 'dhan', setAt: new Date().toISOString() }));
Object.assign(process.env, {
  STOCKKAR_LICENCE_ENFORCE: '0', STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1',
});

// CMRGREEN bought at 257.76, trading at 243.10 - already 5.7% under water,
// so a "3% below my buy price" stop (250.05) sits ABOVE the market.
const fake = createFakeDhan({ securities: { 4707: 'CMRGREEN' }, marketPrice: 243.10 });
let S, app, appPort;

function call(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({ hostname: '127.0.0.1', port: appPort, path: pathname, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-stockkar-internal': S.INTERNAL_SECRET } }, (res) => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, raw: d, body: (() => { try { return JSON.parse(d); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const adopt = (over) => call('POST', '/holdings/adopt', {
  broker: 'dhan', symbol: 'CMRGREEN', qty: 41, entryPrice: 257.76,
  slPrice: 250.05, targetPrice: 0, costPct: 5, trailMode: 'none', ...over,
});

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  // the broker holds them, and reports the live price with the holding
  fake.st.holdings.push({ tradingSymbol: 'CMRGREEN', totalQty: 41, availableQty: 41, exchange: 'NSE', lastTradedPrice: 243.10, avgCostPrice: 257.76 });
  S = require('../server.js')._internals;
  app = http.createServer(S.handleRequest);
  await new Promise(res => app.listen(0, '127.0.0.1', () => { appPort = app.address().port; res(); }));
});
after(() => new Promise(res => app.close(() => fake.close(() => res()))));

test('INCIDENT: a 3%-below-BUY stop that sits above the market is refused BEFORE the broker is called', async () => {
  const r = await adopt();
  assert.equal(r.status, 400, r.raw);
  assert.equal(r.body.ok, false);
  // the two numbers that explain it, and the instruction
  assert.match(r.body.error, /CMRGREEN trades at ₹243\.10 now/);
  assert.match(r.body.error, /stop is ₹250\.05/);
  assert.match(r.body.error, /fire the moment it is placed/);
  assert.match(r.body.error, /worked out from your buy price of ₹257\.76/);
  assert.match(r.body.error, /Set a stop below ₹243\.10/);
  assert.equal(r.body.ltp, 243.10);
  // nothing was sent to the broker, and nothing was left behind
  assert.equal(fake.liveForevers().length, 0, 'no order attempted');
  assert.equal(S.readOrderLog().length, 0, 'no half-adopted row');
});

test('a stop exactly AT the market is refused too - it fires on arrival', async () => {
  const r = await adopt({ slPrice: 243.10 });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at or above the current price/);
});

test('the TARGET twin: on a holding that has RUN UP, a target below the market would sell instantly', async () => {
  // the existing "target must be above the buy price" check catches the easy
  // case; this is the one it cannot see - target above BUY, below MARKET.
  fake.st.holdings.push({ tradingSymbol: 'GESHIP', totalQty: 5, availableQty: 5, exchange: 'NSE', lastTradedPrice: 120, avgCostPrice: 100 });
  const r = await call('POST', '/holdings/adopt', { broker: 'dhan', symbol: 'GESHIP', qty: 5, entryPrice: 100, slPrice: 95, targetPrice: 110, trailMode: 'none' });
  assert.equal(r.status, 400, r.raw);
  assert.match(r.body.error, /target is ₹110\.00/);
  assert.match(r.body.error, /sell immediately/);
  assert.match(r.body.error, /Set a target above ₹120\.00/);
});

test('a stop BELOW the market adopts normally - the guard blocks nothing legitimate', async () => {
  const r = await adopt({ slPrice: 238.50, targetPrice: 0 });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.ok, true);
  const rows = S.readOrderLog();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'NSE:CMRGREEN');
  assert.equal(rows[0].qty, 41);
  assert.equal(fake.liveForevers().length, 1, 'the protective order really went to the broker');
});

test('a broker refusal leaves an artefact support can read, not just a toast', async () => {
  // the row above is managed now, so adopt a second holding whose arm fails
  fake.st.holdings.push({ tradingSymbol: 'IDEA', totalQty: 10, availableQty: 10, exchange: 'NSE', lastTradedPrice: 9.5, avgCostPrice: 12 });
  fake.st.failNext = { method: 'POST', path: '/v2/forever/orders', message: 'Incorrect request for order and cannot be processed' };
  const r = await call('POST', '/holdings/adopt', { broker: 'dhan', symbol: 'IDEA', qty: 10, entryPrice: 12, slPrice: 9, targetPrice: 0, trailMode: 'none' });
  assert.equal(r.status, 502, r.raw);
  // the broker's own words, its CODE, and the hint that names the likely cause
  assert.match(r.body.error, /Incorrect request for order/);
  assert.match(r.body.error, /DH-905/, 'the error code is kept, not dropped: ' + r.body.error);
  assert.match(r.body.error, /at or ABOVE the current price/, 'the hint fires');
  // and the attempt is on disk for /debug/broker to show
  const fails = JSON.parse(fs.readFileSync(path.join(dataDir, 'protect_failures.json'), 'utf8'));
  const last = fails[fails.length - 1];
  assert.equal(last.symbol, 'IDEA');
  assert.equal(last.slPrice, 9);
  assert.equal(last.ltp, 9.5);
  assert.equal(last.where, 'holdings-adopt');
  assert.ok(!JSON.stringify(fails).includes('fake-token'), 'never the credential');
  // no half-adopted row survived
  assert.ok(!S.readOrderLog().some(e => /IDEA/.test(String(e.symbol))));
});

test('LOCKED: the average cost AT THE BROKER wins over anything the caller typed', async () => {
  // BFINVEST-shaped: the dialog locks these fields, and the route enforces it
  // so no caller can adopt a cost the broker disagrees with.
  fake.st.holdings.push({ tradingSymbol: 'BFINVEST', totalQty: 1, availableQty: 1, exchange: 'NSE', lastTradedPrice: 470, avgCostPrice: 463.20 });
  const r = await call('POST', '/holdings/adopt', { broker: 'dhan', symbol: 'BFINVEST', qty: 1, entryPrice: 999, slPrice: 450, targetPrice: 0, trailMode: 'none' });
  assert.equal(r.status, 200, r.raw);
  const row = S.readOrderLog().find(e => /BFINVEST/.test(String(e.symbol)));
  assert.equal(row.entryPrice, 463.20, 'the typed 999 was discarded for the broker figure');
  assert.equal(row.price, 463.20);
  assert.equal(row.qty, 1);
});

test('LOCKED: a stop that only looked valid against the TYPED price is refused against the real one', async () => {
  fake.st.holdings.push({ tradingSymbol: 'PNB', totalQty: 87, availableQty: 87, exchange: 'NSE', lastTradedPrice: 100, avgCostPrice: 95 });
  // 96 is below the typed 999, but ABOVE the broker's 95 average cost
  const r = await call('POST', '/holdings/adopt', { broker: 'dhan', symbol: 'PNB', qty: 87, entryPrice: 999, slPrice: 96, targetPrice: 0, trailMode: 'none' });
  assert.equal(r.status, 400, r.raw);
  assert.match(r.body.error, /average cost for PNB is ₹95\.00/);
  assert.equal(r.body.entryPrice, 95);
});

test('a broker that reports NO average cost leaves the typed price standing', async () => {
  // holdSymbol seeds a holding with no avgCostPrice - there is no truth to lock to
  fake.holdSymbol('OMNI', 3);
  const r = await call('POST', '/holdings/adopt', { broker: 'dhan', symbol: 'OMNI', qty: 3, entryPrice: 50, slPrice: 45, targetPrice: 0, trailMode: 'none' });
  assert.equal(r.status, 200, r.raw);
  const row = S.readOrderLog().find(e => /OMNI/.test(String(e.symbol)));
  assert.equal(row.entryPrice, 50);
});

test('/debug/broker names the failed arm, so support sees it without asking', async () => {
  const r = await call('GET', '/debug/broker?broker=dhan');
  assert.equal(r.status, 200, r.raw);
  const dhan = r.body.brokers.find(b => b.broker === 'dhan');
  assert.ok(dhan.protectFailures && dhan.protectFailures.length, JSON.stringify(dhan.protectFailures));
  assert.ok(r.body.problems.some(p => /Protection could not be armed for IDEA/.test(p.text)),
    JSON.stringify(r.body.problems));
});
