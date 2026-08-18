'use strict';
// brokers/fyers.js — FYERS adapter for the position engine. Same contract as
// brokers/dhan.js / brokers/zerodha.js: getSnapshot(creds, cb) -> one read-only
// sweep of broker truth normalized to the engine snapshot shape. Self-contained.
//
// FYERS quirks this adapter normalizes:
//   - GTT OCO legs are placed leg1 = TARGET, leg2 = SL (single-leg GTT = SL only,
//     used in EMA-trailing mode). Leg ORDER in the list is not broker-guaranteed,
//     so the SL trigger is taken as the LOWER of the two triggers (a long's stop
//     is always below its target) — robust to any ordering.
//   - a fired GTT shows status complete/triggered but the list does NOT say which
//     leg filled or at what price -> mapped to { status: 'fired' } (terminal, not
//     live, asserts neither target nor SL). The engine must close only on E1 SELL
//     fills; for splits its "legA terminal + legB live => T1 booked" rule still
//     works because a stop hit kills BOTH legs (same trigger), never just legA.
//   - order-book `status` is NUMERIC: 1=cancelled, 2=traded, 4=transit,
//     5=rejected, 6=pending; side 1=BUY, -1=SELL.
//   - the order book is TODAY-only (cross-day exits invisible) — same trap as
//     Dhan #1/SAMHI. heldQty (holdings ∪ net positions) is the cross-day truth.
//   - responses wrap payloads under s:'ok' with varying keys (orderBook,
//     holdings, netPositions, data) -> unwrapped defensively.
//
// GTT LIST SHAPE — PROVEN LIVE 2026-08-13 via /debug/fyers, after every
// FYERS position spent the day labelled UNPROTECTED beside healthy broker OCOs:
//   { code, message, s, orderBook: [ { id, symbol, ord_status, gtt_oco_ind,
//     price_trigger, price2_trigger, qty, qty2, oms_msg, ... } ] }
// Three things here contradicted what this adapter (and server.js) assumed:
//   1. the list is under `orderBook`, NOT `gttOrders`/`orders`/`data` — so every
//      read returned [] and every GTT was invisible. This is the unexplained
//      "empty parse" behind the 2026-08-06 stacking incident: #31 guessed
//      `gttOrders` from the docs and the guess was never checked against a
//      real payload, so the incident's true cause survived its own fix.
//   2. state is NUMERIC `ord_status` (the same OMS codes the order book uses),
//      not a status string. Reading only strings meant EVERY GTT fell through
//      to the "unknown -> live" default: correct by accident while the list
//      parsed empty, but a silent naked position the moment it parsed.
//   3. OCO legs are FLAT (price_trigger/price2_trigger, qty/qty2), not
//      orderInfo.leg1/leg2 — so trigger price and qty read 0.
// Only ord_status 6 (pending, i.e. armed) is directly proven by that payload;
// 1/2/4/5 are carried over from the documented order-book codes this OMS
// shares. Unknown codes still fall back to `live`, so a code we have never
// seen can only cost a redundant re-arm, never a silently unprotected row.

const https = require('https');
const { endpointFor, transportFor } = require('./endpoint');   // locked test seam - production byte-identical
const API_EP = endpointFor('FYERS', 'api-t1.fyers.in');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function normSym(s) {
  return String(s || '').replace(/^(NSE|BSE):/i, '').replace('-EQ', '').replace(/\s/g, '').toUpperCase();
}

function fyersGetJson(creds, pathname, cb) {
  const req = transportFor(API_EP).request({
    hostname: API_EP.hostname, port: API_EP.port, path: '/api/v3' + pathname, method: 'GET',
    headers: { Authorization: creds.clientId + ':' + creds.accessToken, 'Content-Type': 'application/json', version: '3' },
  }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      let p; try { p = JSON.parse(d); } catch { p = null; }
      if (res.statusCode >= 400) return cb('HTTP ' + res.statusCode + ' ' + pathname + (p?.message ? ' ' + p.message : ''), null);
      if (p && p.s && p.s !== 'ok') return cb(pathname + ' s=' + p.s + (p.message ? ' ' + p.message : ''), null);
      cb(null, p);
    });
  });
  req.on('error', e => cb(e.message, null));
  req.setTimeout(15000, () => req.destroy(new Error('timeout ' + pathname)));
  req.end();
}

// Unwrap a FYERS list payload across its shape variants.
function rows(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  for (const k of keys) if (Array.isArray(payload?.[k])) return payload[k];
  return Array.isArray(payload?.data) ? payload.data : [];
}

// Numeric ord_status — the live GTT list carries this, not a status string.
const GTT_ORD_STATUS = { 1: 'gone', 2: 'fired', 4: 'live', 5: 'rejected', 6: 'live' };

