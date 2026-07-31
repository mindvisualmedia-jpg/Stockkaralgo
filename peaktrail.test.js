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
