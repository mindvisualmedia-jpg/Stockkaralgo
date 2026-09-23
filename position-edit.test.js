'use strict';
// position-edit.test.js — the planner behind Order Log -> Edit (owner,
// 2026-09-23: "add edit option in orderlog for each stock ... SL T1 T2
// Trailing etc ... same should be updated in broker"). Pure: every decision the
// dialog previews and the server applies, pinned without a broker.
const { test } = require('node:test');
const assert = require('node:assert');
const { planPositionEdit, editableSnapshot } = require('./position-edit');

const tick = (v) => (v >= 1000 ? Math.round(v) : Math.round(v * 10) / 10);   // the server's roundPrice
const ctx = (o) => ({ tick, ltp: 110, heldQty: 10, now: 1790000000000, ...(o || {}) });
// a single OCO: entry 100, stop 95, target 130, 10 shares
const single = (o) => ({ id: 's', broker: 'dhan', symbol: 'INFY', qty: 10, entryPrice: 100, price: 100, slPrice: 95, slPriceOriginal: 95, brokerSlPrice: 95,
  targetPrice: 130, dhanForeverId: 'F1', status: 'DHAN ENTRY + FOREVER OCO', liveLtp: 110, ...(o || {}) });
// a split: T1 +30% on half (5), T2 +60% on the rest (5)
const split = (o) => single({ splitT1: true, t1Pct: 30, t1Qty: 50, t2Pct: 60, targetMode: 'pct', targetPrice: 160, splitLegAQty: 5, splitLegBQty: 5,
  dhanForeverT1Id: 'FA', dhanForeverId: 'FB', ...(o || {}) });

test('the snapshot the dialog opens with is what the position is now', () => {
  const s = editableSnapshot(split());
  assert.deepEqual([s.stop, s.split, s.t1, s.t1QtyPct, s.t2, s.legA, s.legB], [95, true, 130, 50, 160, 5, 5]);
  const o = editableSnapshot(single());
  assert.deepEqual([o.stop, o.split, o.target, o.brokerTarget], [95, false, 130, true]);
});

test('stop only -> MODIFY in place, the row carries the new stop', () => {
  const p = planPositionEdit(single(), { slPrice: 98 }, ctx());
  assert.equal(p.ok, true, p.errors.join('; '));
  assert.equal(p.brokerOp, 'modify');
  assert.equal(p.rowPatch.slPrice, 98);
  assert.equal(p.stop, 98);
  assert.match(p.brokerLine, /modified in place/);
  assert.deepEqual(p.lines, ['Stop ₹95 → ₹98']);
});

test('a stop at or above the live price is refused - it would fire the moment it is placed', () => {
  const p = planPositionEdit(single(), { slPrice: 110 }, ctx());
  assert.equal(p.ok, false);
  assert.match(p.errors[0], /must be below the current price/);
});

test('target change: Dhan re-brackets (no proven target modify), Zerodha modifies in place', () => {
  const d = planPositionEdit(single(), { targetPrice: 140 }, ctx());
  assert.equal(d.brokerOp, 'rebracket');
  assert.deepEqual(d.legs, [{ role: 'single', qty: 10, target: 140 }]);
  assert.match(d.brokerLine, /placed first.*then the old order is cancelled/);
  const z = planPositionEdit(single({ broker: 'zerodha' }), { targetPrice: 140 }, ctx());
  assert.equal(z.brokerOp, 'modify');
  assert.equal(z.rowPatch.targetPrice, 140);
});

test('a target at or below the market, or at/below the stop, or T2 under T1, is refused', () => {
  assert.match(planPositionEdit(single({ broker: 'zerodha' }), { targetPrice: 108 }, ctx()).errors.join(), /sells immediately/);
  assert.match(planPositionEdit(split({ broker: 'zerodha' }), { t1Price: 170 }, ctx()).errors.join(), /T2 .* must be above T1/);
});

test('T1 price on a split: Zerodha modifies both legs in place, Dhan re-brackets; targets pinned as % of entry', () => {
  const z = planPositionEdit(split({ broker: 'zerodha' }), { t1Price: 135 }, ctx());
  assert.equal(z.brokerOp, 'modify');
  assert.equal(z.rowPatch.t1Pct, 35);
  assert.equal(z.rowPatch.t2Pct, 60);
  assert.equal(z.rowPatch.targetMode, 'pct');
  const d = planPositionEdit(split(), { t1Price: 135 }, ctx());
  assert.equal(d.brokerOp, 'rebracket');
  assert.deepEqual(d.legs.map(l => [l.role, l.qty, l.target]), [['t1', 5, 135], ['runner', 5, 160]]);
});

