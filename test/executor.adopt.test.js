'use strict';
// test/executor.adopt.test.js — the ADOPT-A-HOLDING flow, end to end: the REAL
// /holdings/adopt endpoint over a real http wire (handleRequest), the REAL
// restoreBrokerStop against fake Dhan, then the engine managing the adopted
// position — step trail included ("test whether this holdings feature works as
// intended", 2026-08-26).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createFakeDhan } = require('./fake-dhan');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-adopt-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({ clientId: 'FAKECLIENT', token: 'fake-token', savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'active_broker.json'), JSON.stringify({ broker: 'dhan', setAt: new Date().toISOString() }));
Object.assign(process.env, {
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1',
});

const fake = createFakeDhan({ securities: { '1594': 'INFY', '11536': 'TCS' }, marketPrice: 100 });
let S, app, appPort;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const rows = () => S.readOrderLog();
const rowOf = (sym) => rows().find(r => String(r.symbol).includes(sym));
async function enginePass() { S.runEngineCutover(); await wait(700); }

// POST to the REAL endpoint over the wire — the same path the dialog uses.
function adopt(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: appPort, path: '/holdings/adopt', method: 'POST',
      // the internal-loopback header passes the App-Lock exactly as the
      // server's own internal calls do (loopback + shared secret)
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-stockkar-internal': S.INTERNAL_SECRET } }, (res) => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(payload); req.end();
  });
}

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  S.seedDhanSecurityMap({ 'NSE:INFY': '1594', INFY: '1594', 'NSE:TCS': '11536', TCS: '11536' });
  app = http.createServer(S.handleRequest);
  await new Promise(res => app.listen(0, '127.0.0.1', () => { appPort = app.address().port; res(); }));
});
after(() => new Promise(res => app.close(() => fake.close(() => res()))));

test('adopt validation: SL at/above buy price is refused; unknown broker is refused', async () => {
  const bad = await adopt({ broker: 'dhan', symbol: 'INFY', qty: 10, entryPrice: 100, slPrice: 100 });
  assert.equal(bad.body.ok, false);
  const noBroker = await adopt({ broker: 'groww', symbol: 'INFY', qty: 10, entryPrice: 100, slPrice: 95 });
  assert.equal(noBroker.body.ok, false);
  assert.equal(rows().length, 0, 'refused adoptions never leave a row behind');
});

test('adopt a holding with step trail 2%:1% -> REAL SL placed at the broker, row carries the config', async () => {
  fake.holdSymbol('INFY', 10);
  const r = await adopt({ broker: 'dhan', symbol: 'INFY', qty: 10, entryPrice: 100, slPrice: 95,
    trailMode: 'step', emaTrailingPct: 2, stepMovePct: 1 });
  assert.equal(r.body.ok, true, JSON.stringify(r.body));

  const placed = fake.sent('POST', '/v2/forever/orders');
  assert.equal(placed.length, 1, 'ONE protective order at the broker');
  assert.equal(placed[0].body.quantity, 10);
  assert.equal(placed[0].body.triggerPrice, 95, 'stop exactly where the dialog said');
  assert.equal(placed[0].body.orderFlag, 'SINGLE', 'no target -> SL-only Forever, not an OCO');

  const row = rowOf('INFY');
  assert.equal(row.adopted, true);
  assert.equal(row.slPriceOriginal, 95, 'step trail measures from the ORIGINAL stop forever');
  assert.equal(row.trailMode, 'step');
  assert.equal(Number(row.emaTrailingPct), 2);
  assert.equal(Number(row.stepMovePct), 1, 'the asymmetric move survives the wire');
  assert.match(String(row.status), /adopted holding/i);
});

test('the engine manages the adopted holding: +4.2% = 2 steps of 1% -> stop modified to 97', async () => {
  await enginePass();                                    // reads settle; engine sees PROTECTED
  S.updateOrderLogRow(rowOf('INFY').id, r => ({ ...r, liveLtp: 104.2 }));
  await enginePass();
  const mods = fake.sent('PUT', '/v2/forever/orders/');
  assert.equal(mods.length, 1, 'one step-trail modify');
  assert.equal(mods[0].body.triggerPrice, 97, '95 + 2 steps x 1% of entry (asymmetric: trigger 2%, move 1%)');
  await enginePass();                                    // verify-after-modify confirms
  assert.equal(rowOf('INFY').slPriceOriginal, 95, 'the original stop is never rewritten by a trail');

  // pullback: the mark stays, the stop never moves down
  S.updateOrderLogRow(rowOf('INFY').id, r => ({ ...r, liveLtp: 101 }));
  await enginePass();
  assert.equal(fake.sent('PUT', '/v2/forever/orders/').length, 1, 'no modify on a pullback');
});

test('WHEN TO START TRAILING: peak trail + no target arms at +6%, quiet below it (2026-08-26)', async () => {
  fake.holdSymbol('TCS', 5);
  const r = await adopt({ broker: 'dhan', symbol: 'TCS', qty: 5, entryPrice: 100, slPrice: 94,
    trailMode: 'peak', emaTrailingPct: 2, trailStartMode: 'pct', trailStartVal: 6 });
  assert.equal(r.body.ok, true, 'a start level replaces the target requirement: ' + JSON.stringify(r.body));
  const row = rowOf('TCS');
  assert.equal(row.trailStartPct, 6);
  assert.equal(Number(row.targetPrice) || 0, 0, 'genuinely target-less');

  const before = fake.sent('PUT', '/v2/forever/orders/').length;
  await enginePass();
  S.updateOrderLogRow(rowOf('TCS').id, x => ({ ...x, liveLtp: 104 }));
  await enginePass();
  assert.equal(fake.sent('PUT', '/v2/forever/orders/').length, before, '+4% is below the +6% start: fully quiet');

  S.updateOrderLogRow(rowOf('TCS').id, x => ({ ...x, liveLtp: 110 }));
  await enginePass();
  const mods = fake.sent('PUT', '/v2/forever/orders/').slice(before);
  assert.equal(mods.length, 1, 'armed at the start level and trailed');
  assert.equal(mods[0].body.triggerPrice, 107.8, '110 peak - 2% give-back');
});
