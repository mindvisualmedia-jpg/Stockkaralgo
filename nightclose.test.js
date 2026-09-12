'use strict';
// NO-EVIDENCE VERDICTS AT NIGHT (2026-09-12, MANAKCOAT + BFINVEST on Angel).
// MANAKCOAT's lifecycle read "Exit 9/10/2026 11:59:36 PM EXITED" - a close
// reached at midnight from an Angel read that showed nothing held and no fill,
// which is what Angel's end-of-day window returns for EVERY position. The same
// pass was the box's last Angel read for a day and a half (both rows stamped
// 18:29:36Z, nothing after), so BFINVEST sat "open" while its shares had gone.
//
// Rules pinned here:
//   1. "not held + no fill" closes ONLY in market hours (opts.marketHours)
//   2. an all-EMPTY holdings list is not a holdings read until it has
//      persisted for the 20x grace (opts.emptyHoldingsMs)
//   3. a leftover-trigger cancel after a close needs the same evidence
//   4. an estimated close of a booked-T1 position counts the RUNNER once
//   5. rule 5c: extra live triggers on an OPEN, fully covered row are
//      cancelled after two market-hours sightings (FIVESTAR, day 3)
//   6. the executor branch, the row fields, the silent-blind alert and the
//      settlement line exist in server.js; the lifecycle text names the runner

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATE, transition, reconstructClose } = require('./engine');

const NOW = 1_800_000_000_000;
const MIN = 60 * 1000, H = 60 * MIN;
const GRACE = 3 * MIN;

function angelSplit(over = {}) {
  // MANAKCOAT-shaped: 82 @ 121.1, T1 128.5 (41), runner 41, stop locked at T1
  return {
    state: STATE.PROTECTED, symbol: 'MANAKCOAT', qty: 82,
    entryPrice: 121.1, slPrice: 128.5, targetPrice: 139.3, t1Price: 128.5, costTrigger: 0, entryId: 'E1', splitT1: true,
    legs: [{ id: 'T1R', role: 't1', qty: 41 }, { id: 'SLR', role: 'runner', qty: 41 }],
    t1Booked: true, t1Pnl: 303.4, costMoved: true, pendingSl: null, graceStartAt: 0, ltp: 0, otherOpenRows: 0,
    ...over,
  };
}
function snap(over = {}) {
  return { complete: true, protections: {}, entries: {}, heldQty: {}, sells: {}, ...over };
}
const OTHERS_HELD = { PNB: 87, GESHIP: 7 };   // the account holds other things: the list is a real read
// NOTE: every snapshot here has an EMPTY protection list, so the grace is 20x (60 min) - the fixtures start it 2h ago

// ---- 1. market hours -----------------------------------------------------------
test('INCIDENT: legs gone, not held, no fill, grace long expired - at NIGHT the row stays open', () => {
  const r = transition(angelSplit({ graceStartAt: NOW - 2 * H }), snap({ heldQty: { ...OTHERS_HELD } }), { now: NOW, marketHours: false });
  assert.equal(r.state, STATE.PROTECTED, 'no close from absence outside market hours');
  assert.equal(r.patch.exitType, undefined);
});

test('same evidence in MARKET HOURS closes (estimated), exactly as before', () => {
  const r = transition(angelSplit({ graceStartAt: NOW - 2 * H }), snap({ heldQty: { ...OTHERS_HELD } }), { now: NOW, marketHours: true });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.exitEstimated, true);
});

