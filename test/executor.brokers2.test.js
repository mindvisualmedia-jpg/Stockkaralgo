'use strict';
// test/executor.brokers2.test.js - the Kite + FYERS payload paths that were
// only proven on Dhan/Angel (the Angel split bug lived exactly here):
//   split cost-move (both legs, each keeping ITS qty and ITS target),
//   peak trail on an OCO (stop leg only, target kept, never lowers),
//   vanished stop -> re-arm at the MOVED stop + 10-min cooldown,
//   manual sell at the broker -> close from the fill, no orphan re-place.
// Real server.js executor; fake brokers via the locked seam. No real broker.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeKite, createFakeFyers } = require('./fake-brokers');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-brokers2-'));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'broker_tokens.json'), JSON.stringify({ brokers: {
  zerodha: { clientId: 'kiteapikey', clientSecret: 's', accessToken: 'kite-token', updatedAt: new Date().toISOString() },
  fyers: { clientId: 'FYAPP-100', clientSecret: 's', accessToken: 'fyers-token', updatedAt: new Date().toISOString() },
} }));
Object.assign(process.env, {
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_KITE_API_HOST: '127.0.0.1', STOCKKAR_KITE_API_PROTO: 'http',
  STOCKKAR_FYERS_API_HOST: '127.0.0.1', STOCKKAR_FYERS_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1', STOCKKAR_FYERS_LIVE: '1',
});

const kite = createFakeKite({ marketPrice: 103.4 });
const fyers = createFakeFyers({ marketPrice: 103.4 });
let S;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const rows = () => S.readOrderLog();
const rowOf = (id) => rows().find(r => r.id === id);
async function enginePass() { S.runEngineCutover(); await wait(900); }
const now = () => ({ time: new Date().toLocaleString(), recordedAt: new Date().toISOString() });
const setPrice = (sym, px) => {   // the engine reads THIS pass's broker quote first
  kite.data.holdings.forEach(h => { if (h.tradingsymbol === sym) h.last_price = px; });
  fyers.data.holdings.forEach(h => { if (h.symbol === 'NSE:' + sym + '-EQ') h.ltp = px; });
};

