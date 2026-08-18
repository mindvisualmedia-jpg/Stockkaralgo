'use strict';
// test/fake-brokers.js - in-memory Zerodha (Kite), FYERS and Angel One that
// answer the REAL server.js executor the way the live APIs do. Every shape
// here is copied from what the adapters PARSE (brokers/*.js) and from the
// live-payload fixtures in brokers/brokers.test.js - never from docs alone.
// Never touches a real broker: server.js only reaches these through the locked
// seam (brokers/endpoint.js) with env set inside the test process.
//
// Each fake records every request in `st.requests` so a test asserts the exact
// payload sent, and exposes small helpers to seed and inspect broker state.
const http = require('http');

function makeServer(handler) {
  const st = { requests: [], nextId: 7000, cancelled: [], cancelledOrders: [] };
  const nextId = () => String(st.nextId++);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const url = String(req.url || '').split('?')[0];
      const ct = String(req.headers['content-type'] || '');
      let json = null;
      try {
        if (!body) json = null;
        else if (ct.includes('x-www-form-urlencoded')) json = Object.fromEntries(new URLSearchParams(body));
        else json = JSON.parse(body);
      } catch { json = body; }
      st.requests.push({ method: req.method, path: url, body: json, headers: req.headers });
      const send = (code, payload) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(typeof payload === 'string' ? payload : JSON.stringify(payload)); };
      handler({ method: req.method, url, json, send, nextId, st });
    });
  });
  return {
    st,
    listen: (cb) => server.listen(0, '127.0.0.1', () => cb(server.address().port)),
    close: (cb) => server.close(cb),
    sent: (method, prefix) => st.requests.filter(r => r.method === method && r.path.startsWith(prefix)),
  };
}

