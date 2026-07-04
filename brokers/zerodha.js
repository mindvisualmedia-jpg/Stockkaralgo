'use strict';
// brokers/zerodha.js — Zerodha (Kite) adapter for the position engine. Same
// contract as brokers/dhan.js: getSnapshot(creds, cb) -> one read-only sweep of
// broker truth normalized to the engine snapshot shape. Self-contained.
//
// Zerodha quirks this adapter normalizes:
//   - a fired GTT lingers as status 'triggered' with per-leg order results
//     (unlike Dhan, which drops completed Forevers) -> traded_target/traded_sl
//   - a deleted GTT simply disappears from /gtt/triggers -> absent id = 'gone'
//   - GTT legs are placed [SL, TARGET], so leg index 0 = SL, 1 = TARGET
//   - CNC bought recently sits in holdings as t1_quantity until settled

const https = require('https');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function normSym(s) { return String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase(); }

function kiteGetJson(creds, pathname, cb) {
  const req = https.request({
    hostname: 'api.kite.trade', port: 443, path: pathname, method: 'GET',
    headers: { 'X-Kite-Version': '3', Authorization: 'token ' + creds.apiKey + ':' + creds.accessToken },
  }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      let p; try { p = JSON.parse(d); } catch { p = null; }
      if (res.statusCode >= 400) return cb('HTTP ' + res.statusCode + ' ' + pathname + (p?.message ? ' ' + p.message : ''), null);
      cb(null, p?.data !== undefined ? p.data : p);
    });
  });
  req.on('error', e => cb(e.message, null));
  req.setTimeout(15000, () => req.destroy(new Error('timeout ' + pathname)));
  req.end();
}

function legResult(leg) {
  const result = leg?.result || {};
  const orderResult = result.order_result || leg?.order_result || {};
  return {
    orderId: orderResult.order_id || result.order_id || leg?.order_id || '',
    status: String(orderResult.status || result.status || leg?.status || '').toUpperCase(),
    price: num(orderResult.average_price || result.average_price || leg?.average_price || leg?.price),
  };
}

// Normalize one GTT trigger object into an engine protection state.
function gttState(gtt) {
  const status = String(gtt?.status || '').toLowerCase();
  if (/reject/.test(status)) return { status: 'rejected' };
  if (/(cancel|delete|expire|disable)/.test(status)) return { status: 'gone' };
  if (status === 'triggered') {
    const orders = Array.isArray(gtt.orders) ? gtt.orders : [];
    const fired = orders.map((leg, index) => ({ index, ...legResult(leg) }))
      .find(l => l.orderId || l.status);
    if (fired) {
      if (/(REJECT|CANCEL|FAIL)/.test(fired.status)) return { status: 'rejected' };
      if (/(COMPLETE|TRADED|FILLED)/.test(fired.status)) {
        return { status: fired.index === 1 ? 'traded_target' : 'traded_sl', px: fired.price };
      }
    }
    return { status: 'live' }; // triggered but exit order still working -> still owns the position
  }
  // active / anything else non-terminal -> live; SL trigger for modify verification,
  // plus expiry timestamp so the engine can refresh a GTT before its 1-year death.
  const trig = Array.isArray(gtt?.condition?.trigger_values) ? num(gtt.condition.trigger_values[0]) : 0;
  const exp = Date.parse(gtt?.expires_at || '') || 0;
  const live = { status: 'live', triggerPrice: trig };
  if (exp > 0) live.expiresAt = exp;
  return live;
}

function getSnapshot(creds, cb) {
  if (!creds?.apiKey || !creds?.accessToken) return cb('No Zerodha token', null);
  const out = { complete: false, protections: {}, entries: {}, heldQty: {}, sells: {} };

  kiteGetJson(creds, '/gtt/triggers', (gErr, gtts) => {
    if (gErr) return cb('gtt: ' + gErr, null);
    (Array.isArray(gtts) ? gtts : []).forEach(g => {
      const id = String(g.id || g.trigger_id || '').trim();
      if (id) out.protections[id] = gttState(g);
    });

    kiteGetJson(creds, '/orders', (oErr, orders) => {
      if (oErr) return cb('orders: ' + oErr, null);
      (Array.isArray(orders) ? orders : []).forEach(o => {
        const id = String(o.order_id || o.orderId || '').trim();
        const st = String(o.status || '').toUpperCase();
        const side = String(o.transaction_type || '').toUpperCase();
        if (id) {
          out.entries[id] = /(COMPLETE|TRADED|FILLED)/.test(st)
            ? { status: 'filled', fillPrice: num(o.average_price), filledQty: num(o.filled_quantity || o.quantity) }
            : /(REJECT|CANCEL|EXPIRE)/.test(st) ? { status: 'dead' } : { status: 'pending' };
        }
        if (side === 'SELL' && /(COMPLETE|TRADED|FILLED)/.test(st)) {
          const sym = normSym(o.tradingsymbol || o.trading_symbol);
          const qty = num(o.filled_quantity || o.quantity);
          const px = num(o.average_price || o.price);
          if (sym && qty > 0 && px > 0) (out.sells[sym] = out.sells[sym] || []).push({ qty, px });
        }
      });

      kiteGetJson(creds, '/portfolio/holdings', (hErr, holdings) => {
        if (hErr) return cb('holdings: ' + hErr, null);
        kiteGetJson(creds, '/portfolio/positions', (pErr, positions) => {
          if (pErr) return cb('positions: ' + pErr, null);
          const add = (sym, qty) => { const s = normSym(sym); const q = num(qty); if (s && q > 0) out.heldQty[s] = Math.max(out.heldQty[s] || 0, q); };
          (Array.isArray(holdings) ? holdings : []).forEach(h =>
            add(h.tradingsymbol || h.trading_symbol, num(h.quantity) + num(h.t1_quantity))); // t1_quantity = bought, unsettled
          const net = Array.isArray(positions?.net) ? positions.net : [];
          net.forEach(p => add(p.tradingsymbol || p.trading_symbol, p.quantity));
          out.complete = true;
          cb(null, out);
        });
      });
    });
  });
}

module.exports = { getSnapshot, gttState, normSym };
