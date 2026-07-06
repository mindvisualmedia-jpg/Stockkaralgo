'use strict';
// engine.test.js — regression suite for the position engine. Every scenario here
// is a REAL incident from production (July 2026) or a rule distilled from one.
// If a test in this file breaks, a past incident is about to happen again.
const { test } = require('node:test');
const assert = require('node:assert');
const { STATE, transition, reconstructClose } = require('./engine');

const NOW = 1_800_000_000_000;
const GRACE = 3 * 60 * 1000;

// -- helpers -----------------------------------------------------------------
function splitPos(over = {}) {
  // SAMHI-shaped split: entry 172.9 x2, T1 174.63, T2 176.4, SL 166.9
  return {
    state: STATE.PROTECTED, symbol: 'SAMHI', qty: 2,
    entryPrice: 172.9, slPrice: 166.9, targetPrice: 176.4, t1Price: 174.63,
    costTrigger: 0, entryId: 'E1',
    legs: [{ id: 'FT1', role: 't1', qty: 1 }, { id: 'FR', role: 'runner', qty: 1 }],
    t1Booked: false, costMoved: false, pendingSl: null, graceStartAt: 0, ltp: 0,
    ...over,
  };
}
function snap(over = {}) {
  return { complete: true, protections: {}, entries: {}, heldQty: {}, sells: {}, ...over };
}
const live = (trigger) => ({ status: 'live', triggerPrice: trigger });

// -- INCIDENT: fail-safe ------------------------------------------------------
test('incomplete snapshot changes NOTHING (fail-safe: no evidence, no action)', () => {
  const r = transition(splitPos(), { complete: false }, { now: NOW });
  assert.equal(r.state, STATE.PROTECTED);
  assert.deepEqual(r.patch, {});
  assert.deepEqual(r.actions, []);
});

