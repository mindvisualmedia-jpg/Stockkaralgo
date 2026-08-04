#!/usr/bin/env node
/**
 * scripts/audit-pnl.js — P&L truth across three surfaces: ORDER LOG, DASHBOARD,
 * BROKER (Dhan tradebook). READ-ONLY: fetches and compares, changes nothing.
 *
 *   node scripts/audit-pnl.js            # last 7 days of broker fills
 *   node scripts/audit-pnl.js --days 30  # wider tradebook window
 *
 * What each surface IS (so the comparison is honest):
 *   ORDER LOG  stored realisedPnl per closed row = (exit - entry) x qty, GROSS.
 *   DASHBOARD  sum of realisedPnl over rows it classes as closed. Same data,
 *              so log vs dashboard can only diverge via classification/blanks.
 *   BROKER     actual fills from /v2/trades. Gross-vs-gross comparable; the
 *              broker's NET P&L additionally subtracts charges the API does not
 *              expose (STT, stamp, DP, GST...) - reported here as an ESTIMATE,
 *              clearly labelled.
 *
 * Checks, per closed non-test row in the window:
 *   A  internal: stored realisedPnl vs (exitPrice - entryPrice) x qty
 *   B  broker:   stored realisedPnl vs recomputed from ACTUAL sell fills
 *   C  entry:    logged entryPrice vs broker weighted-avg BUY fill
 *   D  flags:    exitEstimated never corrected; blank pnl on closed rows
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = process.env.STOCKKAR_DATA_DIR || path.join(__dirname, '..');
const args = process.argv.slice(2);
const DAYS = Math.max(1, Number(args[args.indexOf('--days') + 1]) || 7);

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const r2 = v => Number(num(v).toFixed(2));
const norm = s => String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
const money = v => (v >= 0 ? '+' : '-') + 'Rs.' + Math.abs(r2(v)).toLocaleString('en-IN');

function readJson(f) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; } }

function getJson(token, pathname) {
  return new Promise((resolve) => {
    const req = https.request({ hostname: 'api.dhan.co', port: 443, path: pathname, method: 'GET',
      headers: { 'access-token': token, 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        let p; try { p = JSON.parse(d); } catch { p = null; }
        if (res.statusCode === 404) return resolve([]);
        if (res.statusCode >= 400) return resolve({ __err: 'HTTP ' + res.statusCode + ' ' + pathname + ' ' + String(d).slice(0, 120) });
        resolve(Array.isArray(p) ? p : (Array.isArray(p && p.data) ? p.data : []));
      });
    });
    req.on('error', e => resolve({ __err: e.message }));
    req.setTimeout(20000, () => { req.destroy(); resolve({ __err: 'timeout' }); });
    req.end();
  });
}

// Merge trades per ORDER id (one sell order fills as many trades: qty summed,
// price weighted) - same rule the server's reconciler uses, for the same reason.
function mergeFills(trades, side) {
  const byOrder = new Map();
  (trades || []).forEach(t => {
    if (String(t.transactionType || t.transaction_type || '').toUpperCase() !== side) return;
    const rec = {
      orderId: String(t.orderId || t.orderid || '').trim(),
      algoId: String(t.algoId || t.algoid || '').trim(),
      sym: norm(t.tradingSymbol || t.symbol || t.customSymbol),
      q: num(t.tradedQuantity || t.tradedQty || t.quantity || t.filledQty),
      px: num(t.tradedPrice || t.price || t.averageTradedPrice),
      at: Date.parse(t.exchangeTime || t.tradeDate || t.updateTime || t.createTime || '') || 0,
    };
    if (!rec.sym || !(rec.q > 0) || !(rec.px > 0)) return;
    const key = rec.orderId || (rec.sym + '|' + rec.at + '|' + rec.px);
    const cur = byOrder.get(key);
    if (!cur) { byOrder.set(key, rec); return; }
    const q = cur.q + rec.q;
    cur.px = ((cur.px * cur.q) + (rec.px * rec.q)) / q;
    cur.q = q; cur.at = Math.max(cur.at, rec.at);
  });
  return [...byOrder.values()];
}

// Delivery charge ESTIMATE per closed trade (Dhan CNC, 2026 schedule; labelled
// estimate everywhere it is printed): STT 0.1% each side + stamp 0.015% on buy
// + exchange 0.00297% each side + SEBI 0.0001% + DP ~Rs.15 on the sell day.
function estCharges(entryPx, exitPx, qty) {
  const buy = entryPx * qty, sell = exitPx * qty;
  return r2(buy * 0.001 + sell * 0.001 + buy * 0.00015 + (buy + sell) * 0.0000297 + (buy + sell) * 0.000001 + 15);
}

(async () => {
  const log = readJson('order_log.json');
  const store = readJson('dhan_token.json');
  if (!log) { console.log('No order_log.json in ' + DATA_DIR); process.exit(1); }

  const now = Date.now();
  const winStart = now - DAYS * 86400000;
  const closedAt = e => Date.parse(e.reconciledAt || e.exitCorrectedAt || e.lastStatusCheckAt || e.recordedAt || e.time || '') || 0;
  const isClosed = e => !e.testMode && e.source !== 'test' && e.exitType && !/REJECT|CANCEL/.test(String(e.exitType).toUpperCase());

  const allClosed = log.filter(isClosed);
  const windowRows = allClosed.filter(e => closedAt(e) >= winStart);

  // ---- DASHBOARD surface: exactly the sum index.html computes --------------
  const dashPnls = allClosed.map(e => Number(e.realisedPnl ?? e.realizedPnl)).filter(Number.isFinite);
  const dashBlank = allClosed.length - dashPnls.length;

  console.log('=====================================================================');
  console.log(' P&L AUDIT  window=' + DAYS + 'd   log rows=' + log.length + '  closed(all-time)=' + allClosed.length);
  console.log('=====================================================================');
  console.log('\n--- SURFACE 1+2: ORDER LOG vs DASHBOARD (same data, classification only)');
  console.log('  dashboard net (all-time, sum of realisedPnl): ' + money(dashPnls.reduce((a, b) => a + b, 0)));
  if (dashBlank) console.log('  !! ' + dashBlank + ' closed rows have BLANK realisedPnl -> in the trade count but NOT in the total');

  // A: internal consistency - does (exit-entry)*qty match what is stored?
  let aMismatch = 0;
  allClosed.forEach(e => {
    const stored = Number(e.realisedPnl ?? e.realizedPnl);
    const ep = num(e.entryPrice || e.price), xp = num(e.exitPrice), q = num(e.qty);
    if (!Number.isFinite(stored) || !ep || !xp || !q) return;
    const recomputed = r2((xp - ep) * q);
    if (Math.abs(recomputed - stored) > Math.max(1, Math.abs(stored) * 0.005)) {
      aMismatch++;
      console.log('  [A] ' + norm(e.symbol) + '  stored=' + money(stored) + '  (exit-entry)x qty=' + money(recomputed)
        + (e.splitT1 ? '  [split: exitPrice is one leg, pnl is both - EXPECTED]' : '  [investigate]'));
    }
  });
  if (!aMismatch) console.log('  [A] every closed row: displayed prices agree with stored P&L');

  const est = allClosed.filter(e => e.exitEstimated && !e.exitCorrectedAt);
  if (est.length) {
    console.log('  [D] ' + est.length + ' closed rows are ESTIMATES never corrected from the tradebook:');
    est.slice(0, 15).forEach(e => console.log('      - ' + norm(e.symbol) + ' ' + e.exitType + ' @' + e.exitPrice
      + ' pnl=' + money(Number(e.realisedPnl) || 0) + '  (assumed trigger price; real fill unknown'
      + (closedAt(e) < now - 7 * 86400000 ? ', >7d old so auto-correction can no longer see it' : '') + ')'));
  } else {
    console.log('  [D] no uncorrected estimated exits');
  }

  // ---- SURFACE 3: BROKER --------------------------------------------------
  if (!store || !store.token) { console.log('\n--- SURFACE 3: BROKER — skipped (no dhan_token.json)'); return; }
  const toD = new Date().toLocaleDateString('en-CA');
  const fromD = new Date(now - DAYS * 86400000).toLocaleDateString('en-CA');
  let trades = [];
  for (let page = 0; page < 20; page++) {                 // paged: page 0 alone truncates busy weeks
    const chunk = await getJson(store.token, '/v2/trades/' + fromD + '/' + toD + '/' + page);
    if (chunk && chunk.__err) { console.log('\n--- SURFACE 3: BROKER — tradebook error: ' + chunk.__err); return; }
    if (!Array.isArray(chunk) || !chunk.length) break;
    trades = trades.concat(chunk);
  }
  const today = await getJson(store.token, '/v2/trades');
  if (Array.isArray(today)) trades = trades.concat(today);

  const sells = mergeFills(trades, 'SELL');
  const buys = mergeFills(trades, 'BUY');
  console.log('\n--- SURFACE 3: BROKER (Dhan tradebook ' + fromD + ' -> ' + toD + ')  buys=' + buys.length + ' sells=' + sells.length);

  const dhanRows = windowRows.filter(e => String(e.broker || 'dhan').toLowerCase() === 'dhan');
  let bMatch = 0, bDiff = 0, cDiff = 0, grossLog = 0, grossBroker = 0, chargesEst = 0;
  const usedSell = new Set();
  dhanRows.forEach(e => {
    const sym = norm(e.symbol), q = num(e.qty);
    const ep = num(e.entryPrice || e.price);
    const stored = Number(e.realisedPnl ?? e.realizedPnl);
    const rowStart = Date.parse(e.createdAt || e.recordedAt || e.time || '') || 0;
    // leg-id attribution first (algoId on a fill = the Forever leg that placed it)
    const fids = new Set();
    [e.dhanForeverId, e.dhanForeverT1Id].forEach(v => { if (v) fids.add(String(v).trim()); });
    let m; const re = /FOREVER(?:-T1)?:([^|\s]+)/gi;
    while ((m = re.exec(String(e.orderId || '')))) fids.add(m[1].trim());
    let fills = sells.filter(s => !usedSell.has(s.orderId) && s.algoId && fids.has(s.algoId));
    let how = 'leg-id';
    if (!fills.length) { fills = sells.filter(s => !usedSell.has(s.orderId) && s.sym === sym && s.at >= rowStart); how = 'symbol+time'; }
    if (!fills.length) { console.log('  [B] ' + sym + '  no broker fills found in window (closed earlier, manual, or window too short)'); return; }
    fills.forEach(f => usedSell.add(f.orderId));

    const soldQ = fills.reduce((s, f) => s + f.q, 0);
    const brokerPnl = r2(fills.reduce((s, f) => s + (f.px - ep) * f.q, 0));
    const buy = buys.find(b => b.sym === sym && Math.abs(b.at - rowStart) < 3 * 86400000);
    if (buy && Math.abs(buy.px - ep) > Math.max(0.05, ep * 0.001)) {
      cDiff++;
      console.log('  [C] ' + sym + '  logged entry ' + ep + ' vs broker avg BUY ' + r2(buy.px)
        + '  -> pnl shifts ' + money(r2((ep - buy.px) * q)));
    }
    if (Number.isFinite(stored)) { grossLog += stored; }
    grossBroker += brokerPnl;
    chargesEst += estCharges(buy ? buy.px : ep, soldQ ? fills.reduce((s, f) => s + f.px * f.q, 0) / soldQ : ep, q);
    if (!Number.isFinite(stored) || Math.abs(brokerPnl - stored) > Math.max(1, Math.abs(brokerPnl) * 0.005)) {
      bDiff++;
      console.log('  [B] ' + sym + '  log=' + (Number.isFinite(stored) ? money(stored) : 'BLANK')
        + '  broker-fills=' + money(brokerPnl) + '  (' + how + ', sold ' + soldQ + '/' + q + ')'
        + (e.exitEstimated ? '  [row is an ESTIMATE - this is the real number]' : ''));
    } else { bMatch++; }
  });

  console.log('\n--- TOTALS over the window (Dhan rows: ' + dhanRows.length + ')');
  console.log('  order log / dashboard gross : ' + money(grossLog));
  console.log('  broker fills gross          : ' + money(grossBroker));
  console.log('  difference (gross vs gross) : ' + money(r2(grossBroker - grossLog)) + '   <- slippage + estimates + entry-price drift');
  console.log('  charges ESTIMATE (delivery) : -' + money(chargesEst).slice(1) + '   <- why broker CONSOLE net is lower than all of the above');
  console.log('  rows matching broker exactly: ' + bMatch + '  | differing: ' + bDiff + '  | entry-price drift: ' + cDiff);
  console.log('\n  NOTE: fills the log never saw (manual trades in the Dhan app) are in the');
  console.log('  broker number but can never be in the log/dashboard - list any [B] "no');
  console.log('  broker fills" + unmatched sells below to see them.');
  const orphans = sells.filter(s => !usedSell.has(s.orderId));
  if (orphans.length) {
    console.log('\n--- SELL fills at the broker NOT matched to any log row (manual / unknown):');
    orphans.forEach(s => console.log('  ' + s.sym + '  ' + s.q + ' @ ' + r2(s.px) + '  ' + (s.at ? new Date(s.at).toISOString().slice(0, 10) : '')));
  }
})();
