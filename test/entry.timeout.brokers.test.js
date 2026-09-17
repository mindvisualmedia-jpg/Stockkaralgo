'use strict';
// test/entry.timeout.brokers.test.js — the ROSSTECH lesson, ported (owner,
// 2026-09-17: "port the same fix to Zerodha, FYERS and Angel").
//
// Every entry carries a tag the broker hands back on its order book - Kite
// `tag`, FYERS `orderTag`, Angel `ordertag` (the fields brokers/*.js already
// read). A lost reply is therefore answerable: the same wrapper pattern as
// Dhan, one per broker, each synthesising that broker's own success shape so
// nothing downstream changes. Against the REAL placeBrokerSuperOrder and the
// fake brokers, each made to accept an order and never answer:
//   - Zerodha, FYERS, Angel One: found by tag -> reported PLACED, one order at
//     the broker, the recovered flag on the row result, the symbol held back
//   - and one never-reached case (Kite): NOT placed, said plainly, held back
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeKite, createFakeFyers, createFakeAngel } = require('./fake-brokers');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-timeout-brokers-'));
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
  STOCKKAR_BROKER_HTTP_TIMEOUT_MS: '1500',        // the socket gives up fast (all three transports honour it)
  STOCKKAR_DHAN_ENTRY_RECOVER_GAP_MS: '150',     // the order book is re-read quickly
  STOCKKAR_ENTRY_TIMEOUT_HOLD_MS: '4000',
});

const kite = createFakeKite({ marketPrice: 93.5 });
const fyers = createFakeFyers({ marketPrice: 93.5 });
const angel = createFakeAngel({ marketPrice: 93.5 });
let S;
const setActive = (b) => fs.writeFileSync(path.join(dataDir, 'active_broker.json'), JSON.stringify({ broker: b, setAt: new Date().toISOString() }));
const order = (sym) => ({ symbol: sym, action: 'BUY', qty: 7, entryPrice: 93.5, slPrice: 90, targetPrice: 110, exchange: 'NSE', segment: 'CNC',
  entryOrderType: 'market', exitOrderType: 'market', slMethod: 'pct' });
const place = (broker, o) => new Promise(r => S.placeBrokerSuperOrder({ broker, credentials: {}, order: o }, (err, res) => r({ err, res })));
const recovered = (res) => !!(res && (res.recoveredAfterTimeout || (res.data && res.data.entry && res.data.entry.recoveredAfterTimeout)));