// -- INCIDENT: SAMHI stuck open (v2.58.0/2.58.1) -------------------------------
test('SAMHI: both Forevers vanished + not held -> CLOSED TARGET HIT, T1+T2, exact P&L 5.13', () => {
  const s = snap({
    protections: {}, // completed Forevers DROP from /v2/forever/all
    heldQty: { SAMHI: 0 },
    sells: { SAMHI: [{ qty: 1, px: 174.55 }, { qty: 1, px: 176.38 }] },
  });
  const r = transition(splitPos(), s, { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.exitType, 'TARGET HIT');
  assert.equal(r.patch.t1Booked, true);
  assert.equal(r.patch.t2Done, true);
  assert.equal(r.patch.realisedPnl, 5.13); // (174.55-172.9)+(176.38-172.9)
  assert.equal(r.patch.exitEstimated, false);
});

test('vanished legs but STILL HELD is NOT a close (never false-close)', () => {
  const s = snap({ heldQty: { SAMHI: 2 }, sells: {} });
  const r = transition(splitPos(), s, { now: NOW });
  assert.notEqual(r.state, STATE.CLOSED);
});

test('FRESH position: legs+holdings LAG (not live, not held, NO sell) -> NOT closed (grace strike 1)', () => {
  // The Monday false-close: a just-placed position whose Forever isn\'t listed yet
  // and whose fresh CNC buy isn\'t in holdings yet must NOT be fabricated closed.
  const pos = splitPos({ graceStartAt: 0 });
  const s = snap({ protections: {}, heldQty: {}, sells: {} }); // nothing live, not held, no fills
  const r = transition(pos, s, { now: NOW });
  assert.notEqual(r.state, STATE.CLOSED);       // no target-price fabrication
  assert.equal(r.patch.graceStartAt, NOW);      // starts the clock instead
});

test('no-sell "close" only after grace persists; WITH a sell it closes immediately', () => {
  // No sell + grace elapsed -> accept (cross-day rolled-off fill case).
  let r = transition(splitPos({ graceStartAt: NOW - GRACE * 4 - 1 }), snap({ protections: {}, heldQty: {}, sells: {} }), { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
  // A real SELL fill is proof -> close immediately, no grace needed.
  r = transition(splitPos({ graceStartAt: 0 }), snap({ protections: {}, heldQty: {}, sells: { SAMHI: [{ qty: 2, px: 176.38 }] } }), { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.exitType, 'TARGET HIT');
});

// -- INCIDENT: T1 not ticking live (v2.58.2/2.58.3) ----------------------------
test('T1 leg vanished + runner LIVE -> T1 booked mid-trade + move runner SL to cost', () => {
  const s = snap({ protections: { FR: live(166.9) }, heldQty: { SAMHI: 1 }, sells: { SAMHI: [{ qty: 1, px: 174.55 }] } });
  const r = transition(splitPos(), s, { now: NOW });
  assert.equal(r.state, STATE.PROTECTED);          // still running
  assert.equal(r.patch.t1Booked, true);            // ticked LIVE, not at close
  const mv = r.actions.find(a => a.type === 'MOVE_SL_TO_COST');
  assert.ok(mv && mv.legIds.includes('FR') && mv.reason === 'post-T1');
});

test('both legs live -> no T1 tick, no actions, grace cleared', () => {
  const s = snap({ protections: { FT1: live(166.9), FR: live(166.9) }, heldQty: { SAMHI: 2 } });
  const r = transition(splitPos({ graceStartAt: NOW - 1000 }), s, { now: NOW });
  assert.equal(r.patch.t1Booked, undefined);
  assert.deepEqual(r.actions, []);
  assert.equal(r.patch.graceStartAt, 0);
});

// -- INCIDENT: INDOAMIN phantom protection (T2T, v2.59.0) ----------------------
test('INDOAMIN: protection never live + held -> grace strike 1 (no alarm yet)', () => {
  const pos = splitPos({ state: STATE.PROTECTION_PENDING, symbol: 'INDOAMIN' });
  const s = snap({ protections: {}, heldQty: { INDOAMIN: 2 }, sells: {} });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.state, STATE.PROTECTION_PENDING); // not alarmed on strike 1
  assert.equal(r.patch.graceStartAt, NOW);
  assert.equal(r.alerts.length, 0);
});

test('INDOAMIN: still unprotected after grace -> UNPROTECTED + alert + false cost tick CLEARED', () => {
  // Empty list => 4x grace (glitch guard), so INDOAMIN flags after 12 min, not 3.
  const pos = splitPos({ state: STATE.PROTECTION_PENDING, symbol: 'INDOAMIN', costMoved: true, graceStartAt: NOW - GRACE * 4 - 1 });
  const s = snap({ protections: {}, heldQty: { INDOAMIN: 2 }, sells: {} });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.state, STATE.UNPROTECTED);
  assert.equal(r.patch.costMoved, false);          // the phantom "SL moved ✓" dies here
  assert.equal(r.alerts[0].type, 'UNPROTECTED');
});

test('protection seen live -> PROTECTED (verified, not assumed)', () => {
  const pos = splitPos({ state: STATE.PROTECTION_PENDING });
  const s = snap({ protections: { FT1: live(166.9), FR: live(166.9) }, heldQty: { SAMHI: 2 } });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.state, STATE.PROTECTED);
  assert.ok(r.patch.protectionVerifiedAt);
});

test('EMPTY protections list = weak evidence: normal grace NOT enough to flag (glitch guard)', () => {
  // List came back completely empty (200-but-glitched / list lag). Absence of the
  // row's ids proves nothing -> the grace is 4x; at normal-grace expiry, still PROTECTED.
  const pos = splitPos({ graceStartAt: NOW - GRACE - 1 });
  const s = snap({ protections: {}, heldQty: { SAMHI: 2 }, sells: {} });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.state, STATE.PROTECTED); // not flagged yet
});

test('EMPTY-list mismatch persisting past the 4x grace -> UNPROTECTED (still catches real rejects)', () => {
  const pos = splitPos({ graceStartAt: NOW - GRACE * 4 - 1 });
  const s = snap({ protections: {}, heldQty: { SAMHI: 2 }, sells: {} });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.state, STATE.UNPROTECTED);
});

test('NON-empty list missing the row ids -> normal grace applies (strong evidence)', () => {
  const pos = splitPos({ graceStartAt: NOW - GRACE - 1 });
  const s = snap({ protections: { OTHER: { status: 'live', triggerPrice: 100 } }, heldQty: { SAMHI: 2 }, sells: {} });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.state, STATE.UNPROTECTED);
});

// -- Pre-T1 SL->cost (v2.58.0 default-ON behavior) -----------------------------
test('LTP crosses cost trigger pre-T1 -> MOVE_SL_TO_COST on BOTH live legs', () => {
  const pos = splitPos({ costTrigger: 174.0, ltp: 174.2 });
  const s = snap({ protections: { FT1: live(166.9), FR: live(166.9) }, heldQty: { SAMHI: 2 } });
  const r = transition(pos, s, { now: NOW });
  const mv = r.actions.find(a => a.type === 'MOVE_SL_TO_COST');
  assert.ok(mv && mv.reason === 'pre-T1');
  assert.deepEqual(mv.legIds.sort(), ['FR', 'FT1']);
});