// ---------------------------------------------------------------------------
// ZERODHA (Kite Connect v3). Envelope: { status:'success', data: ... }.
// GTT: /gtt/triggers -> data:[ { id, status:'active'|'triggered'|'cancelled',
//   condition:{tradingsymbol,trigger_values,last_price}, orders:[{quantity,price,transaction_type,result?}] } ]
// Orders: /orders -> data:[ { order_id, status, transaction_type, tradingsymbol, quantity, filled_quantity, average_price } ]
// Holdings: data:[ { tradingsymbol, quantity, t1_quantity, average_price, last_price } ]
// Positions: data:{ net:[ { tradingsymbol, quantity } ] }
// ---------------------------------------------------------------------------
function createFakeKite(opts = {}) {
  const st0 = { gtts: [], orders: [], holdings: [], positions: [] };
  const marketPrice = Number(opts.marketPrice || 100);
  const parse = (v) => { if (typeof v !== 'string') return v; try { return JSON.parse(v); } catch { return v; } };
  const fake = makeServer(({ method, url, json, send, nextId, st }) => {
    const ok = (data) => send(200, { status: 'success', data });
    const err = (code, message) => send(code, { status: 'error', message, error_type: 'InputException' });
    if (method === 'GET' && url === '/gtt/triggers') return ok(st0.gtts);
    if (method === 'POST' && url === '/gtt/triggers') {
      const id = Number(nextId());
      st0.gtts.push({ id, status: 'active', type: json.type, condition: parse(json.condition), orders: parse(json.orders), created_at: new Date().toISOString() });
      return ok({ trigger_id: id });
    }
    if (method === 'PUT' && url.startsWith('/gtt/triggers/')) {
      const id = Number(url.split('/').pop());
      const g = st0.gtts.find(x => x.id === id);
      if (!g) return err(400, 'Trigger not found');
      g.type = json.type || g.type; g.condition = parse(json.condition); g.orders = parse(json.orders);
      (g.modifies = g.modifies || []).push(json);
      return ok({ trigger_id: id });
    }
    if (method === 'DELETE' && url.startsWith('/gtt/triggers/')) {
      const id = Number(url.split('/').pop());
      const g = st0.gtts.find(x => x.id === id);
      if (!g) return err(400, 'Trigger not found');
      st0.gtts = st0.gtts.filter(x => x.id !== id); st.cancelled.push(String(id));
      return ok({ trigger_id: id });
    }
    if (method === 'GET' && url === '/orders') return ok(st0.orders);
    if (method === 'POST' && url === '/orders/regular') {
      const oid = nextId();
      const filled = String(json.order_type).toUpperCase() === 'MARKET';
      st0.orders.push({ order_id: oid, status: filled ? 'COMPLETE' : 'OPEN', transaction_type: json.transaction_type, tradingsymbol: json.tradingsymbol,
        quantity: Number(json.quantity), filled_quantity: filled ? Number(json.quantity) : 0, average_price: filled ? marketPrice : 0, order_type: json.order_type, product: json.product, placed: json });
      if (filled && String(json.transaction_type).toUpperCase() === 'SELL') {
        const h = st0.holdings.find(x => x.tradingsymbol === json.tradingsymbol); if (h) h.quantity = Math.max(0, Number(h.quantity) - Number(json.quantity));
      }
      return ok({ order_id: oid });
    }
    if (method === 'DELETE' && url.startsWith('/orders/regular/')) {
      const oid = url.split('/').pop();
      const o = st0.orders.find(x => x.order_id === oid);
      if (!o) return err(400, 'Order not found');
      if (o.status === 'COMPLETE') return err(400, 'Order cannot be cancelled');
      o.status = 'CANCELLED'; st.cancelledOrders.push(oid);
      return ok({ order_id: oid });
    }
    if (method === 'GET' && url === '/portfolio/holdings') return ok(st0.holdings);
    if (method === 'GET' && url === '/portfolio/positions') return ok({ net: st0.positions, day: [] });
    if (method === 'GET' && url === '/user/profile') return ok({ user_id: 'FAKE' });
    send(404, { status: 'error', message: 'fake-kite: no route ' + method + ' ' + url });
  });
  return Object.assign(fake, {
    data: st0,
    holdSymbol: (sym, qty, ltp) => st0.holdings.push({ tradingsymbol: sym, quantity: qty, t1_quantity: 0, average_price: 100, last_price: ltp || 100 }),
    seedGtt: (sym, sl, target, qty) => {
      const id = Number(fake.st.nextId++);
      const orders = [{ exchange: 'NSE', tradingsymbol: sym, transaction_type: 'SELL', quantity: qty, order_type: 'LIMIT', product: 'CNC', price: sl }];
      if (target > 0) orders.push({ exchange: 'NSE', tradingsymbol: sym, transaction_type: 'SELL', quantity: qty, order_type: 'LIMIT', product: 'CNC', price: target });
      st0.gtts.push({ id, status: 'active', type: target > 0 ? 'two-leg' : 'single', condition: { exchange: 'NSE', tradingsymbol: sym, trigger_values: target > 0 ? [sl, target] : [sl], last_price: 100 }, orders });
      return String(id);
    },
    gtt: (id) => st0.gtts.find(g => String(g.id) === String(id)),
  });
}

