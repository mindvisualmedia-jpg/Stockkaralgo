'use strict';
// sync.test.js — every fixture here is a REAL divergence from production.
// If one breaks, a specific incident is about to repeat.

const { test } = require('node:test');
const assert = require('node:assert');
const { reconcile, nextPrior, CODES } = require('./sync');

const NOW = Date.parse('2026-08-13T10:30:00+05:30');
const TODAY = '2026-08-13T10:07:00+05:30';
const OLDER = '2026-08-06T10:07:00+05:30';

const snap = (over = {}) => ({ complete: true, protections: {}, entries: {}, heldQty: {}, sells: {}, openSells: {}, ...over });
const live = (symbol, trigger, qty) => ({ status: 'live', symbol, triggerPrice: trigger, qty });
// Confirmed on the first pass: strike discipline is tested separately.
const run = (rows, s, o = {}) => reconcile(rows, s, { now: NOW, minStrikes: 1, ...o });
const codes = (r) => r.divergences.map(d => d.code).sort();
const find = (r, code) => r.divergences.find(d => d.code === code);

// ---- FAIL-SAFE ---------------------------------------------------------------
test('an incomplete snapshot produces NOTHING (no evidence, no verdict)', () => {
  const r = run([{ id: 'r1', symbol: 'ARIS', qty: 3, broker: 'fyers' }], snap({ complete: false }));
  assert.deepEqual(r.divergences, []);
  assert.equal(r.stats.skipped, 'incomplete-snapshot');
});

// ---- GATE 0: the 2026-08-13 FYERS incident -----------------------------------
test('SUSPECT READ: known ids absent from the list -> zero divergences, not a page of them', () => {
  const rows = [
    { id: 'r1', symbol: 'ARIS', qty: 3, broker: 'fyers', recordedAt: TODAY, orderId: 'ENTRY:E1 | GTT-T1:632 | GTT:633' },
    { id: 'r2', symbol: 'FEDFINA', qty: 3, broker: 'fyers', recordedAt: TODAY, orderId: 'ENTRY:E2 | GTT-T1:634 | GTT:635' },
  ];
  // The parse returned [] while the positions were healthy and held.
  const r = run(rows, snap({ heldQty: { ARIS: 3, FEDFINA: 3 } }));
  assert.equal(r.suspectRead, true);
  assert.deepEqual(r.divergences, [], 'a blind read must never produce UNPROTECTED');
});

test('one matching id is enough to trust the read (a genuinely dead leg stays flaggable)', () => {
  const rows = [
    { id: 'r1', symbol: 'ARIS', qty: 3, broker: 'fyers', recordedAt: OLDER, orderId: 'ENTRY:E1 | GTT:633' },
    { id: 'r2', symbol: 'FEDFINA', qty: 3, broker: 'fyers', recordedAt: OLDER, orderId: 'ENTRY:E2 | GTT:635' },
  ];
  const r = run(rows, snap({ protections: { 635: live('FEDFINA', 141.2, 3) }, heldQty: { ARIS: 3, FEDFINA: 3 } }));
  assert.equal(r.suspectRead, false);
  assert.equal(find(r, CODES.UNPROTECTED).symbol, 'ARIS');
});

// ---- ARIS: held, both legs cancelled ----------------------------------------
test('ARIS: held with no live protection -> UNPROTECTED (critical, re-arm)', () => {
  const rows = [{ id: 'r1', symbol: 'ARIS', qty: 3, broker: 'fyers', recordedAt: TODAY,
    orderId: 'ENTRY:E1 | GTT-T1:632 | GTT:633' }];
  const r = run(rows, snap({ protections: { 632: { status: 'gone' }, 633: { status: 'gone' } }, heldQty: { ARIS: 3 } }));
  const d = find(r, CODES.UNPROTECTED);
  assert.equal(d.severity, 'critical');
  assert.equal(d.repair, 'rearm');
  assert.equal(d.evidence.held, 3);
});

// ---- ADVANCE: the half bracket that reads green today ------------------------
test('ADVANCE: 2 of 4 shares covered -> UNDER_PROTECTED (invisible to existence checks)', () => {
  const rows = [{ id: 'r1', symbol: 'ADVANCE', qty: 4, broker: 'fyers', recordedAt: TODAY, splitT1: true,
    splitLegAQty: 2, splitLegBQty: 2, fyersGttT1Id: '638', fyersGttId: '639' }];
  const r = run(rows, snap({
    protections: { 638: live('NSE:ADVANCE-EQ', 113.7, 2), 639: { status: 'gone' } },
    heldQty: { ADVANCE: 4 },
  }));
  const d = find(r, CODES.UNDER_PROTECTED);
  assert.equal(d.evidence.uncovered, 2, '2 shares carry no stop at all');
  assert.equal(d.severity, 'critical');
  assert.ok(!codes(r).includes(CODES.UNPROTECTED), 'a live leg exists, so it is not UNPROTECTED');
});

