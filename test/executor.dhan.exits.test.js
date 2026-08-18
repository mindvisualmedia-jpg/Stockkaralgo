'use strict';
// test/executor.dhan.exits.test.js — the SELL paths of the real executor,
// driven against the fake Dhan. These are the paths that move money and the
// ones that carried the 2026-08-18 `price: ""` defect: a breached stop exited
// at market, a stuck exit chased to market, an orphaned protection cancelled,
// and a split OCO's cost-move touching BOTH legs.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeDhan } = require('./fake-dhan');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-exits-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({ clientId: 'FAKECLIENT', token: 'fake-token' }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
Object.assign(process.env, {
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1',
  STOCKKAR_ENGINE_ENTRIES: '1',   // read once at require time - the orphan test needs the engine to own entries
});

const fake = createFakeDhan({ securities: { '1594': 'INFY', '11536': 'TCS', '3787': 'WIPRO', '1333': 'HDFCBANK' }, marketPrice: 93.5 });
let S;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const rows = () => S.readOrderLog();
const rowOf = (sym) => rows().find(r => r.symbol === sym);
async function enginePass() { S.runEngineCutover(); await wait(700); }

// A healthy second position anchors the read-sanity gate: its id IS in every
// snapshot, so "none of our ids are here" never fires and the engine acts.
let anchorId;
function seedAnchor() {
  fake.holdSymbol('TCS', 5);
  anchorId = fake.seedForever('TCS', 3000, 3300, 5);
  return { id: 'anchor', broker: 'dhan', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300,
    securityId: '11536', exchange: 'NSE', segment: 'CNC', orderId: 'ENTRY:E9 | FOREVER:' + anchorId, dhanEntryOrderId: 'E9',
    dhanProtection: 'forever', dhanForeverId: anchorId, status: 'DHAN ENTRY + FOREVER OCO',
    time: new Date().toLocaleString(), recordedAt: new Date().toISOString() };
}

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  S.seedDhanSecurityMap({ 'NSE:INFY': '1594', INFY: '1594', 'NSE:TCS': '11536', TCS: '11536', 'NSE:WIPRO': '3787', WIPRO: '3787', 'NSE:HDFCBANK': '1333', HDFCBANK: '1333' });
});
after(() => new Promise(res => fake.close(() => res())));

// ---- 1. BREACHED STOP: price through the stop on a naked position ----------
test('breached stop: naked + price through the stop for TWO passes -> MARKET sell with a NUMERIC price (the price:"" defect), never a re-placed trigger', async () => {
  fake.holdSymbol('INFY', 10);
  S.writeOrderLog([seedAnchor(), {
    id: 'b1', broker: 'dhan', symbol: 'INFY', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 95, targetPrice: 110,
    securityId: '1594', exchange: 'NSE', segment: 'CNC', orderId: 'ENTRY:E1', dhanEntryOrderId: 'E1', dhanProtection: 'forever',
    dhanForeverId: '', status: 'ENTRY PLACED BUT PROTECTION FAILED: rejected', protectionFailedAt: new Date().toISOString(),
    orderTag: 'SKDHANTAG000001',                // ORDER TAG: the sell must carry it as correlationId
    liveLtp: 93.5,                              // through the 95 stop
    engineGraceAt: Date.now() - 20 * 60 * 1000, // grace already expired
    time: new Date().toLocaleString(), recordedAt: new Date().toISOString(),
  }]);
  await enginePass();                     // UNPROTECTED; first breach sighting -> wait
  assert.equal(fake.sent('POST', '/v2/orders').length, 0, 'never acts on one tick');
  await enginePass();                     // second sighting -> exit at market
  const sells = fake.sent('POST', '/v2/orders');
  assert.equal(sells.length, 1, 'one market sell');
  const p = sells[0].body;
  assert.equal(p.transactionType, 'SELL');
  assert.equal(p.orderType, 'MARKET');
  assert.equal(p.quantity, 10);
  assert.equal(p.securityId, '1594');
  assert.strictEqual(p.price, 0, 'price must be the NUMBER 0 - the string "" is what Dhan refused on GNFC');
  assert.equal(p.validity, 'DAY');
  assert.equal(p.productType, 'CNC');
  assert.equal(p.correlationId, 'SKDHANTAG000001', 'Dhan: the sell carries the row tag as correlationId');
  // and NO protective trigger was placed for a position the market has passed
  assert.equal(fake.sent('POST', '/v2/forever/orders').length, 0, 'never re-arm a trigger that would fire on arrival');
  const r = rowOf('INFY');
  assert.equal(r.exitPending, true);
  assert.equal(r.engineState, 'EXIT_PENDING');
  assert.equal(r.exitOrderType, 'market');
});

