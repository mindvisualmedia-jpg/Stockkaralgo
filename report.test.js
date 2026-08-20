'use strict';
// report.test.js — golden fixtures for report.js (REPORT-PLAN R6, slice 1).
// This is the money-math every user READS: the Dashboard, the analytics band,
// the PDF and the row P&L cells all derive from these functions. Until this
// file existed it was the only money-math in the product with zero tests.
//
// The fixtures pin the INVARIANTS the surfaces rely on, each one a rule that
// was once broken in production (the comments in report.js tell the stories):
//   - the "By screener" table total reconciles with the headline net
//   - blank P&L means ABSENT, never Rs.0
//   - a split row's one-leg exitPrice is never derived into a P&L
//   - banked T1 on an open split is counted exactly once (realised side)
//   - breakeven-at-cost is a scratch, and scratches stay in the denominator
//   - drawdown orders by CLOSE time and excludes (but counts) undated rows
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('./report.js');

// A realistic mixed book. Every row exercises a distinct rule.
const ROWS = [
  // 1. plain closed win, stored P&L (broker fill truth)
  { id: 'w1', screenerName: 'Alpha', exitType: 'TARGET HIT', realisedPnl: 500, qty: 10,
    entryPrice: 100, exitPrice: 150, targetPrice: 150, closedAt: '2026-08-10T10:00:00Z' },
  // 2. closed loss, BLANK stored P&L but derivable from exit x qty
  { id: 'l1', screenerName: 'Alpha', exitType: 'SL HIT', realisedPnl: '', qty: 10,
    entryPrice: 100, exitPrice: 95, slPrice: 95, closedAt: '2026-08-11T10:00:00Z' },
  // 3. closed at cost after a cost-move -> SCRATCH, and "loss saved" credit
  { id: 's1', screenerName: 'Alpha', exitType: 'EXITED', realisedPnl: 2, qty: 10,
    entryPrice: 100, exitPrice: 100.2, slPrice: 100, slPriceOriginal: 95, mtmCostDone: true,
    closedAt: '2026-08-12T10:00:00Z' },
  // 4. closed SPLIT row with a one-leg exitPrice and NO stored P&L:
  //    deriving (exit-entry) x qty would lie, so it must stay excluded
  { id: 'sp1', screenerName: 'Beta', exitType: 'SL HIT', realisedPnl: '', qty: 10, splitT1: true,
    entryPrice: 100, exitPrice: 100, closedAt: '2026-08-12T11:00:00Z' },
  // 5. OPEN split with T1 banked: Rs.120 realised on the booked leg, runner live
  { id: 'o1', screenerName: 'Beta', status: 'DHAN ENTRY + 2x FOREVER OCO (T1/T2 split)', qty: 10,
    splitT1: true, mtmT1Done: true, splitT1Pnl: 120, unrealisedPnl: 170, entryPrice: 100 },
  // 6. plain open row, live unrealised
  { id: 'o2', screenerName: 'Alpha', status: 'FYERS ENTRY + GTT OCO', qty: 5,
    unrealisedPnl: -30, entryPrice: 200 },
  // 7. exit-pending: still holds the position -> open aggregates
  { id: 'x1', screenerName: 'Alpha', status: 'EXIT PENDING — SELL working', exitPending: true,
    qty: 5, unrealisedPnl: 10, entryPrice: 50 },
  // 8. rejected at entry: never a position, never "taken"
  { id: 'r1', screenerName: 'Alpha', exitType: 'REJECTED', status: 'REJECTED (entry rejected)' },
  // 9. closed win with an ESTIMATED exit (no broker fill seen) and NO close stamp
  { id: 'e1', screenerName: 'Gamma', exitType: 'TARGET HIT', realisedPnl: 80, qty: 4,
    entryPrice: 100, exitPrice: 120, exitEstimated: true },
];
const REPORT = R.computeDashReport(ROWS);

test('headline net = closed P&L + banked T1, and the screener table reconciles with it', () => {
  // closed: 500 + (-50 derived) + 2 scratch = 452 ... +80 estimated = 532; banked T1 +120
  assert.equal(REPORT.net, 652);
  const tableTotal = REPORT.screeners.reduce((a, d) => a + d.pnl, 0);
  assert.equal(Math.round(tableTotal * 100) / 100, REPORT.net,
    'the By screener total must equal the headline (the 2026-08 reconcile bug)');
});

test('blank realisedPnl is ABSENT, not Rs.0 - derived only when the numbers exist', () => {
  assert.equal(R.rowPnlValue({ exitType: 'EXITED', realisedPnl: '' }), null);
  const d = R.rowRealisedPnl(ROWS[1]);
  assert.deepEqual(d, { value: -50, derived: true }, 'blank-but-derivable states its real value');
  assert.equal(R.rowRealisedPnl({ exitType: 'REJECTED', exitPrice: 95, entryPrice: 100, qty: 10 }), null,
    'a rejected row is never derived - it was never a position');
});