test('protection quantity unknown (adapter reports no qty) -> no qty verdict, no false alarm', () => {
  const rows = [{ id: 'r1', symbol: 'ADVANCE', qty: 4, broker: 'dhan', recordedAt: TODAY, dhanForeverId: 'F1' }];
  const r = run(rows, snap({ protections: { F1: { status: 'live', symbol: 'ADVANCE' } }, heldQty: { ADVANCE: 4 } }));
  assert.deepEqual(codes(r), [], 'unknown coverage must stay silent rather than guess');
});

// ---- GAIL / YESBANK: the 6 August duplicates ---------------------------------
test('GAIL: 5 live triggers covering 8 against 2 held -> SURPLUS, never auto-cancelled', () => {
  const rows = [{ id: 'r1', symbol: 'GAIL', qty: 2, broker: 'fyers', recordedAt: OLDER, fyersGttId: 'g1' }];
  const r = run(rows, snap({
    protections: { g1: live('GAIL', 169.1, 2), g2: live('GAIL', 169.1, 2), g3: live('GAIL', 169.1, 2),
      g4: live('GAIL', 169.1, 1), g5: live('GAIL', 169.1, 1) },
    heldQty: { GAIL: 2 },
  }));
  const d = find(r, CODES.SURPLUS_PROTECTION);
  assert.equal(d.evidence.surplus, 6);
  assert.equal(d.repair, 'none', 'cancelling a stop on a HELD symbol is a human decision');
});

// ---- FEDERALBNK: stops with no position --------------------------------------
test('YESBANK: over-protected with NO open row at all is still caught', () => {
  // 2026-08-13: the rows had closed months of duplicates ago; the stops lived
  // on. A row-scoped surplus check sees an empty account and says nothing.
  const r = run([], snap({
    protections: { y1: live('YESBANK', 21.2, 21), y2: live('YESBANK', 21.2, 21),
      y3: live('YESBANK', 21.2, 21), y4: live('YESBANK', 21.2, 21) },
    heldQty: { YESBANK: 21 },
  }));
  const d = find(r, CODES.SURPLUS_PROTECTION);
  assert.equal(d.evidence.count, 4);
  assert.equal(d.evidence.surplus, 63, '84 covered against 21 held');
});

test('a single stop on an unmanaged holding is left alone (it is the owner\'s)', () => {
  const r = run([], snap({ protections: { m1: live('INFY', 1400, 10) }, heldQty: { INFY: 10 } }));
  assert.deepEqual(codes(r), []);
});

test('FEDERALBNK: live triggers, zero holding, no row -> ORPHAN_TRIGGER (cancellable)', () => {
  const r = run([], snap({ protections: { o1: live('FEDERALBNK', 339.8, 1), o2: live('FEDERALBNK', 339.8, 1) } }));
  const d = find(r, CODES.ORPHAN_TRIGGER);
  assert.equal(d.evidence.count, 2);
  assert.equal(d.repair, 'cancel-trigger');
});

test("a manual stop on the user's own holding is NEVER flagged", () => {
  const r = run([], snap({ protections: { m1: live('TCS', 3000, 5) }, heldQty: { TCS: 5 } }));
  assert.deepEqual(codes(r), [], 'not our position, not our business');
});

// ---- T+1 SETTLEMENT ----------------------------------------------------------
test('SELL side: a covering fill closes the row even while holdings still show it', () => {
  const rows = [{ id: 'r1', symbol: 'SAGILITY', qty: 2, broker: 'dhan', recordedAt: OLDER, dhanForeverId: 'F1' }];
  const r = run(rows, snap({ protections: { F1: { status: 'gone' } }, heldQty: {}, sells: { SAGILITY: [{ qty: 2, px: 43.1 }] } }));
  const d = find(r, CODES.PHANTOM_ROW);
  assert.equal(d.evidence.basis, 'sell-fills');
  assert.equal(d.repair, 'close-from-fills');
  assert.ok(!codes(r).includes(CODES.UNPROTECTED));
});

