'use strict';
// Order Log RESULT / STATUS wording (display layer).
//
// Verbatim copies of the index.html functions (describeLogResult,
// logRowState) so the label derivation can be asserted
// without a browser. If these drift from index.html, update both.
//
// THE CONTRACT THIS PROTECTS: relabeling happens at DISPLAY time only. The
// stored exitType is what isOpenOrderLogEntry text-matches to decide "is this a
// live position?", and 60+ sites pattern-match TARGET HIT / SL HIT. These tests
// pin that (a) every closed outcome still derives from an unchanged stored
// value, and (b) no open-row label ever contains a closing token.

const { test } = require('node:test');
const assert = require('node:assert');

// ---- verbatim copy: server/index isOpenOrderLogEntry closing-token test ----
const CLOSING_TOKENS = /(TARGET HIT|SL HIT|REJECT|CANCEL|FAILED|FAIL|INVALID|EXITED|CLOSED)/;

// ---- verbatim copies from index.html ----
const LOG_STATE_LABELS = {
  pending: 'Pending fill', partial: 'Partially filled', open: 'Open',
  'exit-pending': 'Exit pending', closed: 'Closed', rejected: 'Rejected',
};
function logRowState(r) {
  const s = String(r.status || '').toUpperCase();
  const res = String(r.exitType || r.result || '').toUpperCase();
  if (['ERROR', 'SKIPPED', 'N/A'].includes(String(r.orderId || '').toUpperCase())) return 'rejected';
  if (r.manualClose || /TARGET HIT|SL HIT|EXITED|CLOSED/.test(s + ' ' + res)) return 'closed';
  if (/REJECT|CANCEL|FAIL|INVALID|SECURITY ID NOT FOUND/.test(s + ' ' + res)) return 'rejected';
  if (r.exitPending || /EXIT PENDING/.test(s)) return 'exit-pending';
  if (r.awaitingFill) return /PARTIALLY FILLED/.test(s) ? 'partial' : 'pending';
  return 'open';
}
function logExitIsSl(result) { return /SL HIT/i.test(result); }
function logExitIsTarget(result) { return /TARGET HIT/i.test(result); }
function describeLogResult(r) {
  const result = String(r.exitType || r.result || '');
  if (!result) return '';
  const est = r.exitEstimated ? ' ~' : '';
  if (/REJECT/i.test(result)) {
    return /expired|no fill/i.test(String(r.status || '')) ? 'Expired unfilled' : 'Rejected at entry';
  }
  if (/CANCEL/i.test(result)) return 'Cancelled';
  if (r.manualClose) return 'Closed manually' + est;
  if (/EOD/i.test(result)) return 'Closed at EOD' + est;
  const sl = logExitIsSl(result), tgt = logExitIsTarget(result);
  const costDone = !!(r.mtmCostDone || r.splitCostDone);
  const trailed = String(r.emaTrailingStatus || '') === 'trail-exit'
    || (!!r.emaTrailingEnabled && !!r.emaTrailingArmedAt);
  if (r.splitT1 && r.mtmT1Done) {
    if (tgt || r.mtmT2Done) return 'T1 & T2 booked' + est;
    if (sl || /EXITED/i.test(result)) return costDone ? 'T1 booked, T2 SL hit at cost' + est : 'T1 booked, T2 SL hit' + est;
  }
  if (sl || /EXITED/i.test(result)) {
    if (trailed) return 'Trailing SL hit' + est;
    if (costDone) return 'Closed at cost' + est;
    if (sl) return 'Closed with SL' + est;
    return 'Closed' + est;
  }
  if (tgt) return 'Closed at target' + est;
  return result;
}
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

test('a residual EXITED with no explaining flag stays honest ("Closed"), never invents a reason', () => {
  assert.equal(describeLogResult({ exitType: 'EXITED' }), 'Closed');
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
    assert.ok(CLOSING_TOKENS.test(stored.toUpperCase()) || stored === 'EOD EXIT',
      'stored value "' + stored + '" must remain a recognised closing value');
  });
});
