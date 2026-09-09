'use strict';
// FALSE CLOSE FROM ANOTHER TRADE'S FILLS (2026-09-09, RAIN on Dhan).
//
// THE INCIDENT. A 9-share split row (T1 leg 4, runner 5) booked T1, then the
// engine declared the WHOLE row EXITED @ 215.76 with realised 103.67 - while
// Dhan still held 5 shares at the same average. Fills are attributed to a row
// by SYMBOL, and the Dhan adapter merges a 7-day tradebook into them, so a
// 5-share SELL of RAIN from an EARLIER trade (closed before this row opened)
// was counted as this row's runner exit: 5 (old) + 4 (this T1) = 9 = "covered".
// The runner sat at the broker behind a closed row - the TATASTEEL class of
// failure, reached by a different road.
//
// Two guards, both proven here:
//   1. a TIME FENCE in foreignFill: a fill dated before the row opened can never
//      be its exit;
//   2. a FILL-BASED re-check in the CLOSED state: shares still held after
//      settlement, at least the remaining quantity, with no other open row of
//      ours on the symbol, reopen the row (a manual close is never overridden).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATE, transition, foreignFill } = require('./engine');

const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000, DAY = 24 * H;
const OPENED = NOW - 3 * DAY;

// RAIN as the row saw it: 9 @ 204.86, split 4 (T1) / 5 (runner), opened 3 days ago.
function rainPos(over = {}) {
  return {
    state: STATE.PROTECTED, symbol: 'RAIN', qty: 9,
    entryPrice: 204.86, slPrice: 212.9, targetPrice: 217.3, t1Price: 217.15,
    costTrigger: 0, entryId: 'E1', splitT1: true,
    legs: [{ id: 'FT1', role: 't1', qty: 4 }, { id: 'FR', role: 'runner', qty: 5 }],
    t1Booked: false, costMoved: false, pendingSl: null, graceStartAt: 0, ltp: 215.5,
    enteredAt: OPENED,
    ...over,
  };
}
function snap(over = {}) {
  return { complete: true, protections: {}, entries: {}, heldQty: {}, sells: {}, ...over };
}
// The broker's view on the morning it happened: T1 fired (leg terminal), the
// runner's trigger no longer listed, holdings still 9 (CNC settles T+1).
const T1_FIRED = { FT1: { status: 'traded_target', px: 217.15, symbol: 'RAIN' }, FR: { status: 'gone', symbol: 'RAIN' } };
const OLD_EXIT = { qty: 5, px: 215.76, at: NOW - 6 * DAY, orderId: 'OLD-FR' };   // a PREVIOUS RAIN trade's exit
const THIS_T1 = { qty: 4, px: 217.15, at: NOW - 1 * H, orderId: 'FT1' };

// ---- 1. the time fence -------------------------------------------------------

test('foreignFill: a fill dated before the row opened is not this row\'s', () => {
  const pos = rainPos();
  assert.equal(foreignFill(pos, snap(), OLD_EXIT), true, 'six days before the row existed');
  assert.equal(foreignFill(pos, snap(), THIS_T1), false, 'after the row opened');
  assert.equal(foreignFill(pos, snap(), { qty: 5, px: 215.76, at: 0 }), false, 'no timestamp: old behaviour, kept');
  assert.equal(foreignFill(rainPos({ enteredAt: 0 }), snap(), OLD_EXIT), false, 'no entry time: old behaviour, kept');
});

test('INCIDENT: an older trade\'s exit no longer closes the row - the runner stays tracked', () => {
  const r = transition(rainPos(), snap({ protections: T1_FIRED, heldQty: { RAIN: 9 }, sells: { RAIN: [OLD_EXIT, THIS_T1] } }), { now: NOW });
  assert.notEqual(r.state, STATE.CLOSED, 'only 4 of 9 were sold by THIS row');
  assert.equal(r.patch.t1Booked, true, 'T1 is still recognised as booked');
  assert.equal(r.patch.exitType, undefined, 'no exit written');
});

test('the same evidence WITHOUT the fence reproduces the false close (documents the bug)', () => {
  const r = transition(rainPos({ enteredAt: 0 }), snap({ protections: T1_FIRED, heldQty: { RAIN: 9 }, sells: { RAIN: [OLD_EXIT, THIS_T1] } }), { now: NOW });
  assert.equal(r.state, STATE.CLOSED, 'symbol-level fills: 5 + 4 "covers" 9');
  assert.equal(r.patch.exitPrice, 217.15, 'and books a price from fills that were not all its own');
});

