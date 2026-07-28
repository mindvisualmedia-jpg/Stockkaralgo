'use strict';
// Exit-fill aggregation (Dhan close detection).
//
// Verbatim copy of the pushTrade/pushOrder logic from server.js
// (closeCompletedDhanForevers). If it drifts from server.js, update both.
//
// THE INCIDENT (MWL, 2026-07-28): one SELL ORDER fills in MANY TRADES.
// /v2/trades returns each TRADE, and the old code deduped by the ORDER's id —
// so a 10-share order that filled 1+9 counted as 1. The row read sold=12/21,
// covering=false, and a position that was FULLY exited at the broker could
// never be detected closed: it held a Max-Open slot, blocked re-entry, and kept
// getting a fresh stop re-armed onto nothing.

const { test } = require('node:test');
const assert = require('node:assert');

function makeCollector() {
  const sellByOrder = new Map();
  const looseSells = [];
  const looseSeen = new Set();
  const pushLoose = (rec) => {
    const k = rec.sym + '|' + rec.q + '|' + rec.px + '|' + rec.at;
    if (looseSeen.has(k)) return; looseSeen.add(k);
    looseSells.push(rec);
  };
  const pushTrade = (rec) => {
    if (!rec.sym || !(rec.q > 0) || !(rec.px > 0)) return;
    if (!rec.orderId) return pushLoose(rec);
    const cur = sellByOrder.get(rec.orderId);
    if (!cur || cur.src !== 'trade') { sellByOrder.set(rec.orderId, { ...rec, src: 'trade' }); return; }
    const q = cur.q + rec.q;
    cur.px = ((cur.px * cur.q) + (rec.px * rec.q)) / q;
    cur.q = q;
    cur.at = Math.max(cur.at || 0, rec.at || 0);
    cur.algoId = cur.algoId || rec.algoId;
  };
  const pushOrder = (rec) => {
    if (!rec.sym || !(rec.q > 0) || !(rec.px > 0)) return;
    if (!rec.orderId) return pushLoose(rec);
    const cur = sellByOrder.get(rec.orderId);
    if (!cur) { sellByOrder.set(rec.orderId, { ...rec, src: 'order' }); return; }
    if (rec.q > cur.q) sellByOrder.set(rec.orderId, { ...rec, algoId: cur.algoId || rec.algoId, src: 'order' });
  };
  return { pushTrade, pushOrder, all: () => [...sellByOrder.values(), ...looseSells] };
}
const sold = (c) => c.all().reduce((a, s) => a + s.q, 0);
const T = (orderId, q, px, extra = {}) => ({ orderId, algoId: '', sym: 'MWL', q, px, at: 1, ...extra });

test('THE MWL BUG: a 10-share order filling 1+9 counts as 10, not 1', () => {
  const c = makeCollector();
  c.pushTrade(T('ORD-A', 1, 35.7));
  c.pushTrade(T('ORD-A', 9, 35.7));
  assert.equal(sold(c), 10);
});

test('THE MWL ROW: 10 (as 1+9) + 11 covers the full 21 qty', () => {
  const c = makeCollector();
  c.pushTrade(T('ORD-A', 1, 35.7));
  c.pushTrade(T('ORD-A', 9, 35.7));
  c.pushTrade(T('ORD-B', 11, 35.7));
  const total = sold(c);
  assert.equal(total, 21);
  assert.ok(total >= 21 * 0.99, 'covering must now be TRUE (was 12/21 -> KEEP-OPEN forever)');
});

test('the same fill in BOTH books is not double counted', () => {
  const c = makeCollector();
  c.pushTrade(T('ORD-A', 1, 35.7));
  c.pushTrade(T('ORD-A', 9, 35.7));
  c.pushOrder(T('ORD-A', 10, 35.7));   // order book aggregate for the same order
  assert.equal(sold(c), 10, 'aggregate must not add on top of its own trades');
});

test('a truncated tradebook never makes us UNDER-count (aggregate wins when larger)', () => {
  const c = makeCollector();
  c.pushTrade(T('ORD-A', 1, 35.7));    // only the first trade came back
  c.pushOrder(T('ORD-A', 10, 35.7));   // but the order says 10 filled
  assert.equal(sold(c), 10);
});

test('a smaller/stale aggregate never shrinks the summed trades', () => {
  const c = makeCollector();
  c.pushTrade(T('ORD-A', 6, 35.7));
  c.pushTrade(T('ORD-A', 4, 35.7));
  c.pushOrder(T('ORD-A', 6, 35.7));    // stale snapshot
  assert.equal(sold(c), 10);
});

test('price is the WEIGHTED average across an order\'s trades', () => {
  const c = makeCollector();
  c.pushTrade(T('ORD-A', 1, 30));
  c.pushTrade(T('ORD-A', 9, 40));
  const rec = c.all()[0];
  assert.equal(rec.q, 10);
  assert.equal(Math.round(rec.px * 100) / 100, 39);   // (30*1 + 40*9)/10
});

test('separate orders stay separate', () => {
  const c = makeCollector();
  c.pushTrade(T('ORD-A', 10, 35.7));
  c.pushTrade(T('ORD-B', 11, 35.7));
  assert.equal(c.all().length, 2);
  assert.equal(sold(c), 21);
});

test('algoId (the Forever leg that placed the exit) survives the merge', () => {
  const c = makeCollector();
  c.pushTrade(T('ORD-A', 1, 35.7, { algoId: 'LEG-1' }));
  c.pushTrade(T('ORD-A', 9, 35.7));
  assert.equal(c.all()[0].algoId, 'LEG-1');
});

test('fills with no order id still dedupe on their own shape', () => {
  const c = makeCollector();
  c.pushTrade({ orderId: '', algoId: '', sym: 'MWL', q: 5, px: 35.7, at: 1 });
  c.pushTrade({ orderId: '', algoId: '', sym: 'MWL', q: 5, px: 35.7, at: 1 });   // same record twice
  assert.equal(sold(c), 5);
});

test('zero/!priced records are ignored (no phantom exits)', () => {
  const c = makeCollector();
  c.pushTrade(T('ORD-A', 0, 35.7));
  c.pushTrade(T('ORD-B', 10, 0));
  assert.equal(sold(c), 0);
});