test('marketHours absent from opts = open (every existing caller and test unchanged)', () => {
  const r = transition(angelSplit({ graceStartAt: NOW - 2 * H }), snap({ heldQty: { ...OTHERS_HELD } }), { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
});

test('POSITIVE evidence still acts at night: a covering SELL fill closes with real prices', () => {
  const r = transition(angelSplit(), snap({ heldQty: {}, sells: { MANAKCOAT: [{ qty: 41, px: 128.4 }] } }), { now: NOW, marketHours: false, emptyHoldingsMs: 0 });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.exitEstimated, false);
  assert.equal(r.patch.exitType, 'SL HIT');
});

test('EXIT_PENDING: not held and no fill at night -> wait; in market hours -> grace close', () => {
  const pos = angelSplit({ state: STATE.EXIT_PENDING, exitPendingAt: NOW - 3 * H, graceStartAt: NOW - 2 * H });
  const night = transition(pos, snap({ heldQty: { ...OTHERS_HELD } }), { now: NOW, marketHours: false });
  assert.equal(night.state, STATE.EXIT_PENDING);
  const day = transition(pos, snap({ heldQty: { ...OTHERS_HELD } }), { now: NOW, marketHours: true });
  assert.equal(day.state, STATE.CLOSED);
});

// ---- 2. an all-empty holdings list ------------------------------------------
test('INCIDENT: holdings list EMPTY (the broker\'s night) -> not a read: no grace, no close, even in market hours', () => {
  const r = transition(angelSplit({ graceStartAt: NOW - 2 * H }), snap({ heldQty: {} }), { now: NOW, marketHours: true, emptyHoldingsMs: 5 * MIN });
  assert.equal(r.state, STATE.PROTECTED);
  assert.equal(r.patch.graceStartAt, undefined, 'the grace clock is not even started on an empty list');
});

test('an empty list that has PERSISTED for the 20x grace is believed (a one-position account that sold)', () => {
  const r = transition(angelSplit({ graceStartAt: NOW - 2 * H }), snap({ heldQty: {} }), { now: NOW, marketHours: true, emptyHoldingsMs: 20 * GRACE });
  assert.equal(r.state, STATE.CLOSED);
});

test('a list that names OTHER holdings is a real read: this symbol absent = not held', () => {
  const r = transition(angelSplit({ graceStartAt: NOW - 2 * H }), snap({ heldQty: { ...OTHERS_HELD } }), { now: NOW, marketHours: true, emptyHoldingsMs: 0 });
  assert.equal(r.state, STATE.CLOSED);
});

test('emptyHoldingsMs absent from opts = trusted (pure-engine callers and older tests unchanged)', () => {
  const r = transition(angelSplit({ graceStartAt: NOW - 2 * H }), snap({ heldQty: {} }), { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
});

test('TARGETS_ONLY: empty holdings list -> wait; night -> wait; market hours with a real read -> grace close', () => {
  const base = { state: STATE.TARGETS_ONLY, symbol: 'GNFC', qty: 9, entryPrice: 500, slPrice: 0, targetPrice: 550, entryId: 'E9',
    legs: [{ id: 'TG1', role: 'target-t1', qty: 9, price: 550 }], heldSeenAt: NOW - 2 * H, graceStartAt: NOW - 2 * H, otherOpenRows: 0 };   // 2h: an empty protection list makes the grace 20x
  const empty = transition(base, snap({ heldQty: {} }), { now: NOW, marketHours: true, emptyHoldingsMs: 0 });
  assert.equal(empty.state, STATE.TARGETS_ONLY);
  const night = transition(base, snap({ heldQty: { ...OTHERS_HELD } }), { now: NOW, marketHours: false, emptyHoldingsMs: 0 });
  assert.equal(night.state, STATE.TARGETS_ONLY);
  const day = transition(base, snap({ heldQty: { ...OTHERS_HELD } }), { now: NOW, marketHours: true, emptyHoldingsMs: 0 });
  assert.equal(day.state, STATE.CLOSED);
});

// ---- 3. leftover cancel after a close ------------------------------------------
test('CLOSED row, leftover legs live: no cancel at night, none on an empty holdings list, cancel on a real market-hours read', () => {
  const closed = angelSplit({ state: STATE.CLOSED, exitEstimated: false, closedAt: NOW - 3 * 24 * H, manualClose: false, reopened: false });
  const live = { T1R: { status: 'live', triggerPrice: 128.5, qty: 41 }, SLR: { status: 'live', triggerPrice: 128.5, qty: 41 } };
  const cancels = r => r.actions.filter(a => a.type === 'CANCEL_ORPHAN_PROTECTION');
  assert.equal(cancels(transition(closed, snap({ protections: live, heldQty: { ...OTHERS_HELD } }), { now: NOW, marketHours: false })).length, 0, 'night');
  assert.equal(cancels(transition(closed, snap({ protections: live, heldQty: {} }), { now: NOW, marketHours: true, emptyHoldingsMs: 0 })).length, 0, 'empty list');
  const ok = cancels(transition(closed, snap({ protections: live, heldQty: { ...OTHERS_HELD } }), { now: NOW, marketHours: true, emptyHoldingsMs: 0 }));
  assert.equal(ok.length, 1);
  assert.deepEqual(ok[0].legIds, ['T1R', 'SLR']);
});

// ---- 4. estimated close counts the runner once ---------------------------------
test('estimated close after T1: P&L = runner shares at the stop + the booked T1, never the whole row', () => {
  const r = reconstructClose(angelSplit(), []);
  assert.equal(r.exitEstimated, true);
  assert.equal(r.exitType, 'EXITED');
  assert.equal(r.exitPrice, 128.5);
  // (128.5 - 121.1) x 41 = 303.4, plus t1Pnl 303.4
  assert.equal(r.realisedPnl, 606.8);
  assert.equal(r.t1Booked, true);
});

test('estimated close BEFORE T1 is unchanged: whole quantity at the stop', () => {
  const r = reconstructClose(angelSplit({ t1Booked: false, t1Pnl: 0, slPrice: 115 }), []);
  assert.equal(r.realisedPnl, Math.round((115 - 121.1) * 82 * 100) / 100);
});

// ---- 5. rule 5c: surplus triggers on an OPEN row --------------------------------
function fivestar(over = {}) {
  return {
    state: STATE.PROTECTED, symbol: 'FIVESTAR', qty: 28,
    entryPrice: 700, slPrice: 680, targetPrice: 770, t1Price: 735, costTrigger: 0, entryId: 'E5', splitT1: true,
    legs: [{ id: 'NEW-T1', role: 't1', qty: 14 }, { id: 'NEW-R', role: 'runner', qty: 14 }],
    t1Booked: false, costMoved: false, pendingSl: null, graceStartAt: 0, ltp: 705, otherOpenRows: 0, surplusSightings: 0,
    ...over,
  };
}
const OWN = { 'NEW-T1': { status: 'live', triggerPrice: 680, qty: 14, symbol: 'FIVESTAR' }, 'NEW-R': { status: 'live', triggerPrice: 680, qty: 14, symbol: 'FIVESTAR' } };
const EXTRA = { 'OLD-B': { status: 'live', triggerPrice: 680, qty: 28, symbol: 'FIVESTAR' } };
const DAY = { now: NOW, marketHours: true, emptyHoldingsMs: 0 };
const surplusCancels = r => r.actions.filter(a => a.type === 'CANCEL_SURPLUS_PROTECTION');

test('INCIDENT (FIVESTAR, day 3): own bracket covers 28 of 28 held, a 28-share leftover stands -> sighting 1 counts, sighting 2 cancels ONLY the extra', () => {
  const s = snap({ protections: { ...OWN, ...EXTRA }, heldQty: { FIVESTAR: 28, ...OTHERS_HELD } });
  const r1 = transition(fivestar(), s, DAY);
  assert.equal(surplusCancels(r1).length, 0);
  assert.equal(r1.patch.surplusSightings, 1);
  const r2 = transition(fivestar({ surplusSightings: 1 }), s, DAY);
  const c = surplusCancels(r2);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].legIds, ['OLD-B']);
  assert.equal(r2.patch.surplusSightings, 0);
  assert.ok(r2.alerts.some(a => a.type === 'SURPLUS_CANCELLED'));
  assert.equal(r2.state, STATE.PROTECTED, 'the position itself is untouched');
});

test('the user holds MORE than the row covers: the extra trigger may be theirs - untouched', () => {
  const s = snap({ protections: { ...OWN, ...EXTRA }, heldQty: { FIVESTAR: 56, ...OTHERS_HELD } });
  const r = transition(fivestar({ surplusSightings: 1 }), s, DAY);
  assert.equal(surplusCancels(r).length, 0);
  assert.equal(r.patch.surplusSightings, 0, 'the count resets when the condition is not met');
});

test('an extra id ANOTHER row of ours owns (snap.ownedIds) is never touched', () => {
  const s = snap({ protections: { ...OWN, ...EXTRA }, heldQty: { FIVESTAR: 28, ...OTHERS_HELD }, ownedIds: new Set(['OLD-B']) });
  const r = transition(fivestar({ surplusSightings: 1 }), s, DAY);
  assert.equal(surplusCancels(r).length, 0);
});

test('another OPEN row on the symbol, a pending modify, a working SELL, night, or an empty holdings list: no cancel', () => {
  const s = snap({ protections: { ...OWN, ...EXTRA }, heldQty: { FIVESTAR: 28, ...OTHERS_HELD } });
  assert.equal(surplusCancels(transition(fivestar({ surplusSightings: 1, otherOpenRows: 1 }), s, DAY)).length, 0, 'other open row');
  assert.equal(surplusCancels(transition(fivestar({ surplusSightings: 1, pendingSl: { price: 690, at: NOW } }), s, DAY)).length, 0, 'pending modify');
  assert.equal(surplusCancels(transition(fivestar({ surplusSightings: 1 }), snap({ ...s, openSells: { FIVESTAR: 14 } }), DAY)).length, 0, 'sell working');
  assert.equal(surplusCancels(transition(fivestar({ surplusSightings: 1 }), s, { ...DAY, marketHours: false })).length, 0, 'night');
  assert.equal(surplusCancels(transition(fivestar({ surplusSightings: 1 }), snap({ protections: { ...OWN, ...EXTRA }, heldQty: {} }), DAY)).length, 0, 'empty holdings');
});

test('a trigger on a DIFFERENT symbol, or one of the row\'s own legs, is never an extra', () => {
  const s = snap({ protections: { ...OWN, X1: { status: 'live', triggerPrice: 10, qty: 5, symbol: 'PNB' } }, heldQty: { FIVESTAR: 28, ...OTHERS_HELD } });
  const r = transition(fivestar({ surplusSightings: 1 }), s, DAY);
  assert.equal(surplusCancels(r).length, 0);
  assert.equal(r.patch.surplusSightings, 0);
});

test('legs whose quantity is unknown (0 on the row AND in the broker list) never claim coverage: nothing cancelled', () => {
  const noQty = { 'NEW-T1': { status: 'live', triggerPrice: 680, symbol: 'FIVESTAR' }, 'NEW-R': { status: 'live', triggerPrice: 680, symbol: 'FIVESTAR' } };
  const s = snap({ protections: { ...noQty, ...EXTRA }, heldQty: { FIVESTAR: 28, ...OTHERS_HELD } });
  const r = transition(fivestar({ surplusSightings: 1, legs: [{ id: 'NEW-T1', role: 't1', qty: 0 }, { id: 'NEW-R', role: 'runner', qty: 0 }] }), s, DAY);
  assert.equal(surplusCancels(r).length, 0);
});

// ---- 6. the wiring in server.js and the dashboard --------------------------------
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('server passes the clocks the engine needs, and skips an estimated close on a suspect read', () => {
  assert.ok(src.includes('marketHours: marketOpenNow, emptyHoldingsMs, reopenWindowMs: estimatedReopenWindowMs() });'));
  assert.ok(src.includes('const marketOpenNow = withinMarketHours();'));
  assert.ok(src.includes('const emptyHoldingsMs = noteHoldingsRead(brokerName, snap);'));
  assert.ok(src.includes('if (readSuspect && r.state === engine.STATE.CLOSED && pos.state !== engine.STATE.CLOSED && r.patch && r.patch.exitEstimated) return;'));
  // the estimated-close feed and the reopen window agree (20h, 72h on a Monday)
  assert.ok(src.includes("return (getIstNow().getDay() === 1 ? 72 : 20) * 60 * 60 * 1000;"));
  assert.ok(src.includes("|| 0)) < estimatedReopenWindowMs();"));
});

test('rule 5c wiring: sighting counter on the row, executor branch, capped, alert wording', () => {
  assert.ok(src.includes('surplusSightings: Number(row.engineSurplusSightings || 0),'));
  assert.ok(src.includes('if (rp.surplusSightings !== undefined) p.engineSurplusSightings = rp.surplusSightings;'));
  assert.ok(src.includes("if (action.type === 'CANCEL_SURPLUS_PROTECTION') {"));
  assert.ok(src.includes("if (Number(row.surplusCancelAttempts || 0) >= 3) return callback('extra trigger cancel already tried 3 times - cancel it at the broker');"));
  assert.ok(src.includes("SURPLUS_CANCELLED: 'extra triggers on the symbol cancelled'"));
});

test('SILENT BLIND: open rows on a broker with no usable token now reach the blind alert', () => {
  ['dhan', 'zerodha', 'fyers', 'angelone'].forEach(b => {
    assert.ok(src.includes("engineBlind('" + b + "', 'no usable "), b + ' has the no-token branch');
  });
});

test('daily audit: a stock sold by the algo is listed as settling, not as a naked holding', () => {
  assert.ok(src.includes("Sold by the algo, still listed in holdings until settlement (T+1): "));
  assert.ok(src.includes('const naked = nakedAll.filter(sym => !settling.has(sym));'));
});

test('lifecycle text names the RUNNER after T1, never the whole row', () => {
  assert.ok(html.includes("const runnerQ = n(r.splitLegBQty) || n(r.mtmRemainingQty);"));
  assert.ok(html.includes("(runnerQ > 0 && runnerQ < n(r.qty) ? ' \\u00b7 ' + runnerQ + ' still running' : '')"));
});
