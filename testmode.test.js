'use strict';
// TEST MODE rows: worded as tests, never duplicated by hand, and the slot
// dialog names what the log holds beyond the count (2026-09-09 audit).
//
// THE INCIDENT. "Test mode has taken more trades but the algo shows 2 of 3."
// The algo had placed two paper entries (PAPER-ENTRY ids, jobId set): 2 of 3
// was right. The other six rows came from the wizard's Record Test Run button,
// clicked twice two seconds apart: no jobId, no duplicate guard, so the same
// three stocks were recorded twice and none of them could count against any
// algo. And every paper row carried the LIVE status wording ("DHAN ENTRY +
// FOREVER OCO"), so the test log read like real broker orders.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const tm = require('./testmode');

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// ---- 1. wording ----------------------------------------------------------------

test('a paper row reads "DHAN TEST ENTRY ...", never like a live order', () => {
  assert.equal(tm.paperStatusText('dhan', 'DHAN ENTRY + FOREVER OCO'), 'DHAN TEST ENTRY + FOREVER OCO');
  assert.equal(tm.paperStatusText('dhan', 'DHAN ENTRY + 2x FOREVER OCO (T1/T2 split)'), 'DHAN TEST ENTRY + 2x FOREVER OCO (T1/T2 split)');
  assert.equal(tm.paperStatusText('dhan', 'DHAN ENTRY PENDING — awaiting fill, protection on fill'), 'DHAN TEST ENTRY PENDING — awaiting fill, protection on fill');
  assert.equal(tm.paperStatusText('zerodha', 'ZERODHA ENTRY + GTT'), 'ZERODHA TEST ENTRY + GTT');
  assert.equal(tm.paperStatusText('fyers', 'FYERS ENTRY + GTT OCO'), 'FYERS TEST ENTRY + GTT OCO');
  assert.equal(tm.paperStatusText('angelone', 'ANGEL ENTRY + GTT OCO'), 'ANGEL TEST ENTRY + GTT OCO');
});

test('wording is idempotent and covers a text with no broker prefix', () => {
  assert.equal(tm.paperStatusText('dhan', 'DHAN TEST ENTRY + FOREVER OCO'), 'DHAN TEST ENTRY + FOREVER OCO');
  assert.equal(tm.paperStatusText('dhan', 'SUPER ORDER'), 'DHAN TEST SUPER ORDER');
  assert.equal(tm.paperStatusText('dhan', ''), 'DHAN TEST ENTRY');
});

test('the manual test-run status names the broker as a TEST and adds no closing token', () => {
  const s = tm.manualTestStatus('dhan');
  assert.equal(s, 'DHAN TEST ENTRY (manual test run) - no broker order');
  assert.ok(!/(TARGET HIT|SL HIT|REJECT|CANCEL|FAILED|FAIL|INVALID|EXITED|CLOSED|EOD EXIT)/.test(s.toUpperCase()), 'must stay OPEN for isOpenOrderLogEntry');
  assert.ok(!/(TARGET HIT|SL HIT|REJECT|CANCEL|FAILED|FAIL|INVALID|EXITED|CLOSED|EOD EXIT)/.test(tm.paperStatusText('dhan', 'DHAN ENTRY + FOREVER OCO').toUpperCase()));
});

// ---- 2. the duplicate guard -----------------------------------------------------------

const isOpen = e => !e.exitType && !e.manualClose;
const row = (symbol, over = {}) => ({ symbol, broker: 'dhan', source: 'test', qty: 1, ...over });

test('INCIDENT: the second click records nothing new - every symbol is already open', () => {
  const first = [row('INDIANB'), row('ADANIPORTS'), row('TATASTEEL')];
  const a = tm.dedupeManualTestRows(first, [], isOpen);
  assert.equal(a.rows.length, 3);
  assert.equal(a.skipped.length, 0);
  const b = tm.dedupeManualTestRows(first.map(r => ({ ...r })), a.rows, isOpen);
  assert.equal(b.rows.length, 0);
  assert.deepEqual(b.skipped.map(s => s.symbol), ['INDIANB', 'ADANIPORTS', 'TATASTEEL']);
});

