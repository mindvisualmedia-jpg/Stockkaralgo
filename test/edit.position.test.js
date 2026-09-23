'use strict';
// test/edit.position.test.js — Order Log -> Edit, end to end (owner,
// 2026-09-23: "add edit option in orderlog for each stock ... SL T1 T2
// Trailing etc ... same should be updated in broker").
//
// The REAL route over HTTP as the unlocked owner, the real executor, and fake
// Dhan + fake Kite answering as the live brokers do. What must hold:
//   - opening the dialog reads the broker once (price, held, current values)
//   - a preview never calls the broker
//   - a stop change is a MODIFY of the standing order, and the engine is told
//     to verify it; a target change on Dhan RE-BRACKETS (new first, old after)
//   - a T1 book-size change re-brackets into two correctly sized legs
//   - a Zerodha T1 change modifies both GTTs in place
//   - a stop at/above the market is refused before anything is sent
//   - if the old order will not cancel, the new one is taken back and the row
//     is untouched
//   - trailing-only changes touch no broker at all
//   - a support pass cannot edit
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createFakeDhan } = require('./fake-dhan');
const { createFakeKite } = require('./fake-brokers');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-edit-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({ clientId: 'FAKECLIENT', token: 'fake-token', savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'broker_tokens.json'), JSON.stringify({ brokers: {
  zerodha: { clientId: 'kiteapikey', clientSecret: 's', accessToken: 'kite-token', updatedAt: new Date().toISOString() } } }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
Object.assign(process.env, {
  STOCKKAR_LICENCE_ENFORCE: '0',
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http',
  STOCKKAR_KITE_API_HOST: '127.0.0.1', STOCKKAR_KITE_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1',
});

const dhan = createFakeDhan({ securities: { '1594': 'INFY', '3787': 'WIPRO', '2885': 'RELIANCE', '11536': 'TCS', '1333': 'HDFCBANK' }, marketPrice: 110 });
const kite = createFakeKite({ marketPrice: 110 });
let S, app, appPort, cookie = '', supportToken = '';

function call(method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({ hostname: '127.0.0.1', port: appPort, path: pathname, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(headers || {}) } }, (res) => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, raw: d, headers: res.headers, body: (() => { try { return JSON.parse(d); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
const edit = (body) => call('POST', '/order-log/edit', body, { cookie });
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < (ms || 15000)) { if (fn()) return true; await wait(150); } return false; };
const rowOf = (id) => S.readOrderLog().find(r => r.id === id);
const hold = (sym, secId, qty, ltp) => dhan.st.holdings.push({ tradingSymbol: sym, securityId: secId, totalQty: qty, availableQty: qty, exchange: 'NSE', lastTradedPrice: ltp, avgCostPrice: 100 });
const now = () => ({ time: new Date().toLocaleString(), recordedAt: new Date().toISOString() });
const dhanSingle = (id, sym, secId, fid, o) => ({ id, broker: 'dhan', symbol: sym, action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 95, slPriceOriginal: 95, brokerSlPrice: 95,
  targetPrice: 130, securityId: secId, exchange: 'NSE', segment: 'CNC', source: 'auto', orderId: 'ENTRY:E' + id + ' | FOREVER:' + fid, dhanEntryOrderId: 'E' + id,
  dhanForeverId: fid, dhanProtection: 'forever', status: 'DHAN ENTRY + FOREVER OCO', engineState: 'PROTECTED', liveLtp: 110, ...now(), ...(o || {}) });
const liveDhan = (sym) => dhan.liveForevers().filter(f => f.legs.some(l => l.tradingSymbol === sym));

before(async () => {
  await new Promise(res => dhan.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  await new Promise(res => kite.listen(port => { process.env.STOCKKAR_KITE_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  app = http.createServer(S.handleRequest);
  await new Promise(res => app.listen(0, '127.0.0.1', () => { appPort = app.address().port; res(); }));
  const setup = await call('POST', '/app-lock/setup', { pin: '654321', dob: '1990-01-01' });
  assert.equal(setup.status, 200, setup.raw);
  cookie = String(setup.headers['set-cookie'][0]).split(';')[0];
  const g = await call('POST', '/support/grant', { hours: 1 }, { cookie });
  supportToken = g.body.token;
});
after(() => new Promise(res => app.close(() => dhan.close(() => kite.close(() => res())))));

test('opening the dialog reads the broker once: the live price, the held quantity and the current values', async () => {
  hold('INFY', '1594', 10, 110);
  const fid = dhan.seedForever('INFY', 95, 130, 10);
  S.writeOrderLog([dhanSingle('d1', 'INFY', '1594', fid)]);
  const r = await edit({ id: 'd1', open: true });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.ltp, 110);
  assert.equal(r.body.held, 10);
  assert.deepEqual([r.body.snapshot.stop, r.body.snapshot.target, r.body.snapshot.split], [95, 130, false]);
});

test('a preview never calls the broker', async () => {
  const before = dhan.st.requests.length;
  const r = await edit({ id: 'd1', changes: { slPrice: 98 }, ltp: 110, held: 10, dryRun: true });
  assert.equal(r.body.plan.ok, true, JSON.stringify(r.body.plan.errors));
  assert.equal(r.body.plan.brokerOp, 'modify');
  assert.equal(dhan.st.requests.length, before, 'no request reached the broker');
});

test('STOP: a modify of the standing order - the broker holds the new stop and the engine is told to verify it', async () => {
  const fid = rowOf('d1').dhanForeverId;
  const r = await edit({ id: 'd1', changes: { slPrice: 98 } });
  assert.equal(r.status, 200, r.raw);
  const put = dhan.sent('PUT', '/v2/forever/orders/' + fid).slice(-1)[0];
  assert.ok(put, 'a modify was sent');
  assert.equal(put.body.legName, 'STOP_LOSS_LEG');
  assert.equal(Number(put.body.triggerPrice), 98);
  assert.equal(Number(dhan.forever(fid).legs.find(l => l.legName === 'STOP_LOSS_LEG').triggerPrice), 98);
  const row = rowOf('d1');
  assert.equal(row.slPrice, 98); assert.equal(row.brokerSlPrice, 98);
  assert.equal(row.dhanForeverId, fid, 'same order - nothing re-placed');
  assert.equal(row.editLockUntil, 0, 'the lock is released');
  const h = row.editHistory.slice(-1)[0];
  assert.equal(h.ok, true); assert.equal(h.brokerOp, 'modify');
  assert.deepEqual(h.lines, ['Stop ₹95 → ₹98']);
  // until the engine has SEEN the new stop at the broker, a second edit is refused ...
  assert.ok(row.enginePendingSl, 'the engine is asked to verify');
  // ... and the edit kicked an engine pass, which confirms it from the broker's own list
  assert.ok(await until(() => !rowOf('d1').enginePendingSl), 'the engine confirmed the new stop');
  // and it ACCEPTED the edit - it did not re-assert the old stop at the broker or on the row
  assert.equal(rowOf('d1').slPrice, 98, 'the row keeps the edited stop');
  assert.equal(Number(dhan.forever(fid).legs.find(l => l.legName === 'STOP_LOSS_LEG').triggerPrice), 98, 'the broker keeps it too');
});

test('a stop at or above the market is refused before anything is sent', async () => {
  const before = dhan.st.requests.filter(q => q.method !== 'GET').length;
  const r = await edit({ id: 'd1', changes: { slPrice: 111 } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /must be below the current price/);
  assert.equal(dhan.st.requests.filter(q => q.method !== 'GET').length, before, 'no order was sent');
});

test('TARGET on Dhan: re-bracket - the new order is placed FIRST, then the old one is cancelled', async () => {
  const oldId = rowOf('d1').dhanForeverId;
  const r = await edit({ id: 'd1', changes: { targetPrice: 140 } });
  assert.equal(r.status, 200, r.raw);
  const row = rowOf('d1');
  assert.notEqual(row.dhanForeverId, oldId, 'a new order id');
  assert.ok(!dhan.forever(oldId), 'the old order is gone');
  const fv = dhan.forever(row.dhanForeverId);
  assert.equal(Number(fv.legs.find(l => l.legName === 'TARGET_LEG').triggerPrice), 140);
  assert.equal(Number(fv.legs.find(l => l.legName === 'STOP_LOSS_LEG').triggerPrice), 98, 'at the current stop');
  assert.equal(Number(fv.legs[0].quantity), 10);
  assert.equal(row.targetPrice, 140);
  assert.match(String(row.orderId), /^ENTRY:Ed1 \| FOREVER:/, 'the entry token survives');
  // order of operations: the POST came before the DELETE
  const seq = dhan.st.requests.filter(q => (q.method === 'POST' && q.path === '/v2/forever/orders') || (q.method === 'DELETE' && q.path.endsWith('/' + oldId)));
  assert.deepEqual(seq.slice(-2).map(q => q.method), ['POST', 'DELETE']);
});

test('T1 BOOK SIZE: one target becomes T1 + T2, two correctly sized legs, the old bracket retired', async () => {
  hold('WIPRO', '3787', 10, 110);
  const fid = dhan.seedForever('WIPRO', 95, 160, 10);
  S.writeOrderLog([...S.readOrderLog(), dhanSingle('d2', 'WIPRO', '3787', fid, { targetPrice: 160 })]);
  const r = await edit({ id: 'd2', changes: { split: true, t1Price: 125, t1Qty: 40, t2Price: 150 } });
  assert.equal(r.status, 200, r.raw);
  const row = rowOf('d2');
  assert.equal(row.splitT1, true);
  assert.deepEqual([row.splitLegAQty, row.splitLegBQty], [4, 6]);
  assert.equal(row.t1Pct, 25); assert.equal(row.t2Pct, 50);
  assert.ok(!dhan.forever(fid), 'the old single bracket is gone');
  const legs = liveDhan('WIPRO').map(f => [Number(f.legs[0].quantity), Number(f.legs.find(l => l.legName === 'TARGET_LEG').triggerPrice)]).sort((a, b) => a[1] - b[1]);
  assert.deepEqual(legs, [[4, 125], [6, 150]]);
  assert.match(String(row.status), /T1\/T2 split/);
});

test('if the old order will NOT cancel, the new one is taken back and the row is untouched', async () => {
  hold('RELIANCE', '2885', 10, 110);
  const fid = dhan.seedForever('RELIANCE', 95, 130, 10);
  S.writeOrderLog([...S.readOrderLog(), dhanSingle('d3', 'RELIANCE', '2885', fid)]);
  dhan.st.failNext = { method: 'DELETE', path: '/v2/forever/orders/' + fid, message: 'Order cannot be cancelled' };
  const r = await edit({ id: 'd3', changes: { targetPrice: 145 } });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /could not be cancelled.*taken back.*Nothing changed/);
  const row = rowOf('d3');
  assert.equal(row.dhanForeverId, fid, 'the row still points at the order that stands');
  assert.equal(row.targetPrice, 130, 'the row is untouched');
  assert.deepEqual(liveDhan('RELIANCE').map(f => f.orderId), [fid], 'only the original order stands');
  assert.equal(row.editHistory.slice(-1)[0].ok, false);
});

test('ZERODHA T1: both GTTs modified in place - no new orders', async () => {
  kite.holdSymbol('TCS', 10, 110);
  const a = kite.seedGtt('TCS', 95, 130, 5), b = kite.seedGtt('TCS', 95, 160, 5);
  S.writeOrderLog([...S.readOrderLog(), { id: 'z1', broker: 'zerodha', symbol: 'TCS', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 95, slPriceOriginal: 95,
    brokerSlPrice: 95, targetPrice: 160, t1Pct: 30, t1Qty: 50, t2Pct: 60, targetMode: 'pct', splitT1: true, zerodhaSplit: true, splitLegAQty: 5, splitLegBQty: 5,
    zerodhaGttT1Id: a, zerodhaGttId: b, orderId: 'ENTRY:ZE1 | GTT-T1:' + a + ' | GTT:' + b, exchange: 'NSE', segment: 'CNC', source: 'auto',
    status: 'ZERODHA ENTRY + 2x GTT OCO (T1/T2 split)', engineState: 'PROTECTED', liveLtp: 110, ...now() }]);
  const posts = kite.sent('POST', '/gtt/triggers').length;
  const r = await edit({ id: 'z1', changes: { t1Price: 135 } });
  assert.equal(r.status, 200, r.raw);
  assert.equal(kite.sent('POST', '/gtt/triggers').length, posts, 'no new GTT');
  const gA = kite.data.gtts.find(g => String(g.id) === String(a));
  assert.deepEqual(gA.condition.trigger_values.map(Number), [95, 135], 'T1 moved on its own GTT');
  assert.equal(rowOf('z1').t1Pct, 35);
});

test('trailing only: no broker call at all, the row carries the new rule', async () => {
  const before = dhan.st.requests.filter(q => q.method !== 'GET').length;
  const r = await edit({ id: 'd1', changes: { trail: { enabled: true, mode: 'peak', pct: 4 }, costPct: 3 } });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.plan.brokerOp, 'none');
  assert.equal(dhan.st.requests.filter(q => q.method !== 'GET').length, before, 'nothing sent');
  const row = rowOf('d1');
  assert.equal(row.emaTrailingEnabled, true); assert.equal(row.trailMode, 'peak'); assert.equal(row.emaTrailingPct, 4); assert.equal(row.costPct, 3);
});

test('a support pass cannot edit - it is read-only', async () => {
  const r = await call('POST', '/order-log/edit', { id: 'd1', changes: { slPrice: 97 } }, { 'x-stockkar-support': supportToken });
  assert.ok(r.status === 403 || r.status === 401, 'refused: ' + r.status + ' ' + r.raw.slice(0, 120));
  assert.equal(rowOf('d1').slPrice, 98, 'unchanged');
});
