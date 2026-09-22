'use strict';
// test/rearm.held.test.js — IKS on a customer's Dhan box (owner, 2026-09-22):
// "We have only 3 QTY in holding but its trying to sell 5".
//
// A T1/T2 split (2 + 3) had sold its T1 shares without the row ever booking
// T1 - the leg id was lost to a reopen and a consolidation - so the row said 5
// while the broker held 3. Every re-armed stop was a SELL for 5. And the
// level re-armed was a TRAILED stop above the market: to Dhan a SELL trigger
// at/above the LTP is a TARGET leg, so each one fired the second it was placed,
// its child was refused ("sell more than the quantity you currently hold"),
// the leg was consumed, the position was naked again, and ten minutes later
// the same - seven times in one day, with nothing on the row saying what any
// of them carried.
//
// Against the REAL engine pass, executor and restore, and a fake Dhan that now
// fires a SELL trigger at/above the LTP on arrival exactly as the live one did:
//   1. the re-arm sizes the stop to what is HELD (3), adopts that onto the
//      row, says why, and records the placement (trigger, qty, Dhan's answer)
//   2. a trailed level above the market is a BREACHED stop: no trigger is
//      placed; the held 3 are exited at market (the 2026-08-14 rule)
//   3. the restore itself refuses a trigger at/above the market, whoever calls it
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeDhan } = require('./fake-dhan');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-rearmheld-'));
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

const fake = createFakeDhan({ securities: { '28125': 'IKS', '3787': 'WIPRO', '2885': 'RELIANCE', '11536': 'TCS' }, marketPrice: 1850 });
let S, anchorId;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 15000)) { if (fn()) return true; await wait(200); } return false; };
const hold = (sym, secId, qty, ltp, avg) => fake.st.holdings.push({ tradingSymbol: sym, securityId: secId, totalQty: qty, availableQty: qty, exchange: 'NSE', lastTradedPrice: ltp, avgCostPrice: avg });
const rowOf = (id) => S.readOrderLog().find(r => r.id === id);
const now = () => ({ time: new Date().toLocaleString(), recordedAt: new Date(Date.now() - 20 * 24 * 3600 * 1000).toISOString() });
// the IKS shape: a split that lost its T1 leg, the row still saying 5, the broker holding 3, no live stop
const lostSplitRow = (id, sym, secId, over) => ({ id, broker: 'dhan', symbol: sym, action: 'BUY', qty: 5, mtmRemainingQty: 5, splitLegAQty: 2, splitLegBQty: 3, splitT1: false, mtmT1Done: false,
  entryPrice: 1720, price: 1720, slPrice: 1720, slPriceOriginal: 1625, brokerSlPrice: 1720, targetPrice: 1823, runnerNoTarget: true, securityId: secId, exchange: 'NSE', segment: 'CNC', source: 'auto',
  orderId: 'ENTRY:E' + id + ' | FOREVER:DEAD' + id, dhanEntryOrderId: 'E' + id, dhanForeverId: 'DEAD' + id, dhanProtection: 'forever',
  emaTrailingEnabled: true, trailMode: 'peak', emaTrailingPct: 3, trailStartMode: 'pct', trailStartPct: 6, costPct: 3.5,
  status: 'DHAN ⚠ UNPROTECTED — no live stop, add a manual stop [engine]', engineState: 'UNPROTECTED', engineGraceAt: 0, protectionCheckFirstAt: '',
  liveLtp: 1850, ...now(), ...(over || {}) });
const foreversFor = (sym) => fake.st.forevers.filter(f => f.legs.some(l => l.tradingSymbol === sym));
const sellsFor = (sym) => fake.st.orders.filter(o => o.tradingSymbol === sym && o.transactionType === 'SELL');

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  hold('TCS', '11536', 5, 3100, 3000);
  anchorId = fake.seedForever('TCS', 3000, 3300, 5);      // a healthy anchor so the read-sanity gate trusts the snapshot
  S = require('../server.js')._internals;
});
after(() => new Promise(res => fake.close(() => res())));

const anchorRow = () => ({ id: 'anchor', broker: 'dhan', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300, securityId: '11536', exchange: 'NSE', segment: 'CNC',
  orderId: 'ENTRY:E9 | FOREVER:' + anchorId, dhanEntryOrderId: 'E9', dhanProtection: 'forever', dhanForeverId: anchorId, status: 'DHAN ENTRY + FOREVER OCO', engineState: 'PROTECTED', liveLtp: 3100, ...now() });