test('a split row is NEVER derived from its one-leg exit price', () => {
  assert.equal(R.rowPnlValue(ROWS[3]), null);
  // KNOWN GAP (found writing this test, fix in slice 2): missingPnl counts
  // rows via num(), and Number('') === 0 - so a closed row with a BLANK
  // realisedPnl is excluded from every total (rowPnlValue null, correct)
  // yet NOT counted by the "excluded from every P&L figure above" banner.
  // sp1 and l1 are both blank ('') so today's banner says 0. The honest
  // predicate is rowPnlValue(r) === null on rows the figures really dropped.
  assert.equal(REPORT.missingPnl, 0, 'pins the CURRENT undercount, see gap note');
  const undef = R.computeDashReport([{ ...ROWS[3], id: 'sp2', realisedPnl: undefined }]);
  assert.equal(undef.missingPnl, 1, 'an undefined (never-set) P&L IS counted today');
});

test('banked T1 on an open split counts ONCE: on the realised side, subtracted from unrealised', () => {
  assert.equal(REPORT.bankedOpen, 120);
  assert.equal(REPORT.bankedOpenN, 1);
  // unrealised: 170 (contains the fold-in) - 120 banked + (-30) + 10 = 30
  assert.equal(REPORT.unreal, 30);
  assert.ok(REPORT.hasUnreal);
});

test('breakeven-at-cost is a scratch; win rate keeps scratches in the denominator', () => {
  assert.equal(R.rowOutcomeClass(ROWS[2], 2), 'scratch', 'mtmCostDone beats the +Rs.2 sign');
  assert.equal(REPORT.wins, 2);      // w1, e1
  assert.equal(REPORT.losses, 1);    // l1 (derived)
  assert.equal(REPORT.flat, 1);      // s1
  assert.equal(REPORT.wr, 50, '2 of 4 priced closed made money - never 2 of 3');
  assert.equal(R.winRateOf(0, 0, 0), null, 'no trades -> null, not 0%');
});

test('open/exit-pending/rejected classification drives every aggregate', () => {
  assert.equal(REPORT.openN, 3, 'open + open-split + exit-pending all hold positions');
  assert.equal(REPORT.closed, 4, 'priced closed only (the split row is closed but unpriced)');
  assert.equal(REPORT.takenTotal, 8, 'rejected is not taken');
  assert.equal(REPORT.buckets['Rejected'], 1);
  assert.equal(REPORT.buckets['SL hit'], 2, 'plain SL + split runner SL');
  assert.equal(REPORT.buckets['Closed at cost'], 1);
  assert.equal(REPORT.buckets['Target hit'], 2);
  const bucketed = Object.values(REPORT.buckets).reduce((a, b) => a + b, 0);
  assert.equal(bucketed, 6, 'every terminal row lands in exactly one bucket');
});

test('estimates are surfaced, never silently mixed into truth', () => {
  assert.equal(REPORT.estimatedN, 1, 'e1 has an estimated exit and no correction');
  assert.equal(R.computeDashReport([{ ...ROWS[8], exitCorrectedAt: '2026-08-13T00:00:00Z' }]).estimatedN, 0,
    'a broker-corrected exit stops counting as an estimate');
});

test('drawdown uses CLOSE-time order and excludes-but-counts undated rows', () => {
  assert.equal(REPORT.undated, 1, 'e1 has no close stamp');
  // dated sequence by closedAt: +500, -50, +2 -> peak 500, trough 450 -> dd 50
  assert.equal(REPORT.dd, 50);
  assert.ok(REPORT.hasDd);
  const empty = R.computeDashReport([ROWS[7]]);
  assert.equal(empty.hasDd, false, 'no dated closes -> no drawdown claim');
});

test('feature attribution: loss saved only on at-cost ends; banked T1 is an actual, not an estimate', () => {
  assert.equal(REPORT.costN, 1);
  assert.equal(REPORT.costSaved, (100 - 95) * 10, 'vs the ORIGINAL stop, not the moved one');
  assert.equal(REPORT.t1N, 1, 'the open split with a booked leg');
  assert.equal(REPORT.t1Profit, 120);
  assert.equal(REPORT.t1EstN, 0, 'splitT1Pnl is a fill - not an estimate');
});

test('dashWinner: rejected rows do not count, and a winner must have positive P&L', () => {
  const w = REPORT.winner;
  assert.ok(w && w.name === 'Alpha');
  assert.equal(w.taken, 5, 'Alpha: w1,l1,s1,o2,x1 - the rejected row is not taken');
  assert.equal(w.rejected, 1);
  assert.equal(R.computeDashReport([ROWS[1]]).winner, null, 'an all-loss book crowns nobody');
});

test('exit-pending rows still block deletion (logRowTerminal) and read as their own state', () => {
  assert.equal(R.logRowState(ROWS[6]), 'exit-pending');
  assert.equal(R.logRowTerminal(ROWS[6]), false, 'the position is still held at the broker');
  assert.equal(R.logRowTerminal(ROWS[0]), true);
  assert.equal(R.logRowTerminal(ROWS[7]), true);
});
