'use strict';
// brokers.test.js — normalization tests for the broker adapters, using fixture
// payloads shaped like real Dhan/Kite responses. These are the seams where a
// broker quirk becomes an engine fact — a wrong mapping here means the engine
// reasons correctly about wrong data, so every quirk gets a fixture.
const { test } = require('node:test');
const assert = require('node:assert');
const dhan = require('./dhan');
const zerodha = require('./zerodha');

// ---- Dhan foreverState -------------------------------------------------------
test('dhan: pending OCO legs -> live, with SL trigger + qty for integrity checks', () => {
  const s = dhan.foreverState([
    { orderStatus: 'PENDING', legName: 'STOP_LOSS_LEG', triggerPrice: 166.9, quantity: 2 },
    { orderStatus: 'PENDING', legName: 'TARGET_LEG', triggerPrice: 176.4, quantity: 2 },
  ]);
  assert.deepEqual(s, { status: 'live', triggerPrice: 166.9, qty: 2 });
});

test('dhan: TRADED target leg -> traded_target with fill px', () => {
  const s = dhan.foreverState([
    { orderStatus: 'TRADED', legName: 'TARGET_LEG', price: 176.38 },
    { orderStatus: 'CANCELLED', legName: 'STOP_LOSS_LEG' },
  ]);
  assert.equal(s.status, 'traded_target');
  assert.equal(s.px, 176.38);
});

test('dhan: TRADED stop leg -> traded_sl', () => {
  const s = dhan.foreverState([
    { orderStatus: 'TRADED', legName: 'STOP_LOSS_LEG', triggerPrice: 166.9 },
  ]);
  assert.equal(s.status, 'traded_sl');
});

test('dhan: REJECTED forever (T2T async reject) -> rejected', () => {
  const s = dhan.foreverState([{ orderStatus: 'REJECTED', legName: 'STOP_LOSS_LEG' }]);
  assert.equal(s.status, 'rejected');
});

// ---- Zerodha gttState ----------------------------------------------------------
test('zerodha: active GTT -> live with SL trigger (trigger_values[0]) + qty', () => {
  const s = zerodha.gttState({ status: 'active', condition: { trigger_values: [166.9, 176.4] }, orders: [{ quantity: 2 }, { quantity: 2 }] });
  assert.deepEqual(s, { status: 'live', triggerPrice: 166.9, qty: 2 });
});

test('zerodha: triggered GTT, TARGET leg (index 1) COMPLETE -> traded_target', () => {
  const s = zerodha.gttState({
    status: 'triggered',
    orders: [
      {}, // SL leg untouched
      { result: { order_result: { order_id: 'X1', status: 'COMPLETE' }, average_price: 176.38 } },
    ],
  });
  assert.equal(s.status, 'traded_target');
  assert.equal(s.px, 176.38);
});

test('zerodha: triggered GTT, SL leg (index 0) COMPLETE -> traded_sl', () => {
  const s = zerodha.gttState({
    status: 'triggered',
    orders: [{ result: { order_result: { order_id: 'X2', status: 'COMPLETE' }, average_price: 165.4 } }, {}],
  });
  assert.equal(s.status, 'traded_sl');
  assert.equal(s.px, 165.4);
});

test('zerodha: triggered but exit order REJECTED (T2T!) -> rejected, not traded', () => {
  const s = zerodha.gttState({
    status: 'triggered',
    orders: [{ result: { order_result: { order_id: 'X3', status: 'REJECTED', rejection_reason: 'T2T' } } }, {}],
  });
  assert.equal(s.status, 'rejected');
});

test('zerodha: triggered, exit order still working -> live (position still owned)', () => {
  const s = zerodha.gttState({
    status: 'triggered',
    orders: [{ result: { order_result: { order_id: 'X4', status: 'OPEN' } } }, {}],
  });
  assert.equal(s.status, 'live');
});

test('zerodha: deleted/cancelled/disabled GTT -> gone; rejected -> rejected', () => {
  assert.equal(zerodha.gttState({ status: 'deleted' }).status, 'gone');
  assert.equal(zerodha.gttState({ status: 'cancelled' }).status, 'gone');
  assert.equal(zerodha.gttState({ status: 'disabled' }).status, 'gone');
  assert.equal(zerodha.gttState({ status: 'rejected' }).status, 'rejected');
});
