'use strict';
// test/entry.dead.reason.test.js - a DEAD entry says why, and a funds refusal
// halts its algo (2026-10-15, FLUOROCHEM on Dhan).
//
// THE CASE. A No-SL algo placed a LIMIT BUY at 9:16 and, as No-SL does on Dhan,
// its T1 target SELL beside it. At 1:59 PM Dhan's order book showed the buy as
// dead; the engine cancelled the target (right - it could never sell shares
// never bought) and the row read:
//   Entry order  Failed  "orphaned protection cancelled to avoid a naked short"
//   Exit         Failed  "REJECTED"
// - our own cleanup, not why the buy died. The adapters mapped REJECTED /
// CANCELLED / EXPIRED to a bare {status:'dead'}, dropping Dhan's reason
// (omsErrorDescription), which the pre-engine path had recorded. And the
// "insufficient funds -> halt the algo for the day" rule read the row's
// rejectionReason, which this path never filled: it could not fire.
//
// Driven through the REAL executor against the fake Dhan.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeDhan } = require('./fake-dhan');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-deadentry-'));
fs.writeFileSync(path.join(dataDir, 'dhan_token.json'), JSON.stringify({ clientId: 'FAKECLIENT', token: 'fake-token' }));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'algo_schedule.json'), JSON.stringify({ jobs: [
  { id: 'job-funds', enabled: true, config: { algoName: 'RETAILER TRAP' } },
  { id: 'job-user', enabled: true, config: { algoName: 'Cancelled by hand' } },
  { id: 'job-nolegs', enabled: true, config: { algoName: 'Protect after fill' } },
  { id: 'job-revisit', enabled: true, config: { algoName: 'Next morning' } },
] }));
Object.assign(process.env, {
  STOCKKAR_LICENCE_ENFORCE: '0',
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1',
  STOCKKAR_ENGINE_ENTRIES: '1',
});

const fake = createFakeDhan({ securities: { '11536': 'TCS', '9999': 'FLUOROCHEM', '1333': 'HDFCBANK', '3787': 'WIPRO' }, marketPrice: 4600 });
let S;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const rowOf = (sym) => S.readOrderLog().find(r => r.symbol === sym);
const jobOf = (id) => JSON.parse(fs.readFileSync(path.join(dataDir, 'algo_schedule.json'), 'utf8')).jobs.find(j => j.id === id);
// Wait for the pass's LAST write, not a fixed time: under the full suite's load
// 700 ms was not always enough. The halt runs in the same tick as that write,
// so once it lands, everything a test checks has landed too.
async function enginePassUntil(done, ms = 8000) {
  S.runEngineCutover();
  const t0 = Date.now();
  while (!done()) { if (Date.now() - t0 > ms) return; await wait(20); }
}

// A healthy position anchors the read-sanity gate (its id IS in every snapshot).
let anchorId;
function anchorRow() {
  fake.holdSymbol('TCS', 5);
  anchorId = anchorId || fake.seedForever('TCS', 3000, 3300, 5);
  return { id: 'anchor', broker: 'dhan', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300,
    securityId: '11536', exchange: 'NSE', segment: 'CNC', orderId: 'ENTRY:E9 | FOREVER:' + anchorId, dhanEntryOrderId: 'E9',
    dhanProtection: 'forever', dhanForeverId: anchorId, status: 'DHAN ENTRY + FOREVER OCO',
    time: new Date().toLocaleString(), recordedAt: new Date().toISOString() };
}
function deadEntryRow(o) {
  return { id: o.id, broker: 'dhan', symbol: o.symbol, action: 'BUY', qty: 10, entryPrice: 4551, price: 4551, slPrice: o.sl || 4400, targetPrice: 4842,
    securityId: o.secId, exchange: 'NSE', segment: 'CNC', jobId: o.jobId,
    orderId: 'ENTRY:' + o.entryId + (o.foreverId ? ' | FOREVER:' + o.foreverId : ''), dhanEntryOrderId: o.entryId,
    ...(o.foreverId ? { dhanProtection: 'forever', dhanForeverId: o.foreverId } : {}),
    awaitingFill: true, pendingProtection: { entryId: o.entryId, qty: 10 },
    status: 'DHAN ENTRY PENDING', engineState: 'ENTRY_PENDING',
    time: new Date().toLocaleString(), recordedAt: new Date().toISOString() };
}

