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

// ---- 4. T1 money on paper split rows (2026-10-12, the test mode report) ---------
// Live records what a T1 booking made (splitT1Pnl); the paper pass only flagged
// it, so a test report showed T1 as an estimate and counted the T1 leg again
// inside "Profit - T2".

const SPLIT = (o = {}) => ({ id: 'S1', source: 'test', testMode: true, splitT1: true, qty: 4, entryPrice: 4720, paperFillPrice: 4720,
  slPrice: 4578.4, t1Pct: 4, t2Pct: 8, t1Qty: 50, targetMode: 'pct', ...o });

test('a paper T1 booking records its money: (T1 - fill) x the T1 leg, exact - paper fills at the level', () => {
  // T1 = 4720 x 1.04 = 4908.80, the T1 leg = 50% of 4 = 2 shares
  assert.equal(tm.paperT1Money(SPLIT()), 377.6);
  assert.equal(tm.paperT1Money(SPLIT({ qty: 1 })), null, 'one share cannot split');
});

test('after T1 a paper position is the booked T1 money plus the RUNNER at the price (live\'s liveRowPatch rule)', () => {
  assert.equal(tm.paperMarkPnl(SPLIT(), 4950), 920, 'before T1: the whole quantity');
  assert.equal(tm.paperMarkPnl(SPLIT({ mtmT1Done: true, splitT1Pnl: 377.6 }), 4950), 837.6, 'after: 377.6 + 2 x 230');
  assert.equal(tm.paperMarkPnl(SPLIT({ mtmT1Done: true }), 4950), 837.6, 'missing money is derived, never read as zero');
});

test('rows booked before the fix get their T1 money once, and the full-quantity numbers are corrected', () => {
  const open = SPLIT({ id: 'o', mtmT1Done: true, testLtp: 4950, unrealisedPnl: 920 });
  const eod = SPLIT({ id: 'e', segment: 'MIS', mtmT1Done: true, exitType: 'EOD EXIT', exitPrice: 4800, realisedPnl: 320 });
  const t2 = SPLIT({ id: 't', mtmT1Done: true, mtmT2Done: true, exitType: 'TARGET HIT', exitPrice: 5097.6, realisedPnl: 1132.8 });
  const live = { ...SPLIT({ id: 'l', mtmT1Done: true }), source: 'auto', testMode: false };
  const out = tm.backfillPaperT1([open, eod, t2, live]);
  assert.equal(out.changed, 3);
  const [o, e, t, l] = out.rows;
  assert.equal(o.splitT1Pnl, 377.6);
  assert.equal(o.unrealisedPnl, 837.6, 'the open mark is the runner + T1, not 4 shares at the price');
  assert.equal(e.splitT1Pnl, 377.6);
  assert.equal(e.realisedPnl, 537.6, 'an EOD exit after T1: T1 money + the runner 2 x 80, not 4 x 80');
  assert.equal(t.splitT1Pnl, 377.6);
  assert.equal(t.realisedPnl, 1132.8, 'a T2 close already counted both legs: only the T1 money is added');
  assert.strictEqual(l, live, 'live rows are never touched');
  assert.equal(tm.backfillPaperT1(out.rows).changed, 0, 'idempotent');
});

test('the paper pass records T1 money at the booking and marks the runner; every write and the boot backfill', () => {
  const pass = src.slice(src.indexOf('function runPaperBrokerPass('), src.indexOf('function placeAngelOneMarketExit('));
  assert.ok(pass.includes('patch.splitT1Pnl = testmode.paperT1Money(e); patch.t1BookedAt = at;'));
  assert.ok(pass.includes("realisedPnl: testmode.paperMarkPnl({ ...e, ...patch }, px), result: 'EOD EXIT'"));
  assert.ok(pass.includes('const up = testmode.paperMarkPnl({ ...e, ...patch }, px);'));
  const w = src.slice(src.indexOf('function writeTestOrderLog('), src.indexOf('function appendTestOrderLog('));
  assert.ok(w.includes('testmode.backfillPaperT1(entries).rows'), 'every write records missing T1 money');
  assert.ok(src.includes('const t1Fix = testmode.backfillPaperT1(readTestOrderLog());'), 'and once at boot');
});
