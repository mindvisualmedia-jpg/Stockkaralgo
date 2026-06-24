'use strict';
// Tests for computeSplitBracket — the pure decision/quantities for the
// "split T1 at broker" two-OCO bracket. No live I/O.

const { computeSplitBracket, resolveSplitExit, resolveSplitFromFills } = require('./mtm');

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error('FAIL: ' + msg + '\n  expected ' + e + '\n  got      ' + a); }
}
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error('FAIL: ' + msg); } }

// Base: entry 100, SL 97, qty 100, T1 +3% (book 50%), T2 +6%.
const base = { entryPrice: 100, slPrice: 97, qty: 100, t1Pct: 3, t1Qty: 50, t2Pct: 6, action: 'BUY' };

const r = computeSplitBracket(base);
ok(r.split === true, 'clean 50/50 split is allowed');
eq(r.legA, { kind: 'T1', qty: 50, target: 103, sl: 97 }, 'legA = 50 @ T1(103) + SL(97)');
eq(r.legB, { kind: 'T2', qty: 50, target: 106, sl: 97 }, 'legB = 50 @ T2(106) + SL(97)');
ok(r.legA.qty + r.legB.qty === base.qty, 'legs sum to full qty (no shares lost)');
ok(r.legA.sl === r.legB.sl, 'both legs carry the same SL (an SL hit exits both)');

// Uneven %: 30% of 100 = 30 / 70.
eq(computeSplitBracket({ ...base, t1Qty: 30 }).legA.qty, 30, '30% -> bookQty 30');
eq(computeSplitBracket({ ...base, t1Qty: 30 }).legB.qty, 70, '30% -> runner 70');

// Rounding: 33% of 10 = 3 (floor) / 7.
const r10 = computeSplitBracket({ ...base, qty: 10, t1Qty: 33 });
eq([r10.legA.qty, r10.legB.qty], [3, 7], '33% of 10 floors to 3/7');

// --- Fallbacks (split:false => caller uses single OCO) ---
ok(computeSplitBracket({ ...base, qty: 1 }).split === false, 'qty 1 cannot split');
ok(computeSplitBracket({ ...base, t1Qty: 100 }).split === false, '100% at T1 is not a partial split');
ok(computeSplitBracket({ ...base, t1Qty: 0 }).split === false, 'no T1 qty% -> no split');
ok(computeSplitBracket({ ...base, qty: 2, t1Qty: 10 }).split === false, '10% of 2 rounds legA to 0 -> fallback');
ok(computeSplitBracket({ ...base, t1Pct: 0, t1RR: 0 }).split === false, 'no T1 target -> no split');
ok(computeSplitBracket({ ...base, t2Pct: 0, t2RR: 0 }).split === false, 'no T2 target -> no split');
ok(computeSplitBracket({ ...base, slPrice: 101 }).split === false, 'SL above entry -> not splittable');
// T1 must be below T2.
ok(computeSplitBracket({ ...base, t1Pct: 6, t2Pct: 6 }).split === false, 'T1 == T2 -> no split');

// qty 2, 50% -> 1/1 is the smallest valid split.
const r2 = computeSplitBracket({ ...base, qty: 2, t1Qty: 50 });
eq([r2.split, r2.legA.qty, r2.legB.qty], [true, 1, 1], 'qty 2 @ 50% -> 1/1 valid');

// --- resolveSplitExit: closure decision + combined P&L ---
// entry 100, SL 97, T1 103, T2 106, 50/50.
const px = { entryPrice: 100, slPrice: 97, t1Price: 103, t2Price: 106, aQty: 50, bQty: 50 };

// legB not resolved yet -> still open; t1Booked reflects legA.
eq(resolveSplitExit({ ...px, aState: 'pending', bState: 'pending' }), { t1Booked: false, closed: false }, 'both pending -> open');
eq(resolveSplitExit({ ...px, aState: 'target', bState: 'pending' }), { t1Booked: true, closed: false }, 'T1 hit, runner open -> t1Booked, not closed');

