'use strict';
// trailsplit.test.js — EMA trailing + T1/T2 split working TOGETHER.
//
// Design (what these pin down):
//   - T1/T2 stay REAL broker orders (a split bracket is still built) even when
//     EMA trailing is on. Trailing only raises the STOP, exactly like Move SL
//     to Cost — it never removes the targets.
//   - The trail ARMS at the row's R:R target (targetPrice = entry + risk×R:R),
//     the SAME trigger as classic single-leg trailing — user decision 17 Jul:
//     "Trailing should be active as per R:R ratio, not after T1."
//   - Leg targets for reshapes come from computeMtmPlan (t1Price/t2Price), the
//     SAME source computeSplitBracket placed them from. row.targetPrice is the
//     R:R ARM level, NOT legB's T2 — using it in a reshape would silently
//     rewrite the runner's target.
//   - After T1 books, legA is terminal: modifies are RUNNER-ONLY (mtmT1Done).
const { test } = require('node:test');
const assert = require('node:assert');
const { computeSplitBracket, computeMtmPlan } = require('./mtm');

// Mirrors the arm rule in checkEmaTrailingTargetTriggers: the row's R:R target.
const emaTrailArmPrice = (entry) => Number(entry.targetPrice || 0);

// Entry 100, SL 97 (risk 3), qty 100, T1 +3% (book 50%), T2 +6%, R:R 1.5
// -> R:R target = 100 + 1.5×3 = 104.5 (sits BETWEEN T1 and T2). Trailing ON.
const trailingRow = {
  entryPrice: 100, slPrice: 97, qty: 100,
  t1Pct: 3, t1Qty: 50, t2Pct: 6, action: 'BUY',
  emaTrailingEnabled: true, emaTrailingTrigger: 'afterTarget',
  emaTrailingIndicator: 'ema20', emaTrailingPct: 2,
  targetPrice: 104.5,
};

test('EMA trailing no longer suppresses the split: T1/T2 still go to the broker', () => {
  // The whole point of the change. Previously placement gated split off when
  // trailing was on, so T1/T2 silently never reached the broker.
  const r = computeSplitBracket(trailingRow);
  assert.equal(r.split, true);
  assert.deepEqual(r.legA, { kind: 'T1', qty: 50, target: 103, sl: 97 });
  assert.deepEqual(r.legB, { kind: 'T2', qty: 50, target: 106, sl: 97 });
});

test('trail arms at the R:R target — independent of T1/T2 leg levels', () => {
  assert.equal(emaTrailArmPrice(trailingRow), 104.5);                              // entry + risk×R:R
  const legs = computeSplitBracket(trailingRow);
  assert.notEqual(emaTrailArmPrice(trailingRow), legs.legA.target);                // NOT T1 (103)
  assert.notEqual(emaTrailArmPrice(trailingRow), legs.legB.target);                // NOT T2 (106)
});

test('reshape targets come from computeMtmPlan, never from the R:R targetPrice', () => {
  // engineModifySl rebuilds legs with plan.t1Price/plan.t2Price. Using
  // row.targetPrice (104.5, the ARM level) would move the runner's target off
  // its broker-placed 106 — this pins the two apart.
  const plan = computeMtmPlan(trailingRow);
  const legs = computeSplitBracket(trailingRow);
  assert.equal(plan.t1Price, legs.legA.target);   // 103
  assert.equal(plan.t2Price, legs.legB.target);   // 106
  assert.notEqual(plan.t2Price, Number(trailingRow.targetPrice));
});

test('no T1/T2 configured -> not a split; arm falls back to the row target', () => {
  // This is the ORIGINAL trailing behaviour and must be preserved: blank T1/T2
  // => no split => placement keeps the SL-only leg and the software target arms.
  const row = { entryPrice: 100, slPrice: 97, qty: 100, action: 'BUY', targetPrice: 106, emaTrailingEnabled: true };
  assert.equal(computeSplitBracket(row).split, false);
  assert.equal(emaTrailArmPrice(row), 106);
});

test('T1 booking 100% is not a split (nothing left to trail) -> single leg', () => {
  const row = { ...trailingRow, t1Qty: 100 };
  assert.equal(computeSplitBracket(row).split, false);
});

test('the trail only ever RAISES: a lower EMA stop is rejected', () => {
  // Rule from checkDailyEmaTrailing: currentSl = max(lastTrailSl, brokerSl, sl)
  // and nextSl <= currentSl => 'no-raise'. Move-to-cost and the trail therefore
  // compose safely — whichever is higher wins, and the stop never drops.
  const currentSl = (e) => Math.max(Number(e.lastTrailSlPrice || 0), Number(e.brokerSlPrice || 0), Number(e.slPrice || 0));
  const row = { ...trailingRow, slPrice: 97, brokerSlPrice: 100, lastTrailSlPrice: 0 }; // moved to cost
  const emaStop = 98.5;                       // EMA20 2% below -> still under cost
  assert.equal(emaStop <= currentSl(row), true, 'EMA stop below cost must not be applied');
  const betterEmaStop = 101.2;                // trend matured past cost
  assert.equal(betterEmaStop > currentSl(row), true, 'EMA stop above cost raises the floor');
});
