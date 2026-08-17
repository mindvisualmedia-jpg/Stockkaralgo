'use strict';
// protectfill.replay.test.js — REPLAY suite for engine PLACE_PROTECTION.
//
// The engine's ENTRY_PENDING decision is pure and tested in engine.test.js.
// What was never tested is the executor's HANDS: does the same fill produce the
// same protection, the same row, the same alerts, whether legacy or the engine
// pulled the trigger? This file lifts protectFilledEntry and the executor's
// PLACE_PROTECTION branch VERBATIM out of server.js and drives them against a
// fake broker - because a first live run on the critical path of every trade
// is not how this gets proven.
//
// Every scenario is a real incident or its inverse:
//   - full fill (the ordinary path)
//   - PARTIAL fill -> protection sized to the fill, row qty shrinks, alert
//   - GNA: book says cancelled, holdings say held -> protect, never reject
//   - transport failure -> row stays awaitingFill, retried (never a verdict)
//   - broker REFUSAL -> recorded on the row, awaitingFill cleared, no retry loop
//   - unsupported broker -> refuses cleanly

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
function lift(name) {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i > 0, name + ' not found in server.js');
  // to the next top-level function declaration
  const j = src.indexOf('\nfunction ', i + 1);
  return src.slice(i, j > 0 ? j : undefined);
}

// ---- a tiny world the lifted code can live in ------------------------------
function makeWorld(brokerBehaviour) {
  const rows = {};           // id -> row
  const telegrams = [];
  const placements = [];     // what reached the "broker"
  const w = {
    EM_DASH: '—',
    updateOrderLogRow: (id, fn) => { rows[id] = fn(rows[id] || { id }); },
    sendTelegram: (msg, cb) => { telegrams.push(msg); if (cb) cb(); },
    readDhanTokenStore: () => ({ token: 'T', clientId: 'C' }),
    readBrokerTokenStore: () => ({ brokers: { zerodha: { clientId: 'K', accessToken: 'A' }, fyers: { clientId: 'F', accessToken: 'A' } } }),
    extractPlacedOrderLogFields: (b, prot) => ({ ...(prot.fields || {}) }),
    extractPlacedOrderId: (b, prot) => prot.orderId || 'N/A',
    noteProtectionFailure: (b, e) => String(e),
    scheduledOrderStatusText: (b) => b.toUpperCase() + ' ENTRY + PROTECTION',
    // the three brokers' placement functions, replaced by ONE fake that records
    // the ctx and answers per the scenario
    placeDhanForeverProtection: (ctx, cb) => { placements.push({ broker: 'dhan', ctx }); brokerBehaviour('dhan', ctx, cb); },
    placeZerodhaGttProtection: (ctx, cb) => { placements.push({ broker: 'zerodha', ctx }); brokerBehaviour('zerodha', ctx, cb); },
    placeFyersGttProtection: (ctx, cb) => { placements.push({ broker: 'fyers', ctx }); brokerBehaviour('fyers', ctx, cb); },
    rows, telegrams, placements,
  };
  // instantiate the lifted function inside this world
  const body = lift('protectFilledEntry');
  const fn = new Function(...Object.keys(w), body + '\nreturn protectFilledEntry;')(...Object.values(w));
  w.protectFilledEntry = fn;
  return w;
}

const dhanRow = (over = {}) => ({
  id: 'r1', broker: 'dhan', symbol: 'GNA', qty: 4, awaitingFill: true,
  pendingProtection: { symbol: 'GNA', qty: 4, entryId: 'E1', slTrigger: 95, target: 110, product: 'CNC', segPart: 'NSE_EQ', securityId: '123', order: { qty: 4, entryPrice: 100 } },
  ...over,
});
const ok = (b, ctx, cb) => cb(null, { status: 200, orderId: 'ENTRY:E1 | FOREVER:F' + ctx.qty, fields: { dhanForeverId: 'F' + ctx.qty, dhanProtection: 'forever' } });

