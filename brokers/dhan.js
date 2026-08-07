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
  // TRADED and TRIGGERED both mean "the trigger FIRED and Dhan sent the exit
  // order" - NEITHER proves the exit FILLED (TATASTEEL 2026-08-04: leg TRADED
  // @192, no sell ever executed, shares naked for 3 days behind a closed row).
  // Both map to the traded_* CLAIM states; the engine closes only on covering
  // SELL fills or not-held, so a claim without a fill becomes UNPROTECTED ->
  // re-arm, never a phantom close. (#15 TRIGGERED-terminal, finished by the
  // incident it predicted.)
  const fired = rows.find(o => statusOf(o) === 'TRADED' || /TRIGGER/.test(statusOf(o)));
  if (fired) {
    const isTarget = String(fired.legName || '').toUpperCase().includes('TARGET');
    return { status: isTarget ? 'traded_target' : 'traded_sl', px: num(fired.price || fired.triggerPrice) };
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
// 7-day tradebook, cached 10 minutes (past days' fills do not change
// intraday; today's fills come fresh from /v2/trades each snapshot).
let _tradeHistCache = { at: 0, list: null };
function fetchDhanTradeHistory(token, cb) {
  if (_tradeHistCache.list && Date.now() - _tradeHistCache.at < 10 * 60 * 1000) return cb(null, _tradeHistCache.list);
  const toD = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const fromD = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  getJson(token, '/v2/trades/' + fromD + '/' + toD + '/0', (err, list) => {
    if (err) return cb(err, null);
    _tradeHistCache = { at: Date.now(), list: Array.isArray(list) ? list : [] };
    cb(null, _tradeHistCache.list);
  });
}

  attempt(0, false);
}