test('no duplicate cost-move while one is pending verification', () => {
  const pos = splitPos({ costTrigger: 174.0, ltp: 174.2, pendingSl: { price: 172.9, at: NOW - 1000, toCost: true } });
  const s = snap({ protections: { FT1: live(166.9), FR: live(166.9) }, heldQty: { SAMHI: 2 } });
  const r = transition(pos, s, { now: NOW });
  assert.ok(!r.actions.some(a => a.type === 'MOVE_SL_TO_COST'));
});

// -- VERIFY-AFTER-MODIFY (the R2/R3 gap: modifies were trusted on write) --------
test('SL modify CONFIRMED only when broker shows the new trigger on every live leg', () => {
  const pos = splitPos({ pendingSl: { price: 172.9, at: NOW - 1000, toCost: true } });
  const s = snap({ protections: { FT1: live(172.9), FR: live(172.9) }, heldQty: { SAMHI: 2 } });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.patch.slPrice, 172.9);
  assert.equal(r.patch.costMoved, true);           // tick ONLY after broker evidence
  assert.equal(r.patch.pendingSl, null);
});

test('SL modify NOT yet at broker -> no tick; after grace -> STALE-STOP alert', () => {
  const stale = snap({ protections: { FT1: live(166.9), FR: live(166.9) }, heldQty: { SAMHI: 2 } });
  // within grace: keep waiting, no tick, no alert
  let r = transition(splitPos({ pendingSl: { price: 172.9, at: NOW - 1000, toCost: true } }), stale, { now: NOW });
  assert.equal(r.patch.costMoved, undefined);
  assert.equal(r.alerts.length, 0);
  // past grace: surface the stale stop
  r = transition(splitPos({ pendingSl: { price: 172.9, at: NOW - GRACE - 1, toCost: true } }), stale, { now: NOW });
  assert.equal(r.alerts[0].type, 'SL_MODIFY_UNCONFIRMED');
  assert.equal(r.patch.pendingSl, null);
});

// -- Entry lifecycle ------------------------------------------------------------
test('entry fills -> PROTECTION_PENDING + PLACE_PROTECTION (never straight to PROTECTED)', () => {
  const pos = splitPos({ state: STATE.ENTRY_PENDING, legs: [] });
  const s = snap({ entries: { E1: { status: 'filled', fillPrice: 172.95, filledQty: 2 } } });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.state, STATE.PROTECTION_PENDING);
  assert.equal(r.patch.entryPrice, 172.95);
  assert.deepEqual(r.actions, [{ type: 'PLACE_PROTECTION' }]);
});

test('entry rejected -> ENTRY_DEAD (terminal)', () => {
  const pos = splitPos({ state: STATE.ENTRY_PENDING, legs: [] });
  const s = snap({ entries: { E1: { status: 'dead' } } });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.state, STATE.ENTRY_DEAD);
});

test('entry still pending -> wait (no state change, no actions)', () => {
  const pos = splitPos({ state: STATE.ENTRY_PENDING, legs: [] });
  const s = snap({ entries: { E1: { status: 'pending' } } });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.state, STATE.ENTRY_PENDING);
  assert.deepEqual(r.actions, []);
});

test('ENTRY_PENDING with LTP PAST the cost trigger -> still NO cost move (the awaitingFill bug class)', () => {
  // The legacy bug: MTM/cost-move/live-P&L acted on an unfilled entry. In the
  // engine an unfilled entry is ENTRY_PENDING, which manages NOTHING — no
  // MOVE_SL_TO_COST against a non-existent order, no P&L, regardless of price.
  const pos = splitPos({ state: STATE.ENTRY_PENDING, legs: [], costTrigger: 498, ltp: 500.1 });
  const s = snap({ entries: { E1: { status: 'pending' } } });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.state, STATE.ENTRY_PENDING);
  assert.ok(!r.actions.some(a => a.type === 'MOVE_SL_TO_COST'));
  assert.deepEqual(r.actions, []);
});

// -- UNPROTECTED resolution -------------------------------------------------------
test('UNPROTECTED then manually sold -> CLOSED with fills-based P&L', () => {
  const pos = splitPos({ state: STATE.UNPROTECTED, symbol: 'INDOAMIN', qty: 3, entryPrice: 130, slPrice: 126, targetPrice: 138, t1Price: 134 });
  const s = snap({ heldQty: { INDOAMIN: 0 }, sells: { INDOAMIN: [{ qty: 3, px: 132.5 }] } });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.realisedPnl, 7.5);
});

test('UNPROTECTED then protection re-appears live -> back to PROTECTED', () => {
  const pos = splitPos({ state: STATE.UNPROTECTED });
  const s = snap({ protections: { FR: live(166.9) }, heldQty: { SAMHI: 2 } });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.state, STATE.PROTECTED);
});

