#!/usr/bin/env node
/* Read-only consistency audit: the order log against itself, and open rows
 * against what the broker actually holds (Dhan: Forever orders + holdings).
 *
 * Prints findings by severity and writes NOTHING - safe to run any time,
 * server up or down.
 *
 *   node scripts/audit-log.js
 *
 * CRITICAL = money protection may be wrong (naked position, qty mismatch,
 *            LIMIT-era stop leg). WARN = record inconsistency worth fixing.
 * INFO = context. Exit code 2 on any CRITICAL, 1 on WARN-only, 0 clean.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = process.env.STOCKKAR_DATA_DIR || path.join(__dirname, '..');
const readJson = f => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; } };
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

const findings = { CRITICAL: [], WARN: [], INFO: [] };
const add = (sev, msg) => findings[sev].push(msg);

function rowState(r) {
  const s = (String(r.status || '') + ' ' + String(r.exitType || r.result || '')).toUpperCase();
  if (['ERROR', 'SKIPPED', 'N/A'].includes(String(r.orderId || '').toUpperCase())) return 'rejected';
  if (r.manualClose || /TARGET HIT|SL HIT|EXITED|CLOSED/.test(s)) return 'closed';
  if (/REJECT|CANCEL|FAIL|INVALID|SECURITY ID NOT FOUND/.test(s)) return 'rejected';
  return 'open';
}
const tag = r => (r.symbol || '?') + '#' + String(r.id || '').slice(-6);

// ---------------- A. the log against itself ---------------------------------
function auditInternal(rows) {
  const ids = new Map();
  rows.forEach(r => ids.set(r.id, (ids.get(r.id) || 0) + 1));
  [...ids].filter(([, n]) => n > 1).forEach(([id, n]) => add('CRITICAL', 'duplicate row id ' + id + ' x' + n));

  const now = Date.now();
  let closed = 0, open = 0, rejected = 0, undated = 0;
  rows.forEach(r => {
    const st = rowState(r);
    if (st === 'rejected') { rejected++;
      if (num(r.realisedPnl) !== null && num(r.realisedPnl) !== 0) add('WARN', tag(r) + ' rejected but carries realisedPnl ' + r.realisedPnl);
      return;
    }
    const qty = num(r.qty), entry = num(r.entryPrice ?? r.price), exit = num(r.exitPrice);
    const pnl = num(r.realisedPnl ?? r.realizedPnl);
    if (st === 'closed') {
      closed++;
      if (!r.closedAt && !r.testClosedAt) undated++;
      if (pnl === null) add('WARN', tag(r) + ' closed with no realisedPnl (excluded from every P&L figure)');
      // pnl should reconcile with prices x qty (both were scaled together, so
      // this still holds on scaled rows). Split/partial books legitimately
      // differ, so only whole-position rows are held to it.
      if (pnl !== null && qty && entry && exit && !r.splitT1 && !r.mtmT1Done) {
        const expect = (exit - entry) * qty;
        const dv = Math.abs(expect - pnl);
        if (dv > Math.max(1, Math.abs(expect) * 0.02)) add('WARN', tag(r) + ' realisedPnl ' + pnl + ' vs (exit-entry)xqty ' + expect.toFixed(2) + ' - drift ' + dv.toFixed(2));
      }
      if (r.unrealisedPnl !== undefined && r.unrealisedPnl !== '' && r.unrealisedPnl !== null) add('WARN', tag(r) + ' closed but still carries unrealisedPnl ' + r.unrealisedPnl);
      if (r.qtyScaledBy) {
        const pre = r.preScale || {};
        if (num(pre.qty) !== null && Math.abs(num(pre.qty) * r.qtyScaledBy - qty) > 0.01) add('WARN', tag(r) + ' scaled row: qty ' + qty + ' != preScale.qty x' + r.qtyScaledBy);
      }
      const age = now - new Date(r.closedAt || r.testClosedAt || r.recordedAt || now).getTime();
      if (age > 366 * 86400000) add('INFO', tag(r) + ' closed >1yr ago - due for retention prune');
    } else {
      open++;
      if (exit !== null || pnl !== null) add('WARN', tag(r) + ' open but carries exit fields (exitPrice ' + exit + ', pnl ' + pnl + ')');
      if (r.qtyScaledBy) add('CRITICAL', tag(r) + ' OPEN row has qtyScaledBy - open rows must never be scaled');
      const sl = num(r.slPrice);
      const noSl = /No stop-loss/i.test(String(r.exitCriteria || '')) || r.noSl;
      if (!noSl && (sl === null || sl <= 0)) add('WARN', tag(r) + ' open with no slPrice recorded');
      if (sl && entry && sl > entry * 1.5) add('WARN', tag(r) + ' open slPrice ' + sl + ' is far above entry ' + entry + ' (suspicious)');
      if (r.awaitingFill && now - new Date(r.recordedAt || 0).getTime() > 86400000) add('WARN', tag(r) + ' awaitingFill for >1 day');
      if (r.splitT1) {
        const a = num(r.splitLegAQty) || 0, b = num(r.splitLegBQty) || 0;
        if (qty && a + b !== qty && !r.mtmT1Done) add('WARN', tag(r) + ' split legs ' + a + '+' + b + ' != qty ' + qty);
      }
      if (r.mtmSlT1Done && !r.mtmT1Done) add('WARN', tag(r) + ' mtmSlT1Done without mtmT1Done');
      if (r.mtmT2Done) add('WARN', tag(r) + ' open but mtmT2Done set');
    }
  });
  add('INFO', 'rows: ' + rows.length + ' total - ' + closed + ' closed, ' + open + ' open, ' + rejected + ' rejected'
    + (undated ? ' - ' + undated + ' closed row(s) missing close date (excluded from drawdown)' : ''));
  return rows.filter(r => rowState(r) === 'open');
}

// ---------------- B. open rows against Dhan ---------------------------------
function dhanGet(pathName, token) {
  return new Promise((resolve, reject) => {
    https.get({ hostname: 'api.dhan.co', path: pathName, headers: { 'access-token': token } }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(pathName + ' HTTP ' + res.statusCode + ': ' + d.slice(0, 160)));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(pathName + ' bad JSON')); }
      });
    }).on('error', reject);
  });
}
const normSym = s => String(s || '').replace('NSE:', '').replace(/[-\s]EQ$/i, '').replace(/\s/g, '').toUpperCase();

async function auditDhan(openRows) {
  const store = readJson('dhan_token.json');
  if (!store?.token) { add('INFO', 'Dhan: no token file in ' + DATA_DIR + ' - broker checks skipped'); return; }
  let forever = [], holdings = [];
  try { const f = await dhanGet('/v2/forever/all', store.token); forever = Array.isArray(f) ? f : f.data || []; }
  catch (e) { add('WARN', 'Dhan forever fetch failed: ' + e.message + ' - broker checks incomplete'); return; }
  try { const h = await dhanGet('/v2/holdings', store.token); holdings = Array.isArray(h) ? h : h.data || []; }
  catch (e) { add('INFO', 'Dhan holdings fetch failed: ' + e.message); }

  const pending = forever.filter(o => /PENDING|CONFIRM/i.test(String(o.orderStatus || '')));
  add('INFO', 'Dhan: ' + forever.length + ' Forever order(s), ' + pending.length + ' pending, ' + holdings.length + ' holding(s)');

  // pre-June-24 era LIMIT stop legs still live at the broker (HEALTHX class)
  pending.filter(o => String(o.orderType || '').toUpperCase() === 'LIMIT' && Number(o.price) > 0
      && Math.abs(Number(o.price) - Number(o.triggerPrice)) / (Number(o.triggerPrice) || 1) < 0.03)
    .forEach(o => add('CRITICAL', 'Dhan pending Forever ' + (o.tradingSymbol || o.securityId)
      + ' is LIMIT at its trigger (' + o.price + '/' + o.triggerPrice + ') - HEALTHX-class stuck-exit risk; modify to MARKET'));

  const dhanOpen = openRows.filter(r => String(r.broker || 'dhan').toLowerCase() === 'dhan' && !r.testMode && r.source !== 'test' && !r.awaitingFill);
  const bySym = {};
  pending.forEach(o => { const k = normSym(o.tradingSymbol || ''); (bySym[k] = bySym[k] || []).push(o); });

  dhanOpen.forEach(r => {
    const k = normSym(r.symbol);
    const legs = bySym[k] || [];
    if (!legs.length) { add('CRITICAL', tag(r) + ' open LIVE row has NO pending Forever at Dhan - possibly naked (verify in app/broker)'); return; }
    const legQty = legs.reduce((a, o) => a + (Number(o.quantity) || 0) + (Number(o.quantity1) || 0), 0);
    const want = num(r.mtmT1Done ? r.splitLegBQty || r.mtmRemainingQty || r.qty : r.qty) || 0;
    if (want && legQty < want) add('CRITICAL', tag(r) + ' Forever protects qty ' + legQty + ' but row holds ' + want);
    if (want && legQty > want * 2) add('WARN', tag(r) + ' Forever qty ' + legQty + ' far exceeds row qty ' + want + ' (duplicate legs?)');
    const rowSl = num(r.brokerSlPrice) || num(r.slPrice);
    const trigs = legs.map(o => Number(o.triggerPrice) || 0).filter(Boolean);
    if (rowSl && trigs.length && !trigs.some(t => Math.abs(t - rowSl) / rowSl < 0.02)) {
      add('WARN', tag(r) + ' row stop ' + rowSl + ' matches no Forever trigger [' + trigs.join(', ') + '] - drift?');
    }
  });

  // orphan protections: pending Forever with no open row (closed manually?)
  Object.keys(bySym).forEach(k => {
    if (!dhanOpen.some(r => normSym(r.symbol) === k)) add('WARN', 'Dhan pending Forever for ' + k + ' has no open row in the log (orphan protection - cancel it or reconcile)');
  });

  // holdings without any open row (bought outside the algo, or log lost it)
  holdings.forEach(h => {
    const k = normSym(h.tradingSymbol || h.symbol || '');
    const q = Number(h.totalQty ?? h.quantity ?? 0);
    if (q > 0 && !dhanOpen.some(r => normSym(r.symbol) === k)) add('INFO', 'Dhan holding ' + k + ' x' + q + ' has no open row (manual buy or external)');
  });
}

// ---------------- run --------------------------------------------------------
(async () => {
  const rows = readJson('order_log.json');
  if (!Array.isArray(rows)) { console.error('Cannot read order_log.json in ' + DATA_DIR); process.exit(1); }
  const openRows = auditInternal(rows);
  await auditDhan(openRows);
  const zt = readJson('broker_tokens.json');
  if (zt && (zt.zerodha || zt.fyers)) add('INFO', 'Zerodha/FYERS tokens present - broker-side check for them not implemented yet (Dhan only)');

  let code = 0;
  ['CRITICAL', 'WARN', 'INFO'].forEach(sev => {
    if (!findings[sev].length) return;
    console.log('\n=== ' + sev + ' (' + findings[sev].length + ') ===');
    findings[sev].forEach(m => console.log('  ' + (sev === 'CRITICAL' ? '!! ' : '- ') + m));
    if (sev === 'CRITICAL') code = 2; else if (sev === 'WARN' && code === 0) code = 1;
  });
  if (!findings.CRITICAL.length && !findings.WARN.length) console.log('\nAll checks passed - log and broker are consistent.');
  process.exit(code);
})();
