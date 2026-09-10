'use strict';
// LEFTOVER PROTECTION AFTER A CLOSE (2026-09-10, KPIL on Dhan). The Order Log
// read 'Trade closed' for a 7-share split row while Dhan's Forever list still
// held its whole bracket: the 3-share T1 leg (1495 / 1307) and the 4-share
// runner (1692 / 1307). A close that did not come through those legs leaves
// them standing; when one fires it sells shares that are gone.
//
// The rule: a CLOSED row, holdings READ and showing NOTHING held, a leg still
// live, no other open row of ours on the symbol -> cancel the leftover legs.
// Shares still held is never this rule's business - that is the reopen.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { STATE, transition } = require('./engine');

const NOW = 1_800_000_000_000;
const H = 60 * 60 * 1000, DAY = 24 * H;

function kpilClosed(over = {}) {
  return {
    state: STATE.CLOSED, symbol: 'KPIL', qty: 7,
    entryPrice: 1410.1, slPrice: 1410, targetPrice: 1690, t1Price: 1494.71, costTrigger: 0, entryId: 'E1', splitT1: true,
    legs: [{ id: 'FT1', role: 't1', qty: 3 }, { id: 'FR', role: 'runner', qty: 4 }],
    t1Booked: false, costMoved: true, pendingSl: null, graceStartAt: 0, ltp: 1428.1,
    exitEstimated: false, reopened: false, manualClose: false, closedAt: NOW - 3 * DAY, enteredAt: NOW - 8 * DAY, otherOpenRows: 0,
    ...over,
  };
}
function snap(over = {}) {
  return { complete: true, protections: {}, entries: {}, heldQty: {}, sells: {}, ...over };
}
const BRACKET_LIVE = { FT1: { status: 'live', triggerPrice: 1307, qty: 3 }, FR: { status: 'live', triggerPrice: 1307, qty: 4 } };
const cancels = r => r.actions.filter(a => a.type === 'CANCEL_ORPHAN_PROTECTION');

test('INCIDENT: closed row, nothing held, both OCOs still live -> cancel both legs, exit untouched', () => {
  const r = transition(kpilClosed(), snap({ protections: BRACKET_LIVE, heldQty: { KPIL: 0 } }), { now: NOW });
  assert.equal(r.state, STATE.CLOSED, 'stays closed');
  const c = cancels(r);
  assert.equal(c.length, 1);
  assert.deepEqual(c[0].legIds, ['FT1', 'FR']);
  assert.equal(c[0].reason, 'closed-not-held');
  assert.equal(r.patch.reopened, undefined);
  assert.equal(r.patch.exitType, undefined, 'the exit as written is not touched');
});

test('only the legs still LIVE are named; a fired or gone leg is left alone', () => {
  const r = transition(kpilClosed(), snap({ protections: { FT1: { status: 'traded_target' }, FR: { status: 'live', triggerPrice: 1307, qty: 4 } }, heldQty: { KPIL: 0 } }), { now: NOW });
  assert.deepEqual(cancels(r)[0].legIds, ['FR']);
});

test('shares STILL HELD: never cancelled here - the reopen decides (RAIN class)', () => {
  const r = transition(kpilClosed(), snap({ protections: BRACKET_LIVE, heldQty: { KPIL: 7 } }), { now: NOW });
  assert.equal(cancels(r).length, 0);
  assert.equal(r.patch.reopened, true, 'held after settlement with the bracket live -> reopened, PROTECTED');
  assert.equal(r.state, STATE.PROTECTED);
});

test('holdings UNREAD is unknown, not "not held": nothing is cancelled', () => {
  const s = snap({ protections: BRACKET_LIVE });
  delete s.heldQty;
  const r = transition(kpilClosed(), s, { now: NOW });
  assert.equal(cancels(r).length, 0);
});

test('another open row of ours on the symbol may own those shares: hands off', () => {
  const r = transition(kpilClosed({ otherOpenRows: 1 }), snap({ protections: BRACKET_LIVE, heldQty: { KPIL: 0 } }), { now: NOW });
  assert.equal(cancels(r).length, 0);
});

test('a MANUAL close with nothing held still gets its leftovers cancelled (and is never reopened)', () => {
  const r = transition(kpilClosed({ manualClose: true }), snap({ protections: BRACKET_LIVE, heldQty: { KPIL: 0 } }), { now: NOW });
  assert.equal(cancels(r).length, 1);
  assert.equal(r.patch.reopened, undefined);
  const held = transition(kpilClosed({ manualClose: true }), snap({ protections: BRACKET_LIVE, heldQty: { KPIL: 7 } }), { now: NOW });
  assert.equal(cancels(held).length, 0);
  assert.equal(held.patch.reopened, undefined, 'the owner\'s word stands');
});

test('once the legs are gone the row is quiet', () => {
  const r = transition(kpilClosed(), snap({ protections: { FT1: { status: 'gone' }, FR: { status: 'gone' } }, heldQty: { KPIL: 0 } }), { now: NOW });
  assert.equal(r.actions.length, 0);
});

test('a reopened row is terminal for this rule too', () => {
  const r = transition(kpilClosed({ reopened: true }), snap({ protections: BRACKET_LIVE, heldQty: { KPIL: 0 } }), { now: NOW });
  assert.equal(r.actions.length, 0);
});

// ---- wiring ----------------------------------------------------------------------------

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('the executor cancels leftovers WITHOUT rewriting the exit, caps attempts, and re-feeds manual closes', () => {
  assert.ok(src.includes("const closedOrphan = action.reason === 'closed-not-held';"));
  assert.ok(src.includes("if (closedOrphan && Number(row.orphanCancelAttempts || 0) >= 3) return callback("));
  assert.ok(src.includes("orphanLegsCancelledAt: at, lastStatusCheckAt: at,"));
  assert.ok(src.includes("const recentFillClose = e => e.exitType && !e.exitEstimated && !e.reopenedAt && !/^REJECT/i.test(String(e.exitType))"), 'manual closes ride along');
});