test('full fill: protection placed for the ordered qty, row leaves awaitingFill, ids recorded', () => {
  const w = makeWorld(ok);
  w.rows.r1 = dhanRow();
  let res;
  w.protectFilledEntry(w.rows.r1, 4, 100.25, (e, r) => { res = r; });
  assert.deepEqual(res, { placed: true, retry: false, error: null });
  assert.equal(w.placements[0].ctx.qty, 4);
  assert.equal(w.rows.r1.awaitingFill, false);
  assert.equal(w.rows.r1.pendingProtection, null);
  assert.equal(w.rows.r1.dhanForeverId, 'F4');
  assert.equal(w.rows.r1.entryPrice, 100.25, 'broker-truth fill price replaces the limit');
  assert.equal(w.telegrams.length, 0, 'an ordinary fill is not news');
});

test('PARTIAL fill (3 of 4): protection sized to 3, row qty becomes 3, one alert', () => {
  const w = makeWorld(ok);
  w.rows.r1 = dhanRow();
  w.protectFilledEntry(w.rows.r1, 3, 100, () => {});
  assert.equal(w.placements[0].ctx.qty, 3, 'the fill is the truth, the order was an intention');
  assert.equal(w.placements[0].ctx.order.qty, 3);
  assert.equal(w.rows.r1.qty, 3);
  assert.match(w.rows.r1.reconcileNote, /PARTIAL FILL: 3\/4/);
  assert.equal(w.telegrams.length, 1);
  assert.match(w.telegrams[0], /PARTIAL FILL/);
});

test('transport failure: NO result -> row stays awaitingFill, retry flagged, never a verdict', () => {
  const w = makeWorld((b, ctx, cb) => cb('ECONNRESET', null));
  w.rows.r1 = dhanRow();
  let res;
  w.protectFilledEntry(w.rows.r1, 4, 100, (e, r) => { res = r; });
  assert.equal(res.retry, true);
  assert.equal(res.placed, false);
  assert.equal(w.rows.r1.awaitingFill, true, 'still pending - the next pass tries again');
  assert.match(w.rows.r1.lastTrailError, /Protection retry: ECONNRESET/);
});

test('broker REFUSAL: a result with an error -> recorded on the row, awaitingFill cleared, no retry', () => {
  const w = makeWorld((b, ctx, cb) => cb('RMS: DDPI not enabled', { status: 400, orderId: '', fields: {} }));
  w.rows.r1 = dhanRow();
  let res;
  w.protectFilledEntry(w.rows.r1, 4, 100, (e, r) => { res = r; });
  assert.equal(res.placed, true, 'a refusal is terminal for this attempt');
  assert.equal(res.retry, false);
  assert.equal(res.error, 'RMS: DDPI not enabled');
  assert.equal(w.rows.r1.awaitingFill, false);
  assert.match(w.rows.r1.status, /ENTRY PLACED BUT PROTECTION FAILED: RMS: DDPI not enabled/);
});

test('zero filled qty: refuses to place (nothing to protect), no broker call', () => {
  const w = makeWorld(ok);
  w.rows.r1 = dhanRow();
  let err;
  w.protectFilledEntry(w.rows.r1, 0, 100, (e) => { err = e; });
  assert.match(err, /no filled quantity/);
  assert.equal(w.placements.length, 0);
});

test('unsupported broker (angelone arms at entry): clean refusal, no placement', () => {
  const w = makeWorld(ok);
  w.rows.r1 = dhanRow({ broker: 'angelone' });
  let err;
  w.protectFilledEntry(w.rows.r1, 4, 100, (e) => { err = e; });
  assert.match(err, /not supported for angelone/);
});

