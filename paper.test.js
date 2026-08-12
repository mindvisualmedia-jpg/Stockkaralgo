/**
 * Paper adapter tests — Test Mode as a REAL broker.
 *
 * The point of these is not that a fill fills. It is that paper can finally
 * produce the states the old simulator skipped: an entry that dies unfilled, a
 * position held with protection NOT yet visible, a protection accepted then
 * rejected by RMS, and a protection that silently vanishes while the position
 * is still held. Those four are the incidents the engine exists for.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const paper = require('./brokers/paper.js');
const engine = require('./engine.js');

const ROW = (o = {}) => ({
  id: o.id || 'T1', source: 'test', testMode: true,
  symbol: o.symbol || 'NSE:RELIANCE', broker: o.broker || 'dhan',
  qty: o.qty === undefined ? 10 : o.qty,
  entryPrice: o.entryPrice === undefined ? 100 : o.entryPrice,
  slPrice: o.slPrice === undefined ? 95 : o.slPrice,
  targetPrice: o.targetPrice === undefined ? 110 : o.targetPrice,
  orderId: o.orderId || 'ENTRY:E1|FOREVER:F1',
  ...o,
});
const snapOf = (rows, ltp, opts) => paper.buildSnapshot(rows, ltp, opts);

// ---- the shape the engine expects -----------------------------------------

test('snapshot is complete and carries the four sections the engine reads', () => {
  const s = snapOf([ROW()], { RELIANCE: 102 });
  assert.strictEqual(s.complete, true);
  for (const k of ['protections', 'entries', 'heldQty', 'sells']) {
    assert.ok(s[k] && typeof s[k] === 'object', 'missing ' + k);
  }
});

test('non-test rows are ignored entirely — live must never be simulated', () => {
  const live = { ...ROW(), testMode: false, source: 'auto' };
  const s = snapOf([live], { RELIANCE: 102 });
  assert.deepStrictEqual(s.protections, {});
  assert.deepStrictEqual(s.heldQty, {});
});

// ---- entry lifecycle -------------------------------------------------------

test('a BUY LIMIT fills at or below its limit, and is then HELD', () => {
  const s = snapOf([ROW({ awaitingFill: true })], { RELIANCE: 99.5 });
  assert.strictEqual(s.entries.E1.status, 'filled');
  assert.strictEqual(s.entries.E1.fillPrice, 100);
  assert.strictEqual(s.heldQty.RELIANCE, 10,
    'filled but protection not placed yet — this is PROTECTION_PENDING, which the old simulator skipped');
});

test('an unfilled entry stays pending, and DIES at the close', () => {
  const above = { RELIANCE: 101 };
  assert.strictEqual(snapOf([ROW({ awaitingFill: true })], above).entries.E1.status, 'pending');
  assert.strictEqual(snapOf([ROW({ awaitingFill: true })], above, { eod: true }).entries.E1.status, 'dead',
    'DAY validity: unfilled at the close means no position ever existed');
});

test('no LTP means no evidence — pending, never a guess', () => {
  const s = snapOf([ROW({ awaitingFill: true })], {});
  assert.strictEqual(s.entries.E1.status, 'pending');
  assert.deepStrictEqual(s.heldQty, {});
});

// ---- protection truth ------------------------------------------------------

test('protection is live between the stop and the target', () => {
  const s = snapOf([ROW()], { RELIANCE: 102 });
  assert.strictEqual(s.protections.F1.status, 'live');
  assert.strictEqual(s.protections.F1.triggerPrice, 95);
  assert.strictEqual(s.heldQty.RELIANCE, 10);
});

test('stop and target trades are reported as broker fills', () => {
  const hitSl = snapOf([ROW()], { RELIANCE: 94 });
  assert.strictEqual(hitSl.protections.F1.status, 'traded_sl');
  assert.deepStrictEqual(hitSl.sells.RELIANCE, [{ qty: 10, px: 95 }]);

  const hitTgt = snapOf([ROW()], { RELIANCE: 111 });
  assert.strictEqual(hitTgt.protections.F1.status, 'traded_target');
  assert.deepStrictEqual(hitTgt.sells.RELIANCE, [{ qty: 10, px: 110 }]);
});

test('a moved stop (cost / T1 lock) is what the broker is holding', () => {
  // brokerSlPrice is what a live cost move writes; it must beat the original SL.
  const s = snapOf([ROW({ brokerSlPrice: 100, mtmCostDone: true })], { RELIANCE: 99 });
  assert.strictEqual(s.protections.F1.status, 'traded_sl', 'stopped at cost, not at the original 95');
  assert.strictEqual(s.sells.RELIANCE[0].px, 100);
});

test('a closed row is flat: protection gone, position not held', () => {
  const s = snapOf([ROW({ exitType: 'TARGET HIT', exitPrice: 110, testClosedAt: 'x' })], { RELIANCE: 111 });
  assert.strictEqual(s.protections.F1.status, 'gone');
  assert.strictEqual(s.heldQty.RELIANCE, undefined);
});

// ---- split T1 / T2 ---------------------------------------------------------

test('split legs are tracked separately, and a booked T1 leaves only the runner held', () => {
  const split = ROW({
    orderId: 'ENTRY:E1|FOREVER-T1:A1|FOREVER:B1',
    splitT1: true, splitLegAQty: 4, splitLegBQty: 6, t1Price: 105,
  });
  const both = snapOf([split], { RELIANCE: 102 });
  assert.strictEqual(both.protections.A1.status, 'live');
  assert.strictEqual(both.protections.B1.status, 'live');
  assert.strictEqual(both.heldQty.RELIANCE, 10);

  const booked = snapOf([{ ...split, mtmT1Done: true, mtmRemainingQty: 6 }], { RELIANCE: 106 });
  assert.strictEqual(booked.heldQty.RELIANCE, 6, 'only the runner is still held');
});

// ---- FAULT INJECTION: the whole reason this adapter exists ------------------

test('FAULT reject: protection accepted then killed by RMS', () => {
  // The T2T / BE-series incident: the POST returned an id, so the app believed
  // it was protected, and RMS rejected it moments later.
  const s = snapOf([ROW()], { RELIANCE: 102 }, { faults: { reject: 100 } });
  assert.strictEqual(s.protections.F1.status, 'rejected');
  assert.strictEqual(s.heldQty.RELIANCE, 10, 'still holding the stock with no working stop');
});

test('FAULT vanish: protection silently absent while the position is held', () => {
  const s = snapOf([ROW()], { RELIANCE: 102 }, { faults: { vanish: 100 } });
  assert.strictEqual(s.protections.F1.status, 'gone');
  assert.strictEqual(s.heldQty.RELIANCE, 10);
});

test('faults are deterministic — the same row always lands the same way', () => {
  const a = snapOf([ROW()], { RELIANCE: 102 }, { faults: { reject: 50 } });
  const b = snapOf([ROW()], { RELIANCE: 102 }, { faults: { reject: 50 } });
  assert.strictEqual(a.protections.F1.status, b.protections.F1.status,
    'a fault that cannot be reproduced cannot be debugged');
});

test('no faults configured means a clean broker (today\'s behaviour)', () => {
  assert.strictEqual(snapOf([ROW()], { RELIANCE: 102 }).protections.F1.status, 'live');
  assert.strictEqual(snapOf([ROW()], { RELIANCE: 102 }, { faults: '' }).protections.F1.status, 'live');
});

test('parseFaults reads the env spec, and shrugs off rubbish', () => {
  assert.deepStrictEqual(paper.parseFaults('reject:5,vanish:2'), { reject: 5, vanish: 2 });
  assert.deepStrictEqual(paper.parseFaults('reject:5 vanish:2'), { reject: 5, vanish: 2 });
  assert.deepStrictEqual(paper.parseFaults(''), {});
  assert.deepStrictEqual(paper.parseFaults('nonsense'), {}, 'a bad env var must not break Test Mode');
  assert.deepStrictEqual(paper.parseFaults(null), {});
});

// ---- the payoff: the ENGINE reacts to paper exactly as it does to Dhan ------

test('THE POINT: the engine flags UNPROTECTED from a paper snapshot (two-strike)', () => {
  const s = snapOf([ROW()], { RELIANCE: 102 }, { faults: { vanish: 100 } });
  const base = {
    state: engine.STATE.PROTECTED, symbol: 'NSE:RELIANCE', qty: 10,
    entryPrice: 100, slPrice: 95, targetPrice: 110,
    entryId: 'E1', legs: [{ id: 'F1', role: 'single', qty: 10 }],
    ltp: 102,
  };
  const now = 1770000000000;

  // Strike one: the stop is missing, but ONE bad read is not proof. The engine
  // starts a grace clock and holds its nerve - a flaky broker response must not
  // raise a false alarm.
  const first = engine.transition(base, s, { now });
  assert.strictEqual(first.state, engine.STATE.PROTECTED, 'one missing read is not evidence');
  assert.strictEqual(first.patch.graceStartAt, now, 'but the clock starts');

  // Strike two: still missing after the RMS async-decision window. Now it is real.
  const later = engine.transition(
    { ...base, graceStartAt: now }, s,
    { now: now + engine.DEFAULT_GRACE_MS + 1000 });
  assert.strictEqual(later.state, engine.STATE.UNPROTECTED,
    'a vanished stop on a held position must raise the alarm in Test Mode too');
  assert.ok(later.alerts.length > 0, 'and it must alert');
});

test('an incomplete snapshot makes the engine do NOTHING', () => {
  const pos = {
    state: engine.STATE.PROTECTED, symbol: 'NSE:RELIANCE', qty: 10,
    entryPrice: 100, slPrice: 95, targetPrice: 110,
    entryId: 'E1', legs: [{ id: 'F1', role: 'single', qty: 10 }], ltp: 102,
  };
  const r = engine.transition(pos, { complete: false }, {});
  assert.strictEqual(r.state, engine.STATE.PROTECTED);
  assert.strictEqual(r.actions.length, 0);
});

test('getSnapshot honours the adapter callback contract', (t, done) => {
  paper.getSnapshot({ rows: [ROW()], ltp: { RELIANCE: 102 }, faults: '' }, (err, snap) => {
    assert.strictEqual(err, null);
    assert.strictEqual(snap.complete, true);
    assert.strictEqual(snap.protections.F1.status, 'live');
    done();
  });
});

// ---- Broker-faithful paper rows (2026-08-12 Test Mode audit) ---------------
// Test Mode wrote DHAN-shaped ids for every broker, so a FYERS or Angel One
// paper trade carried no broker-native id, extractPlacedOrderId returned 'N/A',
// and the row rendered as REJECTED while the simulator quietly managed it.
// The adapter must resolve each broker's own ids.
test('paper adapter resolves Angel One rule ids (was falling through to Dhan fields)', (t, done) => {
  const row = {
    id: 'a1', testMode: true, broker: 'angelone', symbol: 'RELIANCE', qty: 4,
    entryPrice: 100, slPrice: 95, targetPrice: 110,
    angelOneEntryOrderId: 'AE1', angelOneSlRuleId: 'ASL1', angelOneOco: true,
  };
  paper.getSnapshot({ rows: [row], ltp: { RELIANCE: 102 } }, (err, snap) => {
    assert.strictEqual(err, null);
    assert.strictEqual(snap.protections.ASL1.status, 'live', 'the Angel SL rule is the protection');
    assert.strictEqual(snap.entries.AE1.status, 'filled');
    assert.strictEqual(snap.heldQty.RELIANCE, 4);
    done();
  });
});

test('paper adapter resolves Angel One ids parsed from the orderId string', (t, done) => {
  const row = {
    id: 'a2', testMode: true, broker: 'angelone', symbol: 'RELIANCE', qty: 4,
    entryPrice: 100, slPrice: 95, targetPrice: 110,
    orderId: 'ENTRY:AE2 | T1GTT:AT1 | SLGTT:ASL2', splitT1: true,
    splitLegAQty: 2, splitLegBQty: 2, t1Pct: 3,
  };
  paper.getSnapshot({ rows: [row], ltp: { RELIANCE: 102 } }, (err, snap) => {
    assert.strictEqual(err, null);
    assert.strictEqual(snap.protections.AT1.status, 'live', 'T1GTT leg parsed');
    assert.strictEqual(snap.protections.ASL2.status, 'live', 'SLGTT leg parsed');
    done();
  });
});

test('paper adapter resolves FYERS ids', (t, done) => {
  const row = {
    id: 'f1', testMode: true, broker: 'fyers', symbol: 'RELIANCE', qty: 3,
    entryPrice: 100, slPrice: 95, targetPrice: 110,
    fyersEntryOrderId: 'FE1', fyersGttId: 'FG1',
  };
  paper.getSnapshot({ rows: [row], ltp: { RELIANCE: 102 } }, (err, snap) => {
    assert.strictEqual(snap.protections.FG1.status, 'live');
    assert.strictEqual(snap.entries.FE1.status, 'filled');
    done();
  });
});
