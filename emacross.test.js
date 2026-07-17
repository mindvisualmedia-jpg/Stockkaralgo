'use strict';
// emacross.test.js — the EMA crossover entry filter.
//
// This decision buys real stock, so the rules are pinned here:
//   - EOD ONLY: a mid-session (non-`eod`) reading is off an unfinished candle
//     and must never influence the call.
//   - "crossed in the last N days" = bullish at the latest close AND below at
//     some close inside the window.
//   - the window counts CLOSES (trading days), so weekends/holidays cannot
//     silently shrink it.
//   - not enough history => false. A missing "before" close is not evidence.
const { test } = require('node:test');
const assert = require('node:assert');
const { detectEmaCrossover, emaCrossHistoryDays, eodCloses } = require('./emacross');

const d = (date, e20, e50, extra = {}) => ({ date, eod: true, e20, e50, ...extra });

// Crossed up on 07-13: below on 07-10, above from 07-13.
const CROSSED_RECENTLY = {
  RELIANCE: [
    d('2026-07-08', 460, 466),
    d('2026-07-09', 462, 466),
    d('2026-07-10', 465, 466),   // still below
    d('2026-07-13', 468, 466),   // <- crossed up here
    d('2026-07-14', 470, 466),
  ],
};

test('crosses within the window -> true', () => {
  // Cross was 2 closes back; a 3-day window (4 closes) contains it.
  assert.equal(detectEmaCrossover('RELIANCE', CROSSED_RECENTLY, 20, 50, 3), true);
});

test('cross older than the window -> false (window slides past the flip)', () => {
  // 1-day window = last 2 closes (07-13, 07-14): both already above, no flip.
  assert.equal(detectEmaCrossover('RELIANCE', CROSSED_RECENTLY, 20, 50, 1), false);
});

test('bullish for a long time (no flip in window) -> false', () => {
  const hist = { X: [d('2026-07-08', 480, 460), d('2026-07-09', 481, 460), d('2026-07-10', 482, 460), d('2026-07-13', 483, 460)] };
  assert.equal(detectEmaCrossover('X', hist, 20, 50, 3), false);
});

test('crossed DOWN (bearish now) -> false even though it was above in the window', () => {
  const hist = { X: [d('2026-07-09', 470, 466), d('2026-07-10', 468, 466), d('2026-07-13', 464, 466)] };
  assert.equal(detectEmaCrossover('X', hist, 20, 50, 3), false);
});

test('EOD ONLY: an intraday snapshot never creates a signal', () => {
  // Only two closes exist and both are below; a mid-session row shows "above".
  // Trusting it would fire a cross off an unfinished candle.
  const hist = { X: [
    d('2026-07-10', 460, 466),
    d('2026-07-13', 463, 466),
    { date: '2026-07-14', e20: 470, e50: 466 },   // no eod flag -> ignored
  ] };
  assert.equal(detectEmaCrossover('X', hist, 20, 50, 3), false);
  assert.equal(emaCrossHistoryDays('X', hist, 20, 50), 2);   // the intraday row does not count
});

test('not enough history -> false (never guess)', () => {
  assert.equal(detectEmaCrossover('X', { X: [d('2026-07-13', 470, 466)] }, 20, 50, 3), false); // 1 close
  assert.equal(detectEmaCrossover('X', {}, 20, 50, 3), false);                                  // none
  assert.equal(detectEmaCrossover('NOPE', CROSSED_RECENTLY, 20, 50, 3), false);                 // unknown symbol
});

test('exactly N+1 closes with the flip at the window edge -> true', () => {
  // 3-day window = 4 closes; oldest is the "before" close.
  const hist = { X: [d('2026-07-08', 465, 466), d('2026-07-09', 467, 466), d('2026-07-10', 468, 466), d('2026-07-13', 469, 466)] };
  assert.equal(detectEmaCrossover('X', hist, 20, 50, 3), true);
});

test('window counts CLOSES, not calendar days (a weekend cannot shrink it)', () => {
  // 07-10 (Fri) -> 07-13 (Mon): 3 calendar days apart, but adjacent closes.
  const hist = { X: [d('2026-07-10', 465, 466), d('2026-07-13', 468, 466)] };
  assert.equal(detectEmaCrossover('X', hist, 20, 50, 1), true);
});

test('file order is not trusted — closes are sorted by date', () => {
  const hist = { X: [d('2026-07-13', 468, 466), d('2026-07-08', 460, 466), d('2026-07-10', 465, 466)] };
  assert.equal(detectEmaCrossover('X', hist, 20, 50, 3), true);
  assert.equal(eodCloses('X', hist, 20, 50).map(x => x.date).join(','), '2026-07-08,2026-07-10,2026-07-13');
});

test('symbol lookup is normalised (NSE: prefix / spaces / case)', () => {
  assert.equal(detectEmaCrossover('NSE:reliance ', CROSSED_RECENTLY, 20, 50, 3), true);
});

test('touching equality counts as crossed up (fast >= slow)', () => {
  const hist = { X: [d('2026-07-10', 465, 466), d('2026-07-13', 466, 466)] };
  assert.equal(detectEmaCrossover('X', hist, 20, 50, 1), true);
});

test('closes missing the requested pair are not usable', () => {
  // History holds 20/50 but the filter asks for 9/21.
  assert.equal(emaCrossHistoryDays('RELIANCE', CROSSED_RECENTLY, 9, 21), 0);
  assert.equal(detectEmaCrossover('RELIANCE', CROSSED_RECENTLY, 9, 21, 3), false);
});

test('any fast/slow pair present in the snapshot works', () => {
  const hist = { X: [
    { date: '2026-07-10', eod: true, e9: 100, e21: 101 },
    { date: '2026-07-13', eod: true, e9: 102, e21: 101 },
  ] };
  assert.equal(detectEmaCrossover('X', hist, 9, 21, 2), true);
});
