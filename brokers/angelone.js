'use strict';
// brokers/angelone.js — Angel One (SmartAPI) adapter for the position engine.
// Same contract as brokers/dhan.js / zerodha.js / fyers.js:
//   getSnapshot(creds, cb) -> one read-only sweep of broker truth normalized to
//   the engine snapshot shape. Self-contained: no server.js imports.
//
// Angel quirks this adapter normalizes:
//   - Protection is a GTT *rule* (single-leg SELL trigger), NOT an OCO — the
//     target is software-managed by the app. So protections here carry only
//     the stop side, and "fired" cannot distinguish target-vs-SL (there is no
//     target at the broker to fire).
//   - The rule list is a POST with a status filter. Statuses seen in the wild
//     / docs: NEW, ACTIVE, SENTTOEXCHANGE (triggered, order sent), FORALL,
//     CANCELLED, EXPIRED, COMPLETED. Unknown-but-nonterminal is treated as
//     live: over-believing a stop exists is flagged by the verify pass's
//     held-check; under-believing is what re-armed FYERS every 5 minutes.
//   - tradingsymbol carries a series suffix ("GAIL-EQ") -> normalized off.
//   - The order book is TODAY-only (cross-day exits invisible) — same trap as
//     Dhan #1/SAMHI. heldQty (holdings ∪ net positions) is the cross-day truth.
//
// Field names are parsed tolerantly (several fallbacks per field) because the
// exact payloads are only provable against a live account: validate via
// /debug/angelone + shadow logs BEFORE any cutover (debug-with-data rule).

const https = require('https');

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function normSym(s) {
  return String(s || '').replace(/^(NSE|BSE):/i, '').replace(/-(EQ|BE|BZ|SM|ST)$/i, '').replace(/\s/g, '').toUpperCase();
}

// Angel reports failures INSIDE a 200 body, and uses `success` on some
// endpoints and `status` on others. Pure so it can be pinned by fixtures:
// treating an error envelope as data is what produces a confident EMPTY
// snapshot, and an empty snapshot is indistinguishable from "nothing is
// protected" (the FYERS stacking incident's root shape).
function isErrorEnvelope(payload, statusCode) {
  if (Number(statusCode) >= 400) return true;
  if (!payload || typeof payload !== 'object') return false;
  return payload.success === false || payload.status === false
    || !!payload.errorCode || !!payload.errorcode;
}
function envelopeError(payload, statusCode) {
  return (payload && (payload.message || payload.errorCode || payload.errorcode)) || ('HTTP ' + statusCode);
}

function angelRequest(creds, method, pathname, payload, cb) {
  const body = payload != null ? JSON.stringify(payload) : '';
  const req = https.request({
    hostname: 'apiconnect.angelone.in', port: 443, path: pathname, method,
    headers: {
      Authorization: 'Bearer ' + creds.accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-UserType': 'USER', 'X-SourceID': 'WEB',
      'X-ClientLocalIP': '127.0.0.1', 'X-ClientPublicIP': '127.0.0.1',
      'X-MACAddress': '00:00:00:00:00:00',
      'X-PrivateKey': creds.apiKey || creds.clientId,
      ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
    },
  }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      let p; try { p = JSON.parse(d); } catch { p = null; }
      if (isErrorEnvelope(p, res.statusCode)) return cb(pathname + ': ' + envelopeError(p, res.statusCode), null);
      cb(null, p);
    });
  });
  req.on('error', e => cb(e.message, null));
  req.setTimeout(15000, () => req.destroy(new Error('timeout ' + pathname)));
  if (body) req.write(body);
  req.end();
}

// Unwrap an Angel list payload across its shape variants.
function listRows(payload, ...keys) {
  if (Array.isArray(payload)) return payload;
  for (const k of keys) if (Array.isArray(payload?.[k])) return payload[k];
  if (Array.isArray(payload?.data)) return payload.data;
  for (const k of keys) if (Array.isArray(payload?.data?.[k])) return payload.data[k];
  return [];
}

// Normalize one GTT rule into an engine protection state.
function gttState(g) {
  const status = String(g?.status || g?.ruleStatus || g?.orderStatus || '').toLowerCase();
  if (/cancel|delet/.test(status)) return { status: 'gone' };
  if (/expire/.test(status)) return { status: 'gone' };
  if (/reject/.test(status)) return { status: 'rejected' };
  // SENTTOEXCHANGE = the trigger fired and the exit order went out. Terminal
  // for the RULE; whether the exit FILLED is the order book's business.
  if (/complete|sentto|trigger|forall/.test(status)) return { status: 'fired' };
  // NEW / ACTIVE / anything non-terminal -> live protection.
  return { status: 'live', triggerPrice: num(g?.triggerprice ?? g?.triggerPrice), qty: num(g?.qty ?? g?.quantity) };
}

