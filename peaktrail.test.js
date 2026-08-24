'use strict';
// Target trailing ("peak trail"): once the R:R target arms the position, the
// stop follows the HIGH-WATER MARK minus a give-back %, instead of booking at
// the target. The user's case: entry 100, target 5% (=105), price runs to 110,
// give-back 2% -> stop 107.80.
//
// The other half of this suite is a guard: EMA trailing must be untouched, so
// every EMA assertion below reproduces the exact arithmetic the old inline
// expression used (ema * (1 - pct/100)).
const test = require('node:test');
const assert = require('node:assert');
const { computeTrailStop, nextTrailPeak } = require('./mtm');

// ---------------------------------------------------------------- peak mode
test('peak trail: the user scenario end to end', () => {
  const pct = 2;
  let peak = 0;
  // target armed at 105, then the run-up
  [105, 107, 110, 108.4].forEach(ltp => { peak = nextTrailPeak(peak, ltp); });
  assert.strictEqual(peak, 110, 'peak holds the high, not the last price');
  assert.strictEqual(computeTrailStop({ mode: 'peak', peak, pct }), 107.8);
});

test('peak trail: peak never falls, so the stop never falls', () => {
  let peak = nextTrailPeak(0, 110);
  const first = computeTrailStop({ mode: 'peak', peak, pct: 2 });
  peak = nextTrailPeak(peak, 104);          // price pulls back hard
  const after = computeTrailStop({ mode: 'peak', peak, pct: 2 });
  assert.strictEqual(peak, 110);
  assert.strictEqual(after, first, 'a pullback must not lower the trail');
});

test('peak trail: a new high raises the stop', () => {
  let peak = nextTrailPeak(0, 110);
  assert.strictEqual(computeTrailStop({ mode: 'peak', peak, pct: 2 }), 107.8);
  peak = nextTrailPeak(peak, 120);
  assert.strictEqual(computeTrailStop({ mode: 'peak', peak, pct: 2 }), 117.6);
});

test('peak trail: give-back of 0 trails exactly at the peak', () => {
  assert.strictEqual(computeTrailStop({ mode: 'peak', peak: 110, pct: 0 }), 110);
});

test('peak trail: ignores the EMA entirely', () => {
  // EMA far below; peak mode must not consult it.
  assert.strictEqual(computeTrailStop({ mode: 'peak', peak: 110, ema: 50, pct: 2 }), 107.8);
});

// ------------------------------------------------- EMA mode MUST NOT CHANGE
test('ema trail: same maths as the original inline expression', () => {
  const cases = [[100, 2], [318.4, 1.5], [1214, 3.6], [96.2, 0.5]];
  for (const [ema, pct] of cases) {
    const legacy = Math.round(ema * (1 - pct / 100) * 100) / 100;
    assert.strictEqual(computeTrailStop({ mode: 'ema', ema, pct }), legacy);
  }
});

test('ema trail: a row with NO trailMode behaves as ema (back-compat)', () => {
  assert.strictEqual(computeTrailStop({ mode: undefined, ema: 100, peak: 999, pct: 2 }), 98);
  assert.strictEqual(computeTrailStop({ mode: '', ema: 100, peak: 999, pct: 2 }), 98);
});

test('ema trail: ignores the peak entirely', () => {
  assert.strictEqual(computeTrailStop({ mode: 'ema', ema: 100, peak: 500, pct: 2 }), 98);
});

// ------------------------------------------------------------------ guards
test('trail stop: unusable inputs return NaN, never a bogus price', () => {
  assert.ok(Number.isNaN(computeTrailStop({ mode: 'peak', peak: 0, pct: 2 })));
  assert.ok(Number.isNaN(computeTrailStop({ mode: 'ema', ema: NaN, pct: 2 })));
  assert.ok(Number.isNaN(computeTrailStop({ mode: 'peak', peak: 110, pct: NaN })));
  assert.ok(Number.isNaN(computeTrailStop({ mode: 'peak', peak: 110, pct: -1 })));
  assert.ok(Number.isNaN(computeTrailStop({ mode: 'ema', ema: -5, pct: 2 })));
});

test('nextTrailPeak: tolerates junk and never regresses', () => {
  assert.strictEqual(nextTrailPeak(undefined, 100), 100);
  assert.strictEqual(nextTrailPeak(100, undefined), 100);
  assert.strictEqual(nextTrailPeak(100, 0), 100);
  assert.strictEqual(nextTrailPeak(0, 0), 0);
  assert.strictEqual(nextTrailPeak('110', 105), 110);
});

// ------------------------------------------------------------------ step trail
// STEP (2026-08-24): "for every X% profit, trail SL by X%". Whole steps of the
// high-water mark over ENTRY lift the stop X% OF ENTRY above the ORIGINAL stop.
test('step trail: entry 100 / SL 95 / 1% steps - +3.5% = 3 steps -> 98, +10% -> 105 (profit locked)', () => {
  assert.strictEqual(computeTrailStop({ mode: 'step', entry: 100, slOrig: 95, pct: 1, peak: 103.5 }), 98);
  assert.strictEqual(computeTrailStop({ mode: 'step', entry: 100, slOrig: 95, pct: 1, peak: 110 }), 105);
});
test('step trail: whole steps only - below the first step there is NO move', () => {
  assert.ok(Number.isNaN(computeTrailStop({ mode: 'step', entry: 100, slOrig: 95, pct: 1, peak: 100.9 })));
  assert.strictEqual(computeTrailStop({ mode: 'step', entry: 100, slOrig: 95, pct: 2, peak: 103.9 }), 97, '3.9% at 2% steps = 1 whole step');
});
test('step trail: an exact step boundary counts (float-safe)', () => {
  assert.strictEqual(computeTrailStop({ mode: 'step', entry: 100, slOrig: 95, pct: 1, peak: 103 }), 98);
  assert.strictEqual(computeTrailStop({ mode: 'step', entry: 172.9, slOrig: 166.9, pct: 2, peak: 180 }), 173.82);
});
test('step trail: computed from the PEAK, so a pullback never lowers the count', () => {
  const atPeak = computeTrailStop({ mode: 'step', entry: 100, slOrig: 95, pct: 1, peak: 106 });
  assert.strictEqual(atPeak, 101);
  // price falls to 104 but the mark stays 106 - same stop
  assert.strictEqual(computeTrailStop({ mode: 'step', entry: 100, slOrig: 95, pct: 1, peak: nextTrailPeak(106, 104) }), 101);
});
test('step trail: unusable inputs return NaN, never a bogus price', () => {
  assert.ok(Number.isNaN(computeTrailStop({ mode: 'step', entry: 0, slOrig: 95, pct: 1, peak: 110 })));
  assert.ok(Number.isNaN(computeTrailStop({ mode: 'step', entry: 100, slOrig: 0, pct: 1, peak: 110 })));
  assert.ok(Number.isNaN(computeTrailStop({ mode: 'step', entry: 100, slOrig: 95, pct: 0, peak: 110 })));
  assert.ok(Number.isNaN(computeTrailStop({ mode: 'step', entry: 100, slOrig: 95, pct: 1, peak: 0 })));
});
