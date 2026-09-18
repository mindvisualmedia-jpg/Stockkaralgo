'use strict';
// test/adopt.split.test.js — "This stock recovered but T1 T2 not showing"
// (owner, 2026-09-18, ROSSTECH on a customer box).
//
// 3.28.4 adopted filled-but-"failed" entries with ONE target; the signal had
// T1 +30% on half and T2 +60% on the rest. An automatic adoption knows its
// signal, so the position must get the bracket that signal would have had.
// Against the real engine pass and the fake Dhan:
//   1. adoption carries T1/T2: two Forever OCOs, sized and priced from the
//      BROKER's average cost, the row shows T1/T2 and reads "T1/T2 split"
//   2. a T1 already at/below the market: one final target, and the row says why
//   3. a row ALREADY adopted with one target is converted once - planned from
//      the ORIGINAL stop, placed at the CURRENT (lifted) one, place-first-then-
//      cancel, the old bracket gone, the stop never lowered
//   4. the conversion never repeats
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeDhan } = require('./fake-dhan');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-adoptsplit-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({ clientId: 'FAKECLIENT', token: 'fake-token', savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'active_broker.json'), JSON.stringify({ broker: 'dhan', setAt: new Date().toISOString() }));
Object.assign(process.env, {
  STOCKKAR_LICENCE_ENFORCE: '0',
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1',
});

const fake = createFakeDhan({ securities: { '3787': 'WIPRO', '1594': 'INFY', '2885': 'RELIANCE' }, marketPrice: 100 });
let S;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
// poll instead of sleeping a fixed time: the single-bracket arm does a security-map lookup first
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { if (fn()) return true; await wait(200); } return false; };
const hold = (sym, secId, qty, ltp, avg) => fake.st.holdings.push({ tradingSymbol: sym, securityId: secId, totalQty: qty, availableQty: qty, exchange: 'NSE', lastTradedPrice: ltp, avgCostPrice: avg });
const failedRow = (id, sym, secId, qty, over) => ({ id, broker: 'dhan', symbol: sym, action: 'BUY', qty, price: 100, entryPrice: 100, slPrice: 95, targetPrice: 160,
  securityId: secId, exchange: 'NSE', segment: 'CNC', source: 'auto', orderId: 'N/A', screenerName: 'momtam', jobId: 'job-x',
  status: 'Dhan entry order failed: Dhan request timed out', rejectionReason: 'Dhan entry order failed: Dhan request timed out',
  t1Pct: 30, t1Qty: 50, t2Pct: 60, targetMode: 'pct', slToT1Pct: 2, costPct: 3,
  time: new Date().toLocaleString(), recordedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString(), ...(over || {}) });
const legsOf = (sym) => fake.liveForevers().filter(f => f.legs.some(l => l.tradingSymbol === sym && !/CANCEL/i.test(String(l.orderStatus || ''))));
const legVal = (f, name, k) => Number((f.legs.find(l => l.legName === name) || {})[k] || 0);
const adoptedRow = (sym) => S.readOrderLog().find(r => r.adopted && new RegExp(sym).test(String(r.symbol)));

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
});
after(() => new Promise(res => fake.close(() => res())));

test('adoption carries the signal\'s T1/T2: two Forever OCOs from the broker\'s cost, and the row shows them', async () => {
  hold('WIPRO', '3787', 10, 105, 100);
  S.mutateOrderLog(all => [...all, failedRow('f-wipro', 'WIPRO', '3787', 10)]);
  S.runEngineCutover(); await until(() => { const r = adoptedRow('WIPRO'); return r && /FOREVER/.test(String(r.status)); });
  const row = adoptedRow('WIPRO');
  assert.ok(row, 'adopted: ' + JSON.stringify(S.readOrderLog().map(r => [r.id, r.status])));
  assert.equal(row.splitT1, true, JSON.stringify(row).slice(0, 400));
  assert.equal(row.t1Pct, 30); assert.equal(row.t1Qty, 50); assert.equal(row.t2Pct, 60); assert.equal(row.slToT1Pct, 2);
  assert.equal(row.splitLegAQty, 5); assert.equal(row.splitLegBQty, 5);
  assert.ok(row.dhanForeverT1Id && row.dhanForeverId && row.dhanForeverT1Id !== row.dhanForeverId, 'both leg ids on the row');
  assert.match(String(row.orderId), /^FOREVER-T1:\S+ \| FOREVER:\S+$/);
  assert.match(String(row.status), /2x FOREVER OCO \(T1\/T2 split\)/);
  assert.equal(row.targetPrice, 160, 'T2 = +60% of the broker\'s 100');
  const legs = legsOf('WIPRO');
  assert.equal(legs.length, 2, 'two brackets at the broker');
  const t1 = legs.find(f => legVal(f, 'TARGET_LEG', 'triggerPrice') === 130), t2 = legs.find(f => legVal(f, 'TARGET_LEG', 'triggerPrice') === 160);
  assert.ok(t1 && t2, 'T1 at 130 and T2 at 160: ' + JSON.stringify(legs.map(f => f.legs.map(l => [l.legName, l.triggerPrice, l.quantity]))));
  assert.equal(legVal(t1, 'STOP_LOSS_LEG', 'quantity'), 5); assert.equal(legVal(t2, 'STOP_LOSS_LEG', 'quantity'), 5);
  assert.equal(legVal(t1, 'STOP_LOSS_LEG', 'triggerPrice'), 95); assert.equal(legVal(t2, 'STOP_LOSS_LEG', 'triggerPrice'), 95);
});

