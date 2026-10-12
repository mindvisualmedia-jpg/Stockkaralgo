'use strict';
// test/testmode.report.test.js - the TEST MODE REPORT (2026-10-12, owner:
// "build test mode proper report like we have for live").
//
// The Dashboard read the LIVE log only, so test mode had no report at all.
// Now the same page has a Live trades / Test mode switch and runs the SAME
// math over the test log. This file runs the REAL Dashboard, analytics band,
// PDF writer and Order Log summary from index.html (with report.js, exactly as
// the browser loads them) against real-shaped paper rows, and pins:
//   - the switch reads the test log, and opens on Test while there are no live
//     trades yet;
//   - test mode never borrows the live ledger's archived days;
//   - every live word that would be untrue says the test thing instead
//     ("paper positions", "Expired unfilled", "manual runs");
//   - the shared PDF says TEST MODE on its face (header, badge, watermark,
//     footer) and never VERIFIED - while the live PDF is unchanged.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const reportSrc = fs.readFileSync(path.join(ROOT, 'report.js'), 'utf8');

// A top-level declaration from index.html, sliced from its first line to the
// first column-0 closing brace (no regex over the body).
function fnSource(name) {
  const i = html.indexOf('\nfunction ' + name + '(');
  assert.ok(i >= 0, name + ' is defined in index.html');
  const j = html.indexOf('\n}', i + 1);
  return html.slice(i + 1, j + 2);
}
function lineSource(prefix) {
  const i = html.indexOf('\n' + prefix);
  assert.ok(i >= 0, prefix + ' is defined in index.html');
  return html.slice(i + 1, html.indexOf('\n', i + 1));
}

const FUNCS = ['escapeHtml', 'laMoney', 'laAsOf', 'renderLogAnalytics', 'dashReportOpts', 'dashActiveMode', 'dashIsTest',
  'dashSourceRows', 'dashRejectedIsExpiry', 'dashFromKey', 'dashRangeBounds', 'dashRows', 'dashArchivedOpts', 'dashRangeLabel',
  'generateDashPdfString', 'renderDashboard', 'renderDashModeChrome', 'renderTestLogSummary', 'openDashShare'];

function makePage(state) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: '', textContent: '', value: '', placeholder: '', style: {}, dataset: {},
    classList: { toggle() {} }, setAttribute() {}, focus() {} });
  const modeButtons = ['live', 'test'].map(m => ({ dataset: { m }, on: false, pressed: '',
    classList: { toggle(c, on) { if (c === 'on') this.owner.on = !!on; } }, setAttribute(k, v) { if (k === 'aria-pressed') this.pressed = v; } }));
  modeButtons.forEach(b => { b.classList.owner = b; });
  const ctx = {
    console, Math, Date, Number, String, Array, Object, JSON, Set, Map, isNaN, isFinite, setTimeout: () => 0,
    window: { _algoJobs: state.jobs || [], _rollups: state.rollups || null, _orderLogLoaded: true },
    document: { getElementById: el, querySelectorAll: (sel) => (sel === '#dash-mode button' ? modeButtons : []) },
  };
  vm.createContext(ctx);
  vm.runInContext(reportSrc, ctx, { filename: 'report.js' });
  const src = [
    'let orderLog = [], testOrderLog = [], activeLogTab = "live", dashRange = "30", dashMode = "";',
    lineSource('const LA_COLORS = '), lineSource('const DASH_SHARE_HINT_LIVE = '),
    ...FUNCS.map(fnSource),
    'this.__set = (k, v) => { if (k === "orderLog") orderLog = v; if (k === "testOrderLog") testOrderLog = v; if (k === "activeLogTab") activeLogTab = v; if (k === "dashMode") dashMode = v; if (k === "dashRange") dashRange = v; };',
  ].join('\n');
  vm.runInContext(src, ctx, { filename: 'index.html (extract)' });
  ctx.__set('orderLog', state.live || []);
  ctx.__set('testOrderLog', state.test || []);
  return { ctx, els, el, modeButtons };
}