test('a genuine full exit still closes: both legs\' fills are after the row opened', () => {
  const runnerFill = { qty: 5, px: 215.76, at: NOW - 30 * 60 * 1000, orderId: 'FR' };
  const r = transition(rainPos(), snap({ protections: T1_FIRED, heldQty: { RAIN: 9 }, sells: { RAIN: [THIS_T1, runnerFill] } }), { now: NOW });
  assert.equal(r.state, STATE.CLOSED, 'fills that ARE this row\'s still close it (T+1 lag on holdings ignored, as before)');
});

// ---- 2. the fill-based re-check --------------------------------------------------

function closedRain(over = {}) {
  return rainPos({
    state: STATE.CLOSED, exitEstimated: false, reopened: false, manualClose: false,
    t1Booked: true, closedAt: NOW - 2 * DAY, otherOpenRows: 0,
    ...over,
  });
}
const STILL_HELD_5 = snap({ protections: { FT1: { status: 'gone' }, FR: { status: 'gone' } }, heldQty: { RAIN: 5 } });

test('REPAIR: closed from fills, runner still held after settlement, no other row -> reopened, re-arm follows', () => {
  const r = transition(closedRain(), STILL_HELD_5, { now: NOW });
  assert.equal(r.state, STATE.UNPROTECTED, 'held with nothing guarding it');
  assert.equal(r.patch.reopened, true);
  assert.equal(r.patch.reopenReason, 'fills');
  assert.equal(r.patch.exitType, '');
  assert.ok(r.alerts.some(a => a.type === 'REOPENED' && /still held after settlement/.test(a.reason)));
});

test('REPAIR is refused when another open row of ours holds the symbol (those shares are accounted for)', () => {
  const r = transition(closedRain({ otherOpenRows: 1 }), STILL_HELD_5, { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
  assert.equal(r.patch.reopened, undefined);
});

test('REPAIR never overrides a manual close (the owner\'s word)', () => {
  const r = transition(closedRain({ manualClose: true }), STILL_HELD_5, { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
});

test('REPAIR waits for settlement: an hour-old close with shares still in holdings is just T+1 lag', () => {
  const r = transition(closedRain({ closedAt: NOW - 1 * H }), STILL_HELD_5, { now: NOW });
  assert.equal(r.state, STATE.CLOSED);
});

test('REPAIR needs at least the remaining quantity held, and a close within the window', () => {
  assert.equal(transition(closedRain(), snap({ heldQty: { RAIN: 2 } }), { now: NOW }).state, STATE.CLOSED, '2 held < 5 remaining');
  assert.equal(transition(closedRain({ closedAt: NOW - 11 * DAY }), STILL_HELD_5, { now: NOW }).state, STATE.CLOSED, 'older than the tradebook could have reached');
});

test('an ESTIMATED close keeps its own (existing) re-check', () => {
  const r = transition(closedRain({ exitEstimated: true, closedAt: NOW - 2 * H }), STILL_HELD_5, { now: NOW });
  assert.equal(r.patch.reopened, true, 'estimated + recent + held -> reopened, as before');
});

// ---- 3. the wiring in server.js / index.html ---------------------------------------

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('the row\'s opening time and manual-close flag reach the engine', () => {
  assert.ok(src.includes("enteredAt: Date.parse(row.recordedAt || row.time || '') || 0,"), 'enteredAt missing from the position');
  assert.ok(src.includes('manualClose: !!row.manualClose,'), 'manualClose missing from the position');
  assert.ok(src.includes("closedAt: Date.parse(row.reconciledAt || row.closedAt || row.lastStatusCheckAt || '') || 0,"), 'closedAt must prefer the once-written stamps');
});

test('recently closed rows still own their leg ids, and other-open-row counts are wired', () => {
  assert.ok(src.includes('(isOpenOrderLogEntry(e) || recentlyClosed(e))'), 'ownedIds must include recently closed rows');
  assert.ok(src.includes('p.otherOpenRows = Math.max(0,'), 'otherOpenRows not computed');
  assert.ok(src.includes('recentFillClose(e)'), 'recent fill-based closes must be re-fed to the engine');
});

test('a re-fed CLOSED row that stays closed is not rewritten', () => {
  assert.ok(src.includes("if (r.state === 'CLOSED' && row.engineState === 'CLOSED' && !rp0.reopened) return { lastStatusCheckAt: at };"),
    'engineRowPatch must not remap an unchanged close (it would blank exitPrice / relabel the exit)');
});

test('booking T1 updates the remaining quantity the timeline prints', () => {
  assert.ok(src.includes('if (legB > 0) p.mtmRemainingQty = legB;'), '"9 still running" on a row that just booked 4');
});

test('a trail that armed and ran reads Done on a closed row; Skipped is only for a trail that never started', () => {
  assert.ok(html.includes("add('EMA trail', closedNow ? (r.emaTrailingArmedAt ? 'ok' : 'skip') : (r.emaTrailingArmedAt ? 'ok' : 'wait'),"));
});
