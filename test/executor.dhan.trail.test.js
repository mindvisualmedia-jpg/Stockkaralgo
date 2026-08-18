'use strict';
// test/executor.dhan.trail.test.js — the SL-management paths with no live
// evidence yet: peak trailing, move-SL-to-T1 after T1 books, and a No-SL
// (TARGETS_ONLY) row re-placing a missing target leg. Real executor, fake Dhan.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeDhan } = require('./fake-dhan');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-trail-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({ clientId: 'FAKECLIENT', token: 'fake-token' }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
Object.assign(process.env, {
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1',
});

const fake = createFakeDhan({ securities: { '1594': 'INFY', '11536': 'TCS', '3787': 'WIPRO' } });
let S, anchorId;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const rows = () => S.readOrderLog();
const rowOf = (sym) => rows().find(r => r.symbol === sym);
async function enginePass() { S.runEngineCutover(); await wait(700); }
const anchorRow = () => ({ id: 'anchor', broker: 'dhan', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100,
  slPrice: 3000, targetPrice: 3300, securityId: '11536', exchange: 'NSE', segment: 'CNC',
  orderId: 'ENTRY:E9 | FOREVER:' + anchorId, dhanEntryOrderId: 'E9', dhanProtection: 'forever', dhanForeverId: anchorId,
  status: 'DHAN ENTRY + FOREVER OCO', time: new Date().toLocaleString(), recordedAt: new Date().toISOString() });

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  S.seedDhanSecurityMap({ 'NSE:INFY': '1594', INFY: '1594', 'NSE:TCS': '11536', TCS: '11536', 'NSE:WIPRO': '3787', WIPRO: '3787' });
  fake.holdSymbol('TCS', 5);
  anchorId = fake.seedForever('TCS', 3000, 3300, 5);
});
after(() => new Promise(res => fake.close(() => res())));

// ---- PEAK TRAILING (rule 7) -------------------------------------------------
// entry 100, stop 95, T1 105 (5%), T2 110; trail arms at T1 and gives back 2%.
// The bracket is a NORMAL OCO because trailing no longer changes the shape.
test('peak trail: below the arm level nothing moves; at the arm level the stop steps up to peak-2% (stop leg only, target untouched)', async () => {
  fake.holdSymbol('INFY', 10);
  const fid = fake.seedForever('INFY', 95, 110, 10);
  S.writeOrderLog([anchorRow(), {
    id: 't1', broker: 'dhan', symbol: 'INFY', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 95, targetPrice: 110,
    t1Pct: 5, t2Pct: 10, securityId: '1594', exchange: 'NSE', segment: 'CNC', dhanProtection: 'forever',
    orderId: 'ENTRY:E1 | FOREVER:' + fid, dhanEntryOrderId: 'E1', dhanForeverId: fid,
    emaTrailingEnabled: true, emaTrailingTrigger: 'afterTarget', trailMode: 'peak', emaTrailingPct: 2,
    liveLtp: 104, status: 'DHAN ENTRY + FOREVER OCO', time: new Date().toLocaleString(), recordedAt: new Date().toISOString(),
  }]);
  await enginePass();
  assert.equal(fake.sent('PUT', '/v2/forever/orders/').length, 0, 'below T1 (105) the trail is not armed');
  assert.ok(!rowOf('INFY').trailArmed);

  S.updateOrderLogRow('t1', r => ({ ...r, liveLtp: 106 }));   // through T1 -> arm, peak 106
  await enginePass();
  const mods = fake.sent('PUT', '/v2/forever/orders/');
  assert.equal(mods.length, 1, 'armed and trailed in one step');
  // 106 - 2% = 103.88, snapped to the tick grid by roundPrice (nearest 0.10).
  assert.equal(mods[0].body.triggerPrice, 103.9, '106 - 2%, tick-rounded');
  // INVARIANT: what we BELIEVE is pending must be what the broker was actually
  // sent - otherwise verify-after-modify can never confirm and every trail step
  // would raise a false "stop may be STALE" alert.
  assert.equal(rowOf('INFY').enginePendingSl.price, fake.forever(fid).legs.find(l => l.legName === 'STOP_LOSS_LEG').triggerPrice);
  assert.equal(mods[0].body.legName, 'STOP_LOSS_LEG');
  assert.equal(mods[0].body.orderFlag, 'OCO', 'a trailing row still carries its target leg');
  assert.equal(fake.forever(fid).legs.find(l => l.legName === 'TARGET_LEG').triggerPrice, 110, 'T2 untouched at the broker');
  assert.equal(rowOf('INFY').trailArmed, true);
});

test('peak trail: a NEW high raises the stop; a pullback NEVER lowers it', async () => {
  await enginePass();                                    // verify the pending modify first
  const before = fake.sent('PUT', '/v2/forever/orders/').length;
  S.updateOrderLogRow('t1', r => ({ ...r, liveLtp: 112 }));   // new high
  await enginePass();
  const mods = fake.sent('PUT', '/v2/forever/orders/').slice(before);
  assert.equal(mods.length, 1);
  assert.equal(mods[0].body.triggerPrice, 109.8, '112 - 2%, tick-rounded');
  await enginePass();                                    // verified
  S.updateOrderLogRow('t1', r => ({ ...r, liveLtp: 107 }));   // pullback
  await enginePass();
  assert.equal(fake.sent('PUT', '/v2/forever/orders/').length, before + 1, 'no modify on a pullback');
  assert.equal(fake.forever(fake.liveForevers().find(f => f.legs[0].tradingSymbol === 'INFY').orderId)
    .legs.find(l => l.legName === 'STOP_LOSS_LEG').triggerPrice, 109.8, 'the stop stays at its high-water level');
});

