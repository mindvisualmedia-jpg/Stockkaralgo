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

// ---- FYERS GTT list: the REAL payload (2026-08-13) --------------------------
// The 2026-08-06 stacking incident (GAIL: 5 sell GTTs against a 2-share
// holding) was blamed on parsing payload.data, and #31 "fixed" it by reading
// gttOrders - a key taken from the docs and never checked against a live
// response. It was wrong, so the empty parse survived its own fix and every
// FYERS position read UNPROTECTED for a week. The fixture below is copied from
// an actual /debug/fyers dump; guessed shapes do not belong in this file.
const FYERS_GTT_LIVE = {
  code: 200, message: '', s: 'ok',
  orderBook: [{
    id: '26080600013343', symbol: 'NSE:GAIL-EQ', ord_status: 6, gtt_oco_ind: 2,
    price_trigger: 179.3, price2_trigger: 169.1, price_limit: 179.3, price2_limit: 168.3,
    qty: 2, qty2: 2, product_type: 'CNC', tran_side: -1, report_type: 'NEW',
    oms_msg: 'GTT/OCO order placed successfully.',
  }],
};

test('fyers listRows: unwraps orderBook (the live GTT list envelope)', () => {
  assert.deepEqual(fyers.listRows(FYERS_GTT_LIVE, 'orderBook', 'gttOrders', 'orders').map(r => r.id),
    ['26080600013343']);
});

test('fyers gttState: live OCO -> live, SL = the LOWER flat trigger, qty from that leg', () => {
  const st = fyers.gttState(FYERS_GTT_LIVE.orderBook[0]);
  assert.equal(st.status, 'live', 'ord_status 6 = pending = armed');
  assert.equal(st.triggerPrice, 169.1, 'the SL leg is price2_trigger here, not the 179.3 target');
  assert.equal(st.qty, 2);
});

test('fyers gttState: numeric ord_status terminals are terminal (not "unknown -> live")', () => {
  assert.equal(fyers.gttState({ ord_status: 1 }).status, 'gone');      // cancelled
  assert.equal(fyers.gttState({ ord_status: 2 }).status, 'fired');     // traded
  assert.equal(fyers.gttState({ ord_status: 5 }).status, 'rejected');
  assert.equal(fyers.gttState({ ord_status: 4 }).status, 'live');      // transit
  assert.equal(fyers.gttState({ ord_status: 99 }).status, 'live', 'unknown code -> live: a redundant re-arm beats a silent naked row');
});

test('fyers gttState: string statuses and nested legs still work (no regression)', () => {
  assert.equal(fyers.gttState({ status: 'CANCELLED', ord_status: 6 }).status, 'gone', 'an explicit string wins over the code');
  assert.equal(fyers.gttState({ status: 'TRIGGERED' }).status, 'fired');
  const nested = fyers.gttState({ orderInfo: { leg1: { triggerPrice: 230, qty: 3 }, leg2: { triggerPrice: 214, qty: 3 } } });
  assert.deepEqual(nested, { status: 'live', triggerPrice: 214, qty: 3 });
});

