'use strict';
// test/executor.brokers.test.js - the REAL server.js executor against FAKE
// Zerodha, FYERS and Angel One (test/fake-brokers.js) in ONE process. Same
// money paths already proven on Dhan: re-arm payload after a rejected stop,
// cost-move payload SHAPE (the FYERS leg1/leg2 and Angel whole-OCO restates
// are the most dangerous writes we send), a breached stop exiting at market,
// a stuck exit chased, and a close from the fill. No real broker is reached:
// the locked seam (brokers/endpoint.js) only honours loopback in a test process.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeKite, createFakeFyers, createFakeAngel } = require('./fake-brokers');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-brokers-'));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'broker_tokens.json'), JSON.stringify({ brokers: {
  zerodha: { clientId: 'kiteapikey', clientSecret: 's', accessToken: 'kite-token', updatedAt: new Date().toISOString() },
  fyers: { clientId: 'FYAPP-100', clientSecret: 's', accessToken: 'fyers-token', updatedAt: new Date().toISOString() },
  angelone: { clientId: 'angelapikey', accountId: 'A12345', accessToken: 'angel-token', updatedAt: new Date().toISOString() },
} }));
Object.assign(process.env, {
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_KITE_API_HOST: '127.0.0.1', STOCKKAR_KITE_API_PROTO: 'http',
  STOCKKAR_FYERS_API_HOST: '127.0.0.1', STOCKKAR_FYERS_API_PROTO: 'http',
  STOCKKAR_ANGEL_API_HOST: '127.0.0.1', STOCKKAR_ANGEL_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1',
  STOCKKAR_BREACH_BACKSTOP: 'all', STOCKKAR_FYERS_LIVE: '1',
});

const kite = createFakeKite({ marketPrice: 93.5 });
const fyers = createFakeFyers({ marketPrice: 93.5 });
const angel = createFakeAngel({ marketPrice: 93.5 });
let S;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const rows = () => S.readOrderLog();
const rowOf = (sym) => rows().find(r => r.symbol === sym && !r.exitType) || rows().find(r => r.symbol === sym);
async function enginePass() { S.runEngineCutover(); await wait(900); }
const now = () => ({ time: new Date().toLocaleString(), recordedAt: new Date().toISOString() });