test('breached stop: the fill closes the row as SL HIT at the real price', async () => {
  fake.st.holdings = fake.st.holdings.filter(h => h.tradingSymbol !== 'INFY');
  await enginePass();
  const r = rowOf('INFY');
  assert.equal(r.engineState, 'CLOSED');
  assert.equal(r.exitPrice, 93.5);
  assert.equal(r.realisedPnl, -65);
  assert.equal(r.exitEstimated, false);
});

// ---- 2. CHASE_EXIT: a fired stop whose SELL rests unfilled ------------------
test('CHASE_EXIT: a stuck exit is cancelled FIRST, then re-placed at market for the held qty', async () => {
  // WIPRO: its own symbol, because the adapter caches the 7-day tradebook for
  // 10 minutes - a symbol that already sold once would still read as sold.
  fake.holdSymbol('WIPRO', 10);
  fake.st.orders.push({ orderId: 'STUCK1', orderStatus: 'PENDING', transactionType: 'SELL', tradingSymbol: 'WIPRO',
    quantity: 10, filledQty: 0, orderType: 'LIMIT', price: 95 });
  const sellsBefore = fake.sent('POST', '/v2/orders').length;
  S.writeOrderLog([seedAnchorRow(), {
    id: 'c1', broker: 'dhan', symbol: 'WIPRO', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 95, targetPrice: 110,
    securityId: '3787', exchange: 'NSE', segment: 'CNC', orderId: 'ENTRY:E2', dhanEntryOrderId: 'E2', dhanProtection: 'forever',
    dhanForeverId: '', status: 'DHAN — STOP FIRED, EXIT PENDING', engineState: 'EXIT_PENDING',
    exitPending: true, exitOrderType: 'market', exitPendingAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    liveLtp: 96, time: new Date().toLocaleString(), recordedAt: new Date().toISOString(),
  }]);
  await enginePass();
  assert.deepEqual(fake.st.cancelledOrders || [], ['STUCK1'], 'the resting exit is cancelled first');
  const sells = fake.sent('POST', '/v2/orders').slice(sellsBefore);
  assert.equal(sells.length, 1, 'exactly one market re-place');
  assert.equal(sells[0].body.orderType, 'MARKET');
  assert.equal(sells[0].body.quantity, 10);
  assert.strictEqual(sells[0].body.price, 0);
  assert.equal(sells[0].body.securityId, '3787');
  assert.equal(rowOf('WIPRO').exitChaseAttempts, 1);
});

// helper so the anchor row is re-seeded without duplicating the broker state
function seedAnchorRow() {
  return { id: 'anchor', broker: 'dhan', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300,
    securityId: '11536', exchange: 'NSE', segment: 'CNC', orderId: 'ENTRY:E9 | FOREVER:' + anchorId, dhanEntryOrderId: 'E9',
    dhanProtection: 'forever', dhanForeverId: anchorId, status: 'DHAN ENTRY + FOREVER OCO',
    time: new Date().toLocaleString(), recordedAt: new Date().toISOString() };
}