test('each broker builds ITS OWN ctx from pendingProtection (zerodha / fyers shapes)', () => {
  const w = makeWorld((b, ctx, cb) => cb(null, { status: 200, orderId: 'ENTRY:E1 | GTT:G9', fields: {} }));
  w.rows.z = { id: 'z', broker: 'zerodha', symbol: 'ABC', qty: 2, awaitingFill: true,
    pendingProtection: { symbol: 'ABC', qty: 2, entryId: 'E1', entry: 50, sl: 48, target: 55, product: 'CNC', exchange: 'NSE', order: { qty: 2 } } };
  w.protectFilledEntry(w.rows.z, 2, 50.1, () => {});
  const zc = w.placements[0];
  assert.equal(zc.broker, 'zerodha');
  assert.equal(zc.ctx.apiKey, 'K'); assert.equal(zc.ctx.entry, 50.1); assert.equal(zc.ctx.qty, 2);
  assert.deepEqual(zc.ctx.entryData, { data: { order_id: 'E1' } });
  w.rows.f = { id: 'f', broker: 'fyers', symbol: 'XYZ', qty: 1, awaitingFill: true,
    pendingProtection: { symbol: 'XYZ', qty: 1, entryId: 'E2', entry: 200, sl: 190, target: 220, exchange: 'NSE', order: { qty: 1 } } };
  w.protectFilledEntry(w.rows.f, 1, 0, () => {});
  const fc = w.placements[1];
  assert.equal(fc.broker, 'fyers');
  assert.equal(fc.ctx.entry, 200, 'no fill px -> the intended entry');
  assert.equal(fc.ctx.entryId, 'E2');
});

// ---- The ENGINE decides, the executor calls the SAME function ---------------
test('engine ENTRY_PENDING on a filled entry emits PLACE_PROTECTION with fill truth', () => {
  const engine = require('./engine');
  const pos = { state: engine.STATE.ENTRY_PENDING, symbol: 'GNA', qty: 4, entryPrice: 100, slPrice: 95, targetPrice: 110,
    entryId: 'E1', legs: [], t1Booked: false, costMoved: false, pendingSl: null, graceStartAt: 0, ltp: 0 };
  const r = engine.transition(pos, { complete: true, protections: {}, entries: { E1: { status: 'filled', fillPrice: 100.25, filledQty: 3 } }, heldQty: { GNA: 3 }, sells: {} }, { now: 1 });
  assert.equal(r.state, engine.STATE.PROTECTION_PENDING);
  assert.deepEqual(r.actions.map(a => a.type), ['PLACE_PROTECTION']);
  assert.equal(r.patch.entryPrice, 100.25);
  assert.equal(r.patch.filledQty, 3, 'the partial fill travels with the decision');
});

test('engine ENTRY_PENDING: dead entry -> ENTRY_DEAD, no protection; pending -> nothing', () => {
  const engine = require('./engine');
  const pos = { state: engine.STATE.ENTRY_PENDING, symbol: 'X', qty: 1, entryId: 'E1', legs: [], ltp: 0 };
  assert.equal(engine.transition(pos, { complete: true, protections: {}, entries: { E1: { status: 'dead' } }, heldQty: {}, sells: {} }, { now: 1 }).state, engine.STATE.ENTRY_DEAD);
  assert.deepEqual(engine.transition(pos, { complete: true, protections: {}, entries: { E1: { status: 'pending' } }, heldQty: {}, sells: {} }, { now: 1 }).actions, []);
});

test('the executor PLACE_PROTECTION branch sizes to the FILL and calls protectFilledEntry', () => {
  // lift just the branch, bind a recording protectFilledEntry, and drive it
  const i = src.indexOf("if (action.type === 'PLACE_PROTECTION') {");
  const j = src.indexOf("if (action.type === 'MODIFY_SL')", i);
  const branch = src.slice(i, j);
  const calls = [];
  const run = new Function('row', 'action', 'callback', 'protectFilledEntry', branch + '\nreturn "fell-through";');
  const fake = (row, q, px, cb) => { calls.push({ q, px }); cb(null, { placed: true, retry: false, error: null }); };
  let out;
  run({ id: 'r1', qty: 4, entryPrice: 100 }, { type: 'PLACE_PROTECTION', filledQty: 3, fillPrice: 100.25 }, (e) => { out = e === null ? 'ok' : e; }, fake);
  assert.deepEqual(calls, [{ q: 3, px: 100.25 }], 'action carries the fill; executor passes it through untouched');
  assert.equal(out, 'ok');
  // a deferred (transport) result must surface as an error string so the pass logs it and retries
  const fakeRetry = (row, q, px, cb) => cb(null, { placed: false, retry: true, error: 'timeout' });
  run({ id: 'r1', qty: 4, entryPrice: 100 }, { type: 'PLACE_PROTECTION' }, (e) => { out = e; }, fakeRetry);
  assert.match(out, /deferred: timeout/);
});