// ---------------------------------------------------------------------------
// FYERS (api v3). Envelope: { s:'ok', code, message, ...payloadKey }.
// GTT list: { s:'ok', orderBook:[ { id, symbol:'NSE:INFY-EQ', ord_status:6, gtt_oco_ind, price_trigger, price2_trigger, qty, qty2 } ] }
// (proven live 2026-08-13). Order book: { s:'ok', orderBook:[ { id, symbol, side(1/-1), status(1|2|4|5|6), qty, filledQty, tradedPrice, limitPrice } ] }
// Holdings: { s:'ok', holdings:[ { symbol, quantity, remainingQuantity, costPrice, ltp } ] }
// Positions: { s:'ok', netPositions:[ { symbol, netQty } ] }
// GTT place: POST /gtt/orders/sync { side, symbol, productType, orderInfo:{leg1:{price,triggerPrice,qty}, leg2?} } -> { s:'ok', id }
// ---------------------------------------------------------------------------
function createFakeFyers(opts = {}) {
  const st0 = { gtts: [], orders: [], holdings: [], positions: [] };
  const marketPrice = Number(opts.marketPrice || 100);
  const P = (p) => '/api/v3' + p;
  const fake = makeServer(({ method, url, json, send, nextId, st }) => {
    const ok = (extra) => send(200, { s: 'ok', code: 200, message: '', ...extra });
    const err = (code, message) => send(code, { s: 'error', code: -99, message });
    if (method === 'GET' && url === P('/gtt/orders')) return ok({ orderBook: st0.gtts });
    if (method === 'POST' && url === P('/gtt/orders/sync')) {
      const id = nextId();
      const l1 = (json.orderInfo && json.orderInfo.leg1) || {}, l2 = json.orderInfo && json.orderInfo.leg2;
      // FLAT legs as the live list reports them. FYERS does not guarantee leg
      // order, so leg1 lands first (the target for an OCO); the adapter takes
      // the LOWER trigger as the stop.
      st0.gtts.push({ id, symbol: json.symbol, ord_status: 6, gtt_oco_ind: l2 ? 1 : 0, side: json.side, productType: json.productType,
        price_trigger: Number(l1.triggerPrice), price: Number(l1.price), qty: Number(l1.qty),
        price2_trigger: l2 ? Number(l2.triggerPrice) : 0, price2: l2 ? Number(l2.price) : 0, qty2: l2 ? Number(l2.qty) : 0, placed: json });
      return ok({ id });
    }
    if (method === 'PATCH' && url === P('/gtt/orders/sync')) {
      const g = st0.gtts.find(x => String(x.id) === String(json.id));
      if (!g) return err(400, 'GTT not found');
      const l1 = json.orderInfo && json.orderInfo.leg1, l2 = json.orderInfo && json.orderInfo.leg2;
      if (l1) { g.price_trigger = Number(l1.triggerPrice); g.price = Number(l1.price); g.qty = Number(l1.qty); }
      if (l2) { g.price2_trigger = Number(l2.triggerPrice); g.price2 = Number(l2.price); g.qty2 = Number(l2.qty); }
      (g.modifies = g.modifies || []).push(json);
      return ok({ id: g.id });
    }
    if (method === 'DELETE' && url === P('/gtt/orders/sync')) {
      const g = st0.gtts.find(x => String(x.id) === String(json.id));
      if (!g) return err(400, 'GTT not found');
      st0.gtts = st0.gtts.filter(x => x.id !== g.id); st.cancelled.push(String(g.id));
      return ok({ id: g.id });
    }
    if (method === 'GET' && url === P('/orders')) return ok({ orderBook: st0.orders });
    if (method === 'POST' && url === P('/orders/sync')) {
      const id = nextId();
      const filled = Number(json.type) === 2;   // 2 = market
      st0.orders.push({ id, symbol: json.symbol, side: Number(json.side), status: filled ? 2 : 6, qty: Number(json.qty), filledQty: filled ? Number(json.qty) : 0,
        tradedPrice: filled ? marketPrice : 0, limitPrice: Number(json.limitPrice || 0), type: Number(json.type), productType: json.productType, placed: json });
      if (filled && Number(json.side) === -1) { const h = st0.holdings.find(x => x.symbol === json.symbol); if (h) h.quantity = Math.max(0, Number(h.quantity) - Number(json.qty)); }
      return ok({ id });
    }
    if (method === 'DELETE' && url === P('/orders/sync')) {
      const o = st0.orders.find(x => String(x.id) === String(json.id));
      if (!o) return err(400, 'Order not found');
      if (o.status === 2) return err(400, 'Order already traded');
      o.status = 1; st.cancelledOrders.push(String(o.id));
      return ok({ id: o.id });
    }
    if (method === 'GET' && url === P('/holdings')) return ok({ holdings: st0.holdings });
    if (method === 'GET' && url === P('/positions')) return ok({ netPositions: st0.positions });
    if (method === 'GET' && url === P('/profile')) return ok({ data: { fy_id: 'FAKE' } });
    send(404, { s: 'error', message: 'fake-fyers: no route ' + method + ' ' + url });
  });
  return Object.assign(fake, {
    data: st0,
    holdSymbol: (sym, qty, ltp) => st0.holdings.push({ symbol: 'NSE:' + sym + '-EQ', quantity: qty, remainingQuantity: 0, costPrice: 100, ltp: ltp || 100 }),
    seedGtt: (sym, sl, target, qty) => {   // as the live list reports: flat legs, leg1 = target when OCO
      const id = String(fake.st.nextId++);
      const g = target > 0
        ? { id, symbol: 'NSE:' + sym + '-EQ', ord_status: 6, gtt_oco_ind: 1, price_trigger: target, price: target, qty, price2_trigger: sl, price2: sl, qty2: qty }
        : { id, symbol: 'NSE:' + sym + '-EQ', ord_status: 6, gtt_oco_ind: 0, price_trigger: sl, price: sl, qty, price2_trigger: 0, qty2: 0 };
      st0.gtts.push(g); return id;
    },
    gtt: (id) => st0.gtts.find(g => String(g.id) === String(id)),
    stopOf: (g) => (g.gtt_oco_ind ? Math.min(g.price_trigger, g.price2_trigger) : g.price_trigger),
    targetOf: (g) => (g.gtt_oco_ind ? Math.max(g.price_trigger, g.price2_trigger) : 0),
  });
}

