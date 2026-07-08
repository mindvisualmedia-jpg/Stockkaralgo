'use strict';
// brokers/dhan.js — Dhan adapter for the position engine. Self-contained (own
// HTTPS, credentials passed in), so it is testable without server.js and reusable
// by the shadow reconciler today and the live reconciler after cutover.
//
// getSnapshot(creds, cb) -> ONE sweep of broker truth, normalized to the engine
// snapshot shape. `complete` is true ONLY if every fetch succeeded — the engine
// treats an incomplete snapshot as "no evidence" and does nothing (fail-safe).
//
// Dhan quirks this adapter normalizes (the source of past incidents):
//   - a COMPLETED Forever DROPS from /v2/forever/all -> absent id = 'gone'
//   - a Forever POST returns 200+id but RMS may reject it async (T2T) -> a
//     REJECTED/CANCELLED row in the list = 'rejected'; silently vanished = 'gone'
//   - holdings lag T+1 for CNC, so heldQty = holdings ∪ net positions

const https = require('https');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function normSym(s) { return String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase(); }

function getJson(token, pathname, cb) {
  const req = https.request({
    hostname: 'api.dhan.co', port: 443, path: pathname, method: 'GET',
    headers: { 'access-token': token, 'Content-Type': 'application/json' },
  }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      let p; try { p = JSON.parse(d); } catch { p = null; }
      if (res.statusCode === 404) return cb(null, []); // empty resource, not an error
      if (res.statusCode >= 400) return cb('HTTP ' + res.statusCode + ' ' + pathname, null);
      cb(null, Array.isArray(p) ? p : (Array.isArray(p?.data) ? p.data : []));
    });
  });
  req.on('error', e => cb(e.message, null));
  req.setTimeout(15000, () => req.destroy(new Error('timeout ' + pathname)));
  req.end();
}

// Normalize one Forever order (possibly multi-leg rows sharing an orderId) into
// an engine protection state.
function foreverState(rows) {
  const statusOf = o => String(o.orderStatus || o.status || '').toUpperCase();
  const traded = rows.find(o => statusOf(o) === 'TRADED');
  if (traded) {
    const isTarget = String(traded.legName || '').toUpperCase().includes('TARGET');
    return { status: isTarget ? 'traded_target' : 'traded_sl', px: num(traded.price || traded.triggerPrice) };
  }
  if (rows.some(o => /REJECT|CANCEL|EXPIRE/.test(statusOf(o)))) return { status: 'rejected' };
  // live: report the SL leg's trigger (verify modifies) and qty (integrity checks)
  const slLeg = rows.find(o => String(o.legName || '').toUpperCase().includes('STOP')) || rows[0];
  return { status: 'live', triggerPrice: num(slLeg?.triggerPrice), qty: num(slLeg?.quantity) };
}

// Live finding #5 (2026-07-06): /v2/forever/all returned nothing on an account
// with ACTIVE Forevers. Try it, fall back to /v2/forever/orders, pin the path
// that returns items; believe "empty" only when both readable paths agree.
let _foreverPath = null;
function fetchForeverList(token, cb) {
  const order = [...new Set(_foreverPath ? [_foreverPath, '/v2/forever/all', '/v2/forever/orders'] : ['/v2/forever/all', '/v2/forever/orders'])];
  const attempt = (i, sawEmpty) => {
    if (i >= order.length) return sawEmpty ? cb(null, []) : cb('forever list unreadable', null);
    getJson(token, order[i], (err, list) => {
      if (err) return attempt(i + 1, sawEmpty);
      if (Array.isArray(list) && list.length) { _foreverPath = order[i]; return cb(null, list); }
      return attempt(i + 1, true);
    });
  };
  attempt(0, false);
}

function getSnapshot(creds, cb) {
  const token = creds && creds.token;
  if (!token) return cb('No Dhan token', null);
  const out = { complete: false, protections: {}, entries: {}, heldQty: {}, sells: {} };

  fetchForeverList(token, (fErr, forevers) => {
    if (fErr) return cb('forever: ' + fErr, null);
    const byId = {};
    (forevers || []).forEach(o => {
      const id = String(o.orderId || o.orderid || '').trim();
      if (id) (byId[id] = byId[id] || []).push(o);
    });
    Object.keys(byId).forEach(id => { out.protections[id] = foreverState(byId[id]); });

    getJson(token, '/v2/orders', (oErr, orders) => {
      if (oErr) return cb('orders: ' + oErr, null);
      (orders || []).forEach(o => {
        const id = String(o.orderId || o.orderid || '').trim();
        const st = String(o.orderStatus || o.status || '').toUpperCase();
        const side = String(o.transactionType || o.transaction_type || '').toUpperCase();
        if (id) {
          out.entries[id] = /TRADED|EXECUTED|COMPLETE/.test(st)
            ? { status: 'filled', fillPrice: num(o.averageTradedPrice || o.avgPrice || o.tradedPrice || o.price), filledQty: num(o.filledQty || o.filled_qty || o.tradedQty || o.quantity) }
            : /REJECT|CANCEL|EXPIRE/.test(st) ? { status: 'dead' } : { status: 'pending' };
        }
        if (side === 'SELL' && /TRADED|EXECUTED|COMPLETE/.test(st)) {
          const sym = normSym(o.tradingSymbol || o.symbol || o.customSymbol);
          const qty = num(o.filledQty || o.filled_qty || o.tradedQty || o.quantity);
          const px = num(o.averageTradedPrice || o.avgPrice || o.tradedPrice || o.price);
          if (sym && qty > 0 && px > 0) (out.sells[sym] = out.sells[sym] || []).push({ qty, px });
        }
      });

      getJson(token, '/v2/holdings', (hErr, holdings) => {
        if (hErr) return cb('holdings: ' + hErr, null);
        getJson(token, '/v2/positions', (pErr, positions) => {
          if (pErr) return cb('positions: ' + pErr, null);
          const add = (sym, qty) => { const s = normSym(sym); const q = num(qty); if (s && q > 0) out.heldQty[s] = Math.max(out.heldQty[s] || 0, q); };
          // Consider EVERY quantity bucket (totalQty, dpQty settled, t1Qty unsettled
          // CNC, availableQty): a freshly-bought holding must never read "not held" —
          // the engine treats not-held as closure evidence.
          (holdings || []).forEach(h => add(h.tradingSymbol || h.symbol,
            Math.max(num(h.totalQty), num(h.dpQty) + num(h.t1Qty), num(h.availableQty), num(h.quantity))));
          (positions || []).forEach(p => add(p.tradingSymbol || p.symbol, p.netQty ?? p.netQuantity ?? 0));
          out.complete = true; // every fetch OK -> the engine may act on this
          cb(null, out);
        });
      });
    });
  });
}

module.exports = { getSnapshot, foreverState, normSym };
