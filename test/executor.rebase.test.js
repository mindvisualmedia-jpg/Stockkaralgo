'use strict';
// test/executor.rebase.test.js — CORPORATE ACTION guard, end to end on fake Dhan.
// A 1:5 split rebases the position: holdings x5, price /5, the broker cancels
// the Forever. Before this guard the engine read it as "price crashed through
// the stop" -> REARM at the old stop (now above market) -> breach -> SELL at
// market, with a fictitious loss. Now:
//   1. the engine FREEZES: no protection placed, nothing sold, the row stamped
//   2. adjustRowForSplit rescales qty/prices and clears the dead leg ids
//   3. the next pass re-arms protection at the NEW, sane stop
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeDhan } = require('./fake-dhan');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-rebase-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({ clientId: 'FAKECLIENT', token: 'fake-token', savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
Object.assign(process.env, {
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1', STOCKKAR_BREACH_BACKSTOP: 'all',
});

const fake = createFakeDhan({ securities: { '1594': 'INFY', '11536': 'TCS' }, marketPrice: 20 });
let S, anchorId, fid;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const rows = () => S.readOrderLog();
const rowOf = (id) => rows().find(r => r.id === id);
async function enginePass() { S.runEngineCutover(); await wait(900); }
const now = () => ({ time: new Date().toLocaleString(), recordedAt: new Date().toISOString() });

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  S.seedDhanSecurityMap({ 'NSE:INFY': '1594', INFY: '1594', 'NSE:TCS': '11536', TCS: '11536' });
  fake.holdSymbol('TCS', 5);
  anchorId = fake.seedForever('TCS', 3000, 3300, 5);
  // a healthy protected position: 10 @ 100, stop 95, target 110
  fake.holdSymbol('INFY', 10);
  fid = fake.seedForever('INFY', 95, 110, 10);
  S.writeOrderLog([
    { id: 'anchor', broker: 'dhan', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300,
      securityId: '11536', exchange: 'NSE', segment: 'CNC', orderId: 'ENTRY:E9 | FOREVER:' + anchorId, dhanEntryOrderId: 'E9',
      dhanProtection: 'forever', dhanForeverId: anchorId, status: 'DHAN ENTRY + FOREVER OCO', liveLtp: 3100, ...now() },
    { id: 'sp', broker: 'dhan', symbol: 'INFY', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 95, targetPrice: 110,
      securityId: '1594', exchange: 'NSE', segment: 'CNC', orderId: 'ENTRY:E1 | FOREVER:' + fid, dhanEntryOrderId: 'E1',
      dhanProtection: 'forever', dhanForeverId: fid, status: 'DHAN ENTRY + FOREVER OCO', liveLtp: 100, ...now() },
  ]);
});
after(() => new Promise(res => fake.close(() => res())));

test('a 1:5 split (holdings x5, price /5, Forever cancelled) FREEZES the position: nothing placed, nothing sold', async () => {
  await enginePass();
  assert.equal(rowOf('sp').engineState, 'PROTECTED', 'healthy before the ex-date');
  // EX-DATE: the broker rebases the holding and drops the trigger; price is /5
  fake.st.forevers = fake.st.forevers.filter(f => f.orderId !== fid);
  fake.st.holdings.forEach(h => { if (h.tradingSymbol === 'INFY') h.totalQty = 50; });
  S.updateOrderLogRow('sp', r => ({ ...r, liveLtp: 20 }));
  const sells0 = fake.sent('POST', '/v2/orders').length, fors0 = fake.sent('POST', '/v2/forever/orders').length;
  await enginePass();
  await enginePass();
  await enginePass();   // three passes: the breach logic needed two to fire before the guard
  assert.equal(fake.sent('POST', '/v2/orders').length, sells0, 'NO sell order - the old code would have exited at market here');
  assert.equal(fake.sent('POST', '/v2/forever/orders').length, fors0, 'NO re-arm at the pre-split stop (it sits above market)');
  const r = rowOf('sp');
  assert.ok(r.corporateAction, 'row stamped');
  assert.equal(r.corporateAction.ratio, 5);
  assert.equal(r.corporateAction.heldQty, 50);
  assert.match(String(r.status), /CORPORATE ACTION/);
  assert.ok((r.events || []).some(ev => (ev.w || []).includes('CORPORATE_ACTION')), 'the alert is on the row history');
});

test('adjustRowForSplit rescales qty x5 and every price /5, clears the dead leg ids, keeps only the entry id', () => {
  const adj = S.adjustRowForSplit(rowOf('sp'), 5);
  assert.equal(adj.qty, 50);
  assert.equal(adj.entryPrice, 20); assert.equal(adj.slPrice, 19); assert.equal(adj.targetPrice, 22);
  assert.equal(adj.dhanForeverId, '', 'cancelled at the broker - cleared so the engine re-arms');
  assert.equal(adj.orderId, 'ENTRY:E1', 'string-embedded dead leg id dropped');
  assert.equal(adj.corporateAction, undefined);
  assert.equal(adj.corporateActionAdjusted.ratio, 5);
  assert.deepEqual(adj.corporateActionAdjusted.from, { qty: 10, entryPrice: 100, slPrice: 95, targetPrice: 110 });
});

test('after the adjust, the engine re-arms protection at the NEW stop (19) for the NEW qty (50) - and never sells', async () => {
  S.updateOrderLogRow('sp', r => S.adjustRowForSplit(r, 5));
  const sells0 = fake.sent('POST', '/v2/orders').length, fors0 = fake.sent('POST', '/v2/forever/orders').length;
  await enginePass();
  await enginePass();
  const placed = fake.sent('POST', '/v2/forever/orders').slice(fors0);
  assert.ok(placed.length >= 1, 're-armed');
  assert.equal(placed[0].body.quantity, 50, 'sized to the rebased holding');
  assert.equal(placed[0].body.triggerPrice, 19, 'stop at the rescaled level, below the rebased market (20)');
  assert.equal(fake.sent('POST', '/v2/orders').length, sells0, 'still no sell');
  const r = rowOf('sp');
  assert.ok(!r.corporateAction, 'no re-detection on the now-consistent row');
});