// ---------------------------------------------------------------------------
// ANGEL ONE (SmartAPI). Envelope: { status:true, message:'SUCCESS', errorcode:'', data }.
// ruleList: POST { status:[...], page, count } -> data:[ { id, status:'NEW'|'ACTIVE'|'CANCELLED'|'SENTTOEXCHANGE'|..., tradingsymbol, symboltoken, exchange, price, triggerprice, qty, stoplossprice?, stoplosstriggerprice?, gttType? } ]
// createRule -> data:{ id }. modifyRule -> data:{ id }. cancelRule { id, symboltoken, exchange } -> data:{ id }.
// getOrderBook -> data:[ { orderid, status:'complete'|'rejected'|'open'|..., transactiontype, tradingsymbol, quantity, filledshares, averageprice, price } ]
// placeOrder -> data:{ orderid, uniqueorderid }. getAllHolding -> data:{ holdings:[ { tradingsymbol, quantity, ltp, averageprice } ] } ; getPosition -> data:[ { tradingsymbol, netqty } ]
// ---------------------------------------------------------------------------
function createFakeAngel(opts = {}) {
  const st0 = { rules: [], orders: [], holdings: [], positions: [] };
  const marketPrice = Number(opts.marketPrice || 100);
  const B = '/rest/secure/angelbroking';
  const fake = makeServer(({ method, url, json, send, nextId, st }) => {
    const ok = (data) => send(200, { status: true, message: 'SUCCESS', errorcode: '', data });
    const fail = (message, errorcode) => send(200, { status: false, message, errorcode: errorcode || 'AB1000', data: null });
    if (method === 'POST' && url === B + '/gtt/v1/ruleList') {
      const wanted = Array.isArray(json && json.status) ? json.status : [];
      // live quirk (2026-08-08): the broad documented status list gets HTTP 400 + empty body
      if (wanted.length > 2) return send(400, '');
      return ok(st0.rules.filter(r => !wanted.length || wanted.includes(r.status)));
    }
    if (method === 'POST' && url === B + '/gtt/v1/createRule') {
      const id = Number(nextId());
      st0.rules.push({ id, status: 'NEW', tradingsymbol: json.tradingsymbol, symboltoken: json.symboltoken, exchange: json.exchange,
        producttype: json.producttype, transactiontype: json.transactiontype, price: json.price, triggerprice: json.triggerprice, qty: json.qty,
        gttType: json.gttType || 'SINGLE', stoplossprice: json.stoplossprice, stoplosstriggerprice: json.stoplosstriggerprice, placed: json });
      return ok({ id });
    }
    if (method === 'POST' && url === B + '/gtt/v1/modifyRule') {
      const r = st0.rules.find(x => String(x.id) === String(json.id));
      if (!r) return fail('Rule not found', 'AB1013');
      Object.assign(r, { price: json.price, triggerprice: json.triggerprice, qty: json.qty, gttType: json.gttType || r.gttType, stoplossprice: json.stoplossprice, stoplosstriggerprice: json.stoplosstriggerprice });
      (r.modifies = r.modifies || []).push(json);
      return ok({ id: r.id });
    }
    if (method === 'POST' && url === B + '/gtt/v1/cancelRule') {
      // live quirk (2026-08-10): cancel needs id + symboltoken + exchange; id-only fails
      if (!json.symboltoken || !json.exchange) return fail('Something Went Wrong, Please Try After Sometime', 'AB2001');
      const r = st0.rules.find(x => String(x.id) === String(json.id));
      if (!r) return fail('Rule not found', 'AB1013');
      r.status = 'CANCELLED'; st.cancelled.push(String(r.id));
      return ok({ id: r.id });
    }
    if (method === 'POST' && url === B + '/gtt/v1/ruleDetails') {
      const r = st0.rules.find(x => String(x.id) === String(json.id));
      return r ? ok(r) : fail('Rule not found', 'AB1013');
    }
    if (url === B + '/order/v1/getOrderBook') return ok(st0.orders);
    if (method === 'POST' && url === B + '/order/v1/placeOrder') {
      const oid = nextId();
      const filled = String(json.ordertype).toUpperCase() === 'MARKET';
      st0.orders.push({ orderid: oid, status: filled ? 'complete' : 'open', orderstatus: filled ? 'complete' : 'open', transactiontype: json.transactiontype, tradingsymbol: json.tradingsymbol,
        quantity: Number(json.quantity), filledshares: filled ? Number(json.quantity) : 0, averageprice: filled ? marketPrice : 0, price: Number(json.price || 0), placed: json });
      if (filled && String(json.transactiontype).toUpperCase() === 'SELL') { const h = st0.holdings.find(x => x.tradingsymbol === json.tradingsymbol); if (h) h.quantity = Math.max(0, Number(h.quantity) - Number(json.quantity)); }
      return ok({ orderid: oid, uniqueorderid: 'U' + oid });
    }
    if (method === 'POST' && url === B + '/order/v1/cancelOrder') {
      const o = st0.orders.find(x => String(x.orderid) === String(json.orderid));
      if (!o) return fail('Order not found', 'AB1013');
      if (o.status === 'complete') return fail('Order already complete', 'AB1013');
      o.status = 'cancelled'; o.orderstatus = 'cancelled'; st.cancelledOrders.push(String(o.orderid));
      return ok({ orderid: o.orderid });
    }
    if (url === B + '/portfolio/v1/getAllHolding') return ok({ holdings: st0.holdings });
    if (url === B + '/portfolio/v1/getHolding') return ok(st0.holdings);
    if (url === B + '/order/v1/getPosition') return ok(st0.positions);
    if (url === B + '/user/v1/getProfile') return ok({ clientcode: 'FAKE' });
    send(404, { status: false, message: 'fake-angel: no route ' + method + ' ' + url });
  });
  return Object.assign(fake, {
    data: st0,
    holdSymbol: (sym, qty, ltp) => st0.holdings.push({ tradingsymbol: sym + '-EQ', symboltoken: '1', quantity: qty, ltp: ltp || 100, averageprice: 100 }),
    seedRule: (sym, token, sl, target, qty) => {   // an ACTIVE OCO: target in price/triggerprice, SL in stoploss* (probe-proven 2026-08-10)
      const id = Number(fake.st.nextId++);
      const r = target > 0
        ? { id, status: 'ACTIVE', tradingsymbol: sym + '-EQ', symboltoken: String(token), exchange: 'NSE', gttType: 'OCO', price: String(target), triggerprice: String(target), qty: String(qty), stoplossprice: String(sl), stoplosstriggerprice: String(sl) }
        : { id, status: 'ACTIVE', tradingsymbol: sym + '-EQ', symboltoken: String(token), exchange: 'NSE', gttType: 'SINGLE', price: String(sl), triggerprice: String(sl), qty: String(qty) };
      st0.rules.push(r); return String(id);
    },
    rule: (id) => st0.rules.find(r => String(r.id) === String(id)),
  });
}

module.exports = { createFakeKite, createFakeFyers, createFakeAngel };
