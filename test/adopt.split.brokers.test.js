'use strict';
// test/adopt.split.brokers.test.js — T1/T2 on adoption for the other three
// brokers (owner, 2026-09-22: "Port T1/T2 adoption to Zerodha, FYERS and
// Angel too").
//
// 3.28.6 gave an adopted position the signal's split bracket on Dhan only;
// everywhere else a recovered position got ONE target, so the T1 book the
// customer configured simply did not exist. Against the real engine pass and
// each broker's fake, per broker:
//   1. a filled-but-"failed" entry is adopted WITH the split - two brackets at
//      the broker, sized and priced from the broker's average cost
//   2. a row already adopted with one target is converted once: place first,
//      cancel after, the lifted stop kept, and it never repeats
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeKite, createFakeFyers, createFakeAngel } = require('./fake-brokers');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-adoptsplit-brokers-'));
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

const kite = createFakeKite({ marketPrice: 105 });
const fyers = createFakeFyers({ marketPrice: 105 });
const angel = createFakeAngel({ marketPrice: 105 });
let S, anchors;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 20000)) { if (fn()) return true; await wait(200); } return false; };
const now = () => ({ time: new Date().toLocaleString(), recordedAt: new Date().toISOString() });
const rowOf = (id) => S.readOrderLog().find(r => r.id === id);
const adoptedRow = (sym) => S.readOrderLog().find(r => r.adopted && new RegExp(sym).test(String(r.symbol)));

// the signal every failed row carries: T1 +30% on half, T2 +60% on the rest
const failedRow = (id, broker, sym, qty) => ({ id, broker, symbol: sym, action: 'BUY', qty, price: 100, entryPrice: 100, slPrice: 95, targetPrice: 160,
  exchange: 'NSE', segment: 'CNC', source: 'auto', orderId: 'N/A', screenerName: 'momtam', jobId: 'job-x',
  status: broker.toUpperCase() + ' entry order failed: request timed out', rejectionReason: broker.toUpperCase() + ' entry order failed: request timed out',
  t1Pct: 30, t1Qty: 50, t2Pct: 60, targetMode: 'pct', slToT1Pct: 2, costPct: 3,
  time: new Date().toLocaleString(), recordedAt: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() });

