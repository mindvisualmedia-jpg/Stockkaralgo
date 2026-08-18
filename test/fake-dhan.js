'use strict';
// test/fake-dhan.js — an in-memory Dhan that answers the REAL server.js
// executor exactly like api.dhan.co does (shapes copied from the live payload
// fixtures in brokers/brokers.test.js). It never touches a real broker: the
// harness points server.js at it via STOCKKAR_DHAN_API_* env vars set in the
// test process only.
//
// State is plain data a test can seed and inspect: forevers (per-leg rows as
// /v2/forever/all returns them), orders (today's book), trades, holdings,
// positions. Every request is recorded in `requests` so a test can assert the
// exact payload the executor sent — the thing no unit test could see before.
const http = require('http');

function createFakeDhan(opts = {}) {
  const symbolOfSecurity = Object.assign({}, opts.securities || {});   // securityId -> tradingSymbol
  const st = { forevers: [], orders: [], trades: [], holdings: [], positions: [], requests: [], nextId: 5000, failNext: null };
  const nextId = () => String(st.nextId++);
  const symOf = sid => symbolOfSecurity[String(sid)] || ('SEC' + sid);
  const send = (res, code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const dhanErr = (res, code, msg) => send(res, code, { errorType: 'Order_Error', errorCode: 'DH-905', errorMessage: msg });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let json = null;
      try { json = body ? JSON.parse(body) : null; } catch { json = body; }
      const url = String(req.url || '').split('?')[0];
      st.requests.push({ method: req.method, path: url, body: json });
      // a test can make the NEXT matching call fail like Dhan would
      if (st.failNext && st.failNext.method === req.method && url.startsWith(st.failNext.path)) {
        const f = st.failNext; st.failNext = null;
        return dhanErr(res, f.code || 400, f.message || 'Incorrect request for order and cannot be processed');
      }
      // ---- Forever orders --------------------------------------------------
      if (req.method === 'GET' && (url === '/v2/forever/all' || url === '/v2/forever/orders')) {
        return send(res, 200, st.forevers.flatMap(f => f.legs));
      }
      if (req.method === 'POST' && url === '/v2/forever/orders') {
        const oid = nextId();
        const sym = symOf(json.securityId);
        const legs = [{ orderId: oid, orderStatus: 'PENDING', legName: 'STOP_LOSS_LEG', triggerPrice: Number(json.triggerPrice), price: Number(json.price || 0), quantity: Number(json.quantity), tradingSymbol: sym, transactionType: 'SELL' }];
        if (json.orderFlag === 'OCO') legs.push({ orderId: oid, orderStatus: 'PENDING', legName: 'TARGET_LEG', triggerPrice: Number(json.triggerPrice1), price: Number(json.price1 || 0), quantity: Number(json.quantity1 || json.quantity), tradingSymbol: sym, transactionType: 'SELL' });
        st.forevers.push({ orderId: oid, legs, placed: json });
        return send(res, 200, { orderId: oid, orderStatus: 'PENDING' });
      }
      if (req.method === 'PUT' && url.startsWith('/v2/forever/orders/')) {
        const oid = url.split('/').pop();
        const f = st.forevers.find(x => x.orderId === oid);
        if (!f) return dhanErr(res, 400, 'Order not found');
        const leg = f.legs.find(l => l.legName === (json.legName || 'STOP_LOSS_LEG')) || f.legs[0];
        if (Number(json.triggerPrice) > 0) leg.triggerPrice = Number(json.triggerPrice);
        if (Number(json.quantity) > 0) leg.quantity = Number(json.quantity);
        (f.modifies = f.modifies || []).push(json);
        return send(res, 200, { orderId: oid, orderStatus: 'PENDING' });
      }
      if (req.method === 'DELETE' && url.startsWith('/v2/forever/orders/')) {
        const oid = url.split('/').pop();
        const f = st.forevers.find(x => x.orderId === oid);
        if (!f) return dhanErr(res, 400, 'Order not found');
        st.forevers = st.forevers.filter(x => x.orderId !== oid);
        (st.cancelled = st.cancelled || []).push(oid);
        return send(res, 200, { orderId: oid, orderStatus: 'CANCELLED' });
      }
      // ---- regular orders --------------------------------------------------
      if (req.method === 'GET' && url === '/v2/orders') return send(res, 200, st.orders);
      if (req.method === 'POST' && url === '/v2/orders') {
        const oid = nextId();
        const sym = symOf(json.securityId);
        const px = Number(json.price) > 0 ? Number(json.price) : Number(opts.marketPrice || 100);
        // a MARKET order fills instantly at the fake's market price; a LIMIT rests
        const filled = String(json.orderType || '').toUpperCase() === 'MARKET';
        st.orders.push({ orderId: oid, orderStatus: filled ? 'TRADED' : 'PENDING', transactionType: json.transactionType, tradingSymbol: sym,
          quantity: Number(json.quantity), filledQty: filled ? Number(json.quantity) : 0, averageTradedPrice: filled ? px : 0, orderType: json.orderType, price: Number(json.price || 0), placed: json });
        if (filled && String(json.transactionType).toUpperCase() === 'SELL') {
          st.trades.push({ orderId: oid, tradingSymbol: sym, transactionType: 'SELL', tradedQuantity: Number(json.quantity), tradedPrice: px });
          const h = st.holdings.find(x => x.tradingSymbol === sym); if (h) h.totalQty = Math.max(0, Number(h.totalQty) - Number(json.quantity));
        }
        return send(res, 200, { orderId: oid, orderStatus: filled ? 'TRADED' : 'PENDING' });
      }
      // ---- portfolio -------------------------------------------------------
      if (req.method === 'GET' && url === '/v2/holdings') return send(res, 200, st.holdings);
      if (req.method === 'GET' && url === '/v2/positions') return send(res, 200, st.positions);
      if (req.method === 'GET' && url.startsWith('/v2/trades')) return send(res, 200, st.trades);
      if (req.method === 'GET' && url === '/v2/fundlimit') return send(res, 200, { availabelBalance: 100000 });
      send(res, 404, { errorMessage: 'fake-dhan: no route ' + req.method + ' ' + url });
    });
  });

  return {
    st,
    listen: (cb) => server.listen(0, '127.0.0.1', () => cb(server.address().port)),
    close: (cb) => server.close(cb),
    // helpers a test reads
    forever: (id) => st.forevers.find(f => f.orderId === String(id)),
    liveForevers: () => st.forevers,
    sent: (method, pathPrefix) => st.requests.filter(r => r.method === method && r.path.startsWith(pathPrefix)),
    holdSymbol: (sym, qty) => { st.holdings.push({ tradingSymbol: sym, totalQty: qty, availableQty: qty, exchange: 'NSE' }); },
    seedForever: (sym, sl, target, qty) => {   // an existing OCO at the broker, as Dhan lists it
      const oid = nextId();
      const legs = [{ orderId: oid, orderStatus: 'PENDING', legName: 'STOP_LOSS_LEG', triggerPrice: sl, price: 0, quantity: qty, tradingSymbol: sym, transactionType: 'SELL' }];
      if (target > 0) legs.push({ orderId: oid, orderStatus: 'PENDING', legName: 'TARGET_LEG', triggerPrice: target, price: 0, quantity: qty, tradingSymbol: sym, transactionType: 'SELL' });
      st.forevers.push({ orderId: oid, legs });
      return oid;
    },
  };
}

module.exports = { createFakeDhan };