test('how much T1 books is a RESIZE: re-bracket on every broker (a modify would under-cover between calls)', () => {
  const z = planPositionEdit(split({ broker: 'zerodha' }), { t1Qty: 30 }, ctx());
  assert.equal(z.brokerOp, 'rebracket');
  assert.deepEqual(z.legs.map(l => l.qty), [3, 7]);
  assert.equal(z.rowPatch.splitLegAQty, 3); assert.equal(z.rowPatch.splitLegBQty, 7);
});

test('one target -> T1 + T2, and back, are re-brackets', () => {
  const on = planPositionEdit(single({ broker: 'fyers' }), { split: true, t1Price: 125, t1Qty: 40, t2Price: 150 }, ctx());
  assert.equal(on.ok, true, on.errors.join('; '));
  assert.equal(on.brokerOp, 'rebracket');
  assert.deepEqual(on.legs.map(l => [l.qty, l.target]), [[4, 125], [6, 150]]);
  const off = planPositionEdit(split({ broker: 'angelone' }), { split: false }, ctx());
  assert.equal(off.brokerOp, 'rebracket');
  assert.deepEqual(off.legs, [{ role: 'single', qty: 10, target: 160 }], 'one bracket for everything at the final target');
  assert.equal(off.rowPatch.t1Pct, 0); assert.equal(off.rowPatch.targetPrice, 160);
});

test('after T1 has booked: T1 is locked, the runner (stop, T2) can still change', () => {
  const row = split({ broker: 'zerodha', mtmT1Done: true, mtmRemainingQty: 5 });
  assert.match(planPositionEdit(row, { t1Price: 140 }, ctx({ heldQty: 5 })).errors.join(), /T1 has already booked/);
  const p = planPositionEdit(row, { t2Price: 170 }, ctx({ heldQty: 5 }));
  assert.equal(p.ok, true, p.errors.join('; '));
  assert.equal(p.brokerOp, 'modify');
  assert.deepEqual(p.legs, [{ role: 'runner', qty: 5, target: 170 }]);
});

test('trailing only: nothing at the broker; a new start level re-arms the trail', () => {
  const row = single({ emaTrailingEnabled: true, trailMode: 'peak', emaTrailingPct: 3, trailStartPct: 6, trailStartMode: 'pct', trailArmed: true, trailPeak: 118 });
  const p = planPositionEdit(row, { trail: { mode: 'step', pct: 3, stepMovePct: 2 } }, ctx());
  assert.equal(p.brokerOp, 'none');
  assert.match(p.brokerLine, /Nothing changes at DHAN/);
  assert.equal(p.rowPatch.trailMode, 'step'); assert.equal(p.rowPatch.stepMovePct, 2);
  assert.equal(p.rowPatch.trailArmed, false, 'a different trail starts afresh');
  const s = planPositionEdit(row, { trail: { startVal: 12 } }, ctx());
  assert.equal(s.rowPatch.trailStartPct, 12); assert.equal(s.rowPatch.trailArmed, false); assert.equal(s.rowPatch.trailPeak, 0);
  const off = planPositionEdit(row, { trail: { enabled: false } }, ctx());
  assert.equal(off.rowPatch.emaTrailingEnabled, false);
});

test('lowering the stop is allowed, and the engine\'s next move is said BEFORE it happens', () => {
  // cost already moved, trail armed, price above the cost trigger
  const row = single({ slPrice: 100, brokerSlPrice: 100, mtmCostDone: true, costPct: 3, emaTrailingEnabled: true, trailMode: 'peak', emaTrailingPct: 3, trailArmed: true, lastTrailSlPrice: 100 });
  const p = planPositionEdit(row, { slPrice: 97 }, ctx());
  assert.equal(p.ok, true, p.errors.join('; '));
  assert.equal(p.rowPatch.mtmCostDone, false, 'the "stop sits at cost" promise is withdrawn');
  assert.equal(p.rowPatch.lastTrailSlPrice, 97, 'a later restore must not bring the old level back');
  assert.ok(p.warnings.some(w => /trailing .* lift the stop back up/.test(w)), p.warnings.join(' | '));
  assert.ok(p.warnings.some(w => /move the stop back to cost/.test(w)), p.warnings.join(' | '));
});