// Order-book row -> engine entry state. Angel statuses are lowercase words.
function orderState(o) {
  const st = String(o?.status || o?.orderstatus || '').toLowerCase();
  if (/complete/.test(st)) return {
    status: 'filled',
    fillPrice: num(o.averageprice || o.avgPrice || o.price),
    filledQty: num(o.filledshares || o.filledQty || o.quantity || o.qty),
  };
  if (/reject|cancel/.test(st)) return { status: 'dead' };
  return { status: 'pending' }; // open / trigger pending / modified / unknown -> not final
}

/**
 * getSnapshot — the engine's one read of Angel truth.
 * creds: { apiKey (SmartAPI key, X-PrivateKey), clientId (alias), accessToken }
 */
function getSnapshot(creds, cb) {
  if (!(creds?.apiKey || creds?.clientId) || !creds?.accessToken) return cb('No Angel One token', null);
  const out = { complete: false, protections: {}, entries: {}, heldQty: {}, sells: {} };

  // Rule list first: ask broadly; some deployments reject unknown statuses, so
  // fall back to the minimal live set rather than failing the whole snapshot.
  const RULE_PATH = '/rest/secure/angelbroking/gtt/v1/ruleList';
  const askRules = (statuses, next) =>
    angelRequest(creds, 'POST', RULE_PATH, { status: statuses, page: 1, count: 100 }, next);

  askRules(['NEW', 'ACTIVE', 'SENTTOEXCHANGE', 'FORALL', 'CANCELLED', 'EXPIRED', 'COMPLETED'], (gErr, gPayload) => {
    const proceed = (rulesPayload) => {
      listRows(rulesPayload, 'rules', 'ruleList').forEach(g => {
        const id = String(g?.id ?? g?.ruleId ?? g?.rule_id ?? '').trim();
        if (id) out.protections[id] = { ...gttState(g), symbol: normSym(g?.tradingsymbol || g?.symbol) };
      });
      angelRequest(creds, 'GET', '/rest/secure/angelbroking/order/v1/getOrderBook', null, (oErr, obPayload) => {
        if (oErr) return cb('orders: ' + oErr, null);
        listRows(obPayload, 'orderBook', 'orders').forEach(o => {
          const id = String(o?.orderid || o?.orderId || '').trim();
          if (id) out.entries[id] = orderState(o);
          const side = String(o?.transactiontype || o?.transactionType || '').toUpperCase();
          if (side === 'SELL') {
            const sym = normSym(o?.tradingsymbol || o?.symbol);
            const st = orderState(o);
            if (sym && st.status !== 'dead') {
              out.sells[sym] = out.sells[sym] || { open: 0, filled: 0 };
              if (st.status === 'filled') out.sells[sym].filled += st.filledQty || 0;
              else out.sells[sym].open += num(o?.quantity || o?.qty);
            }
          }
        });
        angelRequest(creds, 'GET', '/rest/secure/angelbroking/portfolio/v1/getAllHolding', null, (hErr, hPayload) => {
          // getAllHolding wraps under data.holdings; older getHolding is a flat
          // data[] — try the flat endpoint before giving up on holdings.
          const finish = (holdPayload) => {
            const add = (sym, qty) => { const k = normSym(sym); if (k && num(qty) > 0) out.heldQty[k] = (out.heldQty[k] || 0) + num(qty); };
            listRows(holdPayload, 'holdings').forEach(h => add(h?.tradingsymbol || h?.symbol, Math.max(num(h?.quantity), num(h?.realisedquantity))));
            angelRequest(creds, 'GET', '/rest/secure/angelbroking/order/v1/getPosition', null, (pErr, pPayload) => {
              if (!pErr) listRows(pPayload, 'positions').forEach(p => add(p?.tradingsymbol || p?.symbol, num(p?.netqty ?? p?.netQty)));
              out.complete = true;
              cb(null, out);
            });
          };
          if (hErr) {
            angelRequest(creds, 'GET', '/rest/secure/angelbroking/portfolio/v1/getHolding', null, (h2Err, h2Payload) => {
              if (h2Err) return cb('holdings: ' + hErr, null);   // both failed -> no cross-day truth -> incomplete
              finish(h2Payload);
            });
          } else finish(hPayload);
        });
      });
    };
    if (!gErr) return proceed(gPayload);
    askRules(['NEW', 'ACTIVE'], (g2Err, g2Payload) => {
      if (g2Err) return cb('gtt rules: ' + gErr, null);
      proceed(g2Payload);
    });
  });
}

// Liveness ping: one authenticated call (see brokers/dhan.js ping). Minimal
// status list only — the broad one is a proven HTTP 400 on live accounts,
// and a probe must never fail on a broker quirk.
function ping(creds, cb) {
  if (!(creds?.apiKey || creds?.clientId) || !creds?.accessToken) return cb('No Angel One token');
  angelRequest(creds, 'POST', '/rest/secure/angelbroking/gtt/v1/ruleList',
    { status: ['NEW', 'ACTIVE'], page: 1, count: 1 }, (err) => cb(err || null));
}

module.exports = { ping, getSnapshot, gttState, orderState, normSym, listRows, isErrorEnvelope };