before(async () => {
  await new Promise(res => kite.listen(port => { process.env.STOCKKAR_KITE_API_PORT = String(port); res(); }));
  await new Promise(res => fyers.listen(port => { process.env.STOCKKAR_FYERS_API_PORT = String(port); res(); }));
  await new Promise(res => angel.listen(port => { process.env.STOCKKAR_ANGEL_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  assert.equal(S.KITE_API.hostname, '127.0.0.1');
  assert.equal(S.FYERS_API_EP.hostname, '127.0.0.1');
  assert.equal(S.ANGEL_API.hostname, '127.0.0.1');
  S.seedAngelInstrumentMap({
    'NSE:INFY': { tradingSymbol: 'INFY-EQ', token: '1594', exchange: 'NSE' }, INFY: { tradingSymbol: 'INFY-EQ', token: '1594', exchange: 'NSE' },
    'NSE:TCS': { tradingSymbol: 'TCS-EQ', token: '11536', exchange: 'NSE' }, TCS: { tradingSymbol: 'TCS-EQ', token: '11536', exchange: 'NSE' },
    'NSE:WIPRO': { tradingSymbol: 'WIPRO-EQ', token: '3787', exchange: 'NSE' }, WIPRO: { tradingSymbol: 'WIPRO-EQ', token: '3787', exchange: 'NSE' },
  });
  // healthy anchors on each broker so the read-sanity gate trusts every snapshot
  kite.holdSymbol('TCS', 5, 3100); fyers.holdSymbol('TCS', 5, 3100); angel.holdSymbol('TCS', 5, 3100);
});
after(async () => { await new Promise(r => kite.close(r)); await new Promise(r => fyers.close(r)); await new Promise(r => angel.close(r)); });

const anchorRows = () => {
  const zk = kite.seedGtt('TCS', 3000, 3300, 5);
  const fk = fyers.seedGtt('TCS', 3000, 3300, 5);
  const ak = angel.seedRule('TCS', '11536', 3000, 3300, 5);
  return [
    { id: 'az', broker: 'zerodha', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300, exchange: 'NSE', segment: 'CNC',
      orderId: 'ENTRY:ZE9 | GTT:' + zk, zerodhaEntryOrderId: 'ZE9', zerodhaGttId: zk, status: 'ZERODHA ENTRY + GTT OCO', liveLtp: 3100, ...now() },
    { id: 'af', broker: 'fyers', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300, exchange: 'NSE', segment: 'CNC',
      orderId: 'ENTRY:FE9 | GTT:' + fk, fyersEntryOrderId: 'FE9', fyersGttId: fk, status: 'FYERS ENTRY + GTT OCO', liveLtp: 3100, ...now() },
    { id: 'aa', broker: 'angelone', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300, exchange: 'NSE', segment: 'CNC',
      orderId: 'ENTRY:AE9 | SLGTT:' + ak, angelOneEntryOrderId: 'AE9', angelOneSlRuleId: ak, angelOneOco: true, status: 'ANGEL ENTRY + GTT OCO', liveLtp: 3100, ...now() },
  ];
};

// ============================================================================
// 1. REARM after a rejected stop - the exact placement payload per broker
// ============================================================================
test('REARM x3: a row whose stop was rejected at entry gets protection placed with each broker\'s exact payload, then reads PROTECTED', async () => {
  kite.holdSymbol('INFY', 10, 100); fyers.holdSymbol('INFY', 10, 100); angel.holdSymbol('INFY', 10, 100);
  const naked = (broker, extra) => ({ broker, symbol: 'INFY', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 95, targetPrice: 110, exchange: 'NSE', segment: 'CNC',
    status: 'ENTRY PLACED BUT PROTECTION FAILED: rejected', protectionFailedAt: new Date().toISOString(), ...now(), ...extra });
  S.writeOrderLog([...anchorRows(),
    naked('zerodha', { id: 'z1', orderId: 'ENTRY:ZE1', zerodhaEntryOrderId: 'ZE1', zerodhaGttId: '' }),
    naked('fyers', { id: 'f1', orderId: 'ENTRY:FE1', fyersEntryOrderId: 'FE1', fyersGttId: '' }),
    naked('angelone', { id: 'a1', orderId: 'ENTRY:AE1', angelOneEntryOrderId: 'AE1', angelOneSlRuleId: '' }),
  ]);
  await enginePass();

  // --- Zerodha: two-leg GTT, condition + orders as JSON strings, LIMIT sells ---
  const zp = kite.sent('POST', '/gtt/triggers');
  assert.equal(zp.length, 1, 'one Kite GTT placed');
  assert.equal(zp[0].body.type, 'two-leg');
  const cond = JSON.parse(zp[0].body.condition), ords = JSON.parse(zp[0].body.orders);
  assert.equal(cond.tradingsymbol, 'INFY');
  assert.deepEqual(cond.trigger_values, [95, 110]);
  assert.equal(ords.length, 2);
  assert.ok(ords.every(o => o.transaction_type === 'SELL' && o.quantity === 10 && o.product === 'CNC'));
  assert.equal(ords[0].order_type, 'MARKET', 'the STOP leg is market-on-trigger (zerodhaGttSlLeg) so a gap-down never leaves a resting limit');
  assert.equal(ords[1].order_type, 'LIMIT'); assert.equal(ords[1].price, 110, 'the TARGET leg is a limit at the target');
  assert.ok(rows().find(r => r.id === 'z1').zerodhaGttId, 'row names the new GTT');

  // --- FYERS: OCO with leg1 = TARGET, leg2 = STOP (never the other way round) ---
  const fp = fyers.sent('POST', '/api/v3/gtt/orders/sync');
  assert.equal(fp.length, 1, 'one FYERS GTT placed');
  const fb = fp[0].body;
  assert.equal(fb.side, -1);
  assert.equal(fb.symbol, 'NSE:INFY-EQ');
  assert.equal(fb.productType, 'CNC');
  assert.equal(fb.orderInfo.leg1.triggerPrice, 110, 'leg1 is the TARGET');
  assert.equal(fb.orderInfo.leg2.triggerPrice, 95, 'leg2 is the STOP');
  assert.equal(fb.orderInfo.leg1.qty, 10); assert.equal(fb.orderInfo.leg2.qty, 10);
  assert.ok(fb.orderInfo.leg2.price <= 95, 'stop leg limit sits at/below the trigger');
  assert.ok(rows().find(r => r.id === 'f1').fyersGttId, 'row names the new GTT');

  // --- Angel: ONE OCO rule, target in price/triggerprice, SL in stoploss* (probe-proven) ---
  const ap = angel.sent('POST', '/rest/secure/angelbroking/gtt/v1/createRule');
  assert.equal(ap.length, 1, 'one Angel rule created');
  const ab = ap[0].body;
  assert.equal(ab.gttType, 'OCO');
  assert.equal(ab.tradingsymbol, 'INFY-EQ'); assert.equal(ab.symboltoken, '1594'); assert.equal(ab.exchange, 'NSE');
  assert.equal(ab.transactiontype, 'SELL'); assert.equal(ab.producttype, 'DELIVERY');
  assert.equal(Number(ab.triggerprice), 110, 'target leg');
  assert.equal(Number(ab.stoplosstriggerprice), 95, 'stop leg');
  assert.equal(Number(ab.qty), 10);
  assert.ok(rows().find(r => r.id === 'a1').angelOneSlRuleId, 'row names the new rule');
  assert.equal(rows().find(r => r.id === 'a1').angelOneOco, true);

  await enginePass();
  ['z1', 'f1', 'a1'].forEach(id => assert.equal(rows().find(r => r.id === id).engineState, 'PROTECTED', id + ' PROTECTED after the next read'));
});

// ============================================================================
// 2. COST-MOVE: the payload SHAPE per broker (the dangerous writes)
// ============================================================================
test('MOVE_SL_TO_COST x3: Kite restates the two-leg GTT with the target intact; FYERS writes the stop into leg2 and restates leg1 = target; Angel restates the WHOLE OCO', async () => {
  ['z1', 'f1', 'a1'].forEach(id => S.updateOrderLogRow(id, r => ({ ...r, costPct: 1, liveLtp: 101.5 })));
  // the engine reads THIS pass's broker quote first (engineLtpFor) - move the fakes' price too
  [kite, fyers, angel].forEach(b => b.data.holdings.forEach(h => { if (/INFY/.test(h.tradingsymbol || h.symbol)) { h.last_price = 101.5; h.ltp = 101.5; } }));
  await enginePass();

  // Zerodha
  const zm = kite.sent('PUT', '/gtt/triggers/');
  assert.equal(zm.length, 1, 'one Kite modify');
  assert.equal(zm[0].body.type, 'two-leg', 'an OCO row stays two-leg');
  const zc = JSON.parse(zm[0].body.condition), zo = JSON.parse(zm[0].body.orders);
  assert.deepEqual(zc.trigger_values, [100, 110], 'stop to cost, TARGET intact');
  assert.equal(zo.length, 2);
  assert.ok(zc.last_price > 100, 'Kite validates a SELL trigger below last_price: the live price is sent, not the entry');

  // FYERS
  const fm = fyers.sent('PATCH', '/api/v3/gtt/orders/sync');
  assert.equal(fm.length, 1, 'one FYERS modify');
  assert.equal(fm[0].body.orderInfo.leg1.triggerPrice, 110, 'leg1 restated as the TARGET - the stop is NEVER written into leg1');
  assert.equal(fm[0].body.orderInfo.leg2.triggerPrice, 100, 'leg2 = the new stop');
  const fg = fyers.gtt(rows().find(r => r.id === 'f1').fyersGttId);
  assert.equal(fyers.stopOf(fg), 100); assert.equal(fyers.targetOf(fg), 110);

  // Angel
  const am = angel.sent('POST', '/rest/secure/angelbroking/gtt/v1/modifyRule');
  assert.equal(am.length, 1, 'one Angel modify');
  assert.equal(am[0].body.gttType, 'OCO', 'the whole OCO is restated');
  assert.equal(Number(am[0].body.triggerprice), 110, 'target leg restated unchanged');
  assert.equal(Number(am[0].body.stoplosstriggerprice), 100, 'stop leg to cost');
  assert.equal(Number(am[0].body.qty), 10);

  await enginePass();   // every modify believed on the next read
  ['z1', 'f1', 'a1'].forEach(id => {
    const r = rows().find(x => x.id === id);
    assert.equal(r.slPrice, 100, id + ' slPrice verified');
    assert.equal(r.mtmCostDone, true, id + ' cost done');
    assert.equal(r.slPriceOriginal, 95, id + ' original stop preserved');
  });
});

// ============================================================================
// 3. BREACHED STOP: naked + price through the stop -> cancel-first market SELL
// ============================================================================
test('breached stop x3: two sightings through the stop -> the exact MARKET sell per broker, no trigger re-placed', async () => {
  kite.holdSymbol('WIPRO', 4, 93.5); fyers.holdSymbol('WIPRO', 4, 93.5); angel.holdSymbol('WIPRO', 4, 93.5);
  const naked = (broker, extra) => ({ broker, symbol: 'WIPRO', action: 'BUY', qty: 4, entryPrice: 100, price: 100, slPrice: 95, targetPrice: 110, exchange: 'NSE', segment: 'CNC',
    status: 'ENTRY PLACED BUT PROTECTION FAILED: rejected', protectionFailedAt: new Date().toISOString(), liveLtp: 93.5,
    orderTag: 'SK' + broker.toUpperCase().slice(0, 5) + 'TAG0001',   // ORDER TAG: every software sell must carry it
    engineGraceAt: Date.now() - 20 * 60 * 1000, ...now(), ...extra });
  S.writeOrderLog([...rows().filter(r => ['az', 'af', 'aa', 'z1', 'f1', 'a1'].includes(r.id)),
    naked('zerodha', { id: 'z2', orderId: 'ENTRY:ZE2', zerodhaEntryOrderId: 'ZE2', zerodhaGttId: '' }),
    naked('fyers', { id: 'f2', orderId: 'ENTRY:FE2', fyersEntryOrderId: 'FE2', fyersGttId: '' }),
    naked('angelone', { id: 'a2', orderId: 'ENTRY:AE2', angelOneEntryOrderId: 'AE2', angelOneSlRuleId: '' }),
  ]);
  const before = { z: kite.sent('POST', '/orders/regular').length, f: fyers.sent('POST', '/api/v3/orders/sync').length, a: angel.sent('POST', '/rest/secure/angelbroking/order/v1/placeOrder').length };
  await enginePass();   // sighting 1 -> wait
  assert.equal(kite.sent('POST', '/orders/regular').length, before.z, 'never on one tick (Kite)');
  await enginePass();   // sighting 2 -> exit at market

  const zs = kite.sent('POST', '/orders/regular').slice(before.z);
  assert.equal(zs.length, 1, 'Kite: one market sell');
  assert.equal(zs[0].body.transaction_type, 'SELL'); assert.equal(zs[0].body.order_type, 'MARKET');
  assert.equal(zs[0].body.tradingsymbol, 'WIPRO'); assert.equal(Number(zs[0].body.quantity), 4); assert.equal(zs[0].body.product, 'CNC');
  assert.equal(zs[0].body.tag, 'SKZERODTAG0001', 'Kite: the sell carries the row tag'); assert.equal(zs[0].body.validity, 'DAY');

  const fs2 = fyers.sent('POST', '/api/v3/orders/sync').slice(before.f);
  assert.equal(fs2.length, 1, 'FYERS: one market sell');
  assert.equal(fs2[0].body.side, -1); assert.equal(fs2[0].body.type, 2, 'type 2 = MARKET');
  assert.equal(fs2[0].body.symbol, 'NSE:WIPRO-EQ'); assert.equal(fs2[0].body.qty, 4); assert.equal(fs2[0].body.productType, 'CNC');
  assert.equal(fs2[0].body.orderTag, 'SKFYERSTAG0001', 'FYERS: the sell carries the row tag'); assert.equal(fs2[0].body.validity, 'DAY'); assert.equal(fs2[0].body.offlineOrder, false);

  const as = angel.sent('POST', '/rest/secure/angelbroking/order/v1/placeOrder').slice(before.a);
  assert.equal(as.length, 1, 'Angel: one market sell');
  assert.equal(as[0].body.transactiontype, 'SELL'); assert.equal(as[0].body.ordertype, 'MARKET');
  assert.equal(as[0].body.tradingsymbol, 'WIPRO-EQ'); assert.equal(as[0].body.symboltoken, '3787'); assert.equal(Number(as[0].body.quantity), 4);
  assert.equal(as[0].body.producttype, 'DELIVERY');
  assert.equal(as[0].body.ordertag, 'SKANGELTAG0001', 'Angel: the sell carries the row tag'); assert.equal(as[0].body.variety, 'NORMAL'); assert.equal(as[0].body.duration, 'DAY');

  assert.equal(kite.sent('POST', '/gtt/triggers').length, 1, 'no new Kite trigger for a breached position');
  assert.equal(fyers.sent('POST', '/api/v3/gtt/orders/sync').length, 1, 'no new FYERS GTT');
  assert.equal(angel.sent('POST', '/rest/secure/angelbroking/gtt/v1/createRule').length, 1, 'no new Angel rule');
  ['z2', 'f2', 'a2'].forEach(id => assert.equal(rows().find(r => r.id === id).engineState, 'EXIT_PENDING', id + ' EXIT_PENDING'));

  // the fills close them at the real price
  kite.data.holdings = kite.data.holdings.filter(h => h.tradingsymbol !== 'WIPRO');
  fyers.data.holdings = fyers.data.holdings.filter(h => h.symbol !== 'NSE:WIPRO-EQ');
  angel.data.holdings = angel.data.holdings.filter(h => h.tradingsymbol !== 'WIPRO-EQ');
  await enginePass();
  ['z2', 'f2', 'a2'].forEach(id => {
    const r = rows().find(x => x.id === id);
    assert.equal(r.engineState, 'CLOSED', id + ' CLOSED');
    assert.equal(r.exitPrice, 93.5, id + ' at the fill');
    assert.equal(r.realisedPnl, -26, id + ' P&L');
    assert.equal(r.exitEstimated, false);
  });
});

// ============================================================================
// 4. Angel cancel needs id + symboltoken + exchange (the 2026-08-10 lesson)
// ============================================================================
test('Angel dead entry: its standing rule is cancelled WITH symboltoken + exchange (id-only is what Angel refuses), row REJECTED', async () => {
  const orphan = angel.seedRule('INFY', '1594', 95, 110, 3);
  angel.data.orders.push({ orderid: 'AE3', status: 'rejected', orderstatus: 'rejected', transactiontype: 'BUY', tradingsymbol: 'INFY-EQ', quantity: 3, filledshares: 0 });
  angel.data.holdings = angel.data.holdings.filter(h => h.tradingsymbol !== 'INFY-EQ');
  S.writeOrderLog([...rows().filter(r => ['az', 'af', 'aa'].includes(r.id)), {
    id: 'a3', broker: 'angelone', symbol: 'INFY', action: 'BUY', qty: 3, entryPrice: 100, price: 100, slPrice: 95, targetPrice: 110, exchange: 'NSE', segment: 'CNC',
    orderId: 'ENTRY:AE3 | SLGTT:' + orphan, angelOneEntryOrderId: 'AE3', angelOneSlRuleId: orphan, angelOneOco: true,
    engineState: 'ENTRY_DEAD', status: 'ANGEL ENTRY REJECTED', ...now(),
  }]);
  await enginePass();
  const c = angel.sent('POST', '/rest/secure/angelbroking/gtt/v1/cancelRule').filter(x => String(x.body.id) === orphan);
  assert.ok(c.length >= 1, 'a cancel of the orphan was sent');
  assert.equal(c[0].body.symboltoken, '1594', 'symboltoken sent - Angel refuses id-only');
  assert.equal(c[0].body.exchange, 'NSE');
  assert.equal(angel.rule(orphan).status, 'CANCELLED');
  assert.equal(rows().find(r => r.id === 'a3').exitType, 'REJECTED');
});

// ============================================================================
// 5. No-SL (TARGETS_ONLY): a missing target leg is re-placed - Kite + Angel
//    (the only path with ZERO live evidence; FYERS has no No-SL placement)
// ============================================================================
test('No-SL x2: the MISSING target leg is re-placed as a SINGLE trigger, qty = held minus what the live leg covers, at the T2 price', async () => {
  kite.holdSymbol('WIPRO', 10, 101); angel.holdSymbol('WIPRO', 10, 101);
  const zT1 = kite.seedGtt('WIPRO', 103, 0, 4);              // T1 leg standing (single, 4 qty)
  const aT1 = angel.seedRule('WIPRO', '3787', 103, 0, 4);
  const base = { symbol: 'WIPRO', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 0, targetPrice: 106, noSl: true,
    t1Pct: 3, t1Qty: 40, t2Pct: 6, exchange: 'NSE', segment: 'CNC', liveLtp: 101, ...now() };
  S.writeOrderLog([...rows().filter(r => ['az', 'af', 'aa'].includes(r.id)),
    { ...base, id: 'zn', broker: 'zerodha', orderId: 'ENTRY:ZE5 | TGT-T1:' + zT1, zerodhaEntryOrderId: 'ZE5', zerodhaTargetT1Id: zT1, zerodhaTargetT2Id: '', status: 'ZERODHA ENTRY + TARGET GTTS (No-SL)' },
    { ...base, id: 'an', broker: 'angelone', orderId: 'ENTRY:AE5 | TGT-T1:' + aT1, angelOneEntryOrderId: 'AE5', angelTargetT1Id: aT1, angelTargetT2Id: '', status: 'ANGELONE ENTRY + TARGET RULES (No-SL)' },
  ]);
  const before = { z: kite.sent('POST', '/gtt/triggers').length, a: angel.sent('POST', '/rest/secure/angelbroking/gtt/v1/createRule').length };
  await enginePass();

  // Kite: ONE single-type GTT, SELL LIMIT, qty 6 (10 held - 4 covered), trigger 106, LIVE last_price
  const zp = kite.sent('POST', '/gtt/triggers').slice(before.z);
  assert.equal(zp.length, 1, 'Kite: only the missing leg is placed');
  assert.equal(zp[0].body.type, 'single');
  const zc = JSON.parse(zp[0].body.condition), zo = JSON.parse(zp[0].body.orders);
  assert.deepEqual(zc.trigger_values, [106]);
  assert.equal(zc.tradingsymbol, 'WIPRO');
  assert.equal(zc.last_price, 101, 'the LIVE price, so Kite never rejects a target already valid');
  assert.equal(zo.length, 1); assert.equal(zo[0].transaction_type, 'SELL'); assert.equal(zo[0].quantity, 6);
  assert.equal(zo[0].order_type, 'LIMIT'); assert.equal(zo[0].product, 'CNC');
  const zr = rows().find(r => r.id === 'zn');
  assert.equal(zr.engineState, 'TARGETS_ONLY'); assert.ok(zr.zerodhaTargetT2Id, 'new leg id recorded'); assert.match(String(zr.orderId), /TGT-T2:/);

  // Angel: ONE single rule (no gttType OCO), SELL, qty 6, trigger 106, symboltoken present
  const ap = angel.sent('POST', '/rest/secure/angelbroking/gtt/v1/createRule').slice(before.a);
  assert.equal(ap.length, 1, 'Angel: only the missing leg is placed');
  const ab = ap[0].body;
  assert.equal(ab.gttType, undefined, 'a target leg is a plain rule, never an OCO');
  assert.equal(ab.transactiontype, 'SELL'); assert.equal(Number(ab.qty), 6); assert.equal(Number(ab.triggerprice), 106);
  assert.equal(ab.tradingsymbol, 'WIPRO-EQ'); assert.equal(ab.symboltoken, '3787'); assert.equal(ab.exchange, 'NSE');
  assert.equal(ab.producttype, 'DELIVERY');
  const ar = rows().find(r => r.id === 'an');
  assert.equal(ar.engineState, 'TARGETS_ONLY'); assert.ok(ar.angelTargetT2Id, 'new leg id recorded');

  // and once both legs stand, nothing more is placed
  await enginePass();
  assert.equal(kite.sent('POST', '/gtt/triggers').length, before.z + 1);
  assert.equal(angel.sent('POST', '/rest/secure/angelbroking/gtt/v1/createRule').length, before.a + 1);
});

// ============================================================================
// 6. Angel SPLIT after T1: the RUNNER rule alone is restated (YESBANK 18 Aug:
//    this path answered 'unsupported broker angelone' for every post-T1
//    modify - cost move, trail, T1-lock, drift re-assert)
// ============================================================================
test('Angel split post-T1: move-SL-to-T1 restates ONLY the runner OCO rule (T2 kept, stop raised, runner qty), verified next pass', async () => {
  angel.holdSymbol('INFY', 6, 105.6);
  const legB = angel.seedRule('INFY', '1594', 100, 110, 6);   // runner OCO after T1 booked, stop already at cost
  S.writeOrderLog([...rows().filter(r => ['az', 'af', 'aa'].includes(r.id)), {
    id: 'as1', broker: 'angelone', symbol: 'INFY', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 100, targetPrice: 110,
    t1Pct: 5, t1Qty: 40, t2Pct: 10, slToT1Pct: 0.5, splitT1: true, angelSplit: true, splitLegAQty: 4, splitLegBQty: 6,
    mtmT1Done: true, mtmCostDone: true, exchange: 'NSE', segment: 'CNC',
    orderId: 'ENTRY:AE7 | SLGTT:' + legB, angelOneEntryOrderId: 'AE7', angelOneSlRuleId: legB, angelOneGttT1Id: '', angelOneOco: true,
    liveLtp: 105.6, status: 'ANGEL ENTRY + 2x GTT OCO (T1/T2 split)', ...now(),
  }]);
  const before = angel.sent('POST', '/rest/secure/angelbroking/gtt/v1/modifyRule').length;
  await enginePass();
  const mods = angel.sent('POST', '/rest/secure/angelbroking/gtt/v1/modifyRule').slice(before);
  assert.equal(mods.length, 1, 'exactly one rule modified - the runner');
  const m = mods[0].body;
  assert.equal(String(m.id), legB);
  assert.equal(m.gttType, 'OCO', 'the whole OCO is restated');
  assert.equal(Number(m.triggerprice), 110, 'T2 target leg kept');
  assert.equal(Number(m.stoplosstriggerprice), 105, 'stop locked at T1');
  assert.equal(Number(m.qty), 6, 'runner qty only');
  assert.equal(m.symboltoken, '1594'); assert.equal(m.exchange, 'NSE');
  const r0 = rows().find(r => r.id === 'as1');
  assert.ok(!/unsupported/i.test(String(r0.lastTrailError || '')), 'no "unsupported broker" error on the row');
  await enginePass();
  const r = rows().find(x => x.id === 'as1');
  assert.equal(r.mtmSlT1Done, true);
  assert.equal(r.slPrice, 105);
});

test('Angel split PRE-T1: the cost trigger restates BOTH OCO rules (each with its own qty and target), stop to cost on both', async () => {
  angel.holdSymbol('WIPRO', 10, 101.5);
  const legA = angel.seedRule('WIPRO', '3787', 95, 105, 4);
  const legB = angel.seedRule('WIPRO', '3787', 95, 110, 6);
  S.writeOrderLog([...rows().filter(r => ['az', 'af', 'aa'].includes(r.id)), {
    id: 'as2', broker: 'angelone', symbol: 'WIPRO', action: 'BUY', qty: 10, entryPrice: 100, price: 100, slPrice: 95, targetPrice: 110,
    t1Pct: 5, t1Qty: 40, t2Pct: 10, costPct: 1, splitT1: true, angelSplit: true, splitLegAQty: 4, splitLegBQty: 6,
    exchange: 'NSE', segment: 'CNC', orderId: 'ENTRY:AE8 | T1GTT:' + legA + ' | SLGTT:' + legB, angelOneEntryOrderId: 'AE8',
    angelOneSlRuleId: legB, angelOneGttT1Id: legA, angelOneOco: true, liveLtp: 101.5,
    status: 'ANGEL ENTRY + 2x GTT OCO (T1/T2 split)', ...now(),
  }]);
  const before = angel.sent('POST', '/rest/secure/angelbroking/gtt/v1/modifyRule').length;
  await enginePass();
  const mods = angel.sent('POST', '/rest/secure/angelbroking/gtt/v1/modifyRule').slice(before);
  assert.equal(mods.length, 2, 'both rules modified');
  const byId = Object.fromEntries(mods.map(m => [String(m.body.id), m.body]));
  assert.equal(Number(byId[legA].qty), 4); assert.equal(Number(byId[legA].triggerprice), 105, 'T1 leg keeps T1');
  assert.equal(Number(byId[legB].qty), 6); assert.equal(Number(byId[legB].triggerprice), 110, 'runner keeps T2');
  [legA, legB].forEach(id => { assert.equal(Number(byId[id].stoplosstriggerprice), 100, 'stop to cost'); assert.equal(byId[id].gttType, 'OCO'); });
  await enginePass();
  assert.equal(rows().find(r => r.id === 'as2').mtmCostDone, true);
});

// ============================================================================
// 7. An ENGINE-closed row is NOT re-touched by the generic legacy refresher
//    (ARIS/ATULAUTO/FEDFINA 2026-08-19: engine CLOSED with a real price, a
//    refresh 2 min later blanked exitPrice because the row had gone unowned)
// ============================================================================
test('a row the engine closed keeps its price when the legacy refresher runs (ownership persists post-close)', async () => {
  // Angel row the engine already closed today with a real fill price. The
  // broker order book has NO fill for it (filled on an earlier day - Angel's
  // book is today-only), exactly the condition that produced the blank.
  const closed = {
    id: 'clo1', broker: 'angelone', symbol: 'ARIS', action: 'BUY', qty: 3, entryPrice: 135.6,
    slPrice: 135.6, targetPrice: 139.7, exchange: 'NSE', segment: 'CNC',
    orderId: 'ENTRY:AE100 | T1GTT:9461602 | SLGTT:9461603', angelOneEntryOrderId: 'AE100', angelOneSlRuleId: '9461603', angelOneGttT1Id: '9461602',
    exitType: 'EXITED', result: 'EXITED', exitPrice: 134.71, realisedPnl: 1.96, exitEstimated: false,
    status: 'ANGELONE EXITED (split) [engine]', reconciledAt: new Date().toISOString(),
    time: new Date().toLocaleString(), recordedAt: new Date().toISOString(),
  };
  S.writeOrderLog([...anchorRows(), closed]);
  await new Promise(res => S.refreshBrokerOrderLogStatuses(() => res()));
  await wait(200);
  const r = rows().find(x => x.id === 'clo1');
  assert.equal(r.exitType, 'EXITED', 'still closed');
  assert.equal(r.exitPrice, 134.71, 'the engine-written price survives the refresh');
  assert.equal(r.realisedPnl, 1.96, 'and its P&L');
  assert.ok(!/Broker closed this position/.test(String(r.reconcileNote || '')), 'the legacy note-writer did not stamp it');
});
