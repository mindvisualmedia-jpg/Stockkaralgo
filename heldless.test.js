'use strict';
// ENGINE vs BROKER SYNC AUDIT (2026-09-10). Owner: "qty held at the broker not
// in sync, GTT orders not there, T1/T2/SL-moved-to-cost not updating".
//
// Four loopholes, each pinned here:
//   1. HELD LESS THAN THE ROW: the broker held fewer shares than the row and
//      nothing adopted it - the stop stayed oversized (rejected when it fires).
//      Engine rule 5b adopts the held quantity when fills explain the gap.
//   2. STOP-MODIFY LOOP: a modify the broker accepted but never showed (or
//      refused every time) was re-sent every 2-4 minutes all day. Budget: 4/h.
//   3. RE-ARM EXHAUSTED FOR GOOD: three refused re-arms left a position naked
//      for days. The attempt budget is per trading day now.
//   4. ALERT STORM: a standing condition re-alerted every pass. One per row per
//      kind per hour.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATE, transition } = require('./engine');
const { modifyBudget } = require('./broker-policy');

const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000, DAY = 24 * H;
const OPENED = NOW - 3 * DAY;

// A single-leg position: 10 @ 100, stop 95, target 110, opened 3 days ago.
function singlePos(over = {}) {
  return {
    state: STATE.PROTECTED, symbol: 'ITC', qty: 10,
    entryPrice: 100, slPrice: 95, targetPrice: 110, t1Price: 110, costTrigger: 0, entryId: 'E1',
    legs: [{ id: 'G1', role: 'single', qty: 10 }],
    t1Booked: false, costMoved: false, pendingSl: null, graceStartAt: 0, ltp: 103, enteredAt: OPENED,
    ...over,
  };
}
// The RAIN shape after T1: 9 @ 204.86, T1 leg 4 booked, runner 5 live.
function runnerPos(over = {}) {
  return {
    state: STATE.PROTECTED, symbol: 'RAIN', qty: 9,
    entryPrice: 204.86, slPrice: 204.86, targetPrice: 217.3, t1Price: 217.15, costTrigger: 0, entryId: 'E1', splitT1: true,
    legs: [{ id: 'FT1', role: 't1', qty: 4 }, { id: 'FR', role: 'runner', qty: 5 }],
    t1Booked: true, costMoved: true, pendingSl: null, graceStartAt: 0, ltp: 215, enteredAt: OPENED,
    ...over,
  };
}
function snap(over = {}) {
  return { complete: true, protections: {}, entries: {}, heldQty: {}, sells: {}, ...over };
}
const LIVE_G1 = { G1: { status: 'live', triggerPrice: 95, qty: 10 } };
const RUNNER_LIVE = { FT1: { status: 'gone' }, FR: { status: 'live', triggerPrice: 204.86, qty: 5 } };
const MANUAL_SELL_4 = { qty: 4, px: 102, at: NOW - 2 * H, orderId: 'MAN1' };

// ---- 1. engine rule 5b ------------------------------------------------------------

test('INCIDENT: 4 of 10 sold by hand, holdings show 6 for two passes -> row adopts 6, stop restated for 6', () => {
  const s = snap({ protections: LIVE_G1, heldQty: { ITC: 6 }, sells: { ITC: [MANUAL_SELL_4] } });
  const first = transition(singlePos(), s, { now: NOW });
  assert.equal(first.patch.heldLessSightings, 1, 'first sighting only counts');
  assert.equal(first.patch.qty, undefined);
  assert.ok(!first.actions.some(a => a.type === 'RESIZE_PROTECTION'));

  const second = transition(singlePos({ heldLessSightings: 1 }), s, { now: NOW + 2 * 60 * 1000 });
  assert.equal(second.state, STATE.PROTECTED);
  assert.equal(second.patch.qty, 6);
  assert.deepEqual(second.patch.qtyAdopted && [second.patch.qtyAdopted.from, second.patch.qtyAdopted.to, second.patch.qtyAdopted.sold], [10, 6, 4]);
  const act = second.actions.find(a => a.type === 'RESIZE_PROTECTION');
  assert.ok(act, 'resize requested');
  assert.equal(act.qty, 6);
  assert.equal(act.stop, 95, 'the current stop, restated');
  assert.deepEqual(act.legIds, ['G1']);
  assert.ok(second.alerts.some(a => a.type === 'QTY_ADOPTED'));
  assert.equal(second.patch.heldLessSightings, 0, 'counter reset after adopting');
});