// -- Close reconstruction edge: SL day --------------------------------------------
test('gap-down SL exit -> SL HIT with real (slipped) fill P&L', () => {
  const s = snap({ heldQty: {}, sells: { SAMHI: [{ qty: 2, px: 165.4 }] } }); // gapped through 166.9
  const r = transition(splitPos(), s, { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.exitType, 'SL HIT');
  assert.equal(r.patch.realisedPnl, -15);          // (165.4-172.9)*2
});

test('single (non-split) close labels from single-leg logic', () => {
  const c = reconstructClose(
    { entryPrice: 100, qty: 5, targetPrice: 110, slPrice: 95, legs: [{ id: 'F1', role: 'single', qty: 5 }] },
    [{ qty: 5, px: 110.1 }]
  );
  assert.equal(c.exitType, 'TARGET HIT');
  assert.equal(c.realisedPnl, 50.5);
});

// -- RE-ARM & RE-ASSERT: nothing mismatched with the broker stays mismatched --------
test('DRIFTED stop (broker trigger != expected SL) -> MODIFY_SL re-assert + drift alert', () => {
  const pos = splitPos({ slPrice: 172.9 }); // app expects cost, broker still shows original SL
  const s = snap({ protections: { FT1: live(166.9), FR: live(166.9) }, heldQty: { SAMHI: 2 } });
  const r = transition(pos, s, { now: NOW });
  const mv = r.actions.find(a => a.type === 'MODIFY_SL');
  assert.ok(mv && mv.price === 172.9 && mv.reason === 'reassert-drift');
  assert.deepEqual(mv.legIds.sort(), ['FR', 'FT1']);
  assert.equal(r.alerts[0].type, 'SL_DRIFT');
});

test('matching stop -> NO re-assert (tolerance respected)', () => {
  const pos = splitPos({ slPrice: 166.9 });
  const s = snap({ protections: { FT1: live(166.9), FR: live(166.92) }, heldQty: { SAMHI: 2 } });
  const r = transition(pos, s, { now: NOW });
  assert.ok(!r.actions.some(a => a.type === 'MODIFY_SL'));
});

test('no re-assert while a modify is pending verification', () => {
  const pos = splitPos({ slPrice: 172.9, pendingSl: { price: 172.9, at: NOW - 1000, toCost: true } });
  const s = snap({ protections: { FT1: live(166.9), FR: live(166.9) }, heldQty: { SAMHI: 2 } });
  const r = transition(pos, s, { now: NOW });
  assert.ok(!r.actions.some(a => a.type === 'MODIFY_SL'));
});

test('LOOPHOLE L1: broker stop ABOVE expected (trail landed, row stale) -> ADOPT, never lower', () => {
  const pos = splitPos({ slPrice: 166.9 }); // row is stale; broker already trailed to 171
  const s = snap({ protections: { FT1: live(171), FR: live(171) }, heldQty: { SAMHI: 2 } });
  const r = transition(pos, s, { now: NOW });
  assert.ok(!r.actions.some(a => a.type === 'MODIFY_SL')); // NEVER moves a stop down
  assert.equal(r.patch.slPrice, 171);                      // adopts broker truth upward
});

test('LOOPHOLE L2: trigger-less live leg (triggered GTT) cannot block SL confirmation', () => {
  const pos = splitPos({ pendingSl: { price: 172.9, at: NOW - 1000, toCost: true } });
  const s = snap({ protections: { FT1: { status: 'live' }, FR: live(172.9) }, heldQty: { SAMHI: 2 } });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.patch.costMoved, true);   // confirmed on the verifiable leg
  assert.equal(r.patch.pendingSl, null);   // no stale-alert loop
});