test('the broker holds fewer than the row: protection is re-bracketed for what is HELD', () => {
  const p = planPositionEdit(split(), { slPrice: 96 }, ctx({ heldQty: 6 }));
  assert.equal(p.brokerOp, 'rebracket');
  assert.deepEqual(p.legs.map(l => l.qty), [3, 3]);
  assert.equal(p.rowPatch.qty, 6); assert.deepEqual([p.rowPatch.qtyAdopted.from, p.rowPatch.qtyAdopted.to, p.rowPatch.qtyAdopted.by], [10, 6, 'edit']);
  assert.ok(p.warnings.some(w => /holds 6 but this position tracked 10/.test(w)));
});

test('positions that cannot be edited say why', () => {
  const why = (o) => planPositionEdit(single(o), { slPrice: 98 }, ctx()).errors[0];
  assert.match(why({ awaitingFill: true }), /has not filled yet/);
  assert.match(why({ exitPending: true }), /exit order is working/);
  assert.match(why({ enginePendingSl: { price: 97 } }), /still being confirmed/);
  assert.match(why({ testMode: true }), /Test-mode/);
  assert.match(why({ noSl: true }), /No-SL/);
  assert.match(planPositionEdit(single(), { slPrice: 98 }, ctx({ open: false })).errors[0], /closed/);
  assert.match(planPositionEdit(single(), {}, ctx()).errors[0], /Nothing has changed/);
});

test('an R:R split is planned from the ORIGINAL stop, so a moved stop does not drag the targets', () => {
  // 1R = 5 from the original 95; T1 = 2R = 110 would be 100 off the moved stop (cost)
  const row = split({ broker: 'zerodha', targetMode: 'rr', t1Pct: 0, t2Pct: 0, t1RR: 3, t2RR: 6, slPrice: 100, brokerSlPrice: 100, slPriceOriginal: 95 });
  const s = editableSnapshot(row);
  assert.deepEqual([s.t1, s.t2], [115, 130]);
  const p = planPositionEdit(row, { slPrice: 102 }, ctx({ ltp: 111 }));
  assert.equal(p.ok, true, p.errors.join('; '));
  assert.equal(p.rowPatch.targetMode, 'pct', 'pinned, so the modify restates exactly these targets');
  assert.equal(p.rowPatch.t1Pct, 15); assert.equal(p.rowPatch.t2Pct, 30);
});

test('IKS shape: an untouched T1 the price has run past does not block a stop change - but a re-bracket must clear it', () => {
  // T1 130 while the stock trades 135: the T1 leg stands below the market
  const row = split({ broker: 'dhan' });
  const stopOnly = planPositionEdit(row, { slPrice: 97 }, ctx({ ltp: 135 }));
  assert.equal(stopOnly.ok, true, stopOnly.errors.join('; '));
  assert.equal(stopOnly.brokerOp, 'modify', 'the stop moves in place; T1 is restated exactly as it stands');
  // a re-bracket places T1 afresh - at 130 with the price at 135 it would sell at once
  const resize = planPositionEdit(row, { t1Qty: 40 }, ctx({ ltp: 135 }));
  assert.equal(resize.ok, false);
  assert.match(resize.errors.join(), /T1 \(₹130\) is at or below the current price .* places the whole bracket again.*switch off "Book part at T1"/);
  // and a T1 being SET below the market is refused on a modify broker too
  const z = planPositionEdit(split({ broker: 'zerodha' }), { t1Price: 132 }, ctx({ ltp: 135 }));
  assert.match(z.errors.join(), /T1 \(₹132\) is at or below the current price/);
});

test('a slip of the keyboard is refused, not sent: a target over 5x the price, a stop 80% under it', () => {
  // found in the dialog: "1650" and "1600" typed into one field made a target of 1,65,01,600
  const big = planPositionEdit(single({ broker: 'zerodha' }), { targetPrice: 16501600 }, ctx());
  assert.equal(big.ok, false);
  assert.match(big.errors.join(), /more than 5 times the current price .* typing error/);
  const tiny = planPositionEdit(single(), { slPrice: 17 }, ctx());
  assert.match(tiny.errors.join(), /more than 80% below the current price .* typing error/);
  // a real +100% target (STAR's T2 was +100%) is not a typo
  assert.equal(planPositionEdit(single({ broker: 'zerodha' }), { targetPrice: 200 }, ctx()).ok, true);
});
