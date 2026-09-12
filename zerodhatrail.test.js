'use strict';
// STAR ON ZERODHA (2026-09-12). Entry 1034.6, stop trailed to 1106, target
// 2070. Between 2:40 and 3:38 AM IST the engine sent the SAME modify to 1106
// four times; Kite had accepted the first one (its screen showed trigger 1106,
// limit 1100). The stop could not be read back, so the engine gave up on each
// confirmation after three minutes and asked again, until the hourly budget
// held. Three guards, each proven here:
//   1. the adapter reads the trigger from a string-form `condition` too
//   2. an accepted modify with no verifiable leg is ADOPTED after grace, not
//      re-asked forever
//   3. trail modifies go out only in trading hours

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zerodha = require('./brokers/zerodha');
const { STATE, transition } = require('./engine');

const NOW = 1_800_000_000_000;
const GRACE = 3 * 60 * 1000;

test('adapter: a GTT whose condition arrives as a JSON string still reports its SL trigger', () => {
  const obj = zerodha.gttState({ status: 'active', condition: { trigger_values: [1106, 2070] }, orders: [{ quantity: 48 }, { quantity: 48 }] });
  const str = zerodha.gttState({ status: 'active', condition: JSON.stringify({ trigger_values: [1106, 2070] }), orders: [{ quantity: 48 }, { quantity: 48 }] });
  assert.equal(obj.triggerPrice, 1106);
  assert.equal(str.triggerPrice, 1106, 'string form used to read as 0 - an unverifiable stop');
  assert.equal(str.qty, 48);
  assert.equal(zerodha.gttState({ status: 'active', condition: '{not json' }).triggerPrice, 0, 'garbage stays 0, never throws');
});

function starPos(over = {}) {
  return {
    state: STATE.PROTECTED, symbol: 'STAR', qty: 48,
    entryPrice: 1034.6, slPrice: 1085, targetPrice: 2070, t1Price: 2070, costTrigger: 0, entryId: 'E1',
    legs: [{ id: 'G334437625', role: 'single', qty: 48 }],
    t1Booked: false, costMoved: false, pendingSl: null, graceStartAt: 0, ltp: 1183.4,
    ...over,
  };
}
const snap = (over = {}) => ({ complete: true, protections: {}, entries: {}, heldQty: { STAR: 48 }, sells: {}, ...over });
const LIVE_NO_TRIGGER = { G334437625: { status: 'live', triggerPrice: 0, qty: 48 } };
const LIVE_1106 = { G334437625: { status: 'live', triggerPrice: 1106, qty: 48 } };

test('INCIDENT: accepted modify, leg live but no trigger readable -> after grace the stop is ADOPTED, flagged, and never re-asked', () => {
  const pending = { price: 1106, at: NOW - GRACE - 1 };
  const r = transition(starPos({ pendingSl: pending }), snap({ protections: LIVE_NO_TRIGGER }), { now: NOW });
  assert.equal(r.patch.pendingSl, null);
  assert.equal(r.patch.slPrice, 1106, 'the accepted write is believed');
  assert.equal(r.patch.slUnverifiedAt, NOW);
  assert.ok(r.alerts.some(a => a.type === 'SL_MODIFY_UNVERIFIABLE'));
  assert.ok(!r.alerts.some(a => a.type === 'SL_MODIFY_UNCONFIRMED'));
  assert.ok(!r.actions.some(a => a.type === 'MODIFY_SL'), 'no re-ask in the same tick');
  // next pass: the row now carries 1106, the leg still reports nothing -> quiet
  const next = transition(starPos({ slPrice: 1106 }), snap({ protections: LIVE_NO_TRIGGER }), { now: NOW + 120000 });
  assert.ok(!next.actions.some(a => a.type === 'MODIFY_SL' && a.price === 1106), 'the same 1106 is not sent again');
});

test('within grace nothing is adopted yet; a leg that DOES report a lower trigger still gets the stale-stop alert, not adoption', () => {
  const early = transition(starPos({ pendingSl: { price: 1106, at: NOW - 1000 } }), snap({ protections: LIVE_NO_TRIGGER }), { now: NOW });
  assert.equal(early.patch.slPrice, undefined);
  assert.equal(early.alerts.length, 0);
  const contradicted = transition(starPos({ pendingSl: { price: 1106, at: NOW - GRACE - 1 } }), snap({ protections: { G334437625: { status: 'live', triggerPrice: 1085, qty: 48 } } }), { now: NOW });
  assert.ok(contradicted.alerts.some(a => a.type === 'SL_MODIFY_UNCONFIRMED'), 'a readable trigger that disagrees is a real non-confirmation');
  assert.equal(contradicted.patch.slPrice, undefined);
});

test('a readable trigger that matches confirms as before', () => {
  const r = transition(starPos({ pendingSl: { price: 1106, at: NOW - 1000 } }), snap({ protections: LIVE_1106 }), { now: NOW });
  assert.equal(r.patch.slPrice, 1106);
  assert.equal(r.patch.slVerifiedAt, NOW);
  assert.equal(r.patch.slUnverifiedAt, undefined);
});

test('an adopted-unverified cost move ticks cost, like a confirmed one', () => {
  const r = transition(starPos({ pendingSl: { price: 1035, at: NOW - GRACE - 1, toCost: true } }), snap({ protections: LIVE_NO_TRIGGER }), { now: NOW });
  assert.equal(r.patch.costMoved, true);
});

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('trail modifies are sent only between 09:00 and 18:00 IST; a night pass consumes no attempt', () => {
  assert.ok(src.includes("function withinTrailingHours(now = getIstNow()) {"));
  assert.ok(src.includes("return mins >= 9 * 60 && mins <= 18 * 60;"));
  assert.ok(src.includes("if (/^trail-/.test(String(action.reason || '')) && !withinTrailingHours()) return callback(null);"));
});
