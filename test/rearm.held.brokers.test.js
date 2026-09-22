'use strict';
// test/rearm.held.brokers.test.js — the IKS backstop on the other three brokers
// (owner, 2026-09-22: "Yes port it to Zerodha, FYERS and Angel too").
//
// On Dhan a SELL trigger at/above the live price is labelled a TARGET leg and
// fires on arrival; its child is then refused for over-selling. Zerodha, FYERS
// and Angel One have no such refusal to save us - a trigger above the market
// simply SELLS the position. So every restore refuses it, and every restore
// records what it placed (trigger, target, quantity, the broker's answer) on
// the row, so an audit never has to infer it from a rejected child again.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeKite, createFakeFyers, createFakeAngel } = require('./fake-brokers');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-rearm-brokers-'));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'broker_tokens.json'), JSON.stringify({ brokers: {
  zerodha: { clientId: 'kiteapikey', clientSecret: 's', accessToken: 'kite-token', updatedAt: new Date().toISOString() },
  fyers: { clientId: 'FYAPP-100', clientSecret: 's', accessToken: 'fyers-token', updatedAt: new Date().toISOString() },
  angelone: { clientId: 'angelapikey', accountId: 'A12345', accessToken: 'angel-token', updatedAt: new Date().toISOString() },
} }));
Object.assign(process.env, {
  STOCKKAR_LICENCE_ENFORCE: '0',
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_KITE_API_HOST: '127.0.0.1', STOCKKAR_KITE_API_PROTO: 'http',
  STOCKKAR_FYERS_API_HOST: '127.0.0.1', STOCKKAR_FYERS_API_PROTO: 'http',
  STOCKKAR_ANGEL_API_HOST: '127.0.0.1', STOCKKAR_ANGEL_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1', STOCKKAR_FYERS_LIVE: '1',
});

const kite = createFakeKite({ marketPrice: 1850 });
const fyers = createFakeFyers({ marketPrice: 1850 });
const angel = createFakeAngel({ marketPrice: 1850 });
let S;
// the IKS shape on each broker: held 3, a stop the trail parked ABOVE today's price
const row = (id, broker, over) => ({ id, broker, symbol: 'IKS', action: 'BUY', qty: 3, mtmRemainingQty: 3,
  entryPrice: 1720, price: 1720, slPrice: 1720, slPriceOriginal: 1625, brokerSlPrice: 1720, targetPrice: 1823,
  exchange: 'NSE', segment: 'CNC', source: 'auto', liveLtp: 1850, emaTrailingEnabled: true, trailMode: 'peak',
  time: new Date().toLocaleString(), recordedAt: new Date().toISOString(), ...(over || {}) });
const restore = (r) => new Promise(res => S.restoreBrokerStop(r, (err, patch) => res({ err, patch }), { liveIds: new Set() }));
const rowOf = (id) => S.readOrderLog().find(x => x.id === id);
const lastPlacement = (id) => ((rowOf(id) || {}).protectionPlacements || []).slice(-1)[0];

before(async () => {
  await new Promise(res => kite.listen(port => { process.env.STOCKKAR_KITE_API_PORT = String(port); res(); }));
  await new Promise(res => fyers.listen(port => { process.env.STOCKKAR_FYERS_API_PORT = String(port); res(); }));
  await new Promise(res => angel.listen(port => { process.env.STOCKKAR_ANGEL_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  S.seedAngelInstrumentMap({
    'NSE:IKS': { tradingSymbol: 'IKS-EQ', token: '28125', exchange: 'NSE' }, IKS: { tradingSymbol: 'IKS-EQ', token: '28125', exchange: 'NSE' },
  });
});
after(async () => { await new Promise(r => kite.close(r)); await new Promise(r => fyers.close(r)); await new Promise(r => angel.close(r)); });

const CASES = [
  { broker: 'zerodha', label: 'Zerodha', method: 'POST', path: '/gtt/triggers', fake: () => kite, over: { zerodhaGttId: 'ZOLD', orderId: 'ENTRY:ZE1 | GTT:ZOLD' } },
  { broker: 'fyers', label: 'FYERS', method: 'POST', path: '/api/v3/gtt/orders/sync', fake: () => fyers, over: { fyersGttId: 'FOLD', orderId: 'ENTRY:FE1 | GTT:FOLD' } },
  { broker: 'angelone', label: 'Angel One', method: 'POST', path: '/rest/secure/angelbroking/gtt/v1/createRule', fake: () => angel, over: { angelOneSlRuleId: 'AOLD', orderId: 'ENTRY:AE1 | SLGTT:AOLD' } },
];

CASES.forEach(c => {
  test(c.label + ': a stop at/above the market is REFUSED - nothing is sent, and the reason names the broker', async () => {
    const id = 'above-' + c.broker;
    // the trail parked the stop at 1855 while the stock trades 1850
    S.mutateOrderLog(all => [...all, row(id, c.broker, { ...c.over, lastTrailSlPrice: 1855 })]);
    const before = c.fake().sent(c.method, c.path).length;
    const { err } = await restore(rowOf(id));
    assert.ok(err, 'refused');
    assert.match(String(err), /at\/above the market/, err);
    assert.match(String(err), /fires on arrival/, err);
    assert.match(String(err), new RegExp(c.label), 'the reason names the broker: ' + err);
    assert.equal(c.fake().sent(c.method, c.path).length, before, 'nothing was sent to the broker');
    assert.equal((rowOf(id).protectionPlacements || []).length, 0, 'and nothing is recorded as placed');
  });

  test(c.label + ': a stop BELOW the market is placed, and the placement is recorded on the row', async () => {
    const id = 'ok-' + c.broker;
    S.mutateOrderLog(all => [...all, row(id, c.broker, c.over)]);       // stop 1720, market 1850
    const before = c.fake().sent(c.method, c.path).length;
    const { err, patch } = await restore(rowOf(id));
    assert.ifError(err);
    assert.equal(c.fake().sent(c.method, c.path).length, before + 1, 'one placement');
    assert.equal(Number(patch.brokerSlPrice), 1720);
    const p = lastPlacement(id);
    assert.ok(p, 'recorded on the row');
    assert.equal(p.broker, c.broker);
    assert.equal(p.trigger, 1720);
    assert.equal(p.qty, 3, 'the quantity actually sent');
    assert.equal(p.ltp, 1850, 'and the price it was judged against');
    assert.equal(p.ok, true);
    assert.ok(p.id, 'the broker\'s own id: ' + JSON.stringify(p));
  });
});

test('a refused placement is recorded too, with the broker\'s answer', async () => {
  const id = 'fail-zerodha';
  S.mutateOrderLog(all => [...all, row(id, 'zerodha', { zerodhaGttId: 'ZOLD2', orderId: 'ENTRY:ZE2 | GTT:ZOLD2' })]);
  // both attempts: the SL leg is a MARKET leg, and kiteGttSend retries those once as LIMIT
  kite.st.failNext = { method: 'POST', path: '/gtt/triggers', code: 400, message: 'Insufficient funds', times: 2 };
  const { err } = await restore(rowOf(id));
  assert.ok(err, 'the caller hears the failure');
  const p = lastPlacement(id);
  assert.ok(p, 'and the attempt is on the row');
  assert.equal(p.ok, false);
  assert.equal(p.trigger, 1720);
  assert.match(String(p.error), /Insufficient funds/, JSON.stringify(p));
});
