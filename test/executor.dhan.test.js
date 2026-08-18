'use strict';
// test/executor.dhan.test.js — the REAL server.js executor against a FAKE Dhan.
//
// This is the wiring the unit suite could never see: engine decision ->
// engineExecuteAction -> the actual restore / modify / cancel / sell functions
// -> the exact HTTP payload -> the row patch. The fake (test/fake-dhan.js)
// answers like api.dhan.co; server.js is pointed at it ONLY through env vars
// set in this process before it is required. No real broker is ever touched.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeDhan } = require('./fake-dhan');

// ---- isolated world: temp data dir, fake token, engine on --------------------
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-exec-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({ clientId: 'FAKECLIENT', token: 'fake-token', savedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
process.env.STOCKKAR_DATA_DIR = dataDir;
process.env.STOCKKAR_TEST_INTERNALS = '1';
process.env.STOCKKAR_ENGINE = '1';
process.env.STOCKKAR_ENGINE_SHADOW = '0';
process.env.STOCKKAR_ENGINE_LEGACY_OFF = '1';
process.env.STOCKKAR_DHAN_API_HOST = '127.0.0.1';
process.env.STOCKKAR_DHAN_API_PROTO = 'http';
process.env.STOCKKAR_TELEGRAM_DISABLED = '1';

const fake = createFakeDhan({ securities: { '1594': 'INFY', '11536': 'TCS' }, marketPrice: 101 });
let S;   // server internals
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const rows = () => S.readOrderLog();
const rowOf = (sym) => rows().find(r => r.symbol === sym && !r.exitType);

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  assert.ok(S, 'internals exported');
  assert.equal(S.DHAN_API.hostname, '127.0.0.1');
  S.seedDhanSecurityMap({ 'NSE:INFY': '1594', INFY: '1594', 'NSE:TCS': '11536', TCS: '11536' });
});
after(() => new Promise(res => fake.close(() => res())));

// One engine pass = getSnapshot (fake) -> transitions -> executor. It is async
// and fire-and-forget inside server.js, so we run it and wait a beat.
async function enginePass() { S.runEngineCutover(); await wait(700); }

// ---- 1. protection rejected at entry -> UNPROTECTED -> REARM places a Forever OCO ----
test('REARM: a row whose stop was rejected at entry gets a Forever OCO placed with the RIGHT payload, then reads PROTECTED', async () => {
  fake.holdSymbol('INFY', 10);
  S.writeOrderLog([{
    id: 'r1', broker: 'dhan', symbol: 'INFY', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 95, targetPrice: 110,
    securityId: '1594', exchange: 'NSE', segment: 'CNC', orderId: 'ENTRY:E1', dhanEntryOrderId: 'E1', dhanProtection: 'forever', dhanForeverId: '',
    status: 'ENTRY PLACED BUT PROTECTION FAILED: Forever rejected', protectionFailedAt: new Date().toISOString(),
    time: new Date().toLocaleString(), recordedAt: new Date().toISOString(),
  }]);
  await enginePass();
  const placed = fake.sent('POST', '/v2/forever/orders');
  assert.equal(placed.length, 1, 'exactly one Forever placed');
  const p = placed[0].body;
  assert.equal(p.orderFlag, 'OCO');
  assert.equal(p.transactionType, 'SELL');
  assert.equal(p.securityId, '1594');
  assert.equal(p.quantity, 10);
  assert.equal(p.triggerPrice, 95);
  assert.equal(p.triggerPrice1, 110);
  assert.equal(p.orderType, 'MARKET');
  assert.equal(p.productType, 'CNC');
  assert.equal(p.exchangeSegment, 'NSE_EQ');
  const r = rowOf('INFY');
  assert.ok(r.dhanForeverId, 'row now names the new Forever id');
  assert.equal(String(r.dhanForeverId), fake.liveForevers()[0].orderId);
  // next pass reads it live -> PROTECTED
  await enginePass();
  assert.equal(rowOf('INFY').engineState, 'PROTECTED');
  assert.equal(rowOf('INFY').protectionUnverified, false);
});

// ---- 2. cost trigger reached -> MODIFY_SL sends legName STOP_LOSS_LEG on the OCO, then verified ----
test('MOVE_SL_TO_COST: modifies ONLY the stop leg of the OCO (orderFlag OCO, legName STOP_LOSS_LEG), believed on the next read', async () => {
  const r0 = rowOf('INFY');
  S.updateOrderLogRow(r0.id, r => ({ ...r, costPct: 1, liveLtp: 101.5 }));   // cost trigger +1%, price now 101.5
  await enginePass();
  const mods = fake.sent('PUT', '/v2/forever/orders/');
  assert.equal(mods.length, 1, 'one modify sent');
  assert.equal(mods[0].body.orderFlag, 'OCO');
  assert.equal(mods[0].body.legName, 'STOP_LOSS_LEG');
  assert.equal(mods[0].body.triggerPrice, 100);
  assert.equal(mods[0].body.quantity, 10);
  const f = fake.liveForevers()[0];
  assert.equal(f.legs.find(l => l.legName === 'STOP_LOSS_LEG').triggerPrice, 100);
  assert.equal(f.legs.find(l => l.legName === 'TARGET_LEG').triggerPrice, 110, 'target leg untouched');
  assert.ok(rowOf('INFY').enginePendingSl, 'pending until verified');
  await enginePass();
  const r = rowOf('INFY');
  assert.equal(r.slPrice, 100);
  assert.equal(r.mtmCostDone, true);
  assert.equal(r.slPriceOriginal, 95, 'original stop preserved for R:R maths');
  assert.ok(!r.enginePendingSl);
});