test('after T1: 2 of the 5-share runner sold by hand -> the RUNNER leg adopts 3 (the T1 fill explains nothing)', () => {
  const t1Fill = { qty: 4, px: 217.15, at: NOW - DAY, orderId: 'FT1' };
  const s = snap({ protections: RUNNER_LIVE, heldQty: { RAIN: 3 }, sells: { RAIN: [t1Fill, { qty: 2, px: 214, at: NOW - 3 * H }] } });
  const r = transition(runnerPos({ heldLessSightings: 1 }), s, { now: NOW });
  assert.equal(r.patch.legBQty, 3);
  assert.equal(r.patch.qty, undefined, 'the row total is history; only the runner shrinks');
  const act = r.actions.find(a => a.type === 'RESIZE_PROTECTION');
  assert.ok(act && act.qty === 3 && act.legIds.length === 1 && act.legIds[0] === 'FR');
});

test('after T1 with ONLY the T1 fill in the book and holdings under-reading 3: no resize (fills do not explain the gap)', () => {
  const t1Fill = { qty: 4, px: 217.15, at: NOW - DAY, orderId: 'FT1' };
  const s = snap({ protections: RUNNER_LIVE, heldQty: { RAIN: 3 }, sells: { RAIN: [t1Fill] } });
  const r = transition(runnerPos({ heldLessSightings: 1 }), s, { now: NOW });
  assert.equal(r.patch.legBQty, undefined);
  assert.ok(!r.actions.some(a => a.type === 'RESIZE_PROTECTION'));
});

test('a holdings under-read WITHOUT fills never shrinks protection (naked shares are the worse failure)', () => {
  const s = snap({ protections: LIVE_G1, heldQty: { ITC: 6 }, sells: {} });
  const r = transition(singlePos({ heldLessSightings: 1 }), s, { now: NOW });
  assert.equal(r.patch.qty, undefined);
  assert.equal(r.patch.heldLessSightings, 0, 'a stale sighting is cleared, never advanced');
  assert.ok(!r.actions.some(a => a.type === 'RESIZE_PROTECTION'));
});

test('a fill dated BEFORE the row opened does not explain the gap (time fence holds here too)', () => {
  const old = { qty: 4, px: 102, at: OPENED - DAY, orderId: 'OLD' };
  const s = snap({ protections: LIVE_G1, heldQty: { ITC: 6 }, sells: { ITC: [old] } });
  const r = transition(singlePos({ heldLessSightings: 1 }), s, { now: NOW });
  assert.equal(r.patch.qty, undefined);
});

test('a split BEFORE T1 is left alone: which leg shrank is not knowable', () => {
  const pre = runnerPos({ t1Booked: false, costMoved: false, slPrice: 198 });
  const s = snap({ protections: { FT1: { status: 'live', triggerPrice: 198, qty: 4 }, FR: { status: 'live', triggerPrice: 198, qty: 5 } },
    heldQty: { RAIN: 7 }, sells: { RAIN: [{ qty: 2, px: 210, at: NOW - H }] } });
  const r = transition(pre, s, { now: NOW });
  assert.equal(r.patch.qty, undefined);
  assert.equal(r.patch.legBQty, undefined);
  assert.ok(!r.actions.some(a => a.type === 'RESIZE_PROTECTION'));
});

test('no resize while an exit SELL is working, while a modify is pending, or with holdings unread', () => {
  const s0 = snap({ protections: LIVE_G1, heldQty: { ITC: 6 }, sells: { ITC: [MANUAL_SELL_4] } });
  assert.ok(!transition(singlePos({ heldLessSightings: 1 }), { ...s0, openSells: { ITC: 6 } }, { now: NOW }).actions.some(a => a.type === 'RESIZE_PROTECTION'), 'exit in flight');
  assert.ok(!transition(singlePos({ heldLessSightings: 1, pendingSl: { price: 96, at: NOW - 1000 } }), s0, { now: NOW }).actions.some(a => a.type === 'RESIZE_PROTECTION'), 'modify pending');
  const noHold = { ...s0 }; delete noHold.heldQty;
  const r = transition(singlePos({ heldLessSightings: 1 }), noHold, { now: NOW });
  assert.ok(!r.actions.some(a => a.type === 'RESIZE_PROTECTION'), 'holdings unknown');
});