// Full stop before T1: both SL.
eq(resolveSplitExit({ ...px, aState: 'sl', bState: 'sl' }),
   { t1Booked: false, closed: true, exitType: 'SL HIT', exitPrice: 97, realisedPnl: -300 }, 'both SL -> SL HIT, -300');

// Ran all the way: T1 then T2.
eq(resolveSplitExit({ ...px, aState: 'target', bState: 'target' }),
   { t1Booked: true, closed: true, exitType: 'TARGET HIT', exitPrice: 106, realisedPnl: 450 }, 'T1+T2 -> TARGET HIT, +450');

// T1 booked, runner stopped at cost (SL moved to 100 after T1).
eq(resolveSplitExit({ ...px, slPrice: 100, aState: 'target', bState: 'sl' }),
   { t1Booked: true, closed: true, exitType: 'EXITED', exitPrice: 100, realisedPnl: 150 }, 'T1 + runner at cost -> EXITED, +150');

// legA vanished but T2 filled -> infer legA was the T1 target.
eq(resolveSplitExit({ ...px, aState: 'absent', bState: 'target' }),
   { t1Booked: false, closed: true, exitType: 'TARGET HIT', exitPrice: 106, realisedPnl: 450 }, 'absent legA + T2 -> infer T1 target, +450');

// legA vanished + runner SL -> full stop.
eq(resolveSplitExit({ ...px, aState: 'absent', bState: 'sl' }),
   { t1Booked: false, closed: true, exitType: 'SL HIT', exitPrice: 97, realisedPnl: -300 }, 'absent legA + runner SL -> SL HIT');

// Uses actual fill px when provided (slippage/gap).
eq(resolveSplitExit({ ...px, aState: 'target', aPx: 103.5, bState: 'target', bPx: 107 }),
   { t1Booked: true, closed: true, exitType: 'TARGET HIT', exitPrice: 107, realisedPnl: Number(((103.5-100)*50 + (107-100)*50).toFixed(2)) }, 'uses real fill px when known');

// --- resolveSplitFromFills (FYERS-style, order-book fills) ---
// entry 100, book 50 / runner 50.
const fp = { entryPrice: 100, bookQty: 50, runnerQty: 50 };

eq(resolveSplitFromFills([], fp), { t1Booked: false, closed: false, soldQty: 0, realisedPnl: 0 }, 'no fills -> open');

// T1 booked: 50 sold at 103 (above entry), runner still open.
eq(resolveSplitFromFills([{ qty: 50, price: 103 }], fp),
   { t1Booked: true, closed: false, soldQty: 50, realisedPnl: 150 }, 'partial profit fill -> t1Booked, +150 so far');

// Full stop: both halves at 97.
eq(resolveSplitFromFills([{ qty: 50, price: 97 }, { qty: 50, price: 97 }], fp),
   { t1Booked: false, closed: true, exitType: 'SL HIT', exitPrice: 97, realisedPnl: -300, soldQty: 100 }, 'both at SL -> SL HIT, -300');

// Ran out: T1 at 103 then runner at 106.
eq(resolveSplitFromFills([{ qty: 50, price: 103 }, { qty: 50, price: 106 }], fp),
   { t1Booked: false, closed: true, exitType: 'TARGET HIT', exitPrice: 106, realisedPnl: 450, soldQty: 100 }, 'T1+T2 -> TARGET HIT, +450');

// T1 booked then runner stopped at cost (100).
eq(resolveSplitFromFills([{ qty: 50, price: 103 }, { qty: 50, price: 100 }], fp),
   { t1Booked: false, closed: true, exitType: 'EXITED', exitPrice: 100, realisedPnl: 150, soldQty: 100 }, 'T1 + runner at cost -> EXITED, +150');

// Ignores junk fills (zero qty/price).
eq(resolveSplitFromFills([{ qty: 0, price: 0 }, { qty: 50, price: 103 }], fp).soldQty, 50, 'junk fills ignored');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
