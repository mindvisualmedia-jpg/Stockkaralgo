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
  // Slice 2 fixed the slice-1 known gap: missingPnl now counts exactly the
  // closed rows the figures DROPPED (rowPnlValue null). The blank-but-
  // DERIVABLE loss row l1 is included in the totals, so it is not "missing";
  // the blank split row sp1 is genuinely excluded, so it is.
  assert.equal(REPORT.missingPnl, 1, 'the banner discloses every excluded trade, nothing else');
  const undef = R.computeDashReport([{ ...ROWS[3], id: 'sp2', realisedPnl: undefined }]);
  assert.equal(undef.missingPnl, 1, 'undefined (never-set) P&L counts the same as blank');
});

// ---- slice 2: machine-readable close facts ---------------------------------

test('a stamped exitKind wins over contradictory wording - frozen close-time truth', () => {
  // Text says SL (exitType SL HIT), but the stamp says the trade ended at
  // cost. The bucket must follow the FACT; only display wording follows text.
  const r = { exitType: 'SL HIT', exitKind: 'COST', realisedPnl: 1, qty: 1, entryPrice: 10, exitPrice: 10 };
  assert.equal(R.logOutcomeBucket(r), 'Closed at cost');
  assert.equal(R.rowOutcomeClass(r, 1), 'scratch', 'outcome class follows the same fact');
  // A stale stamp on a REOPENED row must not bucket - state wins above facts.
  assert.equal(R.logOutcomeBucket({ status: 'DHAN ENTRY + FOREVER OCO', exitKind: 'SL' }), '');
  // An unknown kind value falls back to the text path, never crashes.
  assert.equal(R.logOutcomeBucket({ exitType: 'SL HIT', exitKind: 'BOGUS' }), 'SL hit');
});

test('PARITY: for every close shape, stamping deriveExitKind buckets identically to the text path', () => {
  // The whole corpus of closed-row shapes describeLogResult can produce.
  const corpus = [
    { exitType: 'TARGET HIT' },
    { exitType: 'TARGET HIT', splitT1: true, mtmT1Done: true },                    // T1 & T2 booked
    { exitType: 'SL HIT' },
    { exitType: 'SL HIT', splitT1: true, mtmT1Done: true },                        // runner SL
    { exitType: 'SL HIT', splitT1: true, mtmT1Done: true, mtmCostDone: true },     // runner SL at cost
    { exitType: 'EXITED', mtmCostDone: true },
    { exitType: 'EXITED', emaTrailingStatus: 'trail-exit' },
    { exitType: 'SL HIT', emaTrailingEnabled: true, emaTrailingArmedAt: 'x' },
    { exitType: 'EXITED', realisedPnl: -10 },                                      // pnl-sign SL
    { exitType: 'EXITED', realisedPnl: 10 },                                       // closed in profit
    { exitType: 'EXITED' },                                                        // bare closed
    { exitType: 'EXITED', exitPrice: 99, slPrice: 100 },                           // price-evidence SL
    { exitType: 'EXITED', exitPrice: 120, targetPrice: 120 },                      // price-evidence target
    { exitType: 'EXITED', manualClose: true, mtmCostDone: true },
    { exitType: 'EXITED', splitT1: true, mtmT1Done: true, emaTrailingStatus: 'trail-exit' },   // runner trailed out (T2 blank)
    { exitType: 'EOD EXIT' },
    { exitType: 'REJECTED', status: 'REJECTED (entry rejected)' },
    { exitType: 'CANCELLED' },
    { exitType: 'TARGET HIT', exitEstimated: true },
  ];
  corpus.forEach((r, i) => {
    const textBucket = R.logOutcomeBucket(r);                       // no stamp: text path
    const kind = R.deriveExitKind(r);
    const stamped = R.logOutcomeBucket({ ...r, exitKind: kind });   // stamped: fact path
    assert.equal(stamped, textBucket, 'corpus[' + i + '] kind=' + kind + ' text=' + textBucket);
    assert.ok(kind, 'corpus[' + i + '] derives a kind');
  });
});

// ---- slice 3: algo identity by jobId ---------------------------------------