test('a T1 already at or below the market: ONE final target, and the row says why', async () => {
  hold('RELIANCE', '2885', 10, 105, 100);
  S.mutateOrderLog(all => [...all, failedRow('f-rel', 'RELIANCE', '2885', 10, { t1Pct: 3 })]);   // T1 = 103 < 105
  S.runEngineCutover(); await until(() => { const r = adoptedRow('RELIANCE'); return r && /FOREVER/.test(String(r.status)); });
  const row = adoptedRow('RELIANCE');
  assert.ok(row, 'adopted');
  assert.ok(!row.splitT1, 'no split');
  assert.equal(row.t1Pct, 0, 'the row does not pretend to a T1 it cannot place');
  assert.match(String(row.reconcileNote || ''), /already at or below the market/);
  assert.equal(legsOf('RELIANCE').length, 1, 'one bracket');
  assert.equal(legVal(legsOf('RELIANCE')[0], 'STOP_LOSS_LEG', 'quantity'), 10);
});

test('a row ALREADY adopted with one target is converted: place first, cancel after, the LIFTED stop kept', async () => {
  hold('INFY', '1594', 10, 125, 100);
  const oldId = fake.seedForever('INFY', 120, 160, 10);            // the single bracket 3.28.4 placed, its stop since lifted to 120
  S.mutateOrderLog(all => [...all,
    failedRow('f-infy', 'INFY', '1594', 10, { mergedInto: 'adopt-infy', status: 'DHAN entry timed out but FILLED at the broker - adopted as one position (adopt-infy)' }),
    { id: 'adopt-infy', broker: 'dhan', symbol: 'NSE:INFY', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 120, slPriceOriginal: 95, brokerSlPrice: 120,
      targetPrice: 160, securityId: '1594', exchange: 'NSE', segment: 'CNC', source: 'auto', adopted: true, autoAdopted: true, adoptedFromRows: ['f-infy'],
      orderId: 'FOREVER:' + oldId, dhanForeverId: oldId, dhanProtection: 'forever', status: 'DHAN ENTRY + FOREVER OCO (adopted holding)',
      t1Pct: 0, t1Qty: 0, t2Pct: 0, mtmRemainingQty: 10, liveLtp: 125, time: new Date().toLocaleString(), recordedAt: new Date().toISOString() }]);
  S.runEngineCutover(); await until(() => (S.readOrderLog().find(r => r.id === 'adopt-infy') || {}).adoptSplitChecked);
  const row = S.readOrderLog().find(r => r.id === 'adopt-infy');
  assert.equal(row.splitT1, true, 'converted: ' + JSON.stringify({ st: row.status, note: row.reconcileNote, chk: row.adoptSplitChecked }));
  assert.equal(row.t1Pct, 30); assert.equal(row.t1Qty, 50); assert.equal(row.t2Pct, 60);
  assert.equal(row.slPrice, 120, 'the lifted stop is untouched on the row');
  assert.ok(row.adoptSplitChecked);
  const legs = legsOf('INFY');
  assert.equal(legs.length, 2, 'exactly the two new legs stand: ' + JSON.stringify(fake.liveForevers().filter(f => f.legs.some(l => l.tradingSymbol === 'INFY')).map(f => [f.orderId, f.legs.map(l => [l.legName, l.triggerPrice, l.quantity, l.orderStatus])])));
  assert.ok(!legs.some(f => String(f.orderId) === String(oldId)), 'the old single bracket is gone');
  legs.forEach(f => assert.equal(legVal(f, 'STOP_LOSS_LEG', 'triggerPrice'), 120, 'placed at the CURRENT stop, never the original 95'));
  assert.deepEqual(legs.map(f => legVal(f, 'TARGET_LEG', 'triggerPrice')).sort((a, b) => a - b), [130, 160], 'planned from the original stop and the broker cost');
  assert.deepEqual(legs.map(f => legVal(f, 'STOP_LOSS_LEG', 'quantity')).sort(), [5, 5]);
});

test('and it never repeats', async () => {
  const before = fake.sent('POST', '/v2/forever/orders').length;
  S.runEngineCutover(); await wait(1500);
  assert.equal(fake.sent('POST', '/v2/forever/orders').length, before, 'no further placements');
  assert.equal(legsOf('INFY').length, 2); assert.equal(legsOf('WIPRO').length, 2); assert.equal(legsOf('RELIANCE').length, 1);
});
