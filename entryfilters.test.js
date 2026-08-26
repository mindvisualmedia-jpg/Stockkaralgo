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
const { evaluateValueBand, evaluatePriceBand, normalizeBand, marketCapCrores, latestSignalRows, fearlessBandInputs } = require('./entryfilters');

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

// ---- market cap -------------------------------------------------------------
// Read from the screener row, in Rs. CRORES - EVERY source (2026-08-25,
// REVERSED from the first version: live rows proved Stockkar rows are crores
// too - RAMCOIND market_cap 3038.15 = its real Rs.3,038 Cr. The /100 lakhs
// rule had been inferred from dead code and would have misread by 100x).
test('marketCapCrores: every source is crores - Stockkar rows included', () => {
  assert.strictEqual(marketCapCrores({ fincode: 132369, market_cap: 3038.15 }), 3038.15, 'the RAMCOIND row that exposed the bug');
  assert.strictEqual(marketCapCrores({ big_player_score: 80, market_cap: '45000' }), 45000, 'score columns do NOT change the unit');
  assert.strictEqual(marketCapCrores({ Symbol: 'X', 'Market Cap': 5000 }), 5000, 'sheet column');
  assert.strictEqual(marketCapCrores({ Symbol: 'X', mcap: '12,500' }), 12500, 'commas in sheet cells are stripped');
});
test('marketCapCrores: missing/junk columns read as NaN - never a fake zero', () => {
  assert.ok(Number.isNaN(marketCapCrores({ Symbol: 'X' })), 'no column');
  assert.ok(Number.isNaN(marketCapCrores({ Symbol: 'X', market_cap: '' })), 'blank cell');
  assert.ok(Number.isNaN(marketCapCrores({ Symbol: 'X', market_cap: 'n/a' })), 'junk cell');
  assert.ok(Number.isNaN(marketCapCrores(null)), 'no row at all');
});
test('value band with scaleMax: a crores band is not clamped to 100', () => {
  const b = evaluateValueBand({ label: 'Market Cap (Cr)', value: 19000, min: 1000, max: 50000, scaleMax: 10000000 });
  assert.strictEqual(b.pass, true);
  assert.strictEqual(b.low, 1000); assert.strictEqual(b.high, 50000);
  const out = evaluateValueBand({ label: 'Market Cap (Cr)', value: 90000, min: 1000, max: 50000, scaleMax: 10000000 });
  assert.strictEqual(out.pass, false);
  // and a missing market cap NEVER buys
  const missing = evaluateValueBand({ label: 'Market Cap (Cr)', value: NaN, min: 1000, max: 50000, scaleMax: 10000000 });
  assert.strictEqual(missing.pass, false);
  assert.match(missing.text, /missing/);
});

// ---- latest signal day (2026-08-25/26) --------------------------------------
// The web screener lists per-day signals; a "current stocks" endpoint is a
// dateless live set. When rows DO carry dates, only the newest day survives.
test('latestSignalRows: only the newest signal day survives - the YASHO double-listing collapses', () => {
  const rows = [
    { symbol: 'KRONOX', signal_date: '2026-08-25' },
    { symbol: 'YASHO', signal_date: '2026-08-25' },
    { symbol: 'YASHO', signal_date: '2026-08-24' },
    { symbol: 'OLDONE', signal_date: '2026-08-24' },
  ];
  const out = latestSignalRows(rows);
  assert.deepStrictEqual(out.map(r => r.symbol), ['KRONOX', 'YASHO']);
});
test('latestSignalRows: leaves dateless rows (the live-set shape) untouched', () => {
  const live = [{ symbol: 'RAMCOIND', market_cap: 3038.15 }, { symbol: 'KEI', market_cap: 53059.29 }];
  assert.strictEqual(latestSignalRows(live), live, 'no date column: nothing to pin');
});
test('latestSignalRows: unreadable dates and tiny inputs change nothing', () => {
  const weird = [{ symbol: 'A', signal_date: 'soon' }, { symbol: 'B', signal_date: 'later' }];
  assert.strictEqual(latestSignalRows(weird), weird, 'a format we cannot read must never empty a basket');
  const one = [{ symbol: 'A', signal_date: '2026-08-25' }];
  assert.strictEqual(latestSignalRows(one), one);
  assert.deepStrictEqual(latestSignalRows(null), []);
});

// ---- fearless: live distance (2026-08-26) -----------------------------------
// Owner: "I want live price near 0-2% of the fearless indicator - fearless_pct
// would be static." When the row carries fearless_value, the distance derives
// LIVE from the scan LTP; the stale pct + bearish gate are fallback-only.
test('fearless with a value: distance is LIVE - the stale pct is ignored', () => {
  const fb = fearlessBandInputs({ value: 332.85, pct: 4.81, signal: 'bullish' });
  assert.strictEqual(fb.live, true);
  assert.strictEqual(fb.distancePct, undefined, 'evaluatePriceBand derives from ltp vs value');
  // the RAMCOIND row at a LIVE ltp of 336: +0.95% -> inside a 0-2% band even
  // though the screener stamped +4.81% hours earlier
  const band = evaluatePriceBand({ label: 'Fearless Indicator', value: 332.85, ltp: 336,
    minPct: 0, withinPct: 2, distancePct: fb.distancePct, bullish: fb.bullish });
  assert.strictEqual(band.pass, true);
  // and at the stale +4.81% distance the same filter refuses - staleness matters
  assert.strictEqual(evaluatePriceBand({ value: 332.85, ltp: 348.85, minPct: 0, withinPct: 2 }).pass, false);
});
test('fearless live path needs no signal gate: price below the level is a negative distance', () => {
  const fb = fearlessBandInputs({ value: 719.4, pct: -9.95, signal: 'bearish' });
  assert.strictEqual(fb.live, true);
  assert.strictEqual(fb.bullish, true, 'no static gate on the live path');
  const band = evaluatePriceBand({ value: 719.4, ltp: 647.8, minPct: 0, withinPct: 2, distancePct: fb.distancePct, bullish: fb.bullish });
  assert.strictEqual(band.pass, false, '-9.95% live fails the band on its own');
});
test('fearless WITHOUT a value falls back to the static pct and the bearish gate still bites', () => {
  const fb = fearlessBandInputs({ value: undefined, pct: 1.5, signal: 'bearish' });
  assert.strictEqual(fb.live, false);
  assert.strictEqual(fb.distancePct, 1.5, 'stale is better than nothing when no level exists');
  assert.strictEqual(fb.bullish, false, 'a bearish signal must never enter on the fallback');
  const missing = fearlessBandInputs({});
  assert.strictEqual(missing.live, false);
  assert.ok(Number.isNaN(missing.distancePct), 'nothing at all -> band reads missing -> never passes');
});