function getSnapshot(creds, cb) {
  const token = creds && creds.token;
  if (!token) return cb('No Dhan token', null);
  const out = { complete: false, protections: {}, entries: {}, heldQty: {}, sells: {}, sellsHistoryOk: true };

  fetchForeverList(token, (fErr, forevers) => {
    if (fErr) return cb('forever: ' + fErr, null);
    const byId = {};
    (forevers || []).forEach(o => {
      const id = String(o.orderId || o.orderid || '').trim();
      if (id) (byId[id] = byId[id] || []).push(o);
    });
    Object.keys(byId).forEach(id => {
      const legs = byId[id];
      out.protections[id] = { ...foreverState(legs),
        symbol: normSym(legs[0]?.tradingSymbol || legs[0]?.symbol || legs[0]?.customSymbol) };
    });

    getJson(token, '/v2/orders', (oErr, orders) => {
      if (oErr) return cb('orders: ' + oErr, null);
      (orders || []).forEach(o => {
        const id = String(o.orderId || o.orderid || '').trim();
        const st = String(o.orderStatus || o.status || '').toUpperCase();
        if (id) {
          out.entries[id] = /TRADED|EXECUTED|COMPLETE/.test(st)
            ? { status: 'filled', fillPrice: num(o.averageTradedPrice || o.avgPrice || o.tradedPrice || o.price), filledQty: num(o.filledQty || o.filled_qty || o.tradedQty || o.quantity) }
            : /REJECT|CANCEL|EXPIRE/.test(st) ? { status: 'dead' } : { status: 'pending' };
        }
      });
      // SELLS: order book + today's trades + the 7-DAY TRADEBOOK (#16). The
      // order book and /v2/trades are TODAY-only, so an exit that filled on an
      // earlier day (box down, multi-day hold) was invisible — the SAMHI trap.
      // Merge rules (the MWL 2026-07-28 lesson, ported from the legacy pass):
      // one SELL order fills in MANY trades, so trades are SUMMED per order id
      // (price weighted); the order book's aggregate row is used only when no
      // trades were seen for that id or when it reports MORE (a truncated
      // tradebook must never under-count an exit). Each fill keeps its
      // orderId/algoId (Dhan tags fills with the Forever leg that placed
      // them) so consumers can attribute exits precisely.
      // History is ENRICHMENT: its failure degrades (sellsHistoryOk=false,
      // sells from today only) rather than failing the snapshot — missing
      // sells makes the engine MORE conservative (fewer closes), never less.
      fetchDhanTradeHistory(token, (histErr, histTrades) => {
        if (histErr) out.sellsHistoryOk = false;
        getJson(token, '/v2/trades', (tErr, todayTrades) => {
          const trades = [...(Array.isArray(histTrades) ? histTrades : []), ...(tErr ? [] : (todayTrades || []))];
          const sellByOrder = new Map();
          const loose = []; const looseSeen = new Set();
          const pushLoose = (rec) => {
            const k = rec.sym + '|' + rec.qty + '|' + rec.px + '|' + (rec.at || 0);
            if (looseSeen.has(k)) return; looseSeen.add(k);
            loose.push(rec);
          };
          const pushTrade = (rec) => {
            if (!rec.sym || !(rec.qty > 0) || !(rec.px > 0)) return;
            if (!rec.orderId) return pushLoose(rec);
            const cur = sellByOrder.get(rec.orderId);
            if (!cur || cur.src !== 'trade') { sellByOrder.set(rec.orderId, { ...rec, src: 'trade' }); return; }
            const q = cur.qty + rec.qty;
            cur.px = ((cur.px * cur.qty) + (rec.px * rec.qty)) / q;   // weighted average fill
            cur.qty = q;
            cur.at = Math.max(cur.at || 0, rec.at || 0);
            cur.algoId = cur.algoId || rec.algoId;
          };
          const pushOrder = (rec) => {
            if (!rec.sym || !(rec.qty > 0) || !(rec.px > 0)) return;
            if (!rec.orderId) return pushLoose(rec);
            const cur = sellByOrder.get(rec.orderId);
            if (!cur) { sellByOrder.set(rec.orderId, { ...rec, src: 'order' }); return; }
            if (rec.qty > cur.qty) sellByOrder.set(rec.orderId, { ...rec, algoId: cur.algoId || rec.algoId, src: 'order' });
          };
          (trades || []).forEach(t => {
            if (String(t.transactionType || t.transaction_type || '').toUpperCase() !== 'SELL') return;
            pushTrade({ orderId: String(t.orderId || t.orderid || '').trim(), algoId: String(t.algoId || t.algoid || '').trim(),
              sym: normSym(t.tradingSymbol || t.symbol || t.customSymbol),
              qty: num(t.tradedQuantity || t.tradedQty || t.quantity || t.filledQty),
              px: num(t.tradedPrice || t.price || t.averageTradedPrice),
              at: Date.parse(t.exchangeTime || t.tradeDate || t.updateTime || t.createTime || '') || 0 });
          });
          (orders || []).forEach(o => {
            const side = String(o.transactionType || o.transaction_type || '').toUpperCase();
            const st = String(o.orderStatus || o.status || '').toUpperCase();
            if (side !== 'SELL' || !/TRADED|EXECUTED|COMPLETE/.test(st)) return;
            pushOrder({ orderId: String(o.orderId || o.orderid || '').trim(), algoId: String(o.algoId || o.algoid || '').trim(),
              sym: normSym(o.tradingSymbol || o.symbol || o.customSymbol),
              qty: num(o.filledQty || o.filled_qty || o.tradedQty || o.quantity),
              px: num(o.averageTradedPrice || o.avgPrice || o.tradedPrice || o.price),
              at: Date.parse(o.exchangeTime || o.updateTime || o.createTime || '') || 0 });
          });
          [...sellByOrder.values(), ...loose].forEach(s =>
            (out.sells[s.sym] = out.sells[s.sym] || []).push({ qty: s.qty, px: s.px, at: s.at || 0, orderId: s.orderId || '', algoId: s.algoId || '' }));

      getJson(token, '/v2/holdings', (hErr, holdings) => {
        if (hErr) return cb('holdings: ' + hErr, null);
        getJson(token, '/v2/positions', (pErr, positions) => {
          if (pErr) return cb('positions: ' + pErr, null);
          const add = (sym, qty) => { const s = normSym(sym); const q = num(qty); if (s && q > 0) out.heldQty[s] = Math.max(out.heldQty[s] || 0, q); };
          // Consider EVERY quantity bucket (totalQty, dpQty settled, t1Qty unsettled
          // CNC, availableQty): a freshly-bought holding must never read "not held" —
          // the engine treats not-held as closure evidence.
          out.holdingsDetail = out.holdingsDetail || {};
          (holdings || []).forEach(h => {
            add(h.tradingSymbol || h.symbol,
              Math.max(num(h.totalQty), num(h.dpQty) + num(h.t1Qty), num(h.availableQty), num(h.quantity)));
            const s = normSym(h.tradingSymbol || h.symbol);
            if (s) out.holdingsDetail[s] = {
              qty: Math.max(num(h.totalQty), num(h.dpQty) + num(h.t1Qty), num(h.availableQty), num(h.quantity)),
              avgPrice: num(h.avgCostPrice ?? h.averagePrice ?? h.avgPrice),
              ltp: num(h.lastTradedPrice ?? h.ltp),
            };
          });
          (positions || []).forEach(p => add(p.tradingSymbol || p.symbol, p.netQty ?? p.netQuantity ?? 0));
          out.complete = true; // every fetch OK -> the engine may act on this
          cb(null, out);
        });
      });
        });
      });
    });
  });
}

module.exports = { getSnapshot, foreverState, normSym };