test('fyers listRows: unwraps gttOrders (kept as a fallback shape)', () => {
  const rows = fyers.listRows({ s: 'ok', gttOrders: [{ id: '1001' }, { id: '1002' }] }, 'orderBook', 'gttOrders', 'orders');
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

test('angel: OCO rule (the 2026-08-10 probe payload) -> live with the SL leg as triggerPrice', () => {
  const probeRow = { stoplossprice: 153.3, stoplosstriggerprice: 153.3, gttType: 'OCO', status: 'NEW',
    tradingsymbol: 'V2RETAIL-EQ', symboltoken: '14766', exchange: 'NSE', producttype: 'DELIVERY',
    transactiontype: 'SELL', price: 328.5, qty: 1, triggerprice: 328.5, id: 9388376 };
  const st = angel.gttState(probeRow);
  assert.equal(st.status, 'live');
  assert.equal(st.triggerPrice, 153.3, 'the stop the engine verifies is the SL leg, not the target leg');
  assert.equal(angel.gttState({ status: 'ACTIVE', triggerprice: '169.1', qty: '2' }).triggerPrice, 169.1, 'single-leg rules unchanged');
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

// ---- #16: snapshot sells carry enrichment fields; the engine tolerates them.
// The 7-day tradebook merge adds at/orderId/algoId per fill (attribution);
// reconstructClose must keep reading qty/px unchanged.
test('dhan: enriched sells (at/orderId/algoId) flow through reconstructClose untouched', () => {
  const { reconstructClose } = require('../engine');
  const closed = reconstructClose(
    { entryPrice: 100, qty: 2, targetPrice: 110, slPrice: 95 },
    [{ qty: 2, px: 104, at: 1723100000000, orderId: 'X1', algoId: 'F1' }]);
  assert.equal(closed.exitPrice, 104);
  assert.equal(closed.realisedPnl, 8);
  assert.equal(closed.exitEstimated, false);
});

// ── Zerodha audit gate 3: FULL snapshot normalization through the real
// assembly (not just gttState) — fixture payloads in, engine contract out.
test('zerodha getSnapshot: full-snapshot normalization fixture (gate 3)', (t) => {
  const FIX = {
    '/gtt/triggers': [
      // Kite's GET returns condition as an OBJECT (the JSON-string form is
      // what clients SEND); 222 pins the defensive string-parse for symbol.
      { id: 111, status: 'active', condition: { tradingsymbol: 'TATASTEEL', trigger_values: [95] }, orders: [{ quantity: 10 }] },
      { id: 222, status: 'triggered', condition: JSON.stringify({ tradingsymbol: 'INFY' }),
        orders: [{ result: { order_result: { order_id: 'X1', status: 'COMPLETE' }, average_price: 106 } }] },
    ],
    '/orders': [
      { order_id: 'E1', status: 'COMPLETE', transaction_type: 'BUY', tradingsymbol: 'TATASTEEL', average_price: 100.5, filled_quantity: 10 },
      { order_id: 'E2', status: 'REJECTED', transaction_type: 'BUY', tradingsymbol: 'GNA' },
      { order_id: 'E3', status: 'OPEN', transaction_type: 'BUY', tradingsymbol: 'SAIL' },
      { order_id: 'S1', status: 'COMPLETE', transaction_type: 'SELL', tradingsymbol: 'INFY', filled_quantity: 5, average_price: 106.2 },
    ],
    '/portfolio/holdings': [
      { tradingsymbol: 'TATASTEEL', quantity: 4, t1_quantity: 6, average_price: 100.5, last_price: 103 },
      { tradingsymbol: 'MTFSTOCK', quantity: 0, mtf: { quantity: 12 } },
    ],
    '/portfolio/positions': { net: [{ tradingsymbol: 'DAYPOS', quantity: 3 }, { tradingsymbol: 'TATASTEEL', quantity: -2 }] },
  };
  const orig = zerodha._fetch;
  zerodha._fetch = (creds, pathname, cb) => cb(null, FIX[pathname]);
  t.after(() => { zerodha._fetch = orig; });

  let snap = null;
  zerodha.getSnapshot({ apiKey: 'k', accessToken: 'a' }, (err, s2) => { assert.equal(err, null); snap = s2; });
  assert.ok(snap, 'fixture transport is synchronous');
  assert.equal(snap.complete, true, 'every fetch OK -> engine may act');

  // Protections carry symbol + trigger facts (condition arrives as a JSON STRING).
  assert.equal(snap.protections['111'].status, 'live');
  assert.equal(snap.protections['111'].symbol, 'TATASTEEL');
  assert.equal(snap.protections['111'].triggerPrice, 95);
  assert.equal(snap.protections['111'].qty, 10);
  // Fired-and-filled single-leg GTT: leg index 0 -> traded_sl, at the fill price.
  assert.equal(snap.protections['222'].status, 'traded_sl');
  assert.equal(snap.protections['222'].px, 106);
  assert.equal(snap.protections['222'].symbol, 'INFY');

  // Entries: filled / dead / pending, with fill facts only when filled.
  assert.deepEqual(snap.entries['E1'], { status: 'filled', fillPrice: 100.5, filledQty: 10 });
  assert.equal(snap.entries['E2'].status, 'dead');
  assert.equal(snap.entries['E3'].status, 'pending');

  // Sells: SELL COMPLETE rows only, by normalized symbol.
  assert.deepEqual(snap.sells['INFY'], [{ qty: 5, px: 106.2 }]);
  assert.equal(snap.sells['TATASTEEL'], undefined, 'BUY rows never become sells');

  // Held: holdings quantity + t1 (unsettled) + mtf bucket; positive positions
  // add; a NEGATIVE net position must never erase holdings (Math.max, not sum).
  assert.equal(snap.heldQty['TATASTEEL'], 10);
  assert.equal(snap.heldQty['MTFSTOCK'], 12, 'pure-MTF holding still counts as held');
  assert.equal(snap.heldQty['DAYPOS'], 3);
  assert.equal(snap.holdingsDetail['TATASTEEL'].avgPrice, 100.5);
});

test('zerodha getSnapshot: any read failing fails the snapshot (complete stays false)', (t) => {
  const orig = zerodha._fetch;
  zerodha._fetch = (creds, pathname, cb) => pathname === '/orders' ? cb('orders down', null) : cb(null, []);
  t.after(() => { zerodha._fetch = orig; });
  let got = 'unset';
  zerodha.getSnapshot({ apiKey: 'k', accessToken: 'a' }, (err, s2) => { got = { err, s2 }; });
  assert.match(String(got.err), /orders down/);
  assert.equal(got.s2, null, 'no partial snapshot ever escapes');
});

// ---- ADAPTER CONTRACT: sells is ALWAYS { SYM: [{qty, px}] } ----------------
// Angel One emitted { open, filled } instead, so the first engine pass after
// the 2026-08-12 cutover threw "sells.reduce is not a function" on EVERY cycle
// - no engine management for Angel positions, while engineOwns had already
// switched the legacy Angel passes off. Shape drift between adapters is
// invisible until the engine runs, so it gets pinned here.
test('every adapter declares the array sells shape the engine reads', () => {
  const engineSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'engine.js'), 'utf8');
  assert.match(engineSrc, /sells:\s*\{\s*\[SYMBOL\]:\s*\[\{\s*qty,\s*px\s*\}\]/,
    'engine.js documents sells as an array of fills');
  const angelSrc = require('fs').readFileSync(require('path').join(__dirname, 'angelone.js'), 'utf8');
  assert.ok(/out\.sells\[sym\] = out\.sells\[sym\] \|\| \[\]/.test(angelSrc),
    'angelone.js must build sells as an ARRAY, never { open, filled }');
  assert.ok(/openSells/.test(angelSrc),
    'open (unfilled) SELL qty belongs in its own map, not in sells');
});

test('the engine consumes an Angel-shaped snapshot without throwing', () => {
  const engine = require('../engine.js');
  const pos = { symbol: 'V2RETAIL', state: 'PROTECTED', qty: 2, entryPrice: 222.48, slPrice: 214.3,
    targetPrice: 230, protectionIds: { runner: 'ASL1' }, entryId: 'AE1',
    legs: [{ id: 'ASL1', role: 'single', qty: 2 }] };
  const snap = { complete: true, protections: { ASL1: { status: 'traded_sl', px: 222.23 } },
    entries: { AE1: { status: 'filled', fillPrice: 222.48, filledQty: 2 } }, heldQty: {},
    sells: { V2RETAIL: [{ qty: 2, px: 222.23 }] }, openSells: {} };
  const r = engine.transition(pos, snap, {});
  assert.equal(r.state, 'CLOSED');
  assert.equal(r.patch.exitPrice, 222.23);
});

// ---- openSells: EVERY adapter must report a working exit SELL (2026-08-19) --
// Found by the fake-broker harness: only Angel emitted openSells, so on Dhan,
// Zerodha and FYERS the engine could not see an exit in flight — it would
// re-arm a stop BESIDE a working sell (the HEALTHX double-exit class),
// EXIT_PENDING/CHASE_EXIT were unreachable, and sync reported false reds.
test('CONTRACT: every adapter declares an openSells map (engine reads snap.openSells)', () => {
  const fsx = require('fs'), px = require('path');
  ['dhan', 'zerodha', 'fyers', 'angelone', 'paper'].forEach(b => {
    const src = fsx.readFileSync(px.join(__dirname, b + '.js'), 'utf8');
    assert.ok(/openSells/.test(src), b + '.js must declare openSells');
  });
  const engineSrc = fsx.readFileSync(px.join(__dirname, '..', 'engine.js'), 'utf8');
  assert.match(engineSrc, /snap\.openSells/, 'the engine reads it');
});

test('zerodha getSnapshot: a WORKING sell lands in openSells (not sells); a filled one lands in sells', (t) => {
  const FIX = {
    '/gtt/triggers': [],
    '/orders': [
      { order_id: 'S1', status: 'COMPLETE', transaction_type: 'SELL', tradingsymbol: 'INFY', filled_quantity: 5, average_price: 106.2 },
      { order_id: 'S2', status: 'OPEN', transaction_type: 'SELL', tradingsymbol: 'TATASTEEL', quantity: 10, filled_quantity: 4 },
      { order_id: 'S3', status: 'TRIGGER PENDING', transaction_type: 'SELL', tradingsymbol: 'SAIL', quantity: 7, filled_quantity: 0 },
      { order_id: 'S4', status: 'CANCELLED', transaction_type: 'SELL', tradingsymbol: 'GNA', quantity: 3 },
      { order_id: 'B1', status: 'OPEN', transaction_type: 'BUY', tradingsymbol: 'WIPRO', quantity: 9 },
    ],
    '/portfolio/holdings': [], '/portfolio/positions': { net: [] },
  };
  const orig = zerodha._fetch;
  zerodha._fetch = (creds, pathname, cb) => cb(null, FIX[pathname]);
  t.after(() => { zerodha._fetch = orig; });
  let snap = null;
  zerodha.getSnapshot({ apiKey: 'k', accessToken: 'a' }, (e, s) => { assert.equal(e, null); snap = s; });
  assert.equal(snap.openSells.TATASTEEL, 6, 'remaining qty, not the ordered qty');
  assert.equal(snap.openSells.SAIL, 7);
  assert.equal(snap.openSells.INFY, undefined, 'a filled sell is not "working"');
  assert.equal(snap.openSells.GNA, undefined, 'cancelled is not working');
  assert.equal(snap.openSells.WIPRO, undefined, 'a BUY is not an exit');
  assert.equal(snap.sells.INFY[0].qty, 5, 'filled sells still flow to sells');
});

test('fyers getSnapshot: numeric status 4/6 sells land in openSells, status 2 in sells', (t) => {
  const FIX = {
    '/gtt/orders': { orderBook: [] },
    '/orders': { orderBook: [
      { id: 'S1', side: -1, status: 2, symbol: 'NSE:INFY-EQ', filledQty: 5, tradedPrice: 106.2, qty: 5 },
      { id: 'S2', side: -1, status: 6, symbol: 'NSE:TATASTEEL-EQ', qty: 10, filledQty: 4 },
      { id: 'S3', side: -1, status: 4, symbol: 'NSE:SAIL-EQ', qty: 7, filledQty: 0 },
      { id: 'S4', side: -1, status: 1, symbol: 'NSE:GNA-EQ', qty: 3 },
      { id: 'B1', side: 1, status: 6, symbol: 'NSE:WIPRO-EQ', qty: 9 },
    ] },
    '/holdings': { holdings: [] },
    '/positions': { netPositions: [] },
  };
  const orig = fyers._fetch;
  fyers._fetch = (creds, pathname, cb) => cb(null, FIX[pathname]);
  t.after(() => { fyers._fetch = orig; });
  let snap = null;
  fyers.getSnapshot({ clientId: 'c', accessToken: 'a' }, (e, s) => { snap = s; });
  assert.ok(snap, 'fixture transport is synchronous');
  assert.equal(snap.openSells.TATASTEEL, 6);
  assert.equal(snap.openSells.SAIL, 7);
  assert.equal(snap.openSells.INFY, undefined);
  assert.equal(snap.openSells.GNA, undefined);
  assert.equal(snap.openSells.WIPRO, undefined);
});
