'use strict';

// Run: node mtm.test.js   (zero deps, exits non-zero on failure)
const { computeMtmPlan, computeMtmActions, hasMtmRules, planExitOps } = require('./mtm');

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`FAIL: ${msg}\n  expected ${e}\n  got      ${a}`); }
}
function ok(cond, msg) { if (cond) passed++; else { failed++; console.error(`FAIL: ${msg}`); } }

// The user's worked example: entry 100, SL 97, R:R T1=2 T2=3, book 50% at T1.
const base = {
  action: 'BUY', entryPrice: 100, slPrice: 97, qty: 100,
  costPct: 3, t1RR: 2, t1Qty: 50, t2RR: 3,
};

// ---- Plan math ----
const plan = computeMtmPlan(base);
eq(plan.risk, 3, 'risk = entry - SL');
eq(plan.costTriggerPrice, 103, 'cost trigger = 100 * 1.03');
eq(plan.costSlPrice, 100, 'cost SL = entry');
eq(plan.t1Price, 106, 'T1 = 100 + 2*3');
eq(plan.t2Price, 109, 'T2 = 100 + 3*3');
eq(plan.t1BookQty, 50, 'book 50% of 100');

// ---- Below all triggers: hold ----
eq(computeMtmActions(base, 102).actions, [], 'LTP 102 -> hold');

// ---- Cost trigger (103) but below T1 ----
let r = computeMtmActions(base, 103);
eq(r.actions, [{ type: 'MOVE_SL_TO_COST', newSl: 100, reason: 'Cost trigger hit' }], 'LTP 103 -> SL to cost');
eq(r.patch.mtmCostDone, true, 'cost flag set');

// Idempotent: once cost done, 104 does nothing
eq(computeMtmActions({ ...base, mtmCostDone: true }, 104).actions, [], 'cost done -> no repeat');

// ---- T1 hit (106): book 50 + move SL to cost ----
r = computeMtmActions(base, 106);
eq(r.actions, [
  { type: 'BOOK_T1', qty: 50, price: 106, reason: 'T1 hit' },
  { type: 'MOVE_SL_TO_COST', newSl: 100, reason: 'T1 -> SL to cost' },
], 'LTP 106 -> book T1 + SL to cost');
eq(r.patch.mtmRemainingQty, 50, 'remaining 50 after T1');
ok(r.patch.mtmT1Done && r.patch.mtmCostDone, 'T1 and cost flags set');

// If cost already moved, T1 only books (no duplicate SL move)
r = computeMtmActions({ ...base, mtmCostDone: true }, 106);
eq(r.actions, [{ type: 'BOOK_T1', qty: 50, price: 106, reason: 'T1 hit' }], 'T1 after cost -> book only');

// ---- T2 hit (109): exit remaining 50 ----
r = computeMtmActions({ ...base, mtmCostDone: true, mtmT1Done: true, mtmRemainingQty: 50 }, 109);
eq(r.actions, [{ type: 'BOOK_T2', qty: 50, price: 109, reason: 'T2 hit' }], 'LTP 109 -> exit remaining 50');
eq(r.patch.mtmRemainingQty, 0, 'remaining 0 after T2');

// T2 reached directly (gap up past everything) with nothing booked yet -> full exit
r = computeMtmActions(base, 120);
eq(r.actions, [{ type: 'BOOK_T2', qty: 100, price: 109, reason: 'T2 hit' }], 'gap to 120 -> exit full 100');

// Idempotent after T2
eq(computeMtmActions({ ...base, mtmT2Done: true, mtmRemainingQty: 0 }, 130).actions, [], 'T2 done -> no repeat');

// ---- Edge: 1 qty cannot split at T1 ----
r = computeMtmActions({ ...base, qty: 1 }, 106);
ok(r.patch.mtmT1Skipped, '1 qty: T1 partial book skipped');
ok(!r.actions.some(a => a.type === 'BOOK_T1'), '1 qty: no T1 book action');
ok(r.actions.some(a => a.type === 'MOVE_SL_TO_COST'), '1 qty: still moves SL to cost');
// ...and at T2, the single share exits fully
eq(computeMtmActions({ ...base, qty: 1, mtmCostDone: true }, 109).actions,
   [{ type: 'BOOK_T2', qty: 1, price: 109, reason: 'T2 hit' }], '1 qty: T2 exits the share');

// ---- Only move-to-cost configured (no targets) ----
r = computeMtmActions({ action: 'BUY', entryPrice: 100, slPrice: 97, qty: 10, costPct: 2 }, 102);
eq(r.actions, [{ type: 'MOVE_SL_TO_COST', newSl: 100, reason: 'Cost trigger hit' }], 'cost-only rule works');

// ---- Guards ----
ok(!hasMtmRules({ costPct: 0, t1RR: 0, t2RR: 0 }), 'no rules -> false');
ok(hasMtmRules({ t1RR: 2 }), 'has T1 -> true');
eq(computeMtmActions({ ...base, action: 'SELL' }, 109).actions, [], 'SELL not handled (BUY-only)');
eq(computeMtmActions({ ...base, entryPrice: 0 }, 109).actions, [], 'bad entry -> hold');

// ---- Exit op planner (the risky broker sequencing) ----
const pl = computeMtmPlan(base); // T1=106 book 50, T2=109, cost=100

// Dhan T1: cancel super -> sell 50 -> SL-M remainder 50 @ cost
eq(planExitOps('dhan', { type: 'BOOK_T1', qty: 50, price: 106 }, base, pl), [
  { op: 'cancelDhanSuper', orderId: base.orderId },
  { op: 'dhanSlm', qty: 50, trigger: 100 },
  { op: 'dhanSell', qty: 50 },
], 'Dhan T1 sequence (protect remainder before booking)');

// Zerodha T1: sell 50 -> reshape GTT to remainder 50 (SL=cost, target=T2)
eq(planExitOps('zerodha', { type: 'BOOK_T1', qty: 50, price: 106 }, base, pl), [
  { op: 'zerodhaSell', qty: 50 },
  { op: 'zerodhaGttRemainder', qty: 50, sl: 100, target: 109 },
], 'Zerodha T1 sequence');

// T2 before T1 (gap up): both delegate to broker target leg
eq(planExitOps('dhan', { type: 'BOOK_T2', qty: 100, price: 109 }, base, pl),
   [{ op: 'delegateBrokerTarget' }], 'Dhan T2 before T1 -> delegate');
eq(planExitOps('zerodha', { type: 'BOOK_T2', qty: 100, price: 109 }, base, pl),
   [{ op: 'delegateBrokerTarget' }], 'Zerodha T2 before T1 -> delegate');

// Dhan T2 after T1: cancel remainder SL-M -> market sell remainder
const afterT1 = { ...base, mtmT1Done: true, mtmRemainingQty: 50, mtmRemainderSlOrderId: 'SL123' };
eq(planExitOps('dhan', { type: 'BOOK_T2', qty: 50, price: 109 }, afterT1, pl), [
  { op: 'cancelDhanOrder', orderId: 'SL123' },
  { op: 'dhanSell', qty: 50 },
], 'Dhan T2 after T1 sequence');

// Zerodha T2 after T1: GTT already owns the remainder -> delegate
eq(planExitOps('zerodha', { type: 'BOOK_T2', qty: 50, price: 109 }, { ...afterT1 }, pl),
   [{ op: 'delegateBrokerTarget' }], 'Zerodha T2 after T1 -> GTT owns it');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
