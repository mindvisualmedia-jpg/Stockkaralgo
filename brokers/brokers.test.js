'use strict';
// brokers.test.js — normalization tests for the broker adapters, using fixture
// payloads shaped like real Dhan/Kite responses. These are the seams where a
// broker quirk becomes an engine fact — a wrong mapping here means the engine
// reasons correctly about wrong data, so every quirk gets a fixture.
const { test } = require('node:test');
const assert = require('node:assert');
const dhan = require('./dhan');
const zerodha = require('./zerodha');
const fyers = require('./fyers');

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

// ---- FYERS gttState ------------------------------------------------------------
test('fyers: pending OCO -> live; SL trigger = LOWER leg (leg order not guaranteed)', () => {
  const s = fyers.gttState({ status: 'pending', orderInfo: {
    leg1: { price: 176.4, triggerPrice: 176.4, qty: 2 },   // target leg
    leg2: { price: 166.4, triggerPrice: 166.9, qty: 2 },   // SL leg
  } });
  assert.deepEqual(s, { status: 'live', triggerPrice: 166.9, qty: 2 });
});

test('fyers: legs swapped in list -> SL trigger still the lower one', () => {
  const s = fyers.gttState({ status: 'active', orderInfo: {
    leg1: { price: 166.4, triggerPrice: 166.9, qty: 3 },
    leg2: { price: 176.4, triggerPrice: 176.4, qty: 3 },
  } });
  assert.equal(s.status, 'live');
  assert.equal(s.triggerPrice, 166.9);
  assert.equal(s.qty, 3);
});

test('fyers: single-leg SL GTT (EMA trailing) -> live with that trigger', () => {
  const s = fyers.gttState({ status: 'pending', orderInfo: { leg1: { price: 98, triggerPrice: 98.5, qty: 5 } } });
  assert.deepEqual(s, { status: 'live', triggerPrice: 98.5, qty: 5 });
});

test('fyers: triggered/complete -> fired (terminal, asserts neither target nor SL)', () => {
  assert.equal(fyers.gttState({ status: 'triggered' }).status, 'fired');
  assert.equal(fyers.gttState({ status: 'complete' }).status, 'fired');
});

test('fyers: cancelled/expired -> gone; rejected -> rejected', () => {
  assert.equal(fyers.gttState({ status: 'cancelled' }).status, 'gone');
  assert.equal(fyers.gttState({ status: 'expired' }).status, 'gone');
  assert.equal(fyers.gttState({ status: 'rejected' }).status, 'rejected');
});

// ---- FYERS orderState (numeric statuses) ---------------------------------------
test('fyers: order status 2 -> filled with px+qty; 1/5 -> dead; 4/6 -> pending', () => {
  const f = fyers.orderState({ status: 2, tradedPrice: 101.5, filledQty: 10 });
  assert.deepEqual(f, { status: 'filled', fillPrice: 101.5, filledQty: 10 });
  assert.equal(fyers.orderState({ status: 1 }).status, 'dead');   // cancelled
  assert.equal(fyers.orderState({ status: 5 }).status, 'dead');   // rejected
  assert.equal(fyers.orderState({ status: 4 }).status, 'pending'); // transit
  assert.equal(fyers.orderState({ status: 6 }).status, 'pending'); // pending
});

// ---- FYERS listRows (2026-08-06 GTT-stacking incident) ----------------------
// The legacy readers in server.js parsed the GTT list from payload.data only;
// the real payload nests it under gttOrders. Every read returned [], every
// FYERS position looked naked, and the restore loop stacked a duplicate GTT
// every 5 minutes (GAIL: 5 sell GTTs against a 2-share holding). server.js now
// imports THIS unwrap - these fixtures pin every shape it must survive.
test('fyers listRows: unwraps gttOrders (the real GTT list envelope)', () => {
  const rows = fyers.listRows({ s: 'ok', gttOrders: [{ id: '1001' }, { id: '1002' }] }, 'gttOrders', 'orders');
  assert.deepEqual(rows.map(r => r.id), ['1001', '1002']);
});

test('fyers listRows: falls back to orders, then data, then bare array', () => {
  assert.deepEqual(fyers.listRows({ orders: [{ id: 'a' }] }, 'gttOrders', 'orders').map(r => r.id), ['a']);
  assert.deepEqual(fyers.listRows({ data: [{ id: 'b' }] }, 'gttOrders', 'orders').map(r => r.id), ['b']);
  assert.deepEqual(fyers.listRows([{ id: 'c' }], 'gttOrders', 'orders').map(r => r.id), ['c']);
});

test('fyers listRows: garbage in, empty array out (never throws)', () => {
  assert.deepEqual(fyers.listRows(null, 'gttOrders', 'orders'), []);
  assert.deepEqual(fyers.listRows({ s: 'ok', message: 'no data' }, 'gttOrders', 'orders'), []);
  assert.deepEqual(fyers.listRows('unexpected string', 'gttOrders', 'orders'), []);
});

// ---- Angel One adapter -------------------------------------------------------
// Angel protection is a single-leg SELL GTT *rule* (no OCO; the target is
// software-managed). Fixtures mirror SmartAPI's documented shapes; the live
// shapes are validated via /debug/angelone + shadow before any cutover.
const angel = require('./angelone');

test('angel: NEW/ACTIVE rules -> live with trigger + qty', () => {
  assert.deepEqual(angel.gttState({ status: 'ACTIVE', triggerprice: '169.1', qty: '2' }),
    { status: 'live', triggerPrice: 169.1, qty: 2 });
  assert.equal(angel.gttState({ status: 'NEW', triggerprice: 100, qty: 1 }).status, 'live');
});