let zk, fk;   // anchor ids
before(async () => {
  await new Promise(res => kite.listen(port => { process.env.STOCKKAR_KITE_API_PORT = String(port); res(); }));
  await new Promise(res => fyers.listen(port => { process.env.STOCKKAR_FYERS_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  kite.holdSymbol('TCS', 5, 3100); fyers.holdSymbol('TCS', 5, 3100);
  zk = kite.seedGtt('TCS', 3000, 3300, 5); fk = fyers.seedGtt('TCS', 3000, 3300, 5);
});
after(async () => { await new Promise(r => kite.close(r)); await new Promise(r => fyers.close(r)); });
const anchors = () => [
  { id: 'az', broker: 'zerodha', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300, exchange: 'NSE', segment: 'CNC',
    orderId: 'ENTRY:ZE9 | GTT:' + zk, zerodhaEntryOrderId: 'ZE9', zerodhaGttId: zk, status: 'ZERODHA ENTRY + GTT OCO', liveLtp: 3100, ...now() },
  { id: 'af', broker: 'fyers', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300, exchange: 'NSE', segment: 'CNC',
    orderId: 'ENTRY:FE9 | GTT:' + fk, fyersEntryOrderId: 'FE9', fyersGttId: fk, status: 'FYERS ENTRY + GTT OCO', liveLtp: 3100, ...now() },
];

// ============================================================================
// 1. SPLIT cost-move: two GTTs, BOTH modified, each with ITS qty and ITS target
// ============================================================================
test('split cost-move x2: Kite restates BOTH two-leg GTTs (legA 4 @ T1 105, legB 6 @ T2 110) with stop at cost; FYERS patches BOTH GTTs with leg1 = that leg\'s target, leg2 = stop', async () => {
  kite.holdSymbol('INFY', 10, 101.5); fyers.holdSymbol('INFY', 10, 101.5);
  const zA = kite.seedGtt('INFY', 95, 105, 4), zB = kite.seedGtt('INFY', 95, 110, 6);
  const fA = fyers.seedGtt('INFY', 95, 105, 4), fB = fyers.seedGtt('INFY', 95, 110, 6);
  const split = (broker, extra) => ({ broker, symbol: 'INFY', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 95, targetPrice: 110,
    t1Pct: 5, t1Qty: 40, t2Pct: 10, costPct: 1, splitT1: true, splitLegAQty: 4, splitLegBQty: 6, exchange: 'NSE', segment: 'CNC', liveLtp: 101.5, ...now(), ...extra });
  S.writeOrderLog([...anchors(),
    split('zerodha', { id: 'zs', zerodhaSplit: true, orderId: 'ENTRY:ZE1 | GTT-T1:' + zA + ' | GTT:' + zB, zerodhaEntryOrderId: 'ZE1', zerodhaGttT1Id: zA, zerodhaGttId: zB, status: 'ZERODHA ENTRY + 2x GTT OCO (T1/T2 split)' }),
    split('fyers', { id: 'fs', fyersSplit: true, orderId: 'ENTRY:FE1 | GTT-T1:' + fA + ' | GTT:' + fB, fyersEntryOrderId: 'FE1', fyersGttT1Id: fA, fyersGttId: fB, status: 'FYERS ENTRY + GTT 2x OCO (T1/T2 split)' }),
  ]);
  await enginePass();
  // Kite
  const zm = kite.sent('PUT', '/gtt/triggers/');
  assert.equal(zm.length, 2, 'Kite: both GTTs modified');
  const zBy = Object.fromEntries(zm.map(m => [m.path.split('/').pop(), { c: JSON.parse(m.body.condition), o: JSON.parse(m.body.orders), type: m.body.type }]));
  assert.deepEqual(zBy[zA].c.trigger_values, [100, 105], 'legA: stop to cost, T1 target kept');
  assert.deepEqual(zBy[zB].c.trigger_values, [100, 110], 'legB: stop to cost, T2 target kept');
  assert.equal(zBy[zA].o[0].quantity, 4); assert.equal(zBy[zA].o[1].quantity, 4, 'legA keeps ITS qty on both legs');
  assert.equal(zBy[zB].o[0].quantity, 6); assert.equal(zBy[zB].o[1].quantity, 6, 'legB keeps ITS qty');
  assert.ok(zBy[zA].type === 'two-leg' && zBy[zB].type === 'two-leg');
  assert.ok(zBy[zA].c.last_price > 100 && zBy[zB].c.last_price > 100, 'live last_price sent (Kite validates the SELL trigger against it)');
  // FYERS
  const fm = fyers.sent('PATCH', '/api/v3/gtt/orders/sync');
  assert.equal(fm.length, 2, 'FYERS: both GTTs patched');
  const fBy = Object.fromEntries(fm.map(m => [String(m.body.id), m.body.orderInfo]));
  assert.equal(fBy[fA].leg1.triggerPrice, 105, 'legA leg1 = ITS target (T1)'); assert.equal(fBy[fA].leg2.triggerPrice, 100, 'legA leg2 = stop at cost');
  assert.equal(fBy[fB].leg1.triggerPrice, 110, 'legB leg1 = ITS target (T2)'); assert.equal(fBy[fB].leg2.triggerPrice, 100);
  assert.equal(fBy[fA].leg1.qty, 4); assert.equal(fBy[fA].leg2.qty, 4); assert.equal(fBy[fB].leg1.qty, 6); assert.equal(fBy[fB].leg2.qty, 6);
  assert.equal(fyers.targetOf(fyers.gtt(fA)), 105); assert.equal(fyers.targetOf(fyers.gtt(fB)), 110, 'targets untouched at the broker');
  assert.equal(fyers.stopOf(fyers.gtt(fA)), 100); assert.equal(fyers.stopOf(fyers.gtt(fB)), 100);
  await enginePass();   // believed on the next read
  ['zs', 'fs'].forEach(id => { const r = rowOf(id); assert.equal(r.mtmCostDone, true, id + ' cost done'); assert.equal(r.slPrice, 100, id + ' slPrice'); assert.equal(r.slPriceOriginal, 95); });
});

// ============================================================================
// 2. PEAK trail on a single OCO: stop leg steps up to peak-2%, target kept, never lowers
// ============================================================================
test('peak trail x2: arms at T1, Kite two-leg restated with stop = peak-2% and target kept; FYERS leg2 = new stop, leg1 = target unchanged; a pullback sends nothing', async () => {
  kite.holdSymbol('WIPRO', 10, 104); fyers.holdSymbol('WIPRO', 10, 104);
  const zg = kite.seedGtt('WIPRO', 95, 110, 10), fg = fyers.seedGtt('WIPRO', 95, 110, 10);
  const tr = (broker, extra) => ({ broker, symbol: 'WIPRO', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 95, targetPrice: 110,
    t1Pct: 5, t2Pct: 10, emaTrailingEnabled: true, emaTrailingTrigger: 'afterTarget', trailMode: 'peak', emaTrailingPct: 2,
    exchange: 'NSE', segment: 'CNC', liveLtp: 104, ...now(), ...extra });
  S.writeOrderLog([...anchors(),
    tr('zerodha', { id: 'zt', orderId: 'ENTRY:ZE2 | GTT:' + zg, zerodhaEntryOrderId: 'ZE2', zerodhaGttId: zg, status: 'ZERODHA ENTRY + GTT OCO' }),
    tr('fyers', { id: 'ft', orderId: 'ENTRY:FE2 | GTT:' + fg, fyersEntryOrderId: 'FE2', fyersGttId: fg, status: 'FYERS ENTRY + GTT OCO' }),
  ]);
  const z0 = kite.sent('PUT', '/gtt/triggers/').length, f0 = fyers.sent('PATCH', '/api/v3/gtt/orders/sync').length;
  await enginePass();
  assert.equal(kite.sent('PUT', '/gtt/triggers/').length, z0, 'below T1 nothing moves (Kite)');
  assert.equal(fyers.sent('PATCH', '/api/v3/gtt/orders/sync').length, f0, 'below T1 nothing moves (FYERS)');
  setPrice('WIPRO', 106); ['zt', 'ft'].forEach(id => S.updateOrderLogRow(id, r => ({ ...r, liveLtp: 106 })));
  await enginePass();
  const zm = kite.sent('PUT', '/gtt/triggers/').slice(z0);
  assert.equal(zm.length, 1, 'Kite: one modify on arming');
  const zc = JSON.parse(zm[0].body.condition);
  assert.deepEqual(zc.trigger_values, [103.9, 110], 'stop = 106-2% (tick-rounded), target kept');
  const fm = fyers.sent('PATCH', '/api/v3/gtt/orders/sync').slice(f0);
  assert.equal(fm.length, 1, 'FYERS: one patch on arming');
  assert.equal(fm[0].body.orderInfo.leg1.triggerPrice, 110, 'leg1 is still the target');
  assert.equal(fm[0].body.orderInfo.leg2.triggerPrice, 103.9, 'leg2 is the new stop');
  assert.equal(rowOf('zt').trailArmed, true); assert.equal(rowOf('ft').trailArmed, true);
  await enginePass();   // verified
  assert.equal(rowOf('zt').slPrice, 103.9); assert.equal(rowOf('ft').slPrice, 103.9);
  // pullback -> nothing
  setPrice('WIPRO', 104.5); ['zt', 'ft'].forEach(id => S.updateOrderLogRow(id, r => ({ ...r, liveLtp: 104.5 })));
  const z1 = kite.sent('PUT', '/gtt/triggers/').length, f1 = fyers.sent('PATCH', '/api/v3/gtt/orders/sync').length;
  await enginePass();
  assert.equal(kite.sent('PUT', '/gtt/triggers/').length, z1, 'no Kite modify on a pullback');
  assert.equal(fyers.sent('PATCH', '/api/v3/gtt/orders/sync').length, f1, 'no FYERS modify on a pullback');
});

// ============================================================================
// 3. VANISHED stop -> re-arm at the MOVED stop, cooldown on the second ask
// ============================================================================
test('vanished stop x2: re-armed at the current (moved) stop, not the original; a second vanish inside 10 min is not re-armed', async () => {
  // zt/ft from the trail test: stop now 103.9, target 110 - the broker loses the GTT
  kite.data.gtts = kite.data.gtts.filter(g => !/WIPRO/.test(g.condition.tradingsymbol));
  fyers.data.gtts = fyers.data.gtts.filter(g => !/WIPRO/.test(g.symbol));
  ['zt', 'ft'].forEach(id => S.updateOrderLogRow(id, r => ({ ...r, engineGraceAt: Date.now() - 20 * 60 * 1000 })));
  const zp0 = kite.sent('POST', '/gtt/triggers').length, fp0 = fyers.sent('POST', '/api/v3/gtt/orders/sync').length;
  await enginePass(); await enginePass();
  const zp = kite.sent('POST', '/gtt/triggers').slice(zp0);
  assert.equal(zp.length, 1, 'Kite: one re-arm');
  assert.deepEqual(JSON.parse(zp[0].body.condition).trigger_values, [103.9, 110], 'at the MOVED stop, never back to 95');
  const fp = fyers.sent('POST', '/api/v3/gtt/orders/sync').slice(fp0);
  assert.equal(fp.length, 1, 'FYERS: one re-arm');
  assert.equal(fp[0].body.orderInfo.leg2.triggerPrice, 103.9, 'at the MOVED stop'); assert.equal(fp[0].body.orderInfo.leg1.triggerPrice, 110);
  await enginePass();
  assert.equal(rowOf('zt').engineState, 'PROTECTED'); assert.equal(rowOf('ft').engineState, 'PROTECTED');
  // vanish again immediately -> cooldown
  kite.data.gtts = kite.data.gtts.filter(g => !/WIPRO/.test(g.condition.tradingsymbol));
  fyers.data.gtts = fyers.data.gtts.filter(g => !/WIPRO/.test(g.symbol));
  ['zt', 'ft'].forEach(id => S.updateOrderLogRow(id, r => ({ ...r, engineGraceAt: Date.now() - 20 * 60 * 1000 })));
  await enginePass(); await enginePass();
  assert.equal(kite.sent('POST', '/gtt/triggers').length, zp0 + 1, 'Kite cooldown honoured');
  assert.equal(fyers.sent('POST', '/api/v3/gtt/orders/sync').length, fp0 + 1, 'FYERS cooldown honoured');
});

// ============================================================================
// 4. MANUAL sell at the broker -> CLOSED from the fill, no stop re-placed
// ============================================================================
test('manual sell x2: the row closes from the broker FILL with the real price and P&L; nothing is re-placed', async () => {
  // Own rows: HDFCBANK single OCO on each broker, stop at cost (100). The user
  // sells everything manually at 103.4: GTT gone, holding gone, a SELL fill in
  // today's book. Anchors keep the read trusted.
  const zg = kite.seedGtt('HDFCBANK', 100, 110, 10), fg = fyers.seedGtt('HDFCBANK', 100, 110, 10);
  const mk = (broker, extra) => ({ broker, symbol: 'HDFCBANK', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 100, targetPrice: 110,
    mtmCostDone: true, exchange: 'NSE', segment: 'CNC', liveLtp: 103.4, engineState: 'PROTECTED', ...now(), ...extra });
  S.writeOrderLog([...anchors(),
    mk('zerodha', { id: 'zm', orderId: 'ENTRY:ZE3 | GTT:' + zg, zerodhaEntryOrderId: 'ZE3', zerodhaGttId: zg, status: 'ZERODHA ENTRY + GTT OCO' }),
    mk('fyers', { id: 'fm', orderId: 'ENTRY:FE3 | GTT:' + fg, fyersEntryOrderId: 'FE3', fyersGttId: fg, status: 'FYERS ENTRY + GTT OCO' }),
  ]);
  kite.data.gtts = kite.data.gtts.filter(g => String(g.id) !== String(zg));
  fyers.data.gtts = fyers.data.gtts.filter(g => String(g.id) !== String(fg));
  kite.data.orders.push({ order_id: 'ZM1', status: 'COMPLETE', transaction_type: 'SELL', tradingsymbol: 'HDFCBANK', quantity: 10, filled_quantity: 10, average_price: 103.4 });
  fyers.data.orders.push({ id: 'FM1', side: -1, status: 2, symbol: 'NSE:HDFCBANK-EQ', qty: 10, filledQty: 10, tradedPrice: 103.4 });
  const zp0 = kite.sent('POST', '/gtt/triggers').length, fp0 = fyers.sent('POST', '/api/v3/gtt/orders/sync').length;
  await enginePass();
  ['zm', 'fm'].forEach(id => {
    const r = rowOf(id);
    assert.ok(r, id + ' exists');
    assert.equal(r.engineState, 'CLOSED', id + ' CLOSED');
    assert.equal(r.exitPrice, 103.4, id + ' at the fill');
    assert.equal(r.realisedPnl, 34, id + ' P&L 10 x 3.4');
    assert.equal(r.exitEstimated, false);
  });
  assert.equal(kite.sent('POST', '/gtt/triggers').length, zp0, 'no Kite re-place on a closed position');
  assert.equal(fyers.sent('POST', '/api/v3/gtt/orders/sync').length, fp0, 'no FYERS re-place');
});