test('RENAME-SAFE: one jobId under two names is ONE algo, shown under the newest name', () => {
  const closedWin = (id, jobId, name, at, pnl) => ({ id, jobId, screenerName: name, exitType: 'TARGET HIT',
    realisedPnl: pnl, qty: 1, entryPrice: 100, exitPrice: 100 + pnl, recordedAt: at, closedAt: at });
  const rows = [
    closedWin('a', 'job-1', 'Giant Ride', '2026-08-01T10:00:00Z', 100),
    closedWin('b', 'job-1', 'Giant Ride v2', '2026-08-15T10:00:00Z', 50),   // renamed since
  ];
  const R1 = R.computeDashReport(rows);
  assert.equal(R1.screeners.length, 1, 'keyed on jobId, not on the name');
  assert.equal(R1.screeners[0].pnl, 150, 'history stays together across the rename');
  assert.equal(R1.screeners[0].name, 'Giant Ride v2', 'newest row names the group');
  // the loaded schedule wins over row history - the algo\'s CURRENT name
  const R2 = R.computeDashReport(rows, { jobNames: { 'job-1': 'Giant Ride FINAL' } });
  assert.equal(R2.screeners[0].name, 'Giant Ride FINAL');
  assert.equal(R2.winner.name, 'Giant Ride FINAL', 'winner card uses the same identity');
});

test('DUPLICATE-SAFE: two jobs on the same screener stay two algos', () => {
  const rows = [
    { id: 'a', jobId: 'job-1', screenerName: 'Giant Ride', exitType: 'TARGET HIT', realisedPnl: 100, qty: 1, entryPrice: 100, exitPrice: 200, recordedAt: '2026-08-01' },
    { id: 'b', jobId: 'job-2', screenerName: 'Giant Ride', exitType: 'SL HIT', realisedPnl: -40, qty: 1, entryPrice: 100, exitPrice: 60, recordedAt: '2026-08-02' },
  ];
  const out = R.computeDashReport(rows);
  assert.equal(out.screeners.length, 2, 'same name, different jobs - separate lines');
  assert.equal(out.screeners.reduce((a, d) => a + d.pnl, 0), out.net, 'still reconciles');
});

test('manual/pre-jobId rows group by name; rows with neither land in Unknown - every row counted', () => {
  const rows = [
    { id: 'a', screenerName: 'Manual Picks', exitType: 'TARGET HIT', realisedPnl: 10, qty: 1, entryPrice: 100, exitPrice: 110 },
    { id: 'b', screenerName: 'Manual Picks', status: 'DHAN ENTRY + FOREVER OCO', unrealisedPnl: 5 },
    { id: 'c', exitType: 'SL HIT', realisedPnl: -5, qty: 1, entryPrice: 100, exitPrice: 95 },
  ];
  const out = R.computeDashReport(rows);
  const names = out.screeners.map(d => d.name).sort();
  assert.deepEqual(names, ['Manual Picks', 'Unknown']);
  assert.equal(out.takenTotal, 3);
  assert.equal(R.algoGroupKey(rows[0]), 'name:Manual Picks');
  assert.equal(R.algoGroupKey(rows[2]), '', 'no identity at all - dashWinner skips, table buckets as Unknown');
});