test('INCIDENT: held 3, row 5, stop below the market -> re-armed for 3, the row adopts 3 and says why, the placement is on the row', async () => {
  hold('IKS', '28125', 3, 1850, 1720);
  S.writeOrderLog([anchorRow(), lostSplitRow('iks', 'IKS', '28125')]);
  S.runEngineCutover();
  await until(() => rowOf('iks') && rowOf('iks').dhanForeverId !== 'DEADiks');
  const r = rowOf('iks');
  const fv = foreversFor('IKS');
  assert.equal(fv.length, 1, 'one Forever placed: ' + JSON.stringify(fv.map(f => f.legs)));
  const leg = fv[0].legs[0];
  assert.equal(leg.legName, 'STOP_LOSS_LEG', 'a stop, not a target: ' + JSON.stringify(leg));
  assert.equal(leg.orderStatus, 'PENDING', 'and it STANDS - it did not fire on arrival');
  assert.equal(Number(leg.quantity), 3, 'sized to what is HELD, never the row\'s 5');
  assert.equal(Number(leg.triggerPrice), 1720);
  assert.equal(sellsFor('IKS').length, 0, 'no child sell, no rejection');
  assert.equal(r.qty, 3, 'the row adopted the held quantity');
  assert.equal(r.mtmRemainingQty, 3);
  assert.deepEqual([r.qtyAdopted.from, r.qtyAdopted.to, r.qtyAdopted.by], [5, 3, 'rearm']);
  assert.match(String(r.reconcileNote || ''), /holds 3 but this position was tracked as 5/);
  assert.equal(r.dhanForeverId, String(fv[0].orderId));
  const p = (r.protectionPlacements || []).slice(-1)[0];
  assert.ok(p, 'the placement is recorded on the row');
  assert.equal(p.trigger, 1720); assert.equal(p.qty, 3); assert.equal(p.ok, true); assert.equal(p.id, String(fv[0].orderId)); assert.equal(p.ltp, 1850);
});

test('a TRAILED level above the market is a BREACHED stop: no trigger placed, the held 3 exited at market', async () => {
  hold('WIPRO', '3787', 3, 1850, 1720);
  S.writeOrderLog([anchorRow(), lostSplitRow('wip', 'WIPRO', '3787', { lastTrailSlPrice: 1855 })]);   // the peak trail parked the stop above today's price
  // rule needs the breach seen on two passes
  S.runEngineCutover(); await wait(1500);
  S.runEngineCutover();
  await until(() => sellsFor('WIPRO').length > 0 || foreversFor('WIPRO').length > 0);
  assert.equal(foreversFor('WIPRO').length, 0, 'NO SELL trigger at/above the market was ever placed: ' + JSON.stringify(foreversFor('WIPRO').map(f => f.legs)));
  const sells = sellsFor('WIPRO');
  assert.equal(sells.length, 1, 'one market exit: ' + JSON.stringify(sells));
  assert.equal(Number(sells[0].quantity), 3, 'for the HELD 3, not the row\'s 5');
  assert.equal(sells[0].orderStatus, 'TRADED', 'and it filled - nothing to reject');
  const r = rowOf('wip');
  assert.equal(r.qty, 3, 'the row adopted 3 first');
  assert.match(String(r.status), /BREACHED, MARKET EXIT PLACED/);
});

test('the restore itself refuses a trigger at/above the market, whoever calls it', async () => {
  hold('RELIANCE', '2885', 3, 1850, 1720);
  const before = fake.sent('POST', '/v2/forever/orders').length;
  const err = await new Promise(r => S.restoreBrokerStop({ id: 'rel', broker: 'dhan', symbol: 'RELIANCE', qty: 3, slPrice: 1855, liveLtp: 1850, securityId: '2885', exchange: 'NSE', segment: 'CNC', emaTrailingEnabled: true }, (e) => r(e)));
  assert.ok(err, 'refused');
  assert.match(String(err), /at\/above the market/);
  assert.match(String(err), /fires on arrival/);
  assert.equal(fake.sent('POST', '/v2/forever/orders').length, before, 'nothing was sent');
});
