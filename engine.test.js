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

test('SL HIT but holdings still show the position (T+1 lag): covering SELL closes it anyway', () => {
  // Legs gone, a full SELL is in the book, yet holdings STILL lists the qty
  // (settlement lag). Must CLOSE on the fill, not sit open for a day.
  const s = snap({ protections: {}, heldQty: { SAMHI: 2 }, sells: { SAMHI: [{ qty: 2, px: 166.8 }] } });
  const r = transition(splitPos(), s, { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.exitType, 'SL HIT');
  assert.equal(r.patch.realisedPnl, -12.2); // (166.8-172.9)*2
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
  // The action carries the FILL TRUTH (2026-08-17): the executor sizes
  // protection to what filled, at the price it filled - never to the order.
  assert.deepEqual(r.actions, [{ type: 'PLACE_PROTECTION', filledQty: 2, fillPrice: 172.95 }]);
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

test('INVARIANT sweep: split + EMA trailing together is the NORMAL shape since 2026-08-18 (T1/T2 at broker, stop trails) - not flagged', () => {
  const v = invariantViolations({ splitT1: true, emaTrailingEnabled: true, t1Booked: true, t2Done: false });
  assert.ok(!v.some(x => /trailing/.test(x)));
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


// -- INCIDENT: V2RETAIL 2026-08-13 (T1 booked behind a dead runner) -----------
// The morning's blind GTT read made every FYERS row look naked; the re-arm
// cancelled the RUNNER leg first and was then rate-limited before it could
// replace anything. So T1 later fired against a bracket whose runner was
// already gone. Both existing T1 tells failed: FYERS reports a fired rule as
// "fired" (never "traded_target", and never WHICH leg), and the runner-still-
// live tell needs a runner. Result: T1 booked at the broker, unknown to the
// app - no t1Booked, no t1Pnl, and the leftover share read as an unexplained
// naked position.
test('V2RETAIL: T1 leg terminal + runner DEAD + partial holding still books T1', () => {
  const r = transition(splitPos({ ltp: 224.4 }), snap({
    protections: { FT1: { status: 'fired' }, FR: { status: 'gone' } },
    heldQty: { SAMHI: 1 },                       // exactly the runner's qty left
    sells: { SAMHI: [{ qty: 1, px: 174.63 }] },  // legA's quantity sold
  }), { now: NOW });
  assert.equal(r.patch.t1Booked, true, 'quantity is the evidence when leg state cannot be');
  assert.equal(r.patch.t1Pnl, 1.73, '(174.63 - 172.9) x 1');
});

test('V2RETAIL: a dead runner is never "moved to cost" - the position is unprotected instead', () => {
  const r = transition(splitPos({ ltp: 224.4 }), snap({
    protections: { FT1: { status: 'fired' }, FR: { status: 'gone' } },
    heldQty: { SAMHI: 1 }, sells: { SAMHI: [{ qty: 1, px: 174.63 }] },
  }), { now: NOW });
  assert.deepEqual(r.actions, [], 'no modify can reach a cancelled leg');
});

test('a FULL stop-out is NOT read as a T1 book (nothing left held)', () => {
  const r = transition(splitPos({ ltp: 166 }), snap({
    protections: { FT1: { status: 'fired' }, FR: { status: 'fired' } },
    heldQty: {},                                   // stop-out closes everything
    sells: { SAMHI: [{ qty: 2, px: 166.9 }] },
  }), { now: NOW });
  assert.notEqual(r.patch.t1Booked, true, 'a stop hit kills both legs - never a T1 book');
});

test('T1 terminal + runner dead but NOTHING sold yet -> no T1 claim (wait for fill evidence)', () => {
  const r = transition(splitPos({ ltp: 224.4 }), snap({
    protections: { FT1: { status: 'fired' }, FR: { status: 'gone' } },
    heldQty: { SAMHI: 1 }, sells: {},
  }), { now: NOW });
  assert.notEqual(r.patch.t1Booked, true, 'trigger is not fill');
});

// -- One tick, one modify -----------------------------------------------------
// (1) books T1 and orders the post-T1 move; (3) then fired again for the same
// leg because it read pos.t1Booked (still false) instead of the patch just
// written, so every healthy T1 sent the same modify twice.
test('T1 books and the runner moves to cost EXACTLY once in a tick', () => {
  const r = transition(splitPos({ ltp: 174.7, costTrigger: 173.8 }), snap({
    protections: { FT1: { status: 'fired' }, FR: live(166.9) },
    heldQty: { SAMHI: 1 }, sells: { SAMHI: [{ qty: 1, px: 174.63 }] },
  }), { now: NOW });
  assert.equal(r.patch.t1Booked, true);
  const moves = r.actions.filter(a => a.type === 'MOVE_SL_TO_COST');
  assert.equal(moves.length, 1, 'one modify, not two');
  assert.equal(moves[0].reason, 'post-T1');
  assert.deepEqual(moves[0].legIds, ['FR'], 'the runner only - legA is terminal');
});

test('pre-T1 cost move still fires normally when T1 has NOT booked', () => {
  const r = transition(splitPos({ ltp: 173.9, costTrigger: 173.8 }), snap({
    protections: { FT1: live(166.9), FR: live(166.9) }, heldQty: { SAMHI: 2 },
  }), { now: NOW });
  const moves = r.actions.filter(a => a.type === 'MOVE_SL_TO_COST');
  assert.equal(moves.length, 1);
  assert.equal(moves[0].reason, 'pre-T1');
  assert.deepEqual(moves[0].legIds, ['FT1', 'FR'], 'both legs are live -> both move');
});

test('pre-T1 cost move names ONLY the live legs when one is already gone', () => {
  const r = transition(splitPos({ ltp: 173.9, costTrigger: 173.8 }), snap({
    protections: { FT1: live(166.9), FR: { status: 'gone' } }, heldQty: { SAMHI: 2 },
  }), { now: NOW });
  const moves = r.actions.filter(a => a.type === 'MOVE_SL_TO_COST');
  assert.deepEqual(moves[0].legIds, ['FT1'], 'the executor must not re-derive this from the row');
});

// -- Rule 7: TRAILING is the engine's (2026-08-17) --------------------------
// Ported from the legacy daily pass so the engine owns EVERY write to the stop.
// Each rule below is preserved from legacy on purpose; each is a real trap.
const trailPos = (o) => splitPos({ legs: [{ id: 'F1', role: 'single', qty: 2 }], t1Price: 0, targetPrice: 110, ...o });
const trailSnap = (trig) => snap({ protections: { F1: live(trig) }, heldQty: { SAMHI: 2 } });
const tr = (o) => ({ enabled: true, mode: 'ema', pct: 2, armPrice: 180, armed: false, ema: 0, peak: 0, lastDay: '', today: 'D1', afterCheckTime: true, ...o });

test('trail: below the start level nothing happens', () => {
  const r = transition(trailPos({ ltp: 179, trail: tr() }), trailSnap(166.9), { now: NOW });
  assert.deepEqual(r.actions, []); assert.equal(r.patch.trailArmed, undefined);
});
test('trail: crossing the start level ARMS (sticky) and seeds the peak, but does not modify yet', () => {
  const r = transition(trailPos({ ltp: 181, trail: tr() }), trailSnap(166.9), { now: NOW });
  assert.equal(r.patch.trailArmed, true); assert.equal(r.patch.trailPeak, 181); assert.deepEqual(r.actions, []);
});
test('trail EMA: armed + settled EMA above the stop -> ONE MODIFY_SL upward, stamped for the day', () => {
  const r = transition(trailPos({ ltp: 190, trail: tr({ armed: true, ema: 185 }) }), trailSnap(166.9), { now: NOW });
  assert.deepEqual(r.actions.map(a => a.type + '@' + a.price), ['MODIFY_SL@181.3']);
  assert.equal(r.patch.trailLastDay, 'D1');
});
test('trail EMA: runs ONCE per IST day (a second pass the same day is silent)', () => {
  const r = transition(trailPos({ ltp: 190, trail: tr({ armed: true, ema: 185, lastDay: 'D1' }) }), trailSnap(166.9), { now: NOW });
  assert.deepEqual(r.actions, []);
});
test('trail EMA: waits for the daily check time (a settled EMA, never a half-formed candle)', () => {
  const r = transition(trailPos({ ltp: 190, trail: tr({ armed: true, ema: 185, afterCheckTime: false }) }), trailSnap(166.9), { now: NOW });
  assert.deepEqual(r.actions, []);
});
test('trail: the stop NEVER moves down', () => {
  const r = transition(trailPos({ ltp: 190, slPrice: 184, trail: tr({ armed: true, ema: 185 }) }), trailSnap(184), { now: NOW });
  assert.deepEqual(r.actions, [], '185*0.98 = 181.3 < 184: refused');
});
test('trail: a stop at/above the market is not sent (it would fire on arrival - NAHARINDUS)', () => {
  const r = transition(trailPos({ ltp: 181, trail: tr({ armed: true, ema: 185 }) }), trailSnap(166.9), { now: NOW });
  assert.deepEqual(r.actions, [], '181.3 >= 181');
});
test('trail: waits while a previous modify is pending verification (rule 4 first)', () => {
  const r = transition(trailPos({ ltp: 190, pendingSl: { price: 172.9, at: NOW }, trail: tr({ armed: true, ema: 185 }) }), trailSnap(166.9), { now: NOW });
  assert.ok(!r.actions.some(a => /trail/.test(a.reason || '')));
});
test('trail PEAK: follows the high-water mark and keeps the mark; falls back never lower', () => {
  const up = transition(trailPos({ ltp: 200, trail: tr({ mode: 'peak', pct: 3, armed: true, peak: 195 }) }), trailSnap(166.9), { now: NOW });
  assert.deepEqual(up.actions.map(a => a.type + '@' + a.price), ['MODIFY_SL@194']);
  assert.equal(up.patch.trailPeak, 200);
  const down = transition(trailPos({ ltp: 196, slPrice: 194, trail: tr({ mode: 'peak', pct: 3, armed: true, peak: 200 }) }), trailSnap(194), { now: NOW });
  assert.deepEqual(down.actions, []);
});
test('trail: disabled -> the engine never touches the stop', () => {
  const r = transition(trailPos({ ltp: 250 }), trailSnap(166.9), { now: NOW });
  assert.deepEqual(r.actions, []);
});

// -- INCIDENT: GNA (#37, ported to the engine 2026-08-17) --------------------
// The order book said "no fill" while 1 share sat in holdings. Legacy rejected
// the row and the share ran untracked and unprotected. Holdings outrank the
// book. Built against THIS WEEK'S mistakes: absence is never a verdict; an
// adapter count sizes protection down, never up.
const gnaPos = () => ({ state: STATE.ENTRY_PENDING, symbol: 'GNA', qty: 1, entryId: 'E1', legs: [], ltp: 0 });
const deadBook = { E1: { status: 'dead' } };

test('GNA: book dead + 1 held -> PROTECT (PROTECTION_PENDING + PLACE_PROTECTION), never ENTRY_DEAD', () => {
  const r = transition(gnaPos(), snap({ entries: deadBook, heldQty: { GNA: 1 } }), { now: NOW });
  assert.equal(r.state, STATE.PROTECTION_PENDING);
  assert.deepEqual(r.actions.map(a => [a.type, a.filledQty, a.reason]), [['PLACE_PROTECTION', 1, 'book-lie']]);
  assert.equal(r.alerts[0].type, 'BOOK_LIE');
  assert.match(r.alerts[0].reason, /1 held/, 'the alert names the evidence');
});
test('GNA: book dead + NOT held -> ENTRY_DEAD (the honest reject)', () => {
  assert.equal(transition(gnaPos(), snap({ entries: deadBook, heldQty: {} }), { now: NOW }).state, STATE.ENTRY_DEAD);
});
test('GNA: holdings map MISSING -> WAIT; absence is E4 and never grounds a destructive verdict', () => {
  const s = snap({ entries: deadBook }); delete s.heldQty;
  const r = transition(gnaPos(), s, { now: NOW });
  assert.equal(r.state, STATE.ENTRY_PENDING); assert.deepEqual(r.actions, []);
});
test('GNA: the held count sizes protection DOWN, never up (adapters can over-count)', () => {
  const r = transition(gnaPos(), snap({ entries: deadBook, heldQty: { GNA: 3 } }), { now: NOW });
  assert.equal(r.actions[0].filledQty, 1, 'ordered 1, held reads 3 -> protect 1');
});
test('GNA: partial then cancelled (ordered 4, 1 held) -> protect the 1 actually held', () => {
  const r = transition({ ...gnaPos(), qty: 4 }, snap({ entries: deadBook, heldQty: { GNA: 1 } }), { now: NOW });
  assert.equal(r.actions[0].filledQty, 1);
});

// -- EXIT_PENDING + CHASE_EXIT (2026-08-17; HEALTHX 2026-07-24 class) --------
// A stop fired and its SELL is standing unfilled. That is an exit in flight -
// NOT unprotected. Re-arming beside a standing SELL is the fire-instantly-and-
// RMS-reject loop; and a resting LIMIT above the market never fills, so a stuck
// MARKET-type exit is cancelled and re-placed at market by the executor.
const MIN = 60 * 1000;
const xPos = (o) => splitPos({ legs: [{ id: 'F1', role: 'single', qty: 2 }], t1Price: 0, exitOrderType: 'market', exitPendingAt: 0, exitChaseAttempts: 0, exitChaseLastAt: 0, ...o });
const working = (o = {}) => snap({ heldQty: { SAMHI: 2 }, openSells: { SAMHI: 2 }, ...o });

test('EXIT_PENDING: PROTECTED with a fired stop and a WORKING sell latches (no UNPROTECTED, no grace)', () => {
  const r = transition(xPos(), working({ protections: { F1: { status: 'traded_sl', px: 166.9 } } }), { now: NOW });
  assert.equal(r.state, STATE.EXIT_PENDING); assert.deepEqual(r.actions, []); assert.deepEqual(r.alerts, []);
});
test('EXIT_PENDING: UNPROTECTED + a working sell latches instead of RE-ARMING (the HEALTHX loop, closed)', () => {
  const r = transition(xPos({ state: STATE.UNPROTECTED }), working({ protections: { F1: { status: 'gone' } } }), { now: NOW });
  assert.equal(r.state, STATE.EXIT_PENDING);
  assert.ok(!r.actions.some(a => a.type === 'REARM_PROTECTION'), 'never re-arm beside a live SELL');
});
test('EXIT_PENDING -> CLOSED on a covering fill (E1), with real prices', () => {
  const r = transition(xPos({ state: STATE.EXIT_PENDING, exitPendingAt: NOW - MIN }), snap({ sells: { SAMHI: [{ qty: 2, px: 166.5 }] } }), { now: NOW });
  assert.equal(r.state, STATE.CLOSED); assert.equal(r.patch.exitPrice, 166.5);
});
test('EXIT_PENDING -> UNPROTECTED when the sell vanishes without a fill and we still hold', () => {
  const r = transition(xPos({ state: STATE.EXIT_PENDING, exitPendingAt: NOW - MIN }), snap({ heldQty: { SAMHI: 2 } }), { now: NOW });
  assert.equal(r.state, STATE.UNPROTECTED); assert.equal(r.alerts[0].type, 'UNPROTECTED');
});
test('CHASE_EXIT: only a MARKET-type exit, only after the wait, with cooldown and an attempt cap', () => {
  const at = (o) => transition(xPos({ state: STATE.EXIT_PENDING, ...o }), working(), { now: NOW }).actions.map(a => a.type);
  assert.deepEqual(at({ exitPendingAt: NOW - 1 * MIN }), [], 'too young');
  assert.deepEqual(at({ exitPendingAt: NOW - 4 * MIN }), ['CHASE_EXIT'], 'stuck');
  assert.deepEqual(at({ exitPendingAt: NOW - 4 * MIN, exitOrderType: 'limit' }), [], 'limit exits are not chased');
  assert.deepEqual(at({ exitPendingAt: NOW - 20 * MIN, exitChaseAttempts: 1, exitChaseLastAt: NOW - 5 * MIN }), [], 'cooldown');
  assert.deepEqual(at({ exitPendingAt: NOW - 20 * MIN, exitChaseAttempts: 1, exitChaseLastAt: NOW - 11 * MIN }), ['CHASE_EXIT'], 'second attempt');
  assert.deepEqual(at({ exitPendingAt: NOW - 40 * MIN, exitChaseAttempts: 2, exitChaseLastAt: NOW - 15 * MIN }), [], 'capped at 2');
});
test('CHASE_EXIT: post-T1 the chase quantity is the RUNNER, never the full position', () => {
  const r = transition(xPos({ state: STATE.EXIT_PENDING, exitPendingAt: NOW - 4 * MIN, t1Booked: true, legs: [{ id: 'A', role: 't1', qty: 1 }, { id: 'B', role: 'runner', qty: 1 }] }),
    snap({ heldQty: { SAMHI: 1 }, openSells: { SAMHI: 1 } }), { now: NOW });
  assert.equal(r.actions[0].qty, 1);
});

// -- CLOSED re-check: a FALSE close is corrected by broker truth (2026-08-17) --
// Broker-state lag produces false closes: a leg reads terminal, we book an
// ESTIMATED exit, and the shares are still held. Legacy fixed those with a
// separate reopen pass; the engine re-checks its own verdict. A CONFIRMED close
// (a real fill) is never re-opened; an estimated one is, once, within 8h.
const H = 3600 * 1000;
const cPos = (o) => splitPos({ state: STATE.CLOSED, legs: [{ id: 'F1', role: 'single', qty: 2 }], exitEstimated: true, reopened: false, closedAt: NOW - H, ...o });
test('CLOSED re-check: estimated close but still HELD, nothing live -> UNPROTECTED + REOPENED (re-arm follows)', () => {
  const r = transition(cPos(), snap({ heldQty: { SAMHI: 2 } }), { now: NOW });
  assert.equal(r.state, STATE.UNPROTECTED); assert.equal(r.patch.reopened, true); assert.equal(r.alerts[0].type, 'REOPENED');
  assert.equal(r.patch.exitType, ''); assert.equal(r.patch.exitEstimated, false);
});
test('CLOSED re-check: estimated close but a leg is LIVE -> PROTECTED + REOPENED', () => {
  const r = transition(cPos(), snap({ protections: { F1: live(166.9) } }), { now: NOW });
  assert.equal(r.state, STATE.PROTECTED); assert.equal(r.patch.reopened, true);
});
test('CLOSED re-check: truly flat -> stays CLOSED; a CONFIRMED close is NEVER re-opened; window and once-only hold', () => {
  assert.equal(transition(cPos(), snap(), { now: NOW }).state, STATE.CLOSED);
  assert.equal(transition(cPos({ exitEstimated: false }), snap({ heldQty: { SAMHI: 2 } }), { now: NOW }).state, STATE.CLOSED, 'real fill = real close');
  assert.equal(transition(cPos({ closedAt: NOW - 9 * H }), snap({ heldQty: { SAMHI: 2 } }), { now: NOW }).state, STATE.CLOSED, 'outside the 8h window');
  assert.equal(transition(cPos({ reopened: true }), snap({ heldQty: { SAMHI: 2 } }), { now: NOW }).state, STATE.CLOSED, 'never twice');
});

// -- ENTRY_DEAD cancels its orphaned protection (2026-08-17) -------------------
// Dhan places the Forever at ENTRY time. A rejected entry therefore leaves a
// standing SELL trigger against shares never bought - a naked short when it
// fires. Legacy cancelOrphanedDhanForevers existed for this; the engine now
// treats ENTRY_DEAD as a consequence, not a label.
const dPending = { state: STATE.ENTRY_PENDING, symbol: 'SAMHI', qty: 2, entryId: 'E1', legs: [{ id: 'F1', role: 'single', qty: 2 }], ltp: 0 };
test('ENTRY_DEAD: a rejected entry with protection already placed -> CANCEL_ORPHAN_PROTECTION for its legs', () => {
  const r = transition(dPending, snap({ entries: { E1: { status: 'dead' } }, protections: { F1: live(166.9) } }), { now: NOW });
  assert.equal(r.state, STATE.ENTRY_DEAD);
  assert.deepEqual(r.actions.map(a => [a.type, a.legIds]), [['CANCEL_ORPHAN_PROTECTION', ['F1']]]);
});
test('ENTRY_DEAD: keeps asking while a leg still reads live; goes quiet once gone', () => {
  assert.equal(transition({ ...dPending, state: STATE.ENTRY_DEAD }, snap({ protections: { F1: live(166.9) } }), { now: NOW }).actions.length, 1);
  assert.equal(transition({ ...dPending, state: STATE.ENTRY_DEAD }, snap({ protections: { F1: { status: 'gone' } } }), { now: NOW }).actions.length, 0);
});
test('ENTRY_DEAD: the GNA guard runs FIRST - a "dead" book with shares HELD protects, never cancels', () => {
  const r = transition(dPending, snap({ entries: { E1: { status: 'dead' } }, heldQty: { SAMHI: 2 }, protections: { F1: live(166.9) } }), { now: NOW });
  assert.equal(r.state, STATE.PROTECTION_PENDING);
  assert.ok(!r.actions.some(a => a.type === 'CANCEL_ORPHAN_PROTECTION'));
});

// -- No-SL / TARGETS_ONLY (2026-08-17) -----------------------------------------
// entry 100 x10; T1 4 qty @103, T2 6 qty @106; NO stop by design.
function noSlPos(over = {}) {
  return {
    state: STATE.TARGETS_ONLY, symbol: 'NOSL', qty: 10, entryPrice: 100, slPrice: 0, targetPrice: 106, t1Price: 103,
    costTrigger: 0, entryId: 'E9',
    legs: [{ id: 'TG1', role: 'target-t1', qty: 4, price: 103 }, { id: 'TG2', role: 'target-t2', qty: 6, price: 106 }],
    t1Booked: false, costMoved: false, pendingSl: null, graceStartAt: 0, ltp: 0, heldSeenAt: NOW - 1000,
    ...over,
  };
}
const liveQ = (trigger, qty) => ({ status: 'live', triggerPrice: trigger, qty });

test('NOSL: both legs live + held -> nothing to do (no stop is NOT unprotected)', () => {
  const r = transition(noSlPos(), snap({ protections: { TG1: liveQ(103, 4), TG2: liveQ(106, 6) }, heldQty: { NOSL: 10 } }), { now: NOW });
  assert.equal(r.state, STATE.TARGETS_ONLY);
  assert.deepEqual(r.actions, []);
  assert.deepEqual(r.alerts, []);
});

test('NOSL: fills cover the position -> CLOSED TARGET HIT at the fills VWAP, exact P&L, T1+T2', () => {
  const r = transition(noSlPos(), snap({ heldQty: { NOSL: 10 } /* T+1 lag */, sells: { NOSL: [{ qty: 4, px: 103.1 }, { qty: 6, px: 106.05 }] } }), { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.exitType, 'TARGET HIT');
  assert.equal(r.patch.exitPrice, 104.87);
  assert.equal(r.patch.realisedPnl, 48.7);
  assert.equal(r.patch.t1Booked, true);
  assert.equal(r.patch.t2Done, true);
  assert.equal(r.patch.soldQty, 10);
  assert.equal(r.patch.exitEstimated, false);
});

test('NOSL: full sale BELOW the targets is EXITED (a manual exit), never TARGET HIT', () => {
  const r = transition(noSlPos(), snap({ heldQty: { NOSL: 0 }, sells: { NOSL: [{ qty: 10, px: 101 }] } }), { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.exitType, 'EXITED');
  assert.equal(r.patch.realisedPnl, 10);
});

test('NOSL: T1 qty sold while T2 stands -> t1Booked + t1Pnl from the fill, T1 not re-placed', () => {
  const r = transition(noSlPos(), snap({ protections: { TG2: liveQ(106, 6) }, heldQty: { NOSL: 6 }, sells: { NOSL: [{ qty: 4, px: 103.2 }] } }), { now: NOW });
  assert.equal(r.state, STATE.TARGETS_ONLY);
  assert.equal(r.patch.t1Booked, true);
  assert.equal(r.patch.t1Pnl, 12.8);
  assert.deepEqual(r.actions, []);
});

test('NOSL: cross-day T1 fill (no sell in today\'s book) -> quantity tell books T1; legacy re-placed T1 here (over-sell)', () => {
  const r = transition(noSlPos(), snap({ protections: { TG2: liveQ(106, 6) }, heldQty: { NOSL: 6 }, sells: {} }), { now: NOW });
  assert.equal(r.patch.t1Booked, true);
  assert.equal(r.patch.t1Pnl, 12);            // at the T1 price, no fill to read
  assert.deepEqual(r.actions, []);            // and NO T1 re-place
});

test('NOSL: quantity tell is withheld when today\'s book shows the ENTRY only partly filled', () => {
  const s = snap({ protections: { TG2: liveQ(106, 6) }, heldQty: { NOSL: 6 }, sells: {},
    entries: { E9: { status: 'filled', filledQty: 6, fillPrice: 100 } } });
  const r = transition(noSlPos(), s, { now: NOW });
  assert.equal(r.patch.t1Booked, undefined);
  // and the T1 leg is placed only for what is uncovered: 6 held - 6 live = 0 -> nothing
  assert.deepEqual(r.actions, []);
});

test('NOSL: missing T2 leg while held -> PLACE_TARGET_LEG T2 at the planned qty and price', () => {
  const r = transition(noSlPos(), snap({ protections: { TG1: liveQ(103, 4) }, heldQty: { NOSL: 10 } }), { now: NOW });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, 'PLACE_TARGET_LEG');
  assert.equal(r.actions[0].tag, 'T2');
  assert.equal(r.actions[0].qty, 6);
  assert.equal(r.actions[0].price, 106);
  assert.deepEqual(r.alerts, []);
});

test('NOSL: a re-placed leg is sized DOWN to held minus live cover, never up (+ alert)', () => {
  const r = transition(noSlPos(), snap({ protections: { TG1: liveQ(103, 4) }, heldQty: { NOSL: 7 } }), { now: NOW });
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].qty, 3);
  assert.equal(r.alerts[0].type, 'TARGET_LEG_SIZED_DOWN');
});

test('NOSL: a leg with NO id (placement failed at entry) reads gone -> placed', () => {
  const p = noSlPos({ legs: [{ id: 'TG1', role: 'target-t1', qty: 4, price: 103 }, { id: '', role: 'target-t2', qty: 6, price: 106 }] });
  const r = transition(p, snap({ protections: { TG1: liveQ(103, 4) }, heldQty: { NOSL: 10 } }), { now: NOW });
  assert.equal(r.actions[0].type, 'PLACE_TARGET_LEG');
  assert.equal(r.actions[0].tag, 'T2');
});

test('NOSL: a working SELL blocks any re-place (never sell beside a standing sell)', () => {
  const r = transition(noSlPos(), snap({ protections: { TG1: liveQ(103, 4) }, heldQty: { NOSL: 10 }, openSells: { NOSL: 6 } }), { now: NOW });
  assert.deepEqual(r.actions, []);
});

test('NOSL: a fired CLAIM on a leg is not a fill - still held, no working sell -> re-place it', () => {
  const r = transition(noSlPos(), snap({ protections: { TG1: liveQ(103, 4), TG2: { status: 'traded_sl', px: 106 } }, heldQty: { NOSL: 10 }, sells: {} }), { now: NOW });
  assert.equal(r.state, STATE.TARGETS_ONLY);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].tag, 'T2');
  assert.equal(r.actions[0].qty, 6);
});

test('NOSL: entry dead in the book + not held -> ENTRY_DEAD, live legs cancelled as orphans', () => {
  const s = snap({ protections: { TG1: liveQ(103, 4), TG2: liveQ(106, 6) }, heldQty: { NOSL: 0 }, entries: { E9: { status: 'dead' } } });
  const r = transition(noSlPos({ heldSeenAt: 0 }), s, { now: NOW });
  assert.equal(r.state, STATE.ENTRY_DEAD);
  assert.equal(r.actions[0].type, 'CANCEL_ORPHAN_PROTECTION');
  assert.deepEqual(r.actions[0].legIds, ['TG1', 'TG2']);
  assert.equal(r.actions[0].reason, 'entry-dead');
});

test('NOSL: entry still pending + not held -> wait, place nothing', () => {
  const r = transition(noSlPos({ heldSeenAt: 0 }), snap({ heldQty: { NOSL: 0 }, entries: { E9: { status: 'pending' } } }), { now: NOW });
  assert.equal(r.state, STATE.TARGETS_ONLY);
  assert.deepEqual(r.actions, []);
});

test('NOSL: a missing holdings map is UNKNOWN, not "not held" -> wait even on a dead book', () => {
  const s = { complete: true, protections: {}, entries: { E9: { status: 'dead' } }, sells: {} };   // no heldQty at all
  const r = transition(noSlPos({ heldSeenAt: 0 }), s, { now: NOW });
  assert.equal(r.state, STATE.TARGETS_ONLY);
  assert.deepEqual(r.actions, []);
});

test('NOSL: never held, entry vanished from the book (cross-day) -> grace first, then ENTRY_DEAD (reason entry-expired)', () => {
  const s = snap({ protections: { TG1: liveQ(103, 4) }, heldQty: { NOSL: 0 }, entries: {} });
  const r1 = transition(noSlPos({ heldSeenAt: 0 }), s, { now: NOW });
  assert.equal(r1.state, STATE.TARGETS_ONLY);
  assert.equal(r1.patch.graceStartAt, NOW);
  const r2 = transition(noSlPos({ heldSeenAt: 0, graceStartAt: NOW - GRACE - 1 }), s, { now: NOW });
  assert.equal(r2.state, STATE.ENTRY_DEAD);
  assert.equal(r2.actions[0].reason, 'entry-expired');
  assert.deepEqual(r2.actions[0].legIds, ['TG1']);
});

test('NOSL: seen held before, now flat with no fill today -> grace, then CLOSED estimated at ltp (never at a target)', () => {
  const s = snap({ protections: {}, heldQty: { NOSL: 0 }, entries: {} });   // empty list -> 4x grace
  const r1 = transition(noSlPos({ ltp: 104 }), s, { now: NOW });
  assert.equal(r1.state, STATE.TARGETS_ONLY);
  const r2 = transition(noSlPos({ ltp: 104, graceStartAt: NOW - GRACE * 4 - 1 }), s, { now: NOW });
  assert.equal(r2.state, STATE.CLOSED);
  assert.equal(r2.patch.exitType, 'EXITED');
  assert.equal(r2.patch.exitEstimated, true);
  assert.equal(r2.patch.exitPrice, 104);
  assert.equal(r2.patch.realisedPnl, 40);
});

test('NOSL: partly sold and flat -> CLOSED on what actually sold', () => {
  const r = transition(noSlPos(), snap({ heldQty: { NOSL: 0 }, sells: { NOSL: [{ qty: 4, px: 103 }] } }), { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.soldQty, 4);
  assert.equal(r.patch.exitType, 'TARGET HIT');
  assert.equal(r.patch.realisedPnl, 12);
});

test('NOSL: first sighting held stamps heldSeenAt (the engine\'s own memory)', () => {
  const r = transition(noSlPos({ heldSeenAt: 0 }), snap({ protections: { TG1: liveQ(103, 4), TG2: liveQ(106, 6) }, heldQty: { NOSL: 10 } }), { now: NOW });
  assert.equal(r.patch.heldSeenAt, NOW);
});

// -- rule 8: a stop that STANDS while price is through it (Angel backstop, ported) --
function singlePos(over = {}) {
  return { state: STATE.PROTECTED, symbol: 'ANG', qty: 10, entryPrice: 100, slPrice: 95, targetPrice: 110, t1Price: 0,
    costTrigger: 0, entryId: 'E1', legs: [{ id: 'R1', role: 'single', qty: 10 }],
    t1Booked: false, costMoved: false, pendingSl: null, graceStartAt: 0, ltp: 0, ...over };
}
const BB = { now: NOW, breachBackstop: true };

test('rule 8: price through the standing stop - first sighting counts, does NOT fire', () => {
  const r = transition(singlePos({ ltp: 94.5 }), snap({ protections: { R1: live(95) }, heldQty: { ANG: 10 } }), BB);
  assert.equal(r.patch.breachSightings, 1);
  assert.deepEqual(r.actions, []);
});

test('rule 8: second consecutive sighting -> EXIT_BREACHED_STOP naming the live legs, latched once', () => {
  const r = transition(singlePos({ ltp: 94.5, breachSightings: 1 }), snap({ protections: { R1: live(95) }, heldQty: { ANG: 10 } }), BB);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].type, 'EXIT_BREACHED_STOP');
  assert.deepEqual(r.actions[0].legIds, ['R1']);
  assert.equal(r.actions[0].qty, 10);
  assert.equal(r.patch.breachExitAt, NOW);
  assert.equal(r.alerts[0].type, 'STOP_NOT_FIRING');
  // and never again for this position while the latch stands
  const r2 = transition(singlePos({ ltp: 94.5, breachSightings: 2, breachExitAt: NOW - 1 }), snap({ protections: { R1: live(95) }, heldQty: { ANG: 10 } }), BB);
  assert.deepEqual(r2.actions, []);
});

test('rule 8: price back above the stop resets the counter', () => {
  const r = transition(singlePos({ ltp: 96, breachSightings: 1 }), snap({ protections: { R1: live(95) }, heldQty: { ANG: 10 } }), BB);
  assert.equal(r.patch.breachSightings, 0);
  assert.deepEqual(r.actions, []);
});

test('rule 8: within the margin (0.3%) is NOT through - a stop at 95 with price 94.8 waits', () => {
  const r = transition(singlePos({ ltp: 94.8, breachSightings: 1 }), snap({ protections: { R1: live(95) }, heldQty: { ANG: 10 } }), BB);
  assert.deepEqual(r.actions, []);
});

test('rule 8: a working SELL means the exit is in flight -> never fire beside it', () => {
  const r = transition(singlePos({ ltp: 94.5, breachSightings: 1 }), snap({ protections: { R1: live(95) }, heldQty: { ANG: 10 }, openSells: { ANG: 10 } }), BB);
  assert.deepEqual(r.actions, []);
});

test('rule 8: off unless the caller enables it (legacy scope: Angel, market hours)', () => {
  const r = transition(singlePos({ ltp: 94.5, breachSightings: 1 }), snap({ protections: { R1: live(95) }, heldQty: { ANG: 10 } }), { now: NOW });
  assert.deepEqual(r.actions, []);
  assert.equal(r.patch.breachSightings, undefined);
});

test('rule 8: reads the BROKER trigger when it is above the row stop (a trailed stop the row lost)', () => {
  // row says 95, broker leg stands at 98; price 97.5 is through 98 by 0.51%
  const r = transition(singlePos({ ltp: 97.5, breachSightings: 1 }), snap({ protections: { R1: live(98) }, heldQty: { ANG: 10 } }), BB);
  assert.equal(r.actions.length, 1);
  assert.equal(r.actions[0].stop, 98);
});

test('rule 8: split after T1 booked - exits the RUNNER qty only', () => {
  const p = splitPos({ ltp: 166, t1Booked: true, breachSightings: 1 });
  const r = transition(p, snap({ protections: { FR: live(166.9) }, heldQty: { SAMHI: 1 } }), BB);
  const a = r.actions.find(x => x.type === 'EXIT_BREACHED_STOP');
  assert.ok(a);
  assert.equal(a.qty, 1);
  assert.deepEqual(a.legIds, ['FR']);
});

// -- duplicate rows on one symbol: fills exceed the row -> VWAP x row qty ------
test('L5 dup rows: a 1-share row that sees three 1-share sells books ONE share of P&L at the VWAP (GENUSPOWER x3 on Angel, 2026-08-18)', () => {
  const p = singlePos({ qty: 1, entryPrice: 313.9, slPrice: 313.9, targetPrice: 323.3 });
  const s = snap({ protections: {}, heldQty: { ANG: 0 }, sells: { ANG: [{ qty: 1, px: 313.6 }, { qty: 1, px: 313.7 }, { qty: 1, px: 313.9 }] } });
  const r = transition(p, s, { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.exitPrice, 313.73);                       // VWAP, not the max
  assert.equal(r.patch.realisedPnl, Number(((313.73 - 313.9) * 1).toFixed(2)));   // one share, not three
  assert.equal(r.patch.exitType, 'SL HIT');
});

test('L5 dup rows: a normal close (fills == row qty) is untouched by the cap', () => {
  const p = singlePos({ qty: 2, entryPrice: 100, slPrice: 95, targetPrice: 110 });
  const r = transition(p, snap({ heldQty: { ANG: 0 }, sells: { ANG: [{ qty: 1, px: 110.2 }, { qty: 1, px: 110.4 }] } }), { now: NOW });
  assert.equal(r.patch.exitPrice, 110.4);     // max sell, as before
  assert.equal(r.patch.realisedPnl, 20.6);    // 10.2 + 10.4
  assert.equal(r.patch.exitType, 'TARGET HIT');
});

// -- rule 3b: move SL to T1 after T1 books (legacy checkSplitSlToT1, ported 2026-08-18) --
test('rule 3b: T1 booked, price slToT1Pct above T1 -> MODIFY_SL runner to T1 (reason sl-to-t1)', () => {
  // SAMHI: entry 172.9, T1 174.63; lock trigger 0.5% above T1 = 175.50
  const p = splitPos({ t1Booked: true, costMoved: true, slPrice: 172.9, slT1Trigger: 175.5, ltp: 175.6 });
  const r = transition(p, snap({ protections: { FR: live(172.9) }, heldQty: { SAMHI: 1 } }), { now: NOW });
  const a = r.actions.find(x => x.reason === 'sl-to-t1');
  assert.ok(a, 'expected sl-to-t1 modify');
  assert.equal(a.type, 'MODIFY_SL');
  assert.equal(a.price, 174.63);
  assert.deepEqual(a.legIds, ['FR']);
  assert.equal(r.patch.slT1Done, undefined);   // believed only after verification
});

test('rule 3b: believed only when the broker shows it (pendingSl.toT1 -> slT1Done)', () => {
  const p = splitPos({ t1Booked: true, slPrice: 172.9, slT1Trigger: 175.5, ltp: 175.6, pendingSl: { price: 174.63, at: NOW - 1000, toT1: true } });
  const r = transition(p, snap({ protections: { FR: live(174.63) }, heldQty: { SAMHI: 1 } }), { now: NOW });
  assert.equal(r.patch.slT1Done, true);
  assert.equal(r.patch.slPrice, 174.63);
});

test('rule 3b: below the trigger -> nothing; before T1 books -> nothing', () => {
  const below = transition(splitPos({ t1Booked: true, slPrice: 172.9, slT1Trigger: 175.5, ltp: 175.4 }), snap({ protections: { FR: live(172.9) }, heldQty: { SAMHI: 1 } }), { now: NOW });
  assert.ok(!below.actions.some(x => x.reason === 'sl-to-t1'));
  const preT1 = transition(splitPos({ t1Booked: false, slPrice: 166.9, slT1Trigger: 175.5, ltp: 175.6 }), snap({ protections: { FT1: live(166.9), FR: live(166.9) }, heldQty: { SAMHI: 2 } }), { now: NOW });
  assert.ok(!preT1.actions.some(x => x.reason === 'sl-to-t1'));
});

test('rule 3b: never lowers - stop already trailed above T1 -> flag only, no modify', () => {
  const p = splitPos({ t1Booked: true, slPrice: 175, slT1Trigger: 175.5, ltp: 176 });
  const r = transition(p, snap({ protections: { FR: live(175) }, heldQty: { SAMHI: 1 } }), { now: NOW });
  assert.ok(!r.actions.some(x => x.reason === 'sl-to-t1'));
  assert.equal(r.patch.slT1Done, true);
});

test('rule 3b: fires once - slT1Done set -> silent even past the trigger', () => {
  const p = splitPos({ t1Booked: true, slT1Done: true, slPrice: 172.9, slT1Trigger: 175.5, ltp: 176 });
  const r = transition(p, snap({ protections: { FR: live(172.9) }, heldQty: { SAMHI: 1 } }), { now: NOW });
  assert.ok(!r.actions.some(x => x.reason === 'sl-to-t1'));
});

// -- ADOPT: a row with no protection id + one live trigger on the symbol at the broker --
function nakedPos(over = {}) {
  return { state: STATE.UNPROTECTED, symbol: 'SOUTHWEST', qty: 5, entryPrice: 100, slPrice: 95, targetPrice: 110, t1Price: 0,
    costTrigger: 0, entryId: 'E1', legs: [], t1Booked: false, costMoved: false, pendingSl: null, graceStartAt: 0, ltp: 0, ...over };
}
test('ADOPT: exactly one live trigger on the symbol, none of ours -> adopt it (patch id/qty/trigger), no REARM', () => {
  const s = snap({ protections: { G77: { status: 'live', triggerPrice: 96, qty: 5, symbol: 'SOUTHWEST' } }, heldQty: { SOUTHWEST: 5 } });
  s.ownedIds = new Set();
  const r = transition(nakedPos(), s, { now: NOW });
  assert.equal(r.patch.adoptLegId, 'G77');
  assert.equal(r.patch.adoptLegTrigger, 96);
  assert.equal(r.alerts[0].type, 'ADOPTED_PROTECTION');
  assert.ok(!r.actions.some(a => a.type === 'REARM_PROTECTION'));
});
test('ADOPT: two live triggers on the symbol is ambiguous -> no adopt, REARM asked as before', () => {
  const s = snap({ protections: { A: { status: 'live', symbol: 'SOUTHWEST' }, B: { status: 'live', symbol: 'SOUTHWEST' } }, heldQty: { SOUTHWEST: 5 } });
  const r = transition(nakedPos(), s, { now: NOW });
  assert.equal(r.patch.adoptLegId, undefined);
  assert.ok(r.actions.some(a => a.type === 'REARM_PROTECTION'));
});
test('ADOPT: a trigger another row already names is never adopted', () => {
  const s = snap({ protections: { G77: { status: 'live', symbol: 'SOUTHWEST' } }, heldQty: { SOUTHWEST: 5 } });
  s.ownedIds = new Set(['G77']);
  const r = transition(nakedPos(), s, { now: NOW });
  assert.equal(r.patch.adoptLegId, undefined);
  assert.ok(r.actions.some(a => a.type === 'REARM_PROTECTION'));
});
test('ADOPT: not held -> nothing to adopt', () => {
  const s = snap({ protections: { G77: { status: 'live', symbol: 'SOUTHWEST' } }, heldQty: { SOUTHWEST: 0 } });
  const r = transition(nakedPos(), s, { now: NOW });
  assert.equal(r.patch.adoptLegId, undefined);
});

// -- never-lower guard on cost-move (2026-08-18): a trailed stop above entry is not pulled back to entry --
test('cost-move pre-T1: stop already trailed ABOVE entry -> costMoved ticked, NO modify sent', () => {
  const p = singlePos({ costTrigger: 101, ltp: 104, slPrice: 102 });   // trail lifted the stop to 102 > entry 100
  const r = transition(p, snap({ protections: { R1: live(102) }, heldQty: { ANG: 10 } }), { now: NOW });
  assert.ok(!r.actions.some(a => a.type === 'MOVE_SL_TO_COST'));
  assert.equal(r.patch.costMoved, true);
});
test('cost-move pre-T1: stop below entry -> modify still sent (unchanged behaviour)', () => {
  const p = singlePos({ costTrigger: 101, ltp: 104, slPrice: 95 });
  const r = transition(p, snap({ protections: { R1: live(95) }, heldQty: { ANG: 10 } }), { now: NOW });
  assert.ok(r.actions.some(a => a.type === 'MOVE_SL_TO_COST'));
});
test('cost-move post-T1: runner stop already above entry (trailed) -> ticked, not lowered', () => {
  // SAMHI entry 172.9; T1 books this tick; runner stop already trailed to 174
  const p = splitPos({ slPrice: 174 });
  const r = transition(p, snap({ protections: { FT1: { status: 'traded_target', px: 174.63 }, FR: live(174) }, heldQty: { SAMHI: 1 } }), { now: NOW });
  assert.equal(r.patch.t1Booked, true);
  assert.ok(!r.actions.some(a => a.type === 'MOVE_SL_TO_COST'));
  assert.equal(r.patch.costMoved, true);
});