test('a healthy position (held == row) clears a stale sighting and never resizes', () => {
  const s = snap({ protections: LIVE_G1, heldQty: { ITC: 10 }, sells: {} });
  const r = transition(singlePos({ heldLessSightings: 1 }), s, { now: NOW });
  assert.equal(r.patch.heldLessSightings, 0);
  assert.ok(!r.actions.length);
});

test('the sold shares do not close the row: 4 of 10 sold is a resize, 10 of 10 is a close', () => {
  const s = snap({ protections: {}, heldQty: { ITC: 0 }, sells: { ITC: [{ qty: 10, px: 95, at: NOW - H }] } });
  const r = transition(singlePos(), s, { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.exitType, 'SL HIT');
});

// ---- 2. the stop-modify budget ------------------------------------------------------

test('modifyBudget: 4 modifies per hour, then refused; the window slides', () => {
  let log = [];
  for (let i = 0; i < 4; i++) { const b = modifyBudget(log, NOW + i * 60000); assert.equal(b.allowed, true, 'modify ' + (i + 1)); log = b.next; }
  const fifth = modifyBudget(log, NOW + 5 * 60000);
  assert.equal(fifth.allowed, false);
  assert.equal(fifth.count, 4);
  assert.deepEqual(fifth.next, log, 'a refused modify is not logged');
  const later = modifyBudget(log, NOW + 60 * 60000 + 30000);
  assert.equal(later.allowed, true, 'the first slot has aged out');
  assert.equal(later.count, 3);
});

test('modifyBudget: garbage and future stamps are ignored; the log is capped at 10', () => {
  const b = modifyBudget(['x', null, NOW + 999999, NOW - 10], NOW);
  assert.equal(b.count, 1);
  const long = Array.from({ length: 30 }, (_, i) => NOW - i * 1000);
  assert.equal(modifyBudget(long, NOW, { max: 100 }).next.length, 10);
});

// ---- 3. wiring ----------------------------------------------------------------------------

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('the adopted quantity reaches the row fields every modify reads as the leg size', () => {
  assert.ok(src.includes("if (Number(rp.qty) > 0) { p.qty = rp.qty; if (Number(row.mtmRemainingQty) > 0) p.mtmRemainingQty = rp.qty; }"));
  assert.ok(src.includes("if (Number(rp.legBQty) > 0) { p.splitLegBQty = rp.legBQty; p.mtmRemainingQty = rp.legBQty; }"));
  assert.ok(src.includes("heldLessSightings: Number(row.engineHeldLessSightings || 0),"), 'the sighting counter survives a restart');
  assert.ok(src.includes("if (action.type === 'RESIZE_PROTECTION') {"), 'executor branch');
  assert.ok(src.includes("return engineModifySl(row, stop, markPending(stop, false, false), onlyLive);"), 'restates the current stop through the trail modify path');
});

test('every stop modify spends the per-row budget; RESIZE, cost move and MODIFY_SL alike', () => {
  assert.equal(src.split('spendModifyBudget();').length - 1, 3, 'three call sites');
  assert.ok(src.includes("const mb = brokerPolicy.modifyBudget(row.engineModifyLog, Date.now());"));
});

test('re-arm attempts are a per-day budget, stamped on the row', () => {
  assert.ok(src.includes("const attempts = String(row.slRestoreDay || '') === rearmDay ? Number(row.slRestoreAttempts || 0) : 0;"));
  assert.ok(src.includes("slRestoreAttempts: attempts + 1, slRestoreDay: rearmDay }));"));
});

test('alerts are throttled to one per row per kind per hour; REOPENED always goes out', () => {
  assert.ok(src.includes("if (al.type !== 'REOPENED') {"));
  assert.ok(src.includes("if (Date.now() - Number(_engineAlertLastAt[ak] || 0) < 60 * 60 * 1000) return;"));
});

test('the Qty column reads running / total after T1 and marks an adopted quantity', () => {
  assert.ok(html.includes("return (running ? rem + ' / ' + total : logText(r.qty)) + (r.qtyAdoptedAt ? '*' : '');"));
  assert.ok(html.includes('<td class="num" title="${escapeHtml(qtyCellTitle(r))}">${qtyCellText(r)}</td>'));
});
