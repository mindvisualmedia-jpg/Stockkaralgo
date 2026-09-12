'use strict';
// test/extratriggers.endpoint.test.js — the EXTRA-TRIGGER CLEANUP end to end:
// the REAL routes over a real http wire (handleRequest) against fake Dhan,
// reproducing the owner's post-restart audit of 2026-09-12 (day 6):
//
//   ZFCVINDIA: 3 live triggers cover 18 share(s) but only 9 held
//   Standing trigger with NO position: CCL
//
// What must be true when the owner taps the button: the duplicates are gone at
// the broker, the stop covering the shares is still standing, an id an OPEN row
// owns was never offered, and a stale screen cannot cancel anything.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { createFakeDhan } = require('./fake-dhan');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-extratrig-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({ clientId: 'FAKECLIENT', token: 'fake-token', savedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
Object.assign(process.env, {
  STOCKKAR_LICENCE_ENFORCE: '0',
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http',
  STOCKKAR_TELEGRAM_DISABLED: '1',
});

const fake = createFakeDhan({ securities: { '1': 'ZFCVINDIA', '2': 'CCL', '3': 'IFCI' }, marketPrice: 100 });
let S, app, appPort;
const ID = {};

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
const dhanPlan = (res) => (res.body.brokers || []).find(b => b.broker === 'dhan');
const symOf = (b, s) => (b.symbols || []).find(x => x.symbol === s);
const standing = () => fake.liveForevers().map(f => String(f.orderId));

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  // THE INCIDENT, as the broker saw it.
  fake.holdSymbol('ZFCVINDIA', 9);                 // one position, 9 shares
  ID.whole = String(fake.seedForever('ZFCVINDIA', 100, 150, 9));   // the bracket that belongs to nothing now
  ID.t1 = String(fake.seedForever('ZFCVINDIA', 98, 140, 4));       // a duplicate split pair beside it
  ID.runner = String(fake.seedForever('ZFCVINDIA', 98, 160, 5));
  ID.ccl = String(fake.seedForever('CCL', 600, 700, 30));          // shares long gone
  fake.holdSymbol('IFCI', 102);
  ID.mine = String(fake.seedForever('IFCI', 55, 70, 102));         // an OPEN row's own stop
  ID.oldIfci = String(fake.seedForever('IFCI', 50, 70, 102));      // its duplicate
  fs.writeFileSync(path.join(dataDir, 'order_log.json'), JSON.stringify([{
    id: 'row-ifci', broker: 'dhan', symbol: 'NSE:IFCI', action: 'BUY', qty: 102, entryPrice: 60,
    slPrice: 55, targetPrice: 70, status: 'DHAN ENTRY + FOREVER OCO', dhanProtection: 'forever',
    // a REAL row always carries the broker's ids in orderId; a row without one
    // is normalised to 'N/A', which isOpenOrderLogEntry reads as not open
    orderId: 'ENTRY:900001 | FOREVER:' + ID.mine,
    dhanForeverId: ID.mine, recordedAt: new Date().toISOString(), time: new Date().toLocaleString('en-IN'),
  }]));
  S = require('../server.js')._internals;
  app = http.createServer(S.handleRequest);
  await new Promise(res => app.listen(0, '127.0.0.1', () => { appPort = app.address().port; res(); }));
});
after(() => new Promise(res => app.close(() => fake.close(() => res()))));

test('the plan reproduces the audit: ZFCVINDIA over-covered, CCL held by nobody, IFCI duplicate beside the managed stop', async () => {
  const r = await call('GET', '/protection/extra');
  assert.equal(r.body.ok, true);
  const b = dhanPlan(r);
  assert.equal(b.error, undefined, JSON.stringify(b));

  const zf = symOf(b, 'ZFCVINDIA');
  assert.equal(zf.held, 9);
  assert.deepEqual(zf.keep.map(t => t.id), [ID.whole], 'the single trigger that covers all 9 is kept');
  assert.deepEqual(zf.cancel.map(t => t.id).sort(), [ID.t1, ID.runner].sort());

  const ccl = symOf(b, 'CCL');
  assert.equal(ccl.held, 0);
  assert.deepEqual(ccl.cancel.map(t => t.id), [ID.ccl]);
  assert.match(ccl.cancel[0].why, /no shares of CCL are held/);

  const ifci = symOf(b, 'IFCI');
  assert.deepEqual(ifci.keep.map(t => t.id), [ID.mine], 'the OPEN row\'s own stop is kept');
  assert.deepEqual(ifci.cancel.map(t => t.id), [ID.oldIfci]);
  // it is kept because the ROW OWNS IT (rule 1), not merely because its stop is
  // higher - the reason is what proves ownership resolved over the wire
  assert.match(ifci.note, /stop Stockkar manages/);
  assert.match(ifci.cancel[0].why, /own stop already covers all 102/);
  assert.equal(b.cancelCount, 4);
});

test('an id an OPEN row owns is never offered for cancelling, on any symbol', async () => {
  const b = dhanPlan(await call('GET', '/protection/extra'));
  const offered = (b.symbols || []).flatMap(s => s.cancel.map(t => t.id));
  assert.ok(!offered.includes(ID.mine));
});

test('a stale screen cancels NOTHING: an id that is not extra right now is refused', async () => {
  const r = await call('POST', '/protection/extra/cancel', { broker: 'dhan', ids: [ID.mine, 'nosuchid'] });
  assert.equal(r.status, 409);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /no longer extra/);
  assert.deepEqual(r.body.stale.sort(), [ID.mine, 'nosuchid'].sort());
  assert.ok(standing().includes(ID.mine), 'the managed stop is untouched');
});

test('an empty selection is refused before anything is read', async () => {
  const r = await call('POST', '/protection/extra/cancel', { broker: 'dhan', ids: [] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Nothing selected/);
});

test('APPLY: the confirmed ids are cancelled at the broker, and nothing else is', async () => {
  const before = standing();
  assert.equal(before.length, 6);
  const r = await call('POST', '/protection/extra/cancel', { broker: 'dhan', ids: [ID.t1, ID.runner, ID.ccl, ID.oldIfci] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.cancelled.length, 4);
  assert.deepEqual(r.body.failed, []);
  const after = standing();
  assert.deepEqual(after.sort(), [ID.whole, ID.mine].sort(), 'exactly the covering stops survive');
});

test('the shares are still protected afterwards, and the plan is now clean', async () => {
  const r = await call('GET', '/protection/extra');
  const b = dhanPlan(r);
  assert.equal(b.cancelCount, 0);
  assert.deepEqual(b.symbols, []);
  // ZFCVINDIA's 9 shares and IFCI's 102 each still have a live trigger covering them
  const audit = await call('GET', '/debug/audit?broker=dhan');
  const dhan = (audit.body.brokers || [])[0];
  const live = (dhan.brokerRules || []).filter(x => x.status === 'live');
  assert.equal(live.find(x => x.symbol === 'ZFCVINDIA').qty, 9);
  assert.equal(live.find(x => x.symbol === 'IFCI').qty, 102);
  assert.ok(!live.some(x => x.symbol === 'CCL'), 'the orphan is gone');
  assert.ok(!(dhan.issues || []).some(i => /ZFCVINDIA|CCL/.test(i)), 'the audit lines that ran for six days are gone: ' + JSON.stringify(dhan.issues));
});

test('the cancellation is recorded outside the order log', async () => {
  const file = path.join(dataDir, 'trigger_cleanup.json');
  const log = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(log.length, 1);
  assert.equal(log[0].broker, 'dhan');
  assert.equal(log[0].cancelled.length, 4);
  assert.ok(log[0].at);
});
