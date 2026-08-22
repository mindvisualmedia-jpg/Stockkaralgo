'use strict';
// test/executor.runner.test.js — "let the runner run" (T1 partial + T2 blank):
// legA is a normal OCO (T1 + SL) and legB is an SL-ONLY leg with no target that
// the engine cost-moves / T1-locks / trails until it is stopped out.
//   1. Dhan, end to end through the REAL entry + ENGINE_ENTRIES protection path:
//      MARKET entry fills at the fake -> PLACE_PROTECTION -> legA OCO(5 @ T1) +
//      legB SINGLE(5, no target), row flagged runnerNoTarget
//   2. the runner's stop MODIFY restates the SL-only shape on every broker:
//      Dhan SINGLE, Kite type 'single', FYERS leg1-only, Angel rule without a
//      stop-loss sub-leg (no target leg is ever invented)
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeDhan } = require('./fake-dhan');
const { createFakeKite, createFakeFyers, createFakeAngel } = require('./fake-brokers');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-runner-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({ clientId: 'FAKECLIENT', token: 'fake-token', savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'broker_tokens.json'), JSON.stringify({ brokers: {
  zerodha: { clientId: 'kiteapikey', clientSecret: 's', accessToken: 'kite-token', updatedAt: new Date().toISOString() },
  fyers: { clientId: 'FYAPP-100', clientSecret: 's', accessToken: 'fyers-token', updatedAt: new Date().toISOString() },
  angelone: { clientId: 'angelapikey', accountId: 'A12345', accessToken: 'angel-token', updatedAt: new Date().toISOString() },
} }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'active_broker.json'), JSON.stringify({ broker: 'dhan', setAt: new Date().toISOString() }));
Object.assign(process.env, {
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1', STOCKKAR_ENGINE_ENTRIES: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http',
  STOCKKAR_KITE_API_HOST: '127.0.0.1', STOCKKAR_KITE_API_PROTO: 'http',
  STOCKKAR_FYERS_API_HOST: '127.0.0.1', STOCKKAR_FYERS_API_PROTO: 'http',
  STOCKKAR_ANGEL_API_HOST: '127.0.0.1', STOCKKAR_ANGEL_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1', STOCKKAR_FYERS_LIVE: '1',
});

const dhan = createFakeDhan({ securities: { '1594': 'INFY', '11536': 'TCS' }, marketPrice: 100 });
const kite = createFakeKite({ marketPrice: 100 });
const fyers = createFakeFyers({ marketPrice: 100 });
const angel = createFakeAngel({ marketPrice: 100 });
let S, anchorId;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const rows = () => S.readOrderLog();
const rowOf = (id) => rows().find(r => r.id === id);
async function enginePass() { S.runEngineCutover(); await wait(900); }
const now = () => ({ time: new Date().toLocaleString(), recordedAt: new Date().toISOString() });