test('angel: SENTTOEXCHANGE (trigger fired, order sent) -> fired, not live', () => {
  assert.equal(angel.gttState({ status: 'SENTTOEXCHANGE' }).status, 'fired');
});

test('angel: cancelled/expired -> gone; unknown non-terminal -> live (verify held-check catches over-belief)', () => {
  assert.equal(angel.gttState({ status: 'CANCELLED' }).status, 'gone');
  assert.equal(angel.gttState({ status: 'EXPIRED' }).status, 'gone');
  assert.equal(angel.gttState({ status: 'SOMETHING_NEW' }).status, 'live');
});

test('angel: order book statuses -> filled/dead/pending', () => {
  const f = angel.orderState({ status: 'complete', averageprice: '331.4', filledshares: '2' });
  assert.deepEqual(f, { status: 'filled', fillPrice: 331.4, filledQty: 2 });
  assert.equal(angel.orderState({ status: 'rejected' }).status, 'dead');
  assert.equal(angel.orderState({ status: 'trigger pending' }).status, 'pending');
});

test('angel: normSym strips series suffixes and exchange prefixes', () => {
  assert.equal(angel.normSym('GAIL-EQ'), 'GAIL');
  assert.equal(angel.normSym('NSE:NYKAA-EQ'), 'NYKAA');
  assert.equal(angel.normSym('IWARE-ST'), 'IWARE');
});

test('angel: listRows unwraps data / data.rules / bare array / garbage', () => {
  assert.deepEqual(angel.listRows({ data: [{ id: 1 }] }, 'rules').map(r => r.id), [1]);
  assert.deepEqual(angel.listRows({ data: { rules: [{ id: 2 }] } }, 'rules').map(r => r.id), [2]);
  assert.deepEqual(angel.listRows([{ id: 3 }], 'rules').map(r => r.id), [3]);
  assert.deepEqual(angel.listRows(null, 'rules'), []);
  assert.deepEqual(angel.listRows({ status: true, message: 'no data' }, 'rules'), []);
});

// Angel signals failure INSIDE a 200 body. Missing that produced a confident
// EMPTY snapshot on a live box (Invalid API Key / AG8004, 2026-08-06) — which
// reads as "nothing is protected", the FYERS stacking incident's root shape.
test('angel: error envelopes at HTTP 200 are errors, not data', () => {
  assert.equal(angel.isErrorEnvelope({ success: false, message: 'Invalid API Key', errorCode: 'AG8004', data: '' }, 200), true);
  assert.equal(angel.isErrorEnvelope({ status: false, message: 'Invalid Token' }, 200), true);
  assert.equal(angel.isErrorEnvelope({ errorcode: 'AB1010' }, 200), true);
  assert.equal(angel.isErrorEnvelope({ status: true, data: [] }, 500), true);
});

test('angel: genuine success envelopes are NOT errors (an empty list stays empty)', () => {
  assert.equal(angel.isErrorEnvelope({ status: true, message: 'SUCCESS', data: [] }, 200), false);
  assert.equal(angel.isErrorEnvelope({ success: true, data: { rules: [] } }, 200), false);
  assert.equal(angel.isErrorEnvelope(null, 200), false);
});

// ---- #15 TRIGGERED-terminal (the TATASTEEL 2026-08-04 phantom-exit lesson) --
// A TRIGGERED Forever leg fired its exit order; it is NOT standing protection
// and NOT proof of a fill. It must map to the traded_* claim states - the
// engine then demands covering SELL fills (or not-held) before closing, so a
// trigger-without-fill becomes UNPROTECTED -> re-arm instead of a false close.
test('dhan: TRIGGERED stop leg -> traded_sl claim (not live, not a confirmed fill)', () => {
  const s = dhan.foreverState([
    { orderStatus: 'TRIGGERED', legName: 'STOP_LOSS_LEG', triggerPrice: 191.9 },
    { orderStatus: 'CANCELLED', legName: 'TARGET_LEG' },
  ]);
  assert.equal(s.status, 'traded_sl');
  assert.equal(s.px, 191.9);
});

test('dhan: TRIGGERED target leg -> traded_target claim', () => {
  assert.equal(dhan.foreverState([
    { orderStatus: 'TRIGGERED', legName: 'TARGET_LEG', price: 195.7 },
  ]).status, 'traded_target');
});

test('dhan: PENDING legs still read live (TRIGGERED change must not widen)', () => {
  assert.equal(dhan.foreverState([
    { orderStatus: 'PENDING', legName: 'STOP_LOSS_LEG', triggerPrice: 166.9, quantity: 2 },
  ]).status, 'live');
});


// Kite reports failures as { status: 'error' } — contract clause 1: a body
// error at HTTP 200 is an error, never an empty list (the Angel AG8004 lesson
// applied to Zerodha before it bites).
test('zerodha: error envelopes are errors, not data', () => {
  assert.equal(zerodha.isErrorEnvelope({ status: 'error', message: 'Incorrect api_key or access_token' }, 200), true);
  assert.equal(zerodha.isErrorEnvelope({ error_type: 'TokenException' }, 200), true);
  assert.equal(zerodha.isErrorEnvelope({ status: 'success', data: [] }, 500), true);
});

test('zerodha: success envelopes are NOT errors (an empty list stays empty)', () => {
  assert.equal(zerodha.isErrorEnvelope({ status: 'success', data: [] }, 200), false);
  assert.equal(zerodha.isErrorEnvelope(null, 200), false);
});