test('BUY side: a row that filled TODAY is never phantom on absence alone', () => {
  const rows = [{ id: 'r1', symbol: 'SOUTHWEST', qty: 1, broker: 'fyers', recordedAt: TODAY, fyersGttId: 'g1' }];
  const r = run(rows, snap({ protections: { g1: live('SOUTHWEST', 480, 1) }, heldQty: {} }));
  assert.ok(!codes(r).includes(CODES.PHANTOM_ROW), 'holdings lag behind a same-day buy');
});

test('an exit in flight suppresses both UNPROTECTED and PHANTOM (HEALTHX class)', () => {
  const rows = [{ id: 'r1', symbol: 'HEALTHX', qty: 2, broker: 'dhan', recordedAt: OLDER, dhanForeverId: 'F1' }];
  const r = run(rows, snap({ protections: { F1: { status: 'fired' } }, heldQty: { HEALTHX: 2 }, openSells: { HEALTHX: 2 } }));
  assert.deepEqual(codes(r), [], 'the stop fired and the SELL is working - nothing to re-arm');
});

// ---- FEDFINA: quantity truth -------------------------------------------------
test('FEDFINA: broker holds 6, log manages 3 -> QTY_MISMATCH (aged rows only)', () => {
  const rows = [{ id: 'r1', symbol: 'FEDFINA', qty: 3, broker: 'fyers', recordedAt: OLDER, fyersGttId: 'g1' }];
  const r = run(rows, snap({ protections: { g1: live('FEDFINA', 141.2, 6) }, heldQty: { FEDFINA: 6 } }));
  const d = find(r, CODES.QTY_MISMATCH);
  assert.equal(d.evidence.delta, 3);
  assert.equal(d.evidence.reading, 'extra-at-broker-maybe-manual');
});

test('a same-day quantity difference is NOT reported (settlement lag explains it)', () => {
  const rows = [{ id: 'r1', symbol: 'FEDFINA', qty: 3, broker: 'fyers', recordedAt: TODAY, fyersGttId: 'g1' }];
  const r = run(rows, snap({ protections: { g1: live('FEDFINA', 141.2, 6) }, heldQty: { FEDFINA: 6 } }));
  assert.ok(!codes(r).includes(CODES.QTY_MISMATCH));
});

test('an over-sized ROW is called out separately - exits would over-sell', () => {
  const rows = [{ id: 'r1', symbol: 'PYRAMID', qty: 10, broker: 'dhan', recordedAt: OLDER, dhanForeverId: 'F1' }];
  const r = run(rows, snap({ protections: { F1: live('PYRAMID', 100, 10) }, heldQty: { PYRAMID: 4 } }));
  assert.equal(find(r, CODES.QTY_MISMATCH).evidence.reading, 'row-oversized-exits-would-over-sell');
});

// ---- ENTRY (the GNA class) ---------------------------------------------------
test('GNA: the row awaits a fill the broker already gave it -> ENTRY_DIVERGENCE', () => {
  const rows = [{ id: 'r1', symbol: 'GNA', qty: 1, broker: 'dhan', recordedAt: TODAY, awaitingFill: true,
    dhanEntryOrderId: 'E1' }];
  const r = run(rows, snap({ entries: { E1: { status: 'dead' } }, heldQty: { GNA: 1 } }));
  const d = find(r, CODES.ENTRY_DIVERGENCE);
  assert.equal(d.repair, 'adopt-fill');
  assert.equal(d.evidence.held, 1);
});

test('an unfilled row with nothing at the broker is silent', () => {
  const rows = [{ id: 'r1', symbol: 'X', qty: 1, broker: 'dhan', recordedAt: TODAY, awaitingFill: true, dhanEntryOrderId: 'E1' }];
  const r = run(rows, snap({ entries: { E1: { status: 'pending' } } }));
  assert.deepEqual(codes(r), []);
});

// ---- DRIFT -------------------------------------------------------------------
test('a stop sitting below a promised cost-move -> STOP_DRIFT', () => {
  const rows = [{ id: 'r1', symbol: 'V2RETAIL', qty: 2, broker: 'fyers', recordedAt: OLDER,
    entryPrice: 221.47, slPrice: 205.9, mtmCostDone: true, fyersGttId: 'g1' }];
  const r = run(rows, snap({ protections: { g1: live('V2RETAIL', 205.9, 2) }, heldQty: { V2RETAIL: 2 } }));
  const d = find(r, CODES.STOP_DRIFT);
  assert.equal(d.evidence.expected, 221.47, 'costMoved promises the stop sits at entry');
  assert.equal(d.repair, 'reassert-sl');
});