test('derivePnlSource is a READER: it improves when a reconcile corrects an estimate', () => {
  assert.equal(R.derivePnlSource({ exitType: 'SL HIT', realisedPnl: -50 }), 'fill');
  assert.equal(R.derivePnlSource({ exitType: 'SL HIT', realisedPnl: '', exitPrice: 95, entryPrice: 100, qty: 10 }), 'derived');
  assert.equal(R.derivePnlSource({ exitType: 'SL HIT', realisedPnl: -50, exitEstimated: true }), 'estimate');
  assert.equal(R.derivePnlSource({ exitType: 'SL HIT', realisedPnl: -50, exitEstimated: true, exitCorrectedAt: '2026-08-20' }), 'fill',
    'broker-corrected estimate reads as fill - a stored source would have stayed stale');
  assert.equal(R.derivePnlSource({ exitType: 'SL HIT', realisedPnl: '', splitT1: true }), 'none');
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

// ---- slice 4: the money ledger ---------------------------------------------

test('ledgerCheck: clean fills confirm, a real delta flags, ambiguity NEVER flags', () => {
  const closed = (id, sym, qty, entry, pnl, extra) => ({ id, symbol: sym, qty, entryPrice: entry,
    exitType: 'SL HIT', realisedPnl: pnl, exitPrice: entry + pnl / qty, ...extra });
  const rows = [
    closed('ok1', 'INFY', 10, 100, -50),          // fills agree exactly
    closed('bad1', 'TCS', 10, 100, -20),          // fills say -50: stored is wrong by 30
    closed('est1', 'WIPRO', 5, 200, 25, { exitEstimated: true }),   // no fills visible
    closed('mix1', 'RELIANCE', 10, 100, -50),     // 15 sold at the broker: manual sells mixed in
  ];
  const sells = {
    INFY: [{ qty: 4, px: 95 }, { qty: 6, px: 95 }],          // -50 across two fills
    'NSE:TCS-EQ': [{ qty: 10, px: 95 }],                     // symbol form normalised
    RELIANCE: [{ qty: 15, px: 95 }],
  };
  const out = R.ledgerCheck(rows, sells);
  assert.equal(out.checked, 2, 'INFY and TCS were comparable');
  assert.equal(out.mismatches.length, 1);
  assert.deepEqual(out.mismatches[0], { symbol: 'TCS', ids: ['bad1'], storedPnl: -20, brokerPnl: -50, delta: 30 });
  const reasons = Object.fromEntries(out.unverifiable.map(u => [u.symbol, u.reason]));
  assert.match(reasons.WIPRO, /no SELL fills/);
  assert.match(reasons.RELIANCE, /15 != row qty 10/);
});

test('ledgerCheck: tolerance forgives tick-level noise, and rejected rows are never checked', () => {
  const row = { id: 'a', symbol: 'INFY', qty: 10, entryPrice: 100, exitType: 'SL HIT', realisedPnl: -50, exitPrice: 95 };
  const near = R.ledgerCheck([row], { INFY: [{ qty: 10, px: 95.05 }] });   // broker -49.5, delta 0.5 < Rs.1
  assert.equal(near.mismatches.length, 0);
  assert.equal(near.checked, 1);
  const rej = R.ledgerCheck([{ id: 'r', symbol: 'INFY', qty: 10, entryPrice: 100, exitType: 'REJECTED', status: 'REJECTED (entry rejected)' }],
    { INFY: [{ qty: 10, px: 95 }] });
  assert.equal(rej.checked, 0, 'a rejected row was never a position - nothing to reconcile');
});

test('computeDailyRollups: terminal rows only, bucketed per day per algo, splits carry their booked total', () => {
  const rows = [
    { id: 'a', jobId: 'j1', screenerName: 'Alpha', broker: 'dhan', exitType: 'TARGET HIT', realisedPnl: 100, qty: 1, entryPrice: 100, exitPrice: 200, recordedAt: '2026-08-10T05:00:00Z' },
    { id: 'b', jobId: 'j1', screenerName: 'Alpha', broker: 'dhan', exitType: 'SL HIT', realisedPnl: -40, qty: 1, entryPrice: 100, exitPrice: 60, recordedAt: '2026-08-10T06:00:00Z' },
    { id: 'c', jobId: 'j1', screenerName: 'Alpha', broker: 'dhan', exitType: 'REJECTED', status: 'REJECTED (entry rejected)', recordedAt: '2026-08-10T07:00:00Z' },
    { id: 'd', jobId: 'j2', screenerName: 'Beta', broker: 'zerodha', status: 'ZERODHA ENTRY + GTT OCO', recordedAt: '2026-08-10T07:30:00Z' },   // open: not rolled up
    { id: 'e', jobId: 'j1', screenerName: 'Alpha', broker: 'dhan', exitType: 'EXITED', mtmCostDone: true, realisedPnl: 1, qty: 1, entryPrice: 100, exitPrice: 101, recordedAt: '2026-08-11T05:00:00Z' },
    { id: 't', testMode: true, exitType: 'TARGET HIT', realisedPnl: 5, qty: 1, entryPrice: 10, exitPrice: 15, recordedAt: '2026-08-11T05:00:00Z' },
  ];
  const days = R.computeDailyRollups(rows);
  assert.deepEqual(Object.keys(days).sort(), ['2026-08-10', '2026-08-11']);
  const d10 = days['2026-08-10'].algos;
  assert.equal(d10.length, 1, 'open row and its algo are absent; test rows excluded');
  assert.equal(d10[0].key, 'job:j1');
  assert.deepEqual({ taken: d10[0].taken, c: d10[0].c, w: d10[0].w, l: d10[0].l, pnl: d10[0].pnl }, { taken: 2, c: 2, w: 1, l: 1, pnl: 60 });
  assert.equal(d10[0].buckets['Rejected'], 1, 'rejected is bucketed but never taken');
  assert.equal(days['2026-08-11'].algos[0].buckets['Closed at cost'], 1);
});

test('archived days merge into every summable figure and the table still reconciles', () => {
  const live = [
    { id: 'a', jobId: 'j1', screenerName: 'Alpha', exitType: 'TARGET HIT', realisedPnl: 100, qty: 1, entryPrice: 100, exitPrice: 200, recordedAt: '2026-08-15T05:00:00Z', closedAt: '2026-08-15T06:00:00Z' },
  ];
  const store = {
    '2026-08-01': { algos: [{ key: 'job:j1', name: 'Alpha', taken: 3, c: 3, w: 1, l: 1, scr: 1, pnl: 20, buckets: { 'Target hit': 1, 'SL hit': 1, 'Closed at cost': 1 } }] },
    '2026-08-02': { algos: [{ key: 'job:j9', name: 'Gone Algo', taken: 1, c: 1, w: 1, l: 0, scr: 0, pnl: 30, buckets: { 'Target hit': 1 } }] },
    '2026-08-15': { algos: [{ key: 'job:j1', name: 'Alpha', taken: 9, c: 9, w: 9, l: 0, scr: 0, pnl: 999, buckets: {} }] },   // live day: MUST be excluded
  };
  const { archived, archivedDays } = R.rollupsToArchived(store, { excludeDates: new Set(['2026-08-15']) });
  assert.equal(archivedDays, 2, 'the live day is skipped - nothing counts twice');
  const out = R.computeDashReport(live, { archived, archivedDays });
  assert.equal(out.net, 150, '100 live + 20 + 30 archived');
  assert.equal(out.closed, 5);
  assert.equal(out.total, 5, 'one live row + four archived taken');
  assert.equal(out.wins, 3); assert.equal(out.losses, 1); assert.equal(out.flat, 1);
  assert.equal(out.wr, 60, '3 of 5 with the archived scratch still in the denominator');
  assert.equal(out.buckets['Target hit'], 3);
  assert.equal(out.archivedDays, 2);
  const alpha = out.screeners.find(d => d.key === 'job:j1');
  assert.equal(alpha.pnl, 120, 'archived merges INTO the live line, not beside it');
  assert.equal(out.screeners.find(d => d.key === 'job:j9').name, 'Gone Algo', 'a deleted algo survives via its rollup');
  const tableTotal = out.screeners.reduce((a, d) => a + d.pnl, 0);
  assert.equal(Math.round(tableTotal * 100) / 100, out.net, 'the reconcile invariant holds across the merge');
});

test('unrealAsOf: the newest measurement among contributing open rows; ledger flags are counted', () => {
  const rows = [
    { id: 'a', status: 'DHAN ENTRY + FOREVER OCO', unrealisedPnl: 10, lastStatusCheckAt: '2026-08-20T09:00:00.000Z' },
    { id: 'b', status: 'DHAN ENTRY + FOREVER OCO', unrealisedPnl: -5, lastStatusCheckAt: '2026-08-20T10:30:00.000Z' },
    { id: 'c', status: 'DHAN ENTRY + FOREVER OCO' },   // unmeasured: contributes no timestamp
    { id: 'd', exitType: 'SL HIT', realisedPnl: -50, qty: 1, entryPrice: 100, exitPrice: 50, pnlMismatch: { delta: 30 } },
  ];
  const out = R.computeDashReport(rows);
  assert.equal(out.unrealAsOf, '2026-08-20T10:30:00.000Z');
  assert.equal(out.pnlMismatchN, 1);
  assert.equal(R.computeDashReport([rows[2]]).unrealAsOf, '', 'no measurement, no claim');
});