before(async () => {
  await new Promise(res => kite.listen(port => { process.env.STOCKKAR_KITE_API_PORT = String(port); res(); }));
  await new Promise(res => fyers.listen(port => { process.env.STOCKKAR_FYERS_API_PORT = String(port); res(); }));
  await new Promise(res => angel.listen(port => { process.env.STOCKKAR_ANGEL_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  assert.equal(S.KITE_API.hostname, '127.0.0.1');
  assert.equal(S.FYERS_API_EP.hostname, '127.0.0.1');
  assert.equal(S.ANGEL_API.hostname, '127.0.0.1');
  S.seedAngelInstrumentMap({
    'NSE:INFY': { tradingSymbol: 'INFY-EQ', token: '1594', exchange: 'NSE' }, INFY: { tradingSymbol: 'INFY-EQ', token: '1594', exchange: 'NSE' },
    'NSE:WIPRO': { tradingSymbol: 'WIPRO-EQ', token: '3787', exchange: 'NSE' }, WIPRO: { tradingSymbol: 'WIPRO-EQ', token: '3787', exchange: 'NSE' },
  });
});
after(async () => { await new Promise(r => kite.close(r)); await new Promise(r => fyers.close(r)); await new Promise(r => angel.close(r)); });

test('ZERODHA: Kite accepts the entry and never answers -> found by its tag, reported PLACED, one order, held back', async () => {
  setActive('zerodha');
  kite.st.hangNext = { path: '/orders/regular', record: true, holdMs: 3000 };
  const { err, res } = await place('zerodha', order('INFY'));
  assert.ifError(err);
  assert.equal(recovered(res), true, JSON.stringify(res).slice(0, 300));
  const buys = kite.data.orders.filter(o => o.tradingsymbol === 'INFY' && o.transaction_type === 'BUY');
  assert.equal(buys.length, 1, 'exactly ONE buy at the broker');
  assert.equal(buys[0].tag, res.orderTag, 'identified by the tag');
  assert.ok(JSON.stringify(res).includes(String(buys[0].order_id)), 'the broker\'s own order id is on the result');
  const again = await place('zerodha', order('INFY'));
  assert.ok(again.err && /held back|timed out/i.test(String(again.err)), 'the next scan is refused: ' + again.err);
  assert.equal(kite.data.orders.filter(o => o.tradingsymbol === 'INFY' && o.transaction_type === 'BUY').length, 1, 'still one');
});

test('ZERODHA: a timeout where the order never reached Kite -> NOT placed, said plainly, held back', async () => {
  setActive('zerodha');
  kite.st.hangNext = { path: '/orders/regular', record: false, holdMs: 3000 };
  const { err } = await place('zerodha', order('WIPRO'));
  assert.ok(err, 'reported as a failure');
  assert.match(String(err), /timed out/i);
  assert.match(String(err), /NOT placed/, err);
  assert.equal(kite.data.orders.filter(o => o.tradingsymbol === 'WIPRO').length, 0);
  const again = await place('zerodha', order('WIPRO'));
  assert.ok(again.err && /held back/i.test(String(again.err)), again.err);
});

test('FYERS: accepts the entry and never answers -> found by orderTag, reported PLACED, one order, held back', async () => {
  setActive('fyers');
  fyers.st.hangNext = { path: '/orders/sync', record: true, holdMs: 3000 };
  const { err, res } = await place('fyers', order('INFY'));
  assert.ifError(err);
  assert.equal(recovered(res), true, JSON.stringify(res).slice(0, 300));
  const buys = fyers.data.orders.filter(o => o.symbol === 'NSE:INFY-EQ' && Number(o.side) === 1);
  assert.equal(buys.length, 1, 'exactly ONE buy at the broker');
  assert.equal(buys[0].orderTag, res.orderTag, 'identified by the tag');
  assert.ok(JSON.stringify(res).includes(String(buys[0].id)), 'the broker\'s own order id is on the result');
  const again = await place('fyers', order('INFY'));
  assert.ok(again.err && /held back|timed out/i.test(String(again.err)), again.err);
  assert.equal(fyers.data.orders.filter(o => o.symbol === 'NSE:INFY-EQ' && Number(o.side) === 1).length, 1, 'still one');
});

test('ANGEL ONE: accepts the entry and never answers -> found by ordertag, reported PLACED, one order, held back', async () => {
  setActive('angelone');
  angel.st.hangNext = { path: 'placeOrder', record: true, holdMs: 3000 };
  const { err, res } = await place('angelone', order('INFY'));
  assert.ifError(err);
  assert.equal(recovered(res), true, JSON.stringify(res).slice(0, 300));
  const buys = angel.data.orders.filter(o => o.tradingsymbol === 'INFY-EQ' && /BUY/i.test(o.transactiontype));
  assert.equal(buys.length, 1, 'exactly ONE buy at the broker');
  assert.equal(buys[0].ordertag, res.orderTag, 'identified by the tag');
  assert.ok(JSON.stringify(res).includes(String(buys[0].orderid)), 'the broker\'s own order id is on the result');
  const again = await place('angelone', order('INFY'));
  assert.ok(again.err && /held back|timed out/i.test(String(again.err)), again.err);
  assert.equal(angel.data.orders.filter(o => o.tradingsymbol === 'INFY-EQ' && /BUY/i.test(o.transactiontype)).length, 1, 'still one');
});
