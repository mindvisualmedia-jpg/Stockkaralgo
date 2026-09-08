'use strict';
// BREACHED-STOP MARKET EXIT: throttles and market hours (2026-09-09).
//
// THE INCIDENT THIS COVERS. GARUDA/Dhan, 2026-09-08: 58 market SELL orders for
// ONE position in a day, 57 refused, four of them after the close (17:33, 17:37,
// 17:41, 17:45 IST) with "Market is Closed! Want to place an offline order?".
//
// Three defects, all in the REARM_PROTECTION executor:
//   1. its 'exit-at-market' branch returned BEFORE the attempt cap and the
//      10-minute cooldown that guard the re-arm below it, so the one action
//      that sells shares was the one action with no throttle;
//   2. its only counter (_breachCounts) is in memory AND is deleted on every
//      fire, so it rebuilt 0 -> 1 -> 2 and sold again two passes later, for
//      ever. rearmDecision has no 'alreadyFired' latch - the legacy Angel
//      backstop (slBackstopDecision) does, and rearmDecision runs for EVERY
//      broker;
//   3. nothing checked market hours on this path, though rule 8's caller and
//      the exit chase both do.
//
// These are source-contract tests on purpose: the failure was an ORDERING and
// GUARD bug, not a maths bug, and ordering is exactly what a unit test on a
// pure function cannot see.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { rearmDecision, slBackstopDecision } = require('./mtm');

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

const sliceFn = (name) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i > 0, name + ' not found in server.js');
  const j = src.indexOf('\nfunction ', i + 1);
  return src.slice(i, j > 0 ? j : i + 6000);
};

// ---- 1. the choke point is gated on market hours -----------------------------

test('exitBreachedStopAtMarket refuses to act outside market hours', () => {
  const body = sliceFn('exitBreachedStopAtMarket');
  assert.ok(body.includes('if (!withinMarketHours()) return callback(null);'),
    'the market-hours gate must be IN exitBreachedStopAtMarket so every caller inherits it');
  const gate = body.indexOf('withinMarketHours()');
  const firstSell = body.indexOf('sellFn(');
  const firstCancel = body.indexOf('cancelFn(');
  assert.ok(gate > 0 && gate < firstSell, 'the gate must come before any market sell');
  assert.ok(gate > 0 && gate < firstCancel, 'the gate must come before any trigger cancel');
});

test('the exit chase and rule 8 keep their own market-hours gates', () => {
  // Both already had one; the incident was the third caller that did not.
  assert.ok(src.includes('&& mtmLiveExitEnabled(brokerName) && withinMarketHours();'),
    'rule 8 (breachBackstopOn) must stay gated on market hours');
});

// ---- 2. the re-arm executor's exit branch is throttled ------------------------

// The REARM_PROTECTION branch of engineExecuteAction, from its marker to the
// end of the exit branch.
function rearmExitBranch() {
  const start = src.indexOf("if (action.type === 'REARM_PROTECTION')");
  assert.ok(start > 0, 'REARM_PROTECTION branch not found');
  const end = src.indexOf('return restoreBrokerStop(row,', start);
  assert.ok(end > start, 'end of the re-arm branch not found');
  return src.slice(start, end);
}

test('the market exit has its own attempt cap and cooldown, checked BEFORE it fires', () => {
  const b = rearmExitBranch();
  const capAt = b.indexOf('BREACH_EXIT_MAX_ATTEMPTS');
  const coolAt = b.indexOf('BREACH_EXIT_COOLDOWN_MS');
  const fireAt = b.indexOf('exitBreachedStopAtMarket(');
  assert.ok(capAt > 0, 'no attempt cap on the breached-stop market exit');
  assert.ok(coolAt > 0, 'no cooldown on the breached-stop market exit');
  assert.ok(capAt < fireAt, 'the cap must be checked before the exit is placed');
  assert.ok(coolAt < fireAt, 'the cooldown must be checked before the exit is placed');
});

test('the attempt count is stamped on the ROW, so a restart cannot reset it', () => {
  const b = rearmExitBranch();
  assert.ok(/breachExitAttempts:\s*bxAttempts \+ 1/.test(b), 'the attempt must be persisted on the row');
  assert.ok(b.includes('breachExitLastAt: Date.now()'), 'the fire time must be persisted on the row');
  assert.ok(b.indexOf('updateOrderLogRow') < b.indexOf('exitBreachedStopAtMarket('),
    'persist the attempt BEFORE placing, so a crash mid-flight still counts it');
});

test('the caps are small and finite - a refusing broker is reported, never hammered', () => {
  const cap = Number((src.match(/const BREACH_EXIT_MAX_ATTEMPTS = (\d+);/) || [])[1]);
  const cool = String((src.match(/const BREACH_EXIT_COOLDOWN_MS = ([^;]+);/) || [])[1] || '');
  assert.ok(cap >= 1 && cap <= 5, 'expected a small finite cap, got ' + cap);
  assert.ok(/10 \* 60 \* 1000/.test(cool), 'expected a 10-minute cooldown, got ' + cool);
});

test('hitting the cap tells the owner to exit manually instead of going quiet', () => {
  const b = rearmExitBranch();
  assert.match(b, /exit manually at the broker/i,
    'the capped verdict must say what the owner has to do');
});

// ---- 3. the pure verdicts are unchanged ---------------------------------------

test('rearmDecision still needs TWO sightings before it will sell (unchanged)', () => {
  const base = { ltp: 180, slPrice: 191.5, held: true, exitOpen: false };
  assert.equal(rearmDecision({ ...base, breaches: 0 }), 'wait');
  assert.equal(rearmDecision({ ...base, breaches: 1 }), 'wait', 'one tick must never market-exit');
  assert.equal(rearmDecision({ ...base, breaches: 2 }), 'exit-at-market');
  assert.equal(rearmDecision({ ...base, ltp: 200, breaches: 5 }), 'place', 'above the stop: just re-place it');
  assert.equal(rearmDecision({ ...base, exitOpen: true, breaches: 5 }), 'wait', 'an exit already working');
});

test('rearmDecision has no fire-once latch of its own - the executor MUST provide it', () => {
  // Documents why the throttle lives in the executor: unlike the legacy Angel
  // backstop, this verdict cannot remember that it already fired.
  const base = { ltp: 180, slPrice: 191.5, held: true, exitOpen: false, breaches: 2 };
  assert.equal(rearmDecision(base), 'exit-at-market');
  assert.equal(rearmDecision(base), 'exit-at-market', 'pure: it will say sell every single time');
  const fired = { ltp: 213, slPrice: 214.3, marginPct: 0.3, breaches: 2, ruleLive: true, held: true, exitOpen: false };
  assert.equal(slBackstopDecision({ ...fired, alreadyFired: false }), 'fire');
  assert.equal(slBackstopDecision({ ...fired, alreadyFired: true }), 'leave',
    'the legacy backstop DOES latch on alreadyFired - that is the guard rearmDecision never had');
});
