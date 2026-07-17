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
// Status strings for GTTs are NOT publicly documented in full; the mapping below
// mirrors what the legacy restore pass already treats as non-protecting
// (cancel|reject|expire|complete|triggered). Before any FYERS cutover, validate
// against real payloads via /debug/fyers + shadow logs (debug-with-data rule).

const https = require('https');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function normSym(s) {
  return String(s || '').replace(/^(NSE|BSE):/i, '').replace('-EQ', '').replace(/\s/g, '').toUpperCase();
}

function fyersGetJson(creds, pathname, cb) {
  const req = https.request({
    hostname: 'api-t1.fyers.in', port: 443, path: '/api/v3' + pathname, method: 'GET',
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

// Normalize one GTT order into an engine protection state.
function gttState(g) {
  const status = String(g?.status || g?.orderStatus || '').toLowerCase();
  if (/reject/.test(status)) return { status: 'rejected' };
  if (/(cancel|expire)/.test(status)) return { status: 'gone' };
  if (/(complete|triggered)/.test(status)) return { status: 'fired' }; // fired; leg/px unknown from list (see header)
  // pending/active/anything non-terminal -> live. SL trigger = lower leg trigger
  // (leg order in the list is not guaranteed; a long's SL is always the lower).
  const info = g?.orderInfo || g || {};
  const legs = [info.leg1, info.leg2].filter(Boolean);
  const trigs = legs.map(l => num(l.triggerPrice || l.trigger_price)).filter(t => t > 0);
  const slTrig = trigs.length ? Math.min(...trigs) : 0;
  const slLeg = legs.find(l => num(l.triggerPrice || l.trigger_price) === slTrig) || legs[0] || {};
  return { status: 'live', triggerPrice: slTrig, qty: num(slLeg.qty || slLeg.quantity) };
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
  const out = { complete: false, protections: {}, entries: {}, heldQty: {}, sells: {} };

  fyersGetJson(creds, '/gtt/orders', (gErr, gttPayload) => {
    if (gErr) return cb('gtt: ' + gErr, null);
    rows(gttPayload, 'gttOrders', 'orders').forEach(g => {
      const id = String(g.id || g.gttId || g.orderId || '').trim();
      if (id) out.protections[id] = gttState(g);
    });

    fyersGetJson(creds, '/orders', (oErr, obPayload) => {
      if (oErr) return cb('orders: ' + oErr, null);
      rows(obPayload, 'orderBook').forEach(o => {
        const id = String(o.id || o.orderId || '').trim();
        if (id) out.entries[id] = orderState(o);
        if (num(o.side) === -1 && num(o.status) === 2) {
          const sym = normSym(o.symbol);
          const qty = num(o.filledQty || o.tradedQty || o.qty);
          const px = num(o.tradedPrice || o.avgPrice || o.limitPrice);
          if (sym && qty > 0 && px > 0) (out.sells[sym] = out.sells[sym] || []).push({ qty, px });
        }
      });

      fyersGetJson(creds, '/holdings', (hErr, hPayload) => {
        if (hErr) return cb('holdings: ' + hErr, null);
        fyersGetJson(creds, '/positions', (pErr, pPayload) => {
          if (pErr) return cb('positions: ' + pErr, null);
          const add = (sym, qty) => { const s = normSym(sym); const q = num(qty); if (s && q > 0) out.heldQty[s] = Math.max(out.heldQty[s] || 0, q); };
          rows(hPayload, 'holdings').forEach(h =>
            add(h.symbol, Math.max(num(h.quantity), num(h.remainingQuantity)))); // fresh CNC buys can sit in remainingQuantity pre-settlement
          rows(pPayload, 'netPositions', 'positions').forEach(p => add(p.symbol, p.netQty || p.qty));
          out.complete = true;
          cb(null, out);
        });
      });
    });
  });
}

module.exports = { getSnapshot, gttState, orderState, normSym };