test('a stop within tolerance is not drift', () => {
  const rows = [{ id: 'r1', symbol: 'V2RETAIL', qty: 2, broker: 'fyers', recordedAt: OLDER,
    entryPrice: 221.47, brokerSlPrice: 205.9, fyersGttId: 'g1' }];
  const r = run(rows, snap({ protections: { g1: live('V2RETAIL', 205.91, 2) }, heldQty: { V2RETAIL: 2 } }));
  assert.ok(!codes(r).includes(CODES.STOP_DRIFT));
});

// ---- POST-T1 -----------------------------------------------------------------
test('post-T1: a runner-sized stop against a reduced holding is CORRECT, not surplus', () => {
  const rows = [{ id: 'r1', symbol: 'V2RETAIL', qty: 2, broker: 'fyers', recordedAt: OLDER, splitT1: true,
    mtmT1Done: true, splitLegAQty: 1, splitLegBQty: 1, fyersGttT1Id: '636', fyersGttId: '637' }];
  const r = run(rows, snap({
    protections: { 636: { status: 'fired' }, 637: live('V2RETAIL', 221.47, 1) },
    heldQty: { V2RETAIL: 1 }, sells: { V2RETAIL: [{ qty: 1, px: 222.5 }] },
  }));
  assert.deepEqual(codes(r), [], 'T1 booked, runner protected, nothing wrong');
});

// ---- STRIKE DISCIPLINE -------------------------------------------------------
test('a divergence must persist before it is confirmed (RMS decides async)', () => {
  const rows = [{ id: 'r1', symbol: 'ARIS', qty: 3, broker: 'fyers', recordedAt: TODAY, fyersGttId: 'g1' }];
  const s = snap({ protections: { g1: { status: 'gone' } }, heldQty: { ARIS: 3 } });
  const first = reconcile(rows, s, { now: NOW });
  assert.equal(first.divergences[0].confirmed, false, 'strike one is never acted on');
  const second = reconcile(rows, s, { now: NOW, prior: nextPrior(first) });
  assert.equal(second.divergences[0].strikes, 2);
  assert.equal(second.divergences[0].confirmed, true);
});

test('a resolved divergence starts from zero if it returns', () => {
  const rows = [{ id: 'r1', symbol: 'ARIS', qty: 3, broker: 'fyers', recordedAt: TODAY, fyersGttId: 'g1' }];
  const bad = snap({ protections: { g1: { status: 'gone' } }, heldQty: { ARIS: 3 } });
  const good = snap({ protections: { g1: live('ARIS', 125, 3) }, heldQty: { ARIS: 3 } });
  const one = reconcile(rows, bad, { now: NOW });
  const healed = reconcile(rows, good, { now: NOW, prior: nextPrior(one) });
  assert.deepEqual(healed.divergences, []);
  const again = reconcile(rows, bad, { now: NOW, prior: nextPrior(healed) });
  assert.equal(again.divergences[0].strikes, 1, 'history must not leak across a healed period');
});

// ---- HEALTH ------------------------------------------------------------------
test('a fully healthy broker produces no divergences and honest stats', () => {
  const rows = [{ id: 'r1', symbol: 'SYNCOMF', qty: 2, broker: 'dhan', recordedAt: OLDER,
    slPrice: 100, dhanForeverId: 'F1' }];
  const r = run(rows, snap({ protections: { F1: live('SYNCOMF', 100, 2) }, heldQty: { SYNCOMF: 2 } }));
  assert.deepEqual(r.divergences, []);
  assert.deepEqual(r.stats, { rows: 1, symbols: 1, divergences: 0, confirmed: 0 });
});

test('two rows on ONE symbol are summed, not double-counted', () => {
  const rows = [
    { id: 'r1', symbol: 'IDEA', qty: 5, broker: 'dhan', recordedAt: OLDER, dhanForeverId: 'F1' },
    { id: 'r2', symbol: 'IDEA', qty: 5, broker: 'dhan', recordedAt: OLDER, dhanForeverId: 'F2' },
  ];
  const r = run(rows, snap({ protections: { F1: live('IDEA', 9, 5), F2: live('IDEA', 9, 5) }, heldQty: { IDEA: 10 } }));
  assert.deepEqual(codes(r), [], '10 held, 10 covered, two legitimate rows');
});