before(async () => {
  await new Promise(res => dhan.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  await new Promise(res => kite.listen(port => { process.env.STOCKKAR_KITE_API_PORT = String(port); res(); }));
  await new Promise(res => fyers.listen(port => { process.env.STOCKKAR_FYERS_API_PORT = String(port); res(); }));
  await new Promise(res => angel.listen(port => { process.env.STOCKKAR_ANGEL_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  S.seedDhanSecurityMap({ 'NSE:INFY': '1594', INFY: '1594', 'NSE:TCS': '11536', TCS: '11536' });
  S.seedAngelInstrumentMap({ 'NSE:WIPRO': { tradingSymbol: 'WIPRO-EQ', token: '3787', exchange: 'NSE' }, WIPRO: { tradingSymbol: 'WIPRO-EQ', token: '3787', exchange: 'NSE' } });
  dhan.holdSymbol('TCS', 5);
  anchorId = dhan.seedForever('TCS', 3000, 3300, 5);
  S.writeOrderLog([{ id: 'anchor', broker: 'dhan', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100,
    slPrice: 3000, targetPrice: 3300, securityId: '11536', exchange: 'NSE', segment: 'CNC',
    orderId: 'ENTRY:E9 | FOREVER:' + anchorId, dhanEntryOrderId: 'E9', dhanProtection: 'forever', dhanForeverId: anchorId,
    status: 'DHAN ENTRY + FOREVER OCO', ...now() }]);
});
after(async () => { for (const f of [dhan, kite, fyers, angel]) await new Promise(r => f.close(r)); });

test('Dhan: T1 50% + T2 blank -> legA OCO at T1, legB SINGLE with NO target, row flagged runnerNoTarget', async () => {
  // REAL entry path: MARKET fills instantly at the fake; ENGINE_ENTRIES places
  // the protection on the next pass from the recorded pendingProtection.
  const res = await new Promise((resolve, reject) => S.placeBrokerSuperOrder({ broker: 'dhan', credentials: {}, order: {
    symbol: 'INFY', action: 'BUY', exchange: 'NSE', segment: 'CNC', qty: 10,
    entryPrice: 100, slPrice: 95, targetPrice: 105, entryOrderType: 'market', exitOrderType: 'limit', slMethod: 'pct',
    t1Pct: 5, t1Qty: 50, t2Pct: 0,
  } }, (err, r) => err ? reject(new Error(err)) : resolve(r)));
  const fields = S.extractPlacedOrderLogFields('dhan', res);
  S.mutateOrderLog(all => [...all, { id: 'run1', broker: 'dhan', symbol: 'INFY', action: 'BUY', qty: 10, price: 100, entryPrice: 100,
    slPrice: 95, targetPrice: 105, t1Pct: 5, t1Qty: 50, t2Pct: 0, securityId: '1594', exchange: 'NSE', segment: 'CNC', source: 'auto',
    orderId: S.extractPlacedOrderId('dhan', res), status: 'DHAN ENTRY PLACED (awaiting fill)', ...now(), ...fields }]);
  dhan.holdSymbol('INFY', 10);
  await enginePass();
  const placed = dhan.sent('POST', '/v2/forever/orders');
  assert.equal(placed.length, 2, 'two protective Forevers: booked half + runner');
  const oco = placed.find(p => p.body.orderFlag === 'OCO'), single = placed.find(p => p.body.orderFlag === 'SINGLE');
  assert.ok(oco && single, 'one OCO (legA) and one SINGLE (legB)');
  assert.equal(oco.body.quantity, 5, 'legA = 50% of 10');
  assert.equal(single.body.quantity, 5, 'runner = the other 50%');
  assert.equal(single.body.triggerPrice, 95, 'runner carries the same stop');
  assert.ok(!('price1' in single.body) && !('triggerPrice1' in single.body), 'runner has NO target leg');
  const r = rowOf('run1');
  assert.equal(r.splitT1, true);
  assert.equal(r.runnerNoTarget, true, 'the row knows its runner has no target');
  assert.ok(r.dhanForeverId && r.dhanForeverT1Id, 'both leg ids recorded');
});

// The runner's stop restates the SL-ONLY shape on every broker (a two-leg /
// OCO restate would invent a target leg on a leg that has none).
const runnerRow = (broker, extra) => ({ id: 'mod-' + broker, broker, symbol: broker === 'angelone' ? 'WIPRO' : 'INFY', action: 'BUY', qty: 10, entryPrice: 100, price: 100,
  slPrice: 95, targetPrice: 105, t1Pct: 5, t1Qty: 50, t2Pct: 0, exchange: 'NSE', segment: 'CNC',
  splitT1: true, runnerNoTarget: true, mtmT1Done: true, splitLegAQty: 5, splitLegBQty: 5, ...now(), ...extra });

test('Dhan runner modify: SINGLE shape (no TARGET_LEG touched)', async () => {
  const legB = dhan.seedForever('INFY', 95, 0, 5);
  const row = runnerRow('dhan', { securityId: '1594', dhanProtection: 'forever-split', dhanForeverId: legB, dhanForeverT1Id: 'FA1', orderId: 'ENTRY:E1 | FOREVER-T1:FA1 | FOREVER:' + legB });
  const before1 = dhan.sent('PUT', '/v2/forever/orders/').length;
  await new Promise(res => S.engineModifySl(row, 102, () => res()));
  const m = dhan.sent('PUT', '/v2/forever/orders/').slice(before1);
  assert.equal(m.length, 1, 'only the runner (T1 booked -> legA is terminal)');
  assert.equal(m[0].body.orderFlag, 'SINGLE', 'SL-only shape - never OCO');
  assert.equal(m[0].body.triggerPrice, 102);
  assert.equal(m[0].body.quantity, 5);
});

test('Zerodha runner modify: type single, one trigger value, one SL order', async () => {
  kite.holdSymbol('INFY', 10, 100);
  const legB = kite.seedGtt('INFY', 95, 0, 5);
  const row = runnerRow('zerodha', { zerodhaGttId: legB, zerodhaGttT1Id: 'GA1', orderId: 'ENTRY:ZE1 | GTT-T1:GA1 | GTT:' + legB, liveLtp: 101 });
  const before1 = kite.sent('PUT', '/gtt/triggers/').length;
  await new Promise(res => S.engineModifySl(row, 102, () => res()));
  const m = kite.sent('PUT', '/gtt/triggers/').slice(before1);
  assert.equal(m.length, 1);
  assert.equal(m[0].body.type, 'single', 'SL-only GTT restated as single, never two-leg');
  assert.deepEqual(JSON.parse(m[0].body.condition).trigger_values, [102]);
  assert.equal(JSON.parse(m[0].body.orders).length, 1, 'one SELL stop order, no target order');
});

test('FYERS runner modify: leg1 is the stop, no leg2', async () => {
  fyers.holdSymbol('INFY', 10, 100);
  const legB = fyers.seedGtt('INFY', 95, 0, 5);
  const row = runnerRow('fyers', { fyersGttId: legB, fyersGttT1Id: 'FG1', fyersSplit: true, orderId: 'ENTRY:FE1 | GTT-T1:FG1 | GTT:' + legB });
  const before1 = fyers.sent('PATCH', '/api/v3/gtt/orders/sync').length;
  await new Promise(res => S.engineModifySl(row, 102, () => res()));
  const m = fyers.sent('PATCH', '/api/v3/gtt/orders/sync').slice(before1);
  assert.equal(m.length, 1);
  assert.equal(m[0].body.orderInfo.leg1.triggerPrice, 102, 'single-leg GTT: leg1 IS the stop');
  assert.ok(!m[0].body.orderInfo.leg2, 'no leg2 - there is no target leg to restate');
});

test('Angel runner modify: plain SL rule, no stop-loss sub-leg (no OCO target invented)', async () => {
  angel.holdSymbol('WIPRO', 10, 100);
  const legB = angel.seedRule('WIPRO', '3787', 95, 0, 5);
  const row = runnerRow('angelone', { angelOneSlRuleId: legB, angelOneGttT1Id: 'AR1', angelOneOco: true, angelSplit: true, orderId: 'ENTRY:AE1 | SLGTT:' + legB });
  const before1 = angel.sent('POST', '/rest/secure/angelbroking/gtt/v1/modifyRule').length;
  await new Promise(res => S.engineModifySl(row, 102, () => res()));
  const m = angel.sent('POST', '/rest/secure/angelbroking/gtt/v1/modifyRule').slice(before1);
  assert.equal(m.length, 1, 'the runner rule was modified (not refused as "no target")');
  const body = JSON.stringify(m[0].body).toLowerCase();
  assert.ok(body.includes('102'), 'new stop trigger sent');
  assert.ok(!body.includes('stoploss'), 'SL-only rule: no stoploss sub-leg fields - that shape would be an OCO');
});
