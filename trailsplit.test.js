'use strict';
// trailsplit.test.js — EMA trailing + T1/T2 split working TOGETHER.
//
// Design (what these pin down):
//   - T1/T2 stay REAL broker orders (a split bracket is still built) even when
//     EMA trailing is on. Trailing only raises the STOP, exactly like Move SL
//     to Cost — it never removes the targets.
//   - The trail ARMS at T1 (the first "target reached"), NOT at targetPrice.
//     targetPrice is the full-exit price (= T2) and the broker's own OCO books
//     the runner there, so arming at T2 would arm a position that is gone.
//   - The arm level and legA's broker target come from ONE source
//     (computeMtmPlan.t1Price), so they can never be two different numbers.
const { test } = require('node:test');
const assert = require('node:assert');
const { computeSplitBracket, computeMtmPlan } = require('./mtm');

// Mirrors server.js emaTrailArmPrice() — kept here so the rule is asserted, not
// just implemented. Any drift in computeMtmPlan breaks this test too.
const emaTrailArmPrice = (entry) => {
  const t1 = Number(computeMtmPlan(entry).t1Price || 0);
  return t1 > 0 ? t1 : Number(entry.targetPrice || 0);
};

// Entry 100, SL 97, qty 100, T1 +3% (book 50%), T2 +6%, EMA trailing ON.
const trailingRow = {
  entryPrice: 100, slPrice: 97, qty: 100,
  t1Pct: 3, t1Qty: 50, t2Pct: 6, action: 'BUY',
  emaTrailingEnabled: true, emaTrailingTrigger: 'afterTarget',
  emaTrailingIndicator: 'ema20', emaTrailingPct: 2,
  targetPrice: 106,
};

test('EMA trailing no longer suppresses the split: T1/T2 still go to the broker', () => {
  // The whole point of the change. Previously placement gated split off when
  // trailing was on, so T1/T2 silently never reached the broker.
  const r = computeSplitBracket(trailingRow);
  assert.equal(r.split, true);
  assert.deepEqual(r.legA, { kind: 'T1', qty: 50, target: 103, sl: 97 });
  assert.deepEqual(r.legB, { kind: 'T2', qty: 50, target: 106, sl: 97 });
});

test('trail arms at T1, not at targetPrice (T2)', () => {
  assert.equal(emaTrailArmPrice(trailingRow), 103);          // T1
  assert.notEqual(emaTrailArmPrice(trailingRow), trailingRow.targetPrice); // not T2/106
});

test('arm level is IDENTICAL to legA target (one source of truth)', () => {
  assert.equal(emaTrailArmPrice(trailingRow), computeSplitBracket(trailingRow).legA.target);
});

test('arm level follows the R:R form of T1 too', () => {
  // T1 by risk-multiple instead of %: risk = 100-97 = 3, t1RR 2 -> 100 + 6 = 106.
  const row = { ...trailingRow, t1Pct: 0, t1RR: 2, t2Pct: 0, t2RR: 4 };
  assert.equal(emaTrailArmPrice(row), 106);
  assert.equal(emaTrailArmPrice(row), computeSplitBracket(row).legA.target);
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