// ---- real-shaped rows (fields as runPaperBrokerPass / appendTestOrderLog write them)
const day = (ago, hm) => {
  const d = new Date(); d.setDate(d.getDate() - ago);
  const [h, m] = hm.split(':').map(Number); d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const PAPER = (o) => ({ source: 'test', testMode: true, broker: 'dhan', segment: 'CNC', action: 'BUY', ...o });
const TEST_ROWS = [
  // scheduled split, T1 then T2: T1 money recorded (the 3.30 fix)
  PAPER({ id: 'p1', jobId: 'job_52w', screenerName: '52W High Breakout', symbol: 'CDSL', qty: 12, entryPrice: 1588, paperFillPrice: 1588,
    slPrice: 1540.4, splitT1: true, t1Pct: 4, t2Pct: 8, t1Qty: 50, targetMode: 'pct', orderId: 'ENTRY:PAPER-ENTRY-a1|FOREVER:PAPER-FV-1',
    status: 'DHAN TEST ENTRY + 2x FOREVER OCO (T1/T2 split)', mtmT1Done: true, mtmT2Done: true, paperT1Booked: true, splitT1Pnl: 381.12,
    exitType: 'TARGET HIT', result: 'TARGET HIT', exitPrice: 1715.04, realisedPnl: 1143.36, recordedAt: day(9, '10:12'), testClosedAt: day(5, '13:40') }),
  // scheduled single, stopped out
  PAPER({ id: 'p2', jobId: 'job_52w', screenerName: '52W High Breakout', symbol: 'TRENT', qty: 2, entryPrice: 7240, slPrice: 7023,
    targetPrice: 7674, orderId: 'ENTRY:PAPER-ENTRY-a2|FOREVER:PAPER-FV-2', status: 'DHAN TEST ENTRY + FOREVER OCO',
    exitType: 'SL HIT', result: 'SL HIT', exitPrice: 7023, realisedPnl: -434, recordedAt: day(8, '09:41'), testClosedAt: day(7, '10:50') }),
  // an entry that never filled - the simulator's only rejection
  PAPER({ id: 'p3', jobId: 'job_52w', screenerName: '52W High Breakout', symbol: 'CGPOWER', qty: 26, entryPrice: 742, slPrice: 719.7,
    orderId: 'PAPER-ENTRY-a3', status: 'REJECTED (entry expired — no fill, no protection placed)', exitType: 'REJECTED', result: 'REJECTED',
    recordedAt: day(6, '09:35'), testClosedAt: day(6, '15:20') }),
  // Record Test Run rows: TEST- ids, NO jobId, the algo's name on them
  PAPER({ id: 'm1', screenerName: 'EMA Pullback Swing', symbol: 'ULTRACEMCO', qty: 2, entryPrice: 11250, slPrice: 10913, targetPrice: 11925,
    orderId: 'TEST-1760000000000-01', status: 'DHAN TEST ENTRY (manual test run) - no broker order',
    exitType: 'SL HIT', result: 'SL HIT', exitPrice: 10913, realisedPnl: -674, recordedAt: day(4, '10:16'), testClosedAt: day(3, '10:36') }),
  // the scheduled algo of the same name: an open paper position
  PAPER({ id: 'p4', jobId: 'job_ema', screenerName: 'EMA Pullback Swing', symbol: 'SBILIFE', qty: 11, entryPrice: 1795, slPrice: 1741.2,
    targetPrice: 1902.7, orderId: 'ENTRY:PAPER-ENTRY-a4|FOREVER:PAPER-FV-4', status: 'DHAN TEST ENTRY + FOREVER OCO',
    testLtp: 1842, unrealisedPnl: 517, recordedAt: day(2, '09:45'), lastStatusCheckAt: day(0, '10:00') }),
];
const LIVE_ROWS = [
  { id: 'l1', jobId: 'job_swing', screenerName: 'Swing Momentum', symbol: 'TVSMOTOR', qty: 9, entryPrice: 2640, slPrice: 2534.4,
    targetPrice: 2904, broker: 'dhan', orderId: '512600123', status: 'DHAN ENTRY + FOREVER OCO [engine]', exitType: 'TARGET HIT',
    result: 'TARGET HIT', exitPrice: 2904, realisedPnl: 2376, recordedAt: day(10, '09:41'), closedAt: day(4, '13:10') },
  { id: 'l2', jobId: 'job_brt', screenerName: 'Breakout Retest', symbol: 'KEI', qty: 6, entryPrice: 4120, slPrice: 3996.4,
    broker: 'dhan', orderId: '512600124', status: 'REJECTED: insufficient funds', exitType: 'REJECTED', result: 'REJECTED',
    recordedAt: day(3, '09:42') },
];
const JOBS = [
  { id: 'job_52w', config: { algoName: '52W High Breakout' } }, { id: 'job_ema', config: { algoName: 'EMA Pullback Swing' } },
  { id: 'job_swing', config: { algoName: 'Swing Momentum' } }, { id: 'job_brt', config: { algoName: 'Breakout Retest' } },
];

test('the Dashboard opens on Test while there are no live trades yet, and on Live once there are', () => {
  const fresh = makePage({ live: [], test: TEST_ROWS, jobs: JOBS });
  assert.equal(fresh.ctx.dashActiveMode(), 'test');
  const both = makePage({ live: LIVE_ROWS, test: TEST_ROWS, jobs: JOBS });
  assert.equal(both.ctx.dashActiveMode(), 'live');
  both.ctx.__set('dashMode', 'test');
  assert.equal(both.ctx.dashActiveMode(), 'test', 'a click on the switch wins over the default');
  assert.deepEqual(both.ctx.dashRows().map(r => r.id).sort(), TEST_ROWS.map(r => r.id).sort(), 'the test view reads the TEST log');
});

test('test mode never borrows the live ledger’s archived days', () => {
  const rollups = { '2020-01-02': { algos: [{ key: 'job:job_swing', name: 'Swing Momentum', taken: 3, c: 3, w: 2, l: 1, pnl: 999, buckets: { 'Target hit': 2 } }] } };
  const p = makePage({ live: LIVE_ROWS, test: TEST_ROWS, jobs: JOBS, rollups });
  p.ctx.__set('dashRange', 'all');
  assert.equal(p.ctx.dashArchivedOpts().archivedDays, 1, 'live: the archived day merges in');
  p.ctx.__set('dashMode', 'test');
  assert.deepEqual(JSON.parse(JSON.stringify(p.ctx.dashArchivedOpts())), {}, 'test: no archived days, ever');
});

test('the test view says the test thing wherever a live word would be untrue', () => {
  const p = makePage({ live: LIVE_ROWS, test: TEST_ROWS, jobs: JOBS });
  p.ctx.__set('dashMode', 'test');
  p.ctx.renderDashboard();
  const body = p.els['dash-body'].innerHTML, win = p.els['dash-winner'].innerHTML;
  assert.ok(body.includes('paper positions'), 'Open now counts paper positions');
  assert.ok(!body.includes('live positions'));
  assert.ok(body.includes('>Expired unfilled<'), 'the entry that never filled reads as the row does');
  assert.ok(body.includes('manual runs'), 'Record Test Run rows are named as such in By screener');
  assert.ok(win.includes('TEST MODE') && win.includes('expired unfilled, not counted'));
  assert.equal(p.els['dash-test-note'].style.display, '', 'the TEST MODE strip is shown');
  assert.equal(p.els['dash-share-btn'].textContent, 'Share test report');
  const on = p.modeButtons.find(b => b.on);
  assert.equal(on && on.dataset.m, 'test');
  assert.equal(on.pressed, 'true');
  // the T1 card is the RECORDED T1 money, and T2 is the runner only
  assert.ok(body.includes('+Rs.381'), 'Profit - T1 shows the booked T1 money');
  assert.ok(body.includes('+Rs.762'), 'Profit - T2 is the trade minus T1 (1143.36 - 381.12)');
});

test('the live view is unchanged: live words, no strip, Rejected stays Rejected', () => {
  const p = makePage({ live: LIVE_ROWS, test: TEST_ROWS, jobs: JOBS });
  p.ctx.renderDashboard();
  const body = p.els['dash-body'].innerHTML;
  assert.ok(body.includes('>Rejected<'));
  assert.ok(!body.includes('Expired unfilled') && !body.includes('manual runs') && !body.includes('paper positions'));
  assert.equal(p.els['dash-test-note'].style.display, 'none');
  assert.equal(p.els['dash-share-btn'].textContent, 'Share report');
  assert.ok(!p.els['dash-winner'].innerHTML.includes('TEST MODE'));
});

test('the empty test view says how to get test trades', () => {
  const p = makePage({ live: LIVE_ROWS, test: [], jobs: JOBS });
  p.ctx.__set('dashMode', 'test');
  p.ctx.renderDashboard();
  assert.ok(p.els['dash-body'].innerHTML.includes('No test trades in this period'));
});

test('the shared PDF says TEST MODE on its face and is never VERIFIED; the live PDF is unchanged', () => {
  const p = makePage({ live: LIVE_ROWS, test: TEST_ROWS, jobs: JOBS });
  p.ctx.__set('dashMode', 'test');
  const pdf = p.ctx.generateDashPdfString('Asha');
  ['(TEST MODE REPORT)', '(SIMULATED TRADES', 'NO REAL ORDERS)', '(paper positions)', '(Expired unfilled)', '(EMA Pullback Swing \\(manual\\))',
    'no real orders were placed.)', 'assumed to fill at their exact price', '/ExtGState << /GS1 << /Type /ExtGState /ca 0.09 >> >>', 'q /GS1 gs', '(TEST MODE) Tj']
    .forEach(s => assert.ok(pdf.includes(s), 'test PDF carries ' + s));
  assert.ok(!pdf.includes('(VERIFIED)'), 'a test report is never verified');
  // a long name is shortened, never the " (manual)" tag
  const long = makePage({ live: [], test: TEST_ROWS.concat([{ ...TEST_ROWS[3], id: 'm2', symbol: 'TITAN',
    screenerName: 'Momentum Breakout With Volume Confirmation', orderId: 'TEST-1760000000001-01' }]), jobs: JOBS });
  long.ctx.__set('dashMode', 'test');
  const longPdf = long.ctx.generateDashPdfString('Asha');
  assert.ok(/\(Momentum Breakout[^()]*\.\.\. \\\(manual\\\)\) Tj/.test(longPdf), 'the tag survives a long name');
  assert.ok(!pdf.includes('(PERFORMANCE REPORT)'));
  // every text string is latin-1, so the PDF's Helvetica can print it
  assert.ok(!/[^\x00-\xff]/.test(pdf));
  // the xref offsets still point at their objects
  const xref = Number(pdf.slice(pdf.lastIndexOf('startxref') + 10).trim().split(/\s+/)[0]);
  assert.equal(pdf.slice(xref, xref + 4), 'xref');

  p.ctx.__set('dashMode', 'live');
  const live = p.ctx.generateDashPdfString('Asha');
  assert.ok(live.includes('(PERFORMANCE REPORT)') && live.includes('(VERIFIED)'));
  ['TEST MODE', 'ExtGState', 'SIMULATED', 'paper positions', 'manual'].forEach(s => assert.ok(!live.includes(s), 'live PDF has no ' + s));
});

test('the share dialog drops the verified-badge promise in test mode', () => {
  const p = makePage({ live: LIVE_ROWS, test: TEST_ROWS, jobs: JOBS });
  p.ctx.__set('dashMode', 'test');
  p.ctx.openDashShare();
  assert.equal(p.els['dash-share-title'].textContent, 'Share test mode report');
  assert.ok(p.els['dash-share-hint'].innerHTML.includes('marked as simulated'));
  assert.equal(p.els['dash-share-name'].placeholder, 'Shown on the report');
  p.ctx.__set('dashMode', 'live');
  p.ctx.openDashShare();
  assert.equal(p.els['dash-share-name'].placeholder, 'Shown on the report with a verified badge');
});

test('Order Log > Test Mode Log shows the last 30 days with a way into the report, and only on that tab', () => {
  const p = makePage({ live: LIVE_ROWS, test: TEST_ROWS, jobs: JOBS });
  p.ctx.__set('activeLogTab', 'test');
  p.ctx.renderTestLogSummary();
  const box = p.els['log-test-summary'];
  assert.equal(box.style.display, '');
  ['TEST MODE', 'Last 30 days', 'Realised P&amp;L'.replace('&amp;', '&'), 'Win rate', 'Open test report', 'openTestReport()'].forEach(s => assert.ok(box.innerHTML.includes(s), s));
  // the same rows and the same math as the Dashboard's Test view over 30 days
  p.ctx.__set('dashMode', 'test');
  p.ctx.__set('dashRange', '30');
  const R = p.ctx.computeDashReport(p.ctx.dashRows(), p.ctx.dashReportOpts());
  assert.ok(box.innerHTML.includes('>' + p.ctx.laMoney(R.net) + '<'));
  p.ctx.__set('activeLogTab', 'live');
  p.ctx.renderTestLogSummary();
  assert.equal(box.style.display, 'none');
});

test('the switch, the strip and the summary are in the page, wired to the real handlers', () => {
  assert.ok(html.includes('id="dash-mode"') && html.includes("onclick=\"setDashMode('test')\"") && html.includes("onclick=\"setDashMode('live')\""));
  assert.ok(html.includes('id="dash-test-note"') && html.includes('id="log-test-summary"'));
  assert.ok(fnSource('renderLog').includes('renderTestLogSummary();'));
  assert.ok(fnSource('switchLogTab').includes('renderTestLogSummary();'));
  assert.ok(fnSource('openTestReport').includes("goPage('dash')"));
});