// ---- 3. CANCEL_ORPHAN: the entry died but its Forever stands ---------------
test('dead entry: its standing Forever is CANCELLED (a naked short if it fired) and the row reads REJECTED', async () => {
  const orphanId = fake.seedForever('HDFCBANK', 1600, 1750, 10);
  fake.st.orders.push({ orderId: 'E3', orderStatus: 'REJECTED', transactionType: 'BUY', tradingSymbol: 'HDFCBANK', quantity: 10, filledQty: 0 });
  S.writeOrderLog([seedAnchorRow(), {
    id: 'o1', broker: 'dhan', symbol: 'HDFCBANK', action: 'BUY', qty: 10, entryPrice: 1700, price: 1700, slPrice: 1600, targetPrice: 1750,
    securityId: '1333', exchange: 'NSE', segment: 'CNC', orderId: 'ENTRY:E3 | FOREVER:' + orphanId, dhanEntryOrderId: 'E3',
    dhanProtection: 'forever', dhanForeverId: orphanId, awaitingFill: true, pendingProtection: { entryId: 'E3', qty: 10 },
    status: 'DHAN ENTRY PENDING', engineState: 'ENTRY_PENDING',
    time: new Date().toLocaleString(), recordedAt: new Date().toISOString(),
  }]);
  await enginePass();
  assert.ok((fake.st.cancelled || []).includes(orphanId), 'the orphaned Forever was cancelled');
  assert.ok(!fake.forever(orphanId), 'gone from the broker');
  const r = rowOf('HDFCBANK');
  assert.equal(r.exitType, 'REJECTED');
  assert.match(String(r.status), /no position, protection cancelled/i);
});

// ---- 4. SPLIT OCO: pre-T1 cost move touches BOTH legs ----------------------
test('split OCO: the pre-T1 cost move modifies BOTH legs, each keeping its own qty and target', async () => {
  fake.st.forevers = [];
  fake.st.holdings = [];
  fake.st.orders = [];
  fake.st.trades = [];
  fake.holdSymbol('TCS', 5);
  const anchor2 = fake.seedForever('TCS', 3000, 3300, 5);
  fake.holdSymbol('INFY', 10);
  const legA = fake.seedForever('INFY', 95, 105, 4);    // T1 leg: 4 @ 105
  const legB = fake.seedForever('INFY', 95, 110, 6);    // runner: 6 @ 110
  S.writeOrderLog([{ ...seedAnchorRow(), orderId: 'ENTRY:E9 | FOREVER:' + anchor2, dhanForeverId: anchor2 }, {
    id: 's1', broker: 'dhan', symbol: 'INFY', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 95, targetPrice: 110,
    t1Pct: 5, t1Qty: 40, t2Pct: 10, costPct: 1, splitT1: true, splitLegAQty: 4, splitLegBQty: 6,
    securityId: '1594', exchange: 'NSE', segment: 'CNC', dhanProtection: 'forever-split',
    orderId: 'ENTRY:E4 | FOREVER-T1:' + legA + ' | FOREVER:' + legB, dhanEntryOrderId: 'E4',
    dhanForeverT1Id: legA, dhanForeverId: legB, status: 'DHAN ENTRY + 2x FOREVER OCO (T1/T2 split)',
    liveLtp: 101.5, time: new Date().toLocaleString(), recordedAt: new Date().toISOString(),
  }]);
  const modsBefore = fake.sent('PUT', '/v2/forever/orders/').length;
  await enginePass();
  const mods = fake.sent('PUT', '/v2/forever/orders/').slice(modsBefore);
  assert.equal(mods.length, 2, 'both legs modified');
  const byId = Object.fromEntries(mods.map(m => [m.path.split('/').pop(), m.body]));
  assert.equal(byId[legA].quantity, 4, 'T1 leg keeps ITS qty');
  assert.equal(byId[legB].quantity, 6, 'runner keeps ITS qty');
  [legA, legB].forEach(id => {
    assert.equal(byId[id].triggerPrice, 100, 'stop to cost on both');
    assert.equal(byId[id].legName, 'STOP_LOSS_LEG');
    assert.equal(byId[id].orderFlag, 'OCO');
  });
  assert.equal(fake.forever(legA).legs.find(l => l.legName === 'TARGET_LEG').triggerPrice, 105, 'T1 target untouched');
  assert.equal(fake.forever(legB).legs.find(l => l.legName === 'TARGET_LEG').triggerPrice, 110, 'T2 target untouched');
  await enginePass();
  const r = rowOf('INFY');
  assert.equal(r.mtmCostDone, true);
  assert.equal(r.slPrice, 100);
});