// Normalize one GTT order into an engine protection state.
function gttState(g) {
  const status = String(g?.status || g?.orderStatus || '').toLowerCase();
  if (/reject/.test(status)) return { status: 'rejected' };
  if (/(cancel|expire)/.test(status)) return { status: 'gone' };
  if (/(complete|triggered)/.test(status)) return { status: 'fired' }; // fired; leg/px unknown from list (see header)
  // No status STRING? then the live shape applies: numeric ord_status. Only a
  // recognised terminal code is terminal; unknown stays live (see header).
  if (!status) {
    const code = g?.ord_status !== undefined && g?.ord_status !== null && g?.ord_status !== ''
      ? g.ord_status : g?.ordStatus;
    const mapped = code === undefined || code === null || code === '' ? '' : GTT_ORD_STATUS[num(code)];
    if (mapped && mapped !== 'live') return { status: mapped };
  }
  // pending/active/anything non-terminal -> live. SL trigger = lower leg trigger
  // (leg order in the list is not guaranteed; a long's SL is always the lower).
  // Two leg shapes: nested orderInfo.leg1/leg2, and the FLAT live OCO shape.
  const info = g?.orderInfo || g || {};
  const nested = [info.leg1, info.leg2].filter(Boolean);
  const pairs = nested.length
    ? nested.map(l => ({ t: num(l.triggerPrice || l.trigger_price), q: num(l.qty || l.quantity) }))
    : [{ t: num(g?.price_trigger), q: num(g?.qty) }, { t: num(g?.price2_trigger), q: num(g?.qty2) }];
  const armed = pairs.filter(p => p.t > 0);
  if (!armed.length) return { status: 'live', triggerPrice: 0, qty: num(g?.qty) };
  const sl = armed.reduce((lo, p) => (p.t < lo.t ? p : lo));
  return { status: 'live', triggerPrice: sl.t, qty: sl.q || num(g?.qty) };
}

// Numeric order-book status -> engine entry state.
function orderState(o) {
  const st = num(o?.status);
  if (st === 2) return { status: 'filled', fillPrice: num(o.tradedPrice || o.avgPrice || o.limitPrice), filledQty: num(o.filledQty || o.tradedQty || o.qty) };
  if (st === 1 || st === 5) return { status: 'dead' };
  return { status: 'pending' }; // 4=transit, 6=pending, unknown -> not final
}

function getSnapshot(creds, cb) {
  if (!creds?.clientId || !creds?.accessToken) return cb('No FYERS token', null);
  const out = { complete: false, protections: {}, entries: {}, heldQty: {}, sells: {}, openSells: {} };

  module.exports._fetch(creds, '/gtt/orders', (gErr, gttPayload) => {
    if (gErr) return cb('gtt: ' + gErr, null);
    rows(gttPayload, 'orderBook', 'gttOrders', 'orders').forEach(g => {
      const id = String(g.id || g.gttId || g.orderId || '').trim();
      if (id) out.protections[id] = { ...gttState(g), symbol: normSym(g.symbol) };
    });

    module.exports._fetch(creds, '/orders', (oErr, obPayload) => {
      if (oErr) return cb('orders: ' + oErr, null);
      rows(obPayload, 'orderBook').forEach(o => {
        const id = String(o.id || o.orderId || '').trim();
        if (id) { out.entries[id] = orderState(o); if (o.orderTag) out.entries[id].tag = String(o.orderTag); }   // ORDER TAG (2026-08-19)
        if (num(o.side) === -1 && num(o.status) === 2) {
          const sym = normSym(o.symbol);
          const qty = num(o.filledQty || o.tradedQty || o.qty);
          const px = num(o.tradedPrice || o.avgPrice || o.limitPrice);
          const fill = { qty, px, orderId: id };
          if (o.orderTag) fill.tag = String(o.orderTag);
          if (sym && qty > 0 && px > 0) (out.sells[sym] = out.sells[sym] || []).push(fill);
        }
        // OPEN SELLS (2026-08-19, found by the fake-broker harness): an exit
        // SELL still WORKING at the broker. Without it the engine cannot see an
        // exit in flight - it re-arms a stop beside a working sell (HEALTHX),
        // EXIT_PENDING/CHASE_EXIT are unreachable, and sync reports false reds.
        // FYERS numeric status: 4 = transit, 6 = pending (both still working).
        if (num(o.side) === -1 && (num(o.status) === 4 || num(o.status) === 6)) {
          const sym = normSym(o.symbol);
          const remaining = Math.max(0, num(o.qty) - num(o.filledQty || o.tradedQty));
          if (sym) out.openSells[sym] = num(out.openSells[sym]) + (remaining > 0 ? remaining : num(o.qty));
        }
      });

      module.exports._fetch(creds, '/holdings', (hErr, hPayload) => {
        if (hErr) return cb('holdings: ' + hErr, null);
        module.exports._fetch(creds, '/positions', (pErr, pPayload) => {
          if (pErr) return cb('positions: ' + pErr, null);
          const add = (sym, qty) => { const s = normSym(sym); const q = num(qty); if (s && q > 0) out.heldQty[s] = Math.max(out.heldQty[s] || 0, q); };
          out.holdingsDetail = out.holdingsDetail || {};
          rows(hPayload, 'holdings').forEach(h => {
            const q = Math.max(num(h.quantity), num(h.remainingQuantity)); // fresh CNC buys can sit in remainingQuantity pre-settlement
            add(h.symbol, q);
            const s = normSym(h.symbol);
            if (s) out.holdingsDetail[s] = { qty: q, avgPrice: num(h.costPrice ?? h.avgPrice), ltp: num(h.ltp) };
          });
          rows(pPayload, 'netPositions', 'positions').forEach(p => add(p.symbol, p.netQty || p.qty));
          out.complete = true;
          cb(null, out);
        });
      });
    });
  });
}

// Liveness ping: one authenticated call (see brokers/dhan.js ping).
function ping(creds, cb) {
  if (!creds?.clientId || !creds?.accessToken) return cb('No FYERS token');
  module.exports._fetch(creds, '/gtt/orders', (err) => cb(err || null));
}

// _fetch is the TEST SEAM (same pattern as zerodha): brokers.test.js swaps it
// for a fixture transport so a live payload becomes a regression test.
module.exports = { ping, getSnapshot, gttState, orderState, normSym, listRows: rows, _fetch: fyersGetJson };
