'use strict';
// test/executor.entries.test.js — ENGINE_ENTRIES: the engine owning the NAKED
// WINDOW (entry placed -> fill -> protection) end to end, against fake Dhan.
// This is the evidence gate for the protect-after-fill graduation: the flag
// must not go default-ON until the executor's PLACE_PROTECTION path is pinned
// the same way every other money payload is.
//   1. a resting LIMIT entry places NO protection (a GTT beside a pending
//      entry is the orphan class protect-after-fill exists to prevent)
//   2. the fill arrives -> protection placed at the FILLED qty, not the
//      ordered qty (partial fill: ordered 10, filled 6 -> Forever qty 6)
//   3. a REJECTED entry -> the row dies, no protection is ever placed
//   4. BOOK-LIE (the GNA class): book says rejected, holdings show shares ->
//      protect what is actually held instead of believing the book
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeDhan } = require('./fake-dhan');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-entries-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({ clientId: 'FAKECLIENT', token: 'fake-token', savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'active_broker.json'), JSON.stringify({ broker: 'dhan', setAt: new Date().toISOString() }));
Object.assign(process.env, {
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_ENGINE_ENTRIES: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1',
});

const fake = createFakeDhan({ securities: { '1594': 'INFY', '11536': 'TCS', '3787': 'WIPRO', '4717': 'GAIL' }, marketPrice: 100 });
let S, anchorId;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const rows = () => S.readOrderLog();
const rowOf = (sym) => rows().find(r => r.symbol === sym);
async function enginePass() { S.runEngineCutover(); await wait(900); }
const anchorRow = () => ({ id: 'anchor', broker: 'dhan', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100,
  slPrice: 3000, targetPrice: 3300, securityId: '11536', exchange: 'NSE', segment: 'CNC',
  orderId: 'ENTRY:E9 | FOREVER:' + anchorId, dhanEntryOrderId: 'E9', dhanProtection: 'forever', dhanForeverId: anchorId,
  status: 'DHAN ENTRY + FOREVER OCO', time: new Date().toLocaleString(), recordedAt: new Date().toISOString() });

// The REAL entry path: place through placeBrokerSuperOrder (LIMIT rests at the
// fake), build the row from the same extractors the scan uses.
function placeEntry(sym, secId, qty, cb) {
  S.placeBrokerSuperOrder({ broker: 'dhan', credentials: {}, order: {
    symbol: sym, action: 'BUY', exchange: 'NSE', segment: 'CNC', qty,
    entryPrice: 100, slPrice: 95, targetPrice: 110, entryOrderType: 'limit', exitOrderType: 'limit', slMethod: 'pct',
  } }, (err, res) => {
    assert.ifError(err);
    const fields = S.extractPlacedOrderLogFields('dhan', res);
    S.mutateOrderLog(all => [...all, {
      id: 'row-' + sym, broker: 'dhan', symbol: sym, action: 'BUY', qty, price: 100, entryPrice: 100,
      slPrice: 95, targetPrice: 110, securityId: secId, exchange: 'NSE', segment: 'CNC', source: 'auto',
      orderId: S.extractPlacedOrderId('dhan', res), status: 'DHAN ENTRY PLACED (awaiting fill)',
      time: new Date().toLocaleString(), recordedAt: new Date().toISOString(), ...fields,
    }]);
    cb(res);
  });
}

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  S.seedDhanSecurityMap({ 'NSE:INFY': '1594', INFY: '1594', 'NSE:TCS': '11536', TCS: '11536',
    'NSE:WIPRO': '3787', WIPRO: '3787', 'NSE:GAIL': '4717', GAIL: '4717' });
  fake.holdSymbol('TCS', 5);
  anchorId = fake.seedForever('TCS', 3000, 3300, 5);
  S.writeOrderLog([anchorRow()]);
});
after(() => new Promise(res => fake.close(() => res())));

test('a resting LIMIT entry places NO protection - and the fill then protects the FILLED qty, not the ordered qty', async () => {
  await new Promise(res => placeEntry('INFY', '1594', 10, () => res()));
  const r0 = rowOf('INFY');
  assert.equal(r0.awaitingFill, true, 'entry is resting: the row waits');
  assert.ok(r0.pendingProtection, 'protection context recorded for the fill moment');

  await enginePass();
  assert.equal(fake.sent('POST', '/v2/forever/orders').length, 0, 'no fill yet -> no protection (the orphan class)');
  assert.equal(rowOf('INFY').awaitingFill, true);

  // PARTIAL fill: 6 of 10 land. The fill is the truth; the order was an intention.
  const entryOrder = fake.st.orders.find(o => o.tradingSymbol === 'INFY');
  Object.assign(entryOrder, { orderStatus: 'TRADED', filledQty: 6, averageTradedPrice: 100.5 });
  fake.holdSymbol('INFY', 6);
  await enginePass();

  const placed = fake.sent('POST', '/v2/forever/orders');
  assert.equal(placed.length, 1, 'one protection order for the fill');
  assert.equal(placed[0].body.quantity, 6, 'sized to the FILL (6), never the ordered qty (10)');
  assert.equal(placed[0].body.orderFlag, 'OCO', 'full bracket: stop AND target');
  assert.equal(placed[0].body.triggerPrice, 95, 'stop at the configured SL');
  const r1 = rowOf('INFY');
  assert.equal(r1.awaitingFill, false, 'the naked window is closed');
  assert.ok(r1.dhanForeverId, 'row names its protection id');

  await enginePass();
  assert.equal(rowOf('INFY').engineState, 'PROTECTED', 'verified against the next broker read, not assumed');
});

test('a REJECTED entry dies with NO protection ever placed', async () => {
  await new Promise(res => placeEntry('WIPRO', '3787', 5, () => res()));
  const entryOrder = fake.st.orders.find(o => o.tradingSymbol === 'WIPRO');
  Object.assign(entryOrder, { orderStatus: 'REJECTED', filledQty: 0 });
  const before1 = fake.sent('POST', '/v2/forever/orders').length;
  await enginePass();
  await enginePass();
  assert.equal(fake.sent('POST', '/v2/forever/orders').length, before1, 'no protection for a dead entry');
  const r = rowOf('WIPRO');
  assert.equal(r.awaitingFill === true, false, 'the row is no longer waiting');
  assert.ok(/REJECT|DEAD|EXPIRED/i.test(String(r.status || '') + ' ' + String(r.exitType || '')), 'the row says why: ' + r.status);
});

test('BOOK-LIE (the GNA class): book says rejected, holdings show shares -> protect what is HELD', async () => {
  await new Promise(res => placeEntry('GAIL', '4717', 4, () => res()));
  const entryOrder = fake.st.orders.find(o => o.tradingSymbol === 'GAIL');
  Object.assign(entryOrder, { orderStatus: 'REJECTED', filledQty: 0 });
  fake.holdSymbol('GAIL', 4);                       // ...yet the shares are in the account
  const before1 = fake.sent('POST', '/v2/forever/orders').length;
  await enginePass();
  const placed = fake.sent('POST', '/v2/forever/orders').slice(before1);
  assert.equal(placed.length, 1, 'the held shares get protected - the book lied, the holdings did not');
  assert.equal(placed[0].body.quantity, 4, 'sized to what is actually held');
  assert.equal(rowOf('GAIL').awaitingFill, false);
});