test('LOOPHOLE L3: cross-day split close adds the recorded T1 P&L for the missing leg', () => {
  // T1 booked Monday (+1.73 recorded); Wednesday's book only has the runner fill.
  const pos = splitPos({ t1Booked: true, t1Pnl: 1.73 });
  const s = snap({ heldQty: { SAMHI: 0 }, sells: { SAMHI: [{ qty: 1, px: 176.38 }] } });
  const r = transition(pos, s, { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.realisedPnl, 5.21); // (176.38-172.9)*1 + 1.73
  assert.equal(r.patch.exitType, 'TARGET HIT');
});

test('FALSE cost tick with corrupted row SL: promise wins — re-assert to ENTRY, not the stale field', () => {
  // Legacy trusted-on-write set costMoved ✓ but neither the broker NOR the row
  // SL ever moved: row.slPrice = original 166.9 = broker trigger -> no "drift"
  // by field comparison. The costMoved promise forces expected = entry (172.9).
  const pos = splitPos({ costMoved: true, slPrice: 166.9 });
  const s = snap({ protections: { FT1: live(166.9), FR: live(166.9) }, heldQty: { SAMHI: 2 } });
  const r = transition(pos, s, { now: NOW });
  const mv = r.actions.find(a => a.type === 'MODIFY_SL');
  assert.ok(mv && mv.price === 172.9, 'must re-assert to cost (entry), promise over field');
  assert.equal(r.alerts[0].type, 'SL_DRIFT');
});

test('UNPROTECTED + still held -> REARM_PROTECTION action every pass', () => {
  const pos = splitPos({ state: STATE.UNPROTECTED });
  const s = snap({ protections: {}, heldQty: { SAMHI: 2 }, sells: {} });
  const r = transition(pos, s, { now: NOW });
  assert.ok(r.actions.some(a => a.type === 'REARM_PROTECTION'));
});

test('GTT within 30 days of expiry -> REFRESH_PROTECTION; far expiry -> nothing', () => {
  const soon = { status: 'live', triggerPrice: 166.9, expiresAt: NOW + 10 * 24 * 60 * 60 * 1000 };
  const far = { status: 'live', triggerPrice: 166.9, expiresAt: NOW + 200 * 24 * 60 * 60 * 1000 };
  let r = transition(splitPos({ slPrice: 166.9 }), snap({ protections: { FT1: soon, FR: far }, heldQty: { SAMHI: 2 } }), { now: NOW });
  const rf = r.actions.find(a => a.type === 'REFRESH_PROTECTION');
  assert.ok(rf && rf.legIds.length === 1 && rf.legIds[0] === 'FT1');
  r = transition(splitPos({ slPrice: 166.9 }), snap({ protections: { FT1: far, FR: far }, heldQty: { SAMHI: 2 } }), { now: NOW });
  assert.ok(!r.actions.some(a => a.type === 'REFRESH_PROTECTION'));
});

// -- INVARIANTS: impossible states are produced never, detected always -------------
const { invariantViolations } = require('./engine');

test('INVARIANT: reconstructClose can never emit T2 without T1 (single runner fill)', () => {
  const c = reconstructClose(
    { entryPrice: 380, qty: 2, targetPrice: 400, slPrice: 370, t1Price: 396.73,
      legs: [{ id: 'A', role: 't1', qty: 1 }, { id: 'B', role: 'runner', qty: 1 }] },
    [{ qty: 1, px: 400.1 }] // only the runner's target fill visible
  );
  assert.equal(c.t2Done, true);
  assert.equal(c.t1Booked, true); // forced: T2 implies T1
});

test('INVARIANT sweep: T2 ticked without T1 on a split is flagged (the screenshot bug)', () => {
  const v = invariantViolations({ splitT1: true, t2Done: true, t1Booked: false, open: true });
  assert.ok(v.some(x => /T2.*T1/.test(x)));
});

test('INVARIANT sweep: split + EMA trailing together is flagged', () => {
  const v = invariantViolations({ splitT1: true, emaTrailingEnabled: true, t1Booked: true, t2Done: false });
  assert.ok(v.some(x => /trailing/.test(x)));
});

test('INVARIANT sweep: leg quantities must sum to position qty', () => {
  const v = invariantViolations({ splitT1: true, qty: 3, legAQty: 1, legBQty: 1 });
  assert.ok(v.some(x => /sum/.test(x)));
});

test('INVARIANT sweep: cost tick on UNPROTECTED, and realised P&L while open, are flagged', () => {
  assert.equal(invariantViolations({ unprotected: true, costMoved: true }).length, 1);
  assert.equal(invariantViolations({ open: true, realisedPnl: 5.13 }).length, 1);
});

test('INVARIANT sweep: healthy positions produce zero violations', () => {
  assert.deepEqual(invariantViolations({ splitT1: true, qty: 2, legAQty: 1, legBQty: 1, t1Booked: true, t2Done: true, open: false, closed: true, exitType: 'TARGET HIT', realisedPnl: 5.13 }), []);
  assert.deepEqual(invariantViolations({ splitT1: false, open: true }), []);
});

// -- Never act on the unknown -------------------------------------------------------
test('unknown state -> no change, no actions', () => {
  const r = transition(splitPos({ state: 'SOMETHING_NEW' }), snap(), { now: NOW });
  assert.deepEqual(r.actions, []);
  assert.equal(r.state, 'SOMETHING_NEW');
});