test('a stock the algo already holds on paper is skipped; a CLOSED one may be recorded again', () => {
  const existing = [row('INDIANB', { jobId: 'job-1', orderId: 'PAPER-ENTRY-1' }), row('RAIN', { exitType: 'SL HIT' })];
  const r = tm.dedupeManualTestRows([row('INDIANB'), row('RAIN'), row('NSE:rain ')], existing, isOpen);
  assert.deepEqual(r.rows.map(x => x.symbol), ['RAIN'], 'RAIN once (closed row does not block), the second RAIN spelling is the same symbol');
  assert.deepEqual(r.skipped.map(s => s.symbol), ['INDIANB', 'RAIN']);
});

test('the guard is per broker: the same symbol may be open at another broker', () => {
  const r = tm.dedupeManualTestRows([row('INDIANB', { broker: 'zerodha' })], [row('INDIANB')], isOpen);
  assert.equal(r.rows.length, 1);
});

// ---- 3. the slot dialog names what it does not count ---------------------------------------

test('open rows not written by this job are named by author, deduped, and never include its own', () => {
  const rows = [
    row('INDIANB', { jobId: 'job-1' }), row('ADANIPORTS', { jobId: 'job-1' }),
    row('TATASTEEL'), row('TATASTEEL'),                       // manual test run, recorded twice
    row('SBIN', { jobId: 'job-2' }),
    row('RAIN', { exitType: 'SL HIT' }),                       // closed: not open, not listed
    { symbol: 'ITC', broker: 'dhan', source: 'auto' },         // a live manual order shape
  ];
  const out = tm.otherOpenRows(rows, 'job-1', isOpen, id => ({ 'job-2': 'RSI 60 MOMENTAM' })[id]);
  assert.deepEqual(out, [
    { symbol: 'TATASTEEL', by: 'manual test run' },
    { symbol: 'SBIN', by: 'algo RSI 60 MOMENTAM' },
    { symbol: 'ITC', by: 'manual order' },
  ]);
});

// ---- 4. the wiring in server.js / index.html ---------------------------------------------

test('both scheduled paper placements and the paper fill are worded as tests', () => {
  const placements = src.split("scheduledOrderStatusText(broker, null, pr, { paper: true })").length - 1;
  assert.equal(placements, 2, 'the two scheduled paper placement sites');
  assert.ok(src.includes("status: scheduledOrderStatusText(broker, null, prot, { paper: true }),"), 'the paper-pass fill');
  assert.ok(src.includes("if (opts && opts.paper) return testmode.paperStatusText(broker, scheduledOrderStatusText(broker, orderErr, orderRes));"));
  assert.ok(src.includes("if (testmode.isTestRow(r)) return testmode.paperStatusText(r.broker, BROKER_OPEN_STATUS({ ...r, testMode: false, source: 'auto' }));"), 'engine rewrites keep the TEST word');
});

test('no code path writes the live status to a paper row any more', () => {
  const bare = src.split('scheduledOrderStatusText(broker, null, pr)').length - 1;
  assert.equal(bare, 0);
});

test('the test-log endpoint dedupes manual rows and reports what it skipped', () => {
  assert.ok(src.includes('testmode.dedupeManualTestRows(Array.isArray(incoming) ? incoming : [incoming], readTestOrderLog(), isOpenOrderLogEntry)'));
  assert.ok(src.includes('sendJSON({ ok: true, data, skipped, retentionDays: ORDER_LOG_RETENTION_DAYS });'));
  assert.ok(src.includes("status: (!entry.status || entry.status === testmode.LEGACY_MANUAL_STATUS) ? testmode.manualTestStatus(entry.broker) : entry.status,"), 'legacy "TEST MODE - NO ORDER PLACED" rows are reworded on write');
});

test('the slot detail carries the other open rows, and the dialog prints them', () => {
  assert.ok(src.includes('out.otherOpenInLog = testmode.otherOpenRows('));
  assert.ok(html.includes("lines.push('ALSO OPEN in this log, not placed by this algo (' + d.otherOpenInLog.length + ') - not counted:');"));
});

test('Record Test Run: one click at a time, TEST wording, skipped rows named, slots explained', () => {
  assert.ok(html.includes("if (runBtn && runBtn.disabled) return;"));
  assert.ok(html.includes("status: String(c.broker || 'dhan').toUpperCase() + ' TEST ENTRY (manual test run) - no broker order',"));
  assert.ok(html.includes("const skipped = await persistTestOrderLog(rows);"));
  assert.ok(html.includes("already open in the test log</div>"));
  assert.ok(html.includes("do not use the algo\\'s position slots"));
  assert.ok(!html.includes("'TEST MODE - NO ORDER PLACED'"), 'no legacy wording left in the client');
});
