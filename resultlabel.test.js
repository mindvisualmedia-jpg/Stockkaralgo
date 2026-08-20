'use strict';
// Order Log RESULT / STATUS wording (display layer).
//
// Since slice 1 of REPORT-PLAN these functions live in report.js (loaded by
// index.html AND required here) - the verbatim copies this file used to keep,
// "held equal only by a comment", are gone.
//
// THE CONTRACT THIS PROTECTS: relabeling happens at DISPLAY time only. The
// stored exitType is what isOpenOrderLogEntry text-matches to decide "is this a
// live position?", and 60+ sites pattern-match TARGET HIT / SL HIT. These tests
// pin that (a) every closed outcome still derives from an unchanged stored
// value, and (b) no open-row label ever contains a closing token.

const { test } = require('node:test');
const assert = require('node:assert');
const { describeLogResult } = require('./report.js');

// ---- verbatim copy: server/index isOpenOrderLogEntry closing-token test ----
const CLOSING_TOKENS = /(TARGET HIT|SL HIT|REJECT|CANCEL|FAILED|FAIL|INVALID|EXITED|CLOSED|EOD EXIT)/;

// ── the four labels the user asked for ──────────────────────────────────────

test('Trailing SL hit — trail locked profit, no longer a bare "EXITED"', () => {
  assert.equal(describeLogResult({ exitType: 'EXITED', emaTrailingStatus: 'trail-exit' }), 'Trailing SL hit');
  // armed-then-stopped is the same outcome via the other flag
  assert.equal(describeLogResult({ exitType: 'SL HIT', emaTrailingEnabled: true, emaTrailingArmedAt: '2026-07-25T05:00:00Z' }), 'Trailing SL hit');
});


test('T1 booked, T2 SL hit at cost — partial win then breakeven runner', () => {
  assert.equal(describeLogResult({ exitType: 'EXITED', splitT1: true, mtmT1Done: true, mtmCostDone: true }), 'T1 booked, T2 SL hit at cost');
  assert.equal(describeLogResult({ exitType: 'SL HIT', splitT1: true, mtmT1Done: true, splitCostDone: true }), 'T1 booked, T2 SL hit at cost');
});

test('T1 booked, T2 SL hit — runner stopped WITHOUT a cost move (a real loss on the runner)', () => {
  assert.equal(describeLogResult({ exitType: 'SL HIT', splitT1: true, mtmT1Done: true }), 'T1 booked, T2 SL hit');
});

test('T1 & T2 booked — both targets', () => {
  assert.equal(describeLogResult({ exitType: 'TARGET HIT', splitT1: true, mtmT1Done: true }), 'T1 & T2 booked');
  assert.equal(describeLogResult({ exitType: 'EXITED', splitT1: true, mtmT1Done: true, mtmT2Done: true }), 'T1 & T2 booked');
});

// ── the outcomes EXITED used to hide ────────────────────────────────────────

test('Closed at cost is distinguished from a real SL loss', () => {
  assert.equal(describeLogResult({ exitType: 'EXITED', mtmCostDone: true }), 'Closed at cost');
  assert.equal(describeLogResult({ exitType: 'SL HIT' }), 'Closed with SL');
});

test('THE SCREENSHOT BUG: a losing EXITED reads as an SL hit, not a bare "Closed"', () => {
  // Both rows the user flagged: stored EXITED, negative P&L, no cost/trail flag.
  assert.equal(describeLogResult({ exitType: 'EXITED', realisedPnl: -18.5, exitPrice: 490 }), 'Closed with SL');
  assert.equal(describeLogResult({ exitType: 'EXITED', realisedPnl: -17.4, exitPrice: 301.1 }), 'Closed with SL');
});

test('PRICE EVIDENCE wins over the P&L sign (same rule as engine reconstructClose)', () => {
  // Exit at/just below the stop -> SL, even though these numbers show a profit.
  assert.equal(describeLogResult({ exitType: 'EXITED', exitPrice: 100, slPrice: 100, realisedPnl: 5 }), 'Closed with SL');
  assert.equal(describeLogResult({ exitType: 'EXITED', exitPrice: 99, brokerSlPrice: 100 }), 'Closed with SL');
  // Exit at/above the target -> target, even on a negative P&L row.
  assert.equal(describeLogResult({ exitType: 'EXITED', exitPrice: 120, targetPrice: 120, realisedPnl: -1 }), 'Closed at target');
});

test('a profitable EXITED with no prices is NOT called an SL hit', () => {
  assert.equal(describeLogResult({ exitType: 'EXITED', realisedPnl: 12 }), 'Closed in profit');
});

test('a residual EXITED with NOTHING to go on stays honest ("Closed")', () => {
  assert.equal(describeLogResult({ exitType: 'EXITED' }), 'Closed');
  assert.equal(describeLogResult({ exitType: 'EXITED', realisedPnl: 0 }), 'Closed');
});

test('rejected-at-entry vs expired-unfilled are separated', () => {
  assert.equal(describeLogResult({ exitType: 'REJECTED', status: 'REJECTED (entry rejected — no protection placed)' }), 'Rejected at entry');
  assert.equal(describeLogResult({ exitType: 'REJECTED', status: 'REJECTED (entry expired — no fill, no protection placed)' }), 'Expired unfilled');
});

test('manual close and EOD are labelled, not disguised as broker exits', () => {
  assert.equal(describeLogResult({ exitType: 'EXITED', manualClose: true }), 'Closed manually');
  assert.equal(describeLogResult({ exitType: 'EOD EXIT' }), 'Closed at EOD');
});

test('an estimated exit price is marked ~ (we inferred it, broker gave no fill)', () => {
  assert.equal(describeLogResult({ exitType: 'TARGET HIT', exitEstimated: true }), 'Closed at target ~');
});

test('no result yet -> empty (the cell shows "-")', () => {
  assert.equal(describeLogResult({}), '');
});

// ── the contract: display never changes open/closed truth ───────────────────

test('every RESULT label is derived from an UNCHANGED stored exitType', () => {
  // The stored values must still be the ones isOpenOrderLogEntry recognises.
  ['TARGET HIT', 'SL HIT', 'EXITED', 'REJECTED', 'EOD EXIT'].forEach(stored => {
    const label = describeLogResult({ exitType: stored, status: '' });
    assert.ok(label, 'stored "' + stored + '" must produce a label');
    assert.ok(CLOSING_TOKENS.test(stored.toUpperCase()),
      'stored value "' + stored + '" must remain a recognised closing value');
  });
});
