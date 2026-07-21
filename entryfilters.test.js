'use strict';
// Entry-filter band tests.
//
// Two things must hold above all else:
//   1. BACKWARD COMPATIBILITY — every algo saved before ranges existed carries
//      only `withinPct`. It must keep selecting exactly the same stocks.
//   2. MISSING DATA NEVER PASSES — a stock with no RSI/score reading must be
//      skipped, never treated as a match.

const { test } = require('node:test');
const assert = require('node:assert');
const { evaluateValueBand, evaluatePriceBand, normalizeBand } = require('./entryfilters');

// ── RSI / score value band ──────────────────────────────────────────────────

test('RSI inside the band passes', () => {
  const r = evaluateValueBand({ label: 'RSI 14', value: 32.4, min: 20, max: 40 });
  assert.equal(r.pass, true);
  assert.equal(r.text, 'RSI 14 32.4 in 20-40');
});

test('RSI outside the band fails on both sides', () => {
  assert.equal(evaluateValueBand({ value: 18, min: 20, max: 40 }).pass, false);
  assert.equal(evaluateValueBand({ value: 41, min: 20, max: 40 }).pass, false);
});

test('RSI exactly on either edge passes (band is inclusive)', () => {
  assert.equal(evaluateValueBand({ value: 20, min: 20, max: 40 }).pass, true);
  assert.equal(evaluateValueBand({ value: 40, min: 20, max: 40 }).pass, true);
});

test('a missing RSI reading never passes', () => {
  for (const v of [undefined, null, NaN, '']) {
    const r = evaluateValueBand({ label: 'RSI 14', value: v, min: 0, max: 100 });
    assert.equal(r.pass, false, 'value ' + String(v) + ' must not pass');
    assert.match(r.text, /missing/);
  }
});

test('a reversed band is read as written, not as an empty set', () => {
  const r = evaluateValueBand({ value: 30, min: 40, max: 20 });
  assert.equal(r.low, 20);
  assert.equal(r.high, 40);
  assert.equal(r.pass, true);
});

test('band values are clamped to the 0-100 scale', () => {
  const b = normalizeBand(-10, 250, 100);
  assert.deepEqual(b, { low: 0, high: 100 });
});

test('score filters still work through the same band (minScore/maxScore path)', () => {
  // server.js passes minScore/maxScore in as min/max — same maths, same result.
  const r = evaluateValueBand({ label: 'Big Player Score', value: 71, min: 60, max: 100 });
  assert.equal(r.pass, true);
});

// ── EMA / price distance band ───────────────────────────────────────────────

test('BACK-COMPAT: withinPct alone behaves exactly like the old "within X%"', () => {
  // Old rule: pass when distance is 0%..X% above the indicator.
  const near = evaluatePriceBand({ label: 'EMA200', value: 100, ltp: 103, withinPct: 5 });
  assert.equal(near.pass, true);
  assert.equal(near.minPct, 0);
  const far = evaluatePriceBand({ label: 'EMA200', value: 100, ltp: 108, withinPct: 5 });
  assert.equal(far.pass, false);
  // Below the indicator was never allowed and still is not.
  const below = evaluatePriceBand({ label: 'EMA200', value: 100, ltp: 98, withinPct: 5 });
  assert.equal(below.pass, false);
});

test('a 2-5% band rejects a stock hugging the EMA', () => {
  const r = evaluatePriceBand({ label: 'EMA200', value: 100, ltp: 101, minPct: 2, withinPct: 5 });
  assert.equal(r.pass, false, '+1% is inside the old rule but below the 2% floor');
});

test('a 2-5% band accepts a stock inside it and rejects one stretched above', () => {
  assert.equal(evaluatePriceBand({ value: 100, ltp: 103.5, minPct: 2, withinPct: 5 }).pass, true);
  assert.equal(evaluatePriceBand({ value: 100, ltp: 106, minPct: 2, withinPct: 5 }).pass, false);
});

test('both edges of the price band are inclusive', () => {
  assert.equal(evaluatePriceBand({ value: 100, ltp: 102, minPct: 2, withinPct: 5 }).pass, true);
  assert.equal(evaluatePriceBand({ value: 100, ltp: 105, minPct: 2, withinPct: 5 }).pass, true);
});

test('a From above the To degrades to the plain within-rule, not to zero matches', () => {
  const r = evaluatePriceBand({ value: 100, ltp: 103, minPct: 9, withinPct: 5 });
  assert.equal(r.minPct, 5, 'floor is capped at the ceiling');
  assert.equal(r.pass, false);
  // and a stock at exactly the ceiling still matches, so the filter is not dead
  assert.equal(evaluatePriceBand({ value: 100, ltp: 105, minPct: 9, withinPct: 5 }).pass, true);
});

test('a missing indicator value never passes', () => {
  const r = evaluatePriceBand({ label: 'EMA200', value: undefined, ltp: 103, withinPct: 5 });
  assert.equal(r.pass, false);
  assert.match(r.text, /missing/);
});

test('Fearless supplies its own distance and must be bullish to pass', () => {
  const bull = evaluatePriceBand({ label: 'Fearless Indicator', distancePct: 3, minPct: 2, withinPct: 5, bullish: true });
  assert.equal(bull.pass, true);
  const bear = evaluatePriceBand({ label: 'Fearless Indicator', distancePct: 3, minPct: 2, withinPct: 5, bullish: false });
  assert.equal(bear.pass, false, 'a bearish signal must never enter, band or not');
});

test('the band is spelled out in the preview text', () => {
  const r = evaluatePriceBand({ label: 'EMA200', value: 100, ltp: 103, minPct: 2, withinPct: 5 });
  assert.equal(r.text, 'EMA200 +3.00% in 2-5%');
});