before(async () => {
  await new Promise(res => kite.listen(port => { process.env.STOCKKAR_KITE_API_PORT = String(port); res(); }));
  await new Promise(res => fyers.listen(port => { process.env.STOCKKAR_FYERS_API_PORT = String(port); res(); }));
  await new Promise(res => angel.listen(port => { process.env.STOCKKAR_ANGEL_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  S.seedAngelInstrumentMap({
    'NSE:TCS': { tradingSymbol: 'TCS-EQ', token: '11536', exchange: 'NSE' }, TCS: { tradingSymbol: 'TCS-EQ', token: '11536', exchange: 'NSE' },
    'NSE:WIPRO': { tradingSymbol: 'WIPRO-EQ', token: '3787', exchange: 'NSE' }, WIPRO: { tradingSymbol: 'WIPRO-EQ', token: '3787', exchange: 'NSE' },
    'NSE:INFY': { tradingSymbol: 'INFY-EQ', token: '1594', exchange: 'NSE' }, INFY: { tradingSymbol: 'INFY-EQ', token: '1594', exchange: 'NSE' },
  });
  // a healthy anchor on each broker: the pass only runs for a broker that has rows, and the read-sanity gate wants a tracked id visible
  kite.holdSymbol('TCS', 5, 3100); fyers.holdSymbol('TCS', 5, 3100); angel.holdSymbol('TCS', 5, 3100);
  const zk = kite.seedGtt('TCS', 3000, 3300, 5), fk = fyers.seedGtt('TCS', 3000, 3300, 5), ak = angel.seedRule('TCS', '11536', 3000, 3300, 5);
  anchors = () => [
    { id: 'az', broker: 'zerodha', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300, exchange: 'NSE', segment: 'CNC',
      orderId: 'ENTRY:ZE9 | GTT:' + zk, zerodhaEntryOrderId: 'ZE9', zerodhaGttId: zk, status: 'ZERODHA ENTRY + GTT OCO', engineState: 'PROTECTED', liveLtp: 3100, ...now() },
    { id: 'af', broker: 'fyers', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300, exchange: 'NSE', segment: 'CNC',
      orderId: 'ENTRY:FE9 | GTT:' + fk, fyersEntryOrderId: 'FE9', fyersGttId: fk, status: 'FYERS ENTRY + GTT OCO', engineState: 'PROTECTED', liveLtp: 3100, ...now() },
    { id: 'aa', broker: 'angelone', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300, exchange: 'NSE', segment: 'CNC',
      orderId: 'ENTRY:AE9 | SLGTT:' + ak, angelOneEntryOrderId: 'AE9', angelOneSlRuleId: ak, angelOneOco: true, status: 'ANGEL ENTRY + GTT OCO', engineState: 'PROTECTED', liveLtp: 3100, ...now() },
  ];
});
after(async () => { await new Promise(r => kite.close(r)); await new Promise(r => fyers.close(r)); await new Promise(r => angel.close(r)); });

// {target, sl, qty} for every bracket standing at the broker for this symbol
const legsZ = (sym) => kite.data.gtts.filter(g => g.condition.tradingsymbol === sym && g.status === 'active')
  .map(g => ({ target: Number(g.condition.trigger_values[1] || 0), sl: Number(g.condition.trigger_values[0]), qty: Number(g.orders[0].quantity) }));
const legsF = (sym) => fyers.data.gtts.filter(g => g.symbol === 'NSE:' + sym + '-EQ')
  .map(g => ({ target: Number(g.price_trigger), sl: Number(g.price2_trigger), qty: Number(g.qty) }));
const legsA = (sym) => angel.data.rules.filter(r => r.tradingsymbol === sym + '-EQ' && r.status !== 'CANCELLED')
  .map(r => ({ target: Number(r.triggerprice), sl: Number(r.stoplosstriggerprice), qty: Number(r.qty) }));

const CASES = [
  { broker: 'zerodha', label: 'Zerodha', sym: 'WIPRO', conv: 'INFY', legs: legsZ, t1: 'zerodhaGttT1Id', run: 'zerodhaGttId', splitFlag: 'zerodhaSplit',
    hold: (s, q, l) => kite.holdSymbol(s, q, l), seedOld: (s) => kite.seedGtt(s, 120, 160, 10), oldField: 'zerodhaGttId',
    status: /2x GTT OCO \(T1\/T2 split\)/, orderId: /^GTT-T1:\S+ \| GTT:\S+$/ },
  { broker: 'fyers', label: 'FYERS', sym: 'WIPRO', conv: 'INFY', legs: legsF, t1: 'fyersGttT1Id', run: 'fyersGttId', splitFlag: 'fyersSplit',
    hold: (s, q, l) => fyers.holdSymbol(s, q, l), seedOld: (s) => fyers.seedGtt(s, 120, 160, 10), oldField: 'fyersGttId',
    status: /2x GTT OCO \(T1\/T2 split\)/, orderId: /^GTT-T1:\S+ \| GTT:\S+$/ },
  { broker: 'angelone', label: 'Angel One', sym: 'WIPRO', conv: 'INFY', legs: legsA, t1: 'angelOneGttT1Id', run: 'angelOneSlRuleId', splitFlag: 'angelSplit',
    hold: (s, q, l) => angel.holdSymbol(s, q, l), seedOld: (s) => angel.seedRule(s, '1594', 120, 160, 10), oldField: 'angelOneSlRuleId',
    status: /2x GTT OCO \(T1\/T2 split\)/, orderId: /^SLGTT:\S+$/ },
];

CASES.forEach(c => {
  test(c.label + ': a recovered position is adopted WITH the signal\'s T1/T2 - two brackets from the broker\'s cost', async () => {
    c.hold(c.sym, 10, 105);                                   // broker avg 100, trading 105
    S.writeOrderLog([...anchors(), failedRow('f-' + c.broker, c.broker, c.sym, 10)]);
    S.runEngineCutover();
    await until(() => { const r = adoptedRow(c.sym); return r && r.splitT1; });
    const row = adoptedRow(c.sym);
    assert.ok(row, 'adopted: ' + JSON.stringify(S.readOrderLog().map(r => [r.id, r.broker, r.status])));
    assert.equal(row.broker, c.broker);
    assert.equal(row.splitT1, true, JSON.stringify(row).slice(0, 400));
    assert.equal(row[c.splitFlag], true, 'the broker-specific split flag the engine reads');
    assert.equal(row.t1Pct, 30); assert.equal(row.t1Qty, 50); assert.equal(row.t2Pct, 60); assert.equal(row.slToT1Pct, 2);
    assert.equal(row.splitLegAQty, 5); assert.equal(row.splitLegBQty, 5);
    assert.ok(row[c.t1] && row[c.run] && row[c.t1] !== row[c.run], 'both leg ids on the row: ' + JSON.stringify([row[c.t1], row[c.run]]));
    assert.match(String(row.orderId), c.orderId);
    assert.match(String(row.status), c.status);
    assert.equal(row.targetPrice, 160, 'T2 = +60% of the broker\'s 100');
    const legs = c.legs(c.sym).sort((a, b) => a.target - b.target);
    assert.equal(legs.length, 2, 'two brackets at the broker: ' + JSON.stringify(c.legs(c.sym)));
    assert.deepEqual(legs.map(l => l.target), [130, 160], 'T1 +30% and T2 +60%');
    assert.deepEqual(legs.map(l => l.qty), [5, 5]);
    legs.forEach(l => assert.equal(l.sl, 95, 'both legs carry the stop'));
  });

  test(c.label + ': a row already adopted with ONE target is converted, keeping the lifted stop, and never repeats', async () => {
    c.hold(c.conv, 10, 125);
    const oldId = c.seedOld(c.conv);            // the single bracket 3.28.4 placed; its stop has since been lifted to 120
    S.writeOrderLog([...anchors(),
      { ...failedRow('f2-' + c.broker, c.broker, c.conv, 10), mergedInto: 'adopt-' + c.broker },
      { id: 'adopt-' + c.broker, broker: c.broker, symbol: 'NSE:' + c.conv, action: 'BUY', qty: 10, entryPrice: 100, price: 100,
        slPrice: 120, slPriceOriginal: 95, brokerSlPrice: 120, targetPrice: 160, exchange: 'NSE', segment: 'CNC', source: 'auto',
        adopted: true, autoAdopted: true, adoptedFromRows: ['f2-' + c.broker], [c.oldField]: oldId,
        orderId: (c.broker === 'angelone' ? 'SLGTT:' : 'GTT:') + oldId, ...(c.broker === 'angelone' ? { angelOneOco: true } : {}),
        status: c.label.toUpperCase() + ' ENTRY + OCO (adopted holding)', t1Pct: 0, t1Qty: 0, t2Pct: 0, mtmRemainingQty: 10, liveLtp: 125, ...now() }]);
    S.runEngineCutover();
    await until(() => (rowOf('adopt-' + c.broker) || {}).adoptSplitChecked);
    const row = rowOf('adopt-' + c.broker);
    assert.equal(row.splitT1, true, 'converted: ' + JSON.stringify({ st: row.status, note: row.reconcileNote }));
    assert.equal(row.t1Pct, 30); assert.equal(row.t2Pct, 60);
    assert.equal(row.slPrice, 120, 'the lifted stop is untouched on the row');
    assert.match(String(row.status), c.status);
    const legs = c.legs(c.conv).sort((a, b) => a.target - b.target);
    assert.equal(legs.length, 2, 'exactly the two new legs stand: ' + JSON.stringify(c.legs(c.conv)));
    assert.deepEqual(legs.map(l => l.target), [130, 160]);
    legs.forEach(l => assert.equal(l.sl, 120, 'placed at the CURRENT stop, never the original 95'));
    assert.deepEqual(legs.map(l => l.qty), [5, 5]);
    // and it never repeats
    S.runEngineCutover(); await wait(1200);
    assert.equal(c.legs(c.conv).length, 2, 'still two');
  });
});
