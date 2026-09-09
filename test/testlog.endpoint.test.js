'use strict';
// test/testlog.endpoint.test.js - the REAL /test-order-log endpoint over a real
// http wire (handleRequest): the wizard's Record Test Run posts the same three
// stocks twice, two seconds apart (the 2026-09-09 incident). The second post
// must record nothing new and name what it skipped, and every row must be
// worded as a TEST entry, never like a live order.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-testlog-'));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'test_order_log.json'), '[]');
Object.assign(process.env, {
  STOCKKAR_LICENCE_ENFORCE: '0',
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_TELEGRAM_DISABLED: '1',
});

let S, app, appPort;

function call(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({ hostname: '127.0.0.1', port: appPort, path: pathname, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), 'x-stockkar-internal': S.INTERNAL_SECRET } }, (res) => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(d) }); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  S = require('../server.js')._internals;
  app = http.createServer(S.handleRequest);
  await new Promise(res => app.listen(0, '127.0.0.1', () => { appPort = app.address().port; res(); }));
});
after(() => new Promise(res => app.close(() => res())));

const manualRows = (suffix) => ['INDIANB', 'ADANIPORTS', 'TATASTEEL'].map((symbol, idx) => ({
  time: new Date().toLocaleString(), recordedAt: new Date().toISOString(), symbol, action: 'BUY', qty: 10,
  price: 100, entryPrice: 100, slPrice: 95, targetPrice: 110, rr: 2,
  orderId: 'TEST-' + Date.now() + '-' + (idx + 1) + suffix, status: 'TEST MODE - NO ORDER PLACED', source: 'test', broker: 'dhan',
}));

test('INCIDENT: the same three stocks posted twice are recorded once, and the second post names the skips', async () => {
  const a = await call('POST', '/test-order-log', { entries: manualRows('a') });
  assert.equal(a.status, 200);
  assert.equal(a.body.ok, true);
  assert.equal(a.body.data.length, 3);
  assert.deepEqual(a.body.skipped, []);

  const b = await call('POST', '/test-order-log', { entries: manualRows('b') });
  assert.equal(b.body.data.length, 3, 'nothing new recorded');
  assert.deepEqual(b.body.skipped.map(s => s.symbol), ['INDIANB', 'ADANIPORTS', 'TATASTEEL']);
  assert.ok(b.body.skipped.every(s => /already open in the test log/.test(s.reason)));

  const log = await call('GET', '/test-order-log');
  assert.equal(log.body.data.length, 3);
  assert.equal(S.readTestOrderLog().length, 3, 'the file agrees');
});

test('every manual row is worded as a TEST entry (legacy wording rewritten on write) and still counts as OPEN', async () => {
  const rows = S.readTestOrderLog();
  rows.forEach(r => {
    assert.equal(r.status, 'DHAN TEST ENTRY (manual test run) - no broker order');
    assert.equal(S.isOpenOrderLogEntry(r), true);
    assert.equal(r.jobId, undefined, 'a manual row belongs to no algo');
  });
});

test('a symbol closed in the test log can be recorded again; an open one at another broker does not block', async () => {
  S.writeTestOrderLog(S.readTestOrderLog().map(r => r.symbol === 'TATASTEEL' ? { ...r, exitType: 'SL HIT', result: 'SL HIT', testClosedAt: new Date().toISOString() } : r));
  const again = manualRows('c').filter(r => r.symbol !== 'ADANIPORTS').map(r => r.symbol === 'INDIANB' ? { ...r, broker: 'zerodha' } : r);
  const c = await call('POST', '/test-order-log', { entries: again });
  assert.deepEqual(c.body.skipped, []);
  assert.equal(c.body.data.length, 5);
  const z = c.body.data.find(r => r.broker === 'zerodha');
  assert.equal(z.status, 'ZERODHA TEST ENTRY (manual test run) - no broker order');
});

test('the slot detail names open rows the job did not write, and does not count them', async () => {
  // A scheduled paper row of job-1 beside the manual rows above.
  S.writeTestOrderLog([{ id: 'p1', symbol: 'SBIN', broker: 'dhan', qty: 5, entryPrice: 50, slPrice: 48, targetPrice: 55, jobId: 'job-1',
    orderId: 'PAPER-ENTRY-1', status: 'DHAN TEST ENTRY + FOREVER OCO', source: 'test', recordedAt: new Date().toISOString() }, ...S.readTestOrderLog()]);
  const d = S.algoHeldPositionDetail(null, 'job-1', true);
  assert.deepEqual(d.openInLog, ['SBIN']);
  assert.equal(S.openPositionsForJob('job-1', true), 1, 'manual rows never count against the algo');
  const others = d.otherOpenInLog.map(o => o.symbol + ':' + o.by).sort();
  assert.deepEqual(others, ['ADANIPORTS:manual test run', 'INDIANB:manual test run', 'TATASTEEL:manual test run']);
});
