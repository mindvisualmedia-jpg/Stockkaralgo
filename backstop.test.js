'use strict';
// Angel SL backstop (#43): the pure verdict behind checkAngelSlBackstop.
//
// THE RISK IT COVERS: Angel's GTT model renders a rule's primary trigger in
// the TARGET slot (2026-08-09 app screenshot of our SL at 214.30 under
// "Target Trigger Price"), and no live Angel SL rule has ever been observed
// firing. If the primary leg only fires on an UPWARD cross, a single-leg "SL"
// rule never fires on the way down and the position rides through its stop.
// The backstop exits in software when price is through the stop while the
// rule still stands. The 'leave' verdicts matter as much as 'fire': the
// backstop must never double-exit beside a rule that DID fire.

const { test } = require('node:test');
const assert = require('node:assert');
const { slBackstopDecision } = require('./mtm');

const base = { ltp: 213.0, slPrice: 214.3, marginPct: 0.3, breaches: 2, ruleLive: true, held: true, exitOpen: false, alreadyFired: false };
const d = (over = {}) => slBackstopDecision({ ...base, ...over });

test('price through the stop + rule standing + held + 2 sightings -> fire', () => {
  assert.equal(d(), 'fire');
});

test('not meaningfully through the stop -> wait (margin honored)', () => {
  assert.equal(d({ ltp: 214.3 }), 'wait', 'at the stop is the broker rule\'s job, not ours');
  assert.equal(d({ ltp: 214.0 }), 'wait', 'inside the 0.3% margin');
  assert.equal(d({ ltp: 213.65 }), 'fire', 'just past the margin fires');
});

test('first sighting -> wait (one bad tick must not market-exit)', () => {
  assert.equal(d({ breaches: 1 }), 'wait');
  assert.equal(d({ breaches: 0 }), 'wait');
});

test('rule fired/gone -> leave (verify + reconcile own the exit; never double-sell)', () => {
  assert.equal(d({ ruleLive: false }), 'leave');
});

test('rule state unknown -> wait (never act blind)', () => {
  assert.equal(d({ ruleLive: undefined }), 'wait');
  assert.equal(d({ ruleLive: null }), 'wait');
});

test('not held -> leave; held unknown -> wait', () => {
  assert.equal(d({ held: false }), 'leave', 'nothing to sell: close-booking owns it');
  assert.equal(d({ held: undefined }), 'wait');
});

test('an exit SELL already working at the broker -> leave', () => {
  assert.equal(d({ exitOpen: true }), 'leave');
});

test('already fired once -> leave forever (no re-fire loop)', () => {
  assert.equal(d({ alreadyFired: true }), 'leave');
});

test('no price / no stop -> wait', () => {
  assert.equal(d({ ltp: 0 }), 'wait');
  assert.equal(d({ slPrice: 0 }), 'wait');
});