// ---- 3. stop vanishes at the broker while held -> UNPROTECTED (grace) -> REARM again; a second REARM cools down ----
test('READ-SANITY GATE: when the ONLY known id vanishes, the engine does NOT re-arm (a vanished stop and a broken read look the same)', async () => {
  const keep = fake.st.forevers.slice();
  fake.st.forevers = [];
  const r0 = rowOf('INFY');
  S.updateOrderLogRow(r0.id, r => ({ ...r, engineGraceAt: Date.now() - 20 * 60 * 1000, engineRearmAt: 0 }));
  await enginePass(); await enginePass();
  assert.equal(fake.sent('POST', '/v2/forever/orders').length, 1, 'no re-arm on a read that shows none of our ids');
  assert.notEqual(rowOf('INFY').engineState, 'UNPROTECTED', 'not even flagged on a suspect read');
  fake.st.forevers = keep;   // restore the broker state for the next test
  await enginePass();
});

test('vanished stop: engine re-arms once, honours the 10-min cooldown on the second ask', async () => {
  // a second, healthy row on TCS anchors the read (its id IS in the snapshot -> the read is trusted)
  fake.holdSymbol('TCS', 5);
  const tcsId = fake.seedForever('TCS', 3000, 3300, 5);
  S.writeOrderLog(rows().concat([{ id: 'r2', broker: 'dhan', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300,
    securityId: '11536', exchange: 'NSE', segment: 'CNC', orderId: 'ENTRY:E2 | FOREVER:' + tcsId, dhanEntryOrderId: 'E2', dhanProtection: 'forever', dhanForeverId: tcsId,
    status: 'DHAN ENTRY + FOREVER OCO', time: new Date().toLocaleString(), recordedAt: new Date().toISOString() }]));
  await enginePass();
  assert.equal(rowOf('TCS').engineState, 'PROTECTED');
  fake.st.forevers = fake.st.forevers.filter(f => f.orderId === tcsId);   // Dhan lost INFY's Forever (corporate action / manual cancel)
  const r0 = rowOf('INFY');
  S.updateOrderLogRow(r0.id, r => ({ ...r, engineGraceAt: Date.now() - 20 * 60 * 1000, engineRearmAt: 0 }));   // grace already expired
  await enginePass();   // -> UNPROTECTED (+ REARM in the same pass? no: UNPROTECTED is a state change; REARM asked next pass)
  await enginePass();
  const placed = fake.sent('POST', '/v2/forever/orders');
  assert.equal(placed.length, 2, 'a second Forever placed by the re-arm');
  assert.equal(placed[1].body.triggerPrice, 100, 're-armed at the MOVED stop (cost), never back at the original');
  assert.equal(placed[1].body.triggerPrice1, 110);
  fake.st.forevers = fake.st.forevers.filter(f => f.orderId === tcsId);   // vanishes again immediately
  const r1 = rowOf('INFY');
  S.updateOrderLogRow(r1.id, r => ({ ...r, engineGraceAt: Date.now() - 20 * 60 * 1000 }));
  await enginePass(); await enginePass();
  assert.equal(fake.sent('POST', '/v2/forever/orders').length, 2, 'cooldown: no third placement inside 10 minutes');
});

// ---- 4. the position sells at the broker -> CLOSED from the fill, no re-place of the orphan stop ----
test('manual sell at broker: row closes from the FILL (real price), the stop is not re-placed', async () => {
  fake.st.forevers = fake.st.forevers.filter(f => f.legs[0].tradingSymbol === 'TCS');   // INFY's stop is gone; TCS anchors the read
  fake.st.holdings = fake.st.holdings.filter(h => h.tradingSymbol === 'TCS');
  fake.st.trades = [{ orderId: 'M1', tradingSymbol: 'INFY', transactionType: 'SELL', tradedQuantity: 10, tradedPrice: 103.4 }];
  fake.st.orders = [{ orderId: 'M1', orderStatus: 'TRADED', transactionType: 'SELL', tradingSymbol: 'INFY', quantity: 10, filledQty: 10, averageTradedPrice: 103.4, orderType: 'MARKET' }];
  const before = fake.sent('POST', '/v2/forever/orders').length;
  await enginePass();
  const r = rows().find(x => x.symbol === 'INFY');
  assert.equal(r.engineState, 'CLOSED');
  assert.equal(r.exitType, 'EXITED');
  assert.equal(r.exitPrice, 103.4);
  assert.equal(r.realisedPnl, 34);
  assert.equal(r.exitEstimated, false);
  assert.equal(fake.sent('POST', '/v2/forever/orders').length, before, 'no protection placed on a closed position');
});
