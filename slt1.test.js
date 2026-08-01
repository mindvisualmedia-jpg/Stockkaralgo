'use strict';
// "Move SL to T1" — after T1 books, price slToT1Pct% above the T1 price parks
// the runner's stop at T1. These tests pin the user's spec: T1 booked, price
// runs the trigger % further, SL of the T2 order moves to the T1 target price.
const test = require('node:test');
const assert = require('node:assert');
const { computeMtmPlan, computeMtmActions } = require('./mtm');

// entry 100, SL 96, T1 +8% = 108 (book 50%), T2 +12% = 112, lock trigger +3%
// above T1 -> 108 * 1.03 = 111.24
const base = {
  action: 'BUY', entryPrice: 100, slPrice: 96, qty: 10,
  t1Pct: 8, t1Qty: 50, t2Pct: 12, slToT1Pct: 3,
};

test('plan: lock trigger price is t1Price * (1 + slToT1Pct/100)', () => {
  const plan = computeMtmPlan(base);
  assert.strictEqual(plan.t1Price, 108);
  assert.strictEqual(plan.slT1TriggerPrice, 111.24);
});

test('plan: no trigger when the field is absent or zero', () => {
  assert.strictEqual(computeMtmPlan({ ...base, slToT1Pct: 0 }).slT1TriggerPrice, 0);
  const { slToT1Pct, ...noField } = base;
  assert.strictEqual(computeMtmPlan(noField).slT1TriggerPrice, 0);
});

test('does NOT fire before T1 is booked, even above the trigger price', () => {
  // price above 111.24 but T1 not yet done -> the tick books T1 instead;
  // the lock must wait for a later tick (mtmT1Done persisted).
  const { actions, patch } = computeMtmActions({ ...base }, 111.5);
  assert.ok(actions.some(a => a.type === 'BOOK_T1'));
  assert.ok(!actions.some(a => a.type === 'MOVE_SL_TO_T1'));
  assert.notStrictEqual(patch.mtmSlT1Done, true);
});

test('fires once T1 is booked and price reaches the trigger', () => {
  const entry = { ...base, mtmT1Done: true, mtmCostDone: true, mtmRemainingQty: 5, brokerSlPrice: 100 };
  const { actions, patch } = computeMtmActions(entry, 111.24);
  const move = actions.find(a => a.type === 'MOVE_SL_TO_T1');
  assert.ok(move, 'expected MOVE_SL_TO_T1');
  assert.strictEqual(move.newSl, 108);          // the T1 target price
  assert.strictEqual(patch.mtmSlT1Done, true);
});

test('holds below the trigger', () => {
  const entry = { ...base, mtmT1Done: true, mtmCostDone: true, mtmRemainingQty: 5, brokerSlPrice: 100 };
  const { actions, patch } = computeMtmActions(entry, 111.0);
  assert.ok(!actions.some(a => a.type === 'MOVE_SL_TO_T1'));
  assert.notStrictEqual(patch.mtmSlT1Done, true);
});

test('fires at most once (done flag suppresses a second move)', () => {
  const entry = { ...base, mtmT1Done: true, mtmCostDone: true, mtmSlT1Done: true, mtmRemainingQty: 5, brokerSlPrice: 108 };
  const { actions } = computeMtmActions(entry, 111.5);
  assert.ok(!actions.some(a => a.type === 'MOVE_SL_TO_T1'));
});

test('never lowers the stop: SL already above T1 -> no action, flag set', () => {
  // e.g. a trail already raised the stop past T1
  const entry = { ...base, mtmT1Done: true, mtmCostDone: true, mtmRemainingQty: 5, brokerSlPrice: 109.5 };
  const { actions, patch } = computeMtmActions(entry, 111.5);
  assert.ok(!actions.some(a => a.type === 'MOVE_SL_TO_T1'));
  assert.strictEqual(patch.mtmSlT1Done, true);  // sealed so it never re-evaluates
});

test('T2 still wins when price reaches it (lock does not block the exit)', () => {
  const entry = { ...base, mtmT1Done: true, mtmCostDone: true, mtmRemainingQty: 5, brokerSlPrice: 100 };
  const { actions, patch } = computeMtmActions(entry, 112);
  assert.ok(actions.some(a => a.type === 'BOOK_T2'));
  assert.strictEqual(patch.mtmT2Done, true);
});

test('regression: no slToT1Pct -> byte-identical action stream to before', () => {
  const { slToT1Pct, ...noField } = base;
  const entry = { ...noField, mtmT1Done: true, mtmCostDone: true, mtmRemainingQty: 5, brokerSlPrice: 100 };
  const { actions, patch } = computeMtmActions(entry, 111.5);
  assert.deepStrictEqual(actions, []);
  assert.deepStrictEqual(patch, {});
});