before(async () => {
  await new Promise(res => fake.listen(port => { process.env.STOCKKAR_DHAN_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  S.seedDhanSecurityMap({ 'NSE:TCS': '11536', TCS: '11536', 'NSE:FLUOROCHEM': '9999', FLUOROCHEM: '9999', 'NSE:HDFCBANK': '1333', HDFCBANK: '1333', 'NSE:WIPRO': '3787', WIPRO: '3787' });
});
after(() => new Promise(res => fake.close(() => res())));

test('a buy Dhan REJECTED for margin: the row says so in Dhan\'s words, the target is cancelled, and the algo halts for the day', async () => {
  const foreverId = fake.seedForever('FLUOROCHEM', 4400, 4842, 10);
  const why = 'RMS:Margin Exceeds,Cash Available:1000.00,Margin Required:45510.00';
  fake.st.orders.push({ orderId: 'E1', orderStatus: 'REJECTED', transactionType: 'BUY', tradingSymbol: 'FLUOROCHEM', quantity: 10, filledQty: 0,
    omsErrorDescription: why, updateTime: '2026-10-14 09:16:13' });
  S.writeOrderLog([anchorRow(), deadEntryRow({ id: 'f1', symbol: 'FLUOROCHEM', secId: '9999', entryId: 'E1', foreverId, jobId: 'job-funds' })]);
  await enginePassUntil(() => rowOf('FLUOROCHEM')?.exitType === 'REJECTED');
  const r = rowOf('FLUOROCHEM');
  assert.ok((fake.st.cancelled || []).includes(foreverId), 'the standing target/stop was cancelled');
  assert.equal(r.exitType, 'REJECTED');
  assert.equal(r.status, 'DHAN ENTRY REJECTED - no position, protection cancelled');
  assert.match(r.rejectionReason, /^Entry rejected at DHAN \(RMS:Margin Exceeds,Cash Available:1000\.00,Margin Required:45510\.00\); its protective order was cancelled, so nothing can sell shares that were never bought$/);
  assert.deepEqual([r.entryBrokerStatus, r.entryBrokerReason, r.entryBrokerAt], ['REJECTED', why, '2026-10-14 09:16:13']);
  assert.ok((r.events || []).some(e => e.s === 'ENTRY_PENDING>ENTRY_DEAD' && e.at), 'the moment it was seen dead is on the row (the timeline reads it)');
  const job = jobOf('job-funds');
  assert.ok(job.haltedDate, 'a margin refusal fails every stock alike: the algo is halted for the day');
  assert.match(job.haltedReason, /Margin Exceeds/);
});

test('a buy CANCELLED at Dhan (by hand): named as cancelled, and the algo keeps running', async () => {
  const foreverId = fake.seedForever('HDFCBANK', 1600, 1750, 10);
  fake.st.orders.push({ orderId: 'E2', orderStatus: 'CANCELLED', transactionType: 'BUY', tradingSymbol: 'HDFCBANK', quantity: 10, filledQty: 0,
    omsErrorDescription: '', updateTime: '2026-10-14 13:58:51' });
  S.writeOrderLog([anchorRow(), deadEntryRow({ id: 'h1', symbol: 'HDFCBANK', secId: '1333', entryId: 'E2', foreverId, jobId: 'job-user' })]);
  await enginePassUntil(() => rowOf('HDFCBANK')?.exitType === 'REJECTED');
  const r = rowOf('HDFCBANK');
  assert.equal(r.status, 'DHAN ENTRY CANCELLED - no position, protection cancelled');
  assert.match(r.rejectionReason, /^Entry cancelled at DHAN; its protective order was cancelled/);
  assert.equal(r.entryBrokerAt, '2026-10-14 13:58:51');
  assert.ok(!jobOf('job-user').haltedDate, 'a cancel is not an account problem - no halt');
});

test('protect-after-fill (nothing placed yet): a funds REJECT closes the row with Dhan\'s reason and halts the algo', async () => {
  fake.st.orders.push({ orderId: 'E3', orderStatus: 'REJECTED', transactionType: 'BUY', tradingSymbol: 'WIPRO', quantity: 10, filledQty: 0,
    omsErrorDescription: 'Insufficient Funds', updateTime: '2026-10-14 10:02:00' });
  S.writeOrderLog([anchorRow(), deadEntryRow({ id: 'w1', symbol: 'WIPRO', secId: '3787', entryId: 'E3', jobId: 'job-nolegs' })]);
  await enginePassUntil(() => rowOf('WIPRO')?.exitType === 'REJECTED');
  const r = rowOf('WIPRO');
  assert.equal(r.exitType, 'REJECTED');
  assert.match(r.status, /^REJECTED \(entry rejected: Insufficient Funds — no position, nothing at the broker\) \[engine\]$/);
  assert.equal(r.rejectionReason, 'Entry rejected at DHAN (Insufficient Funds)');
  assert.equal(r.entryBrokerReason, 'Insufficient Funds');
  assert.ok(jobOf('job-nolegs').haltedDate, 'the no-legs close halts too');
});

test('the 24h sweep re-visiting a closed dead entry (a leg still live) cancels it, keeps the words and does NOT halt again', async () => {
  // The sweep runs 24h from the row's creation - into the next trading morning.
  // A re-halt there would stop the algo for a day it did nothing wrong in.
  const foreverId = fake.seedForever('HDFCBANK', 1600, 1750, 10);
  const words = 'Entry rejected at DHAN (Insufficient Funds); its protective order was cancelled, so nothing can sell shares that were never bought';
  S.writeOrderLog([anchorRow(), { ...deadEntryRow({ id: 'r1', symbol: 'HDFCBANK', secId: '1333', entryId: 'E4', foreverId, jobId: 'job-revisit' }),
    awaitingFill: false, pendingProtection: null, engineState: 'ENTRY_DEAD', exitType: 'REJECTED',
    status: 'DHAN ENTRY REJECTED - no position, protection cancelled', rejectionReason: words,
    entryBrokerStatus: 'REJECTED', entryBrokerReason: 'Insufficient Funds', entryBrokerAt: '2026-10-14 09:16:13' }]);
  await enginePassUntil(() => rowOf('HDFCBANK')?.dhanProtection === 'forever-cancelled');
  const r = rowOf('HDFCBANK');
  assert.ok((fake.st.cancelled || []).includes(foreverId), 'the leg still standing is cancelled');
  assert.deepEqual([r.status, r.rejectionReason], ['DHAN ENTRY REJECTED - no position, protection cancelled', words], 'the first pass\'s words stand');
  assert.ok(!jobOf('job-revisit').haltedDate, 'no second halt from a re-visit');
});