// ---- MOVE SL TO T1 (rule 3b) ------------------------------------------------
test('move SL to T1: after T1 books, price 0.5% above T1 locks the RUNNER stop at T1 (once, verified)', async () => {
  fake.st.forevers = fake.st.forevers.filter(f => f.legs[0].tradingSymbol === 'TCS');
  fake.st.holdings = fake.st.holdings.filter(h => h.tradingSymbol === 'TCS');
  fake.holdSymbol('WIPRO', 6);
  const legB = fake.seedForever('WIPRO', 100, 110, 6);   // runner only: T1 already booked at the broker
  S.writeOrderLog([anchorRow(), {
    id: 'w1', broker: 'dhan', symbol: 'WIPRO', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 100, targetPrice: 110,
    t1Pct: 5, t1Qty: 40, t2Pct: 10, slToT1Pct: 0.5, splitT1: true, splitLegAQty: 4, splitLegBQty: 6,
    mtmT1Done: true, mtmCostDone: true, securityId: '3787', exchange: 'NSE', segment: 'CNC', dhanProtection: 'forever-split',
    orderId: 'ENTRY:E5 | FOREVER:' + legB, dhanEntryOrderId: 'E5', dhanForeverId: legB, dhanForeverT1Id: '',
    liveLtp: 105.6,                                     // T1 = 105; lock trigger = 105.525
    status: 'DHAN ENTRY + 2x FOREVER OCO (T1/T2 split)', time: new Date().toLocaleString(), recordedAt: new Date().toISOString(),
  }]);
  const before = fake.sent('PUT', '/v2/forever/orders/').length;
  await enginePass();
  const mods = fake.sent('PUT', '/v2/forever/orders/').slice(before);
  assert.equal(mods.length, 1, 'one modify: the runner leg');
  assert.equal(mods[0].path.split('/').pop(), legB);
  assert.equal(mods[0].body.triggerPrice, 105, 'stop locked AT the T1 price');
  assert.equal(mods[0].body.quantity, 6, 'runner qty, never the full position');
  await enginePass();                                    // broker shows it -> believed
  const r = rowOf('WIPRO');
  assert.equal(r.mtmSlT1Done, true);
  assert.equal(r.slPrice, 105);
  // and it never fires twice
  const after1 = fake.sent('PUT', '/v2/forever/orders/').length;
  S.updateOrderLogRow('w1', r2 => ({ ...r2, liveLtp: 106 }));
  await enginePass();
  assert.equal(fake.sent('PUT', '/v2/forever/orders/').length, after1, 'fires once');
});

// ---- TARGETS_ONLY (No-SL) ---------------------------------------------------
test('No-SL row: a missing target leg is re-placed as a SINGLE Forever at the planned qty and price, sized to what is HELD', async () => {
  fake.st.forevers = fake.st.forevers.filter(f => f.legs[0].tradingSymbol === 'TCS');
  fake.st.holdings = fake.st.holdings.filter(h => h.tradingSymbol === 'TCS');
  fake.holdSymbol('INFY', 10);
  const t1Id = fake.seedForever('INFY', 0, 0, 0);        // placeholder id we immediately drop
  fake.st.forevers = fake.st.forevers.filter(f => f.orderId !== t1Id);
  const liveT1 = fake.seedForever('INFY', 103, 0, 4);    // T1 leg standing (single-leg SELL trigger)
  S.writeOrderLog([anchorRow(), {
    id: 'n1', broker: 'dhan', symbol: 'INFY', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 0, targetPrice: 106,
    noSl: true, t1Pct: 3, t1Qty: 40, t2Pct: 6, securityId: '1594', exchange: 'NSE', segment: 'CNC',
    orderId: 'ENTRY:E6 | TGT-T1:' + liveT1, dhanEntryOrderId: 'E6', dhanTargetT1Id: liveT1, dhanTargetT2Id: '',
    status: 'DHAN ENTRY + FOREVER TARGETS (No-SL)', time: new Date().toLocaleString(), recordedAt: new Date().toISOString(),
  }]);
  const before = fake.sent('POST', '/v2/forever/orders').length;
  await enginePass();
  const placed = fake.sent('POST', '/v2/forever/orders').slice(before);
  assert.equal(placed.length, 1, 'only the MISSING leg is placed');
  const p = placed[0].body;
  assert.equal(p.orderFlag, 'SINGLE', 'a target leg is a single SELL trigger, not an OCO');
  assert.equal(p.transactionType, 'SELL');
  assert.equal(p.quantity, 6, 'T2 leg qty = 10 - 4 booked at T1');
  assert.equal(p.triggerPrice, 106, 'T2 = entry +6%');
  assert.equal(p.orderType, 'LIMIT');
  assert.equal(p.securityId, '1594');
  const r = rowOf('INFY');
  assert.equal(r.engineState, 'TARGETS_ONLY');
  assert.ok(r.dhanTargetT2Id, 'the new leg id is recorded on the row');
  assert.match(String(r.orderId), /TGT-T2:/);
});
