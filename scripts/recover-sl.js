#!/usr/bin/env node
/* Recover the ORIGINAL stop-loss for trades whose slPrice was overwritten by
 * move-SL-to-cost (fixed forward in 2.64.0-staging.4; this repairs older rows).
 *
 * How: each row's exitCriteria stores the stop RULE ("SL 3% below ema20" or
 * "SL 2% below entry"). Percent-below-entry stops recompute exactly. Indicator
 * stops recompute from Dhan historical daily candles: EMA/SMA as of the entry
 * date, minus the stored percent.
 *
 * Standalone on purpose - imports NOTHING from server.js (requiring server.js
 * would start the trading server). Touches no live feature: it only ever
 * writes the slPriceOriginal field, which nothing but the "Loss saved" tile
 * reads.
 *
 * Modes:
 *   node scripts/recover-sl.js --validate   read-only: recompute rows whose true
 *                                           original SL survived; print error table.
 *                                           Run this FIRST - it proves accuracy.
 *   node scripts/recover-sl.js              dry-run: show what would be recovered.
 *   node scripts/recover-sl.js --apply      write slPriceOriginal (+Estimated flag).
 *                                           Refuses while the server is running.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const net = require('net');

const DATA_DIR = process.env.STOCKKAR_DATA_DIR || path.join(__dirname, '..');
const ORDER_LOG_FILE = path.join(DATA_DIR, 'order_log.json');
const DHAN_TOKEN_FILE = path.join(DATA_DIR, 'dhan_token.json');
const PORT = Number(process.env.PORT || 7777);
const MODE = process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--validate') ? 'validate' : 'dry-run';

// EMA at the entry may have been read off the still-forming daily bar, so both
// variants are computed; --validate reports which one matches reality better.
const round2 = n => Math.round(n * 100) / 100;

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }

function istDateOf(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  return new Date(t + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

// ---- row classification (mirrors the frontend rules, no imports) -----------
function isClosed(r) {
  const s = (String(r.status || '') + ' ' + String(r.exitType || r.result || '')).toUpperCase();
  if (['ERROR', 'SKIPPED', 'N/A'].includes(String(r.orderId || '').toUpperCase())) return false;
  if (/REJECT|CANCEL|FAIL|INVALID/.test(s)) return false;
  return !!r.manualClose || /TARGET HIT|SL HIT|EXITED|CLOSED/.test(s);
}
function closedAtCost(r) {
  return isClosed(r) && !!(r.mtmCostDone || r.splitCostDone)
    && /SL HIT|EXITED/.test(String(r.exitType || r.result || '').toUpperCase());
}
function parseStopRule(r) {
  const txt = String(r.exitCriteria || '');
  let m = txt.match(/SL\s+([\d.]+)%\s+below\s+entry/i);
  if (m) return { kind: 'entry', pct: Number(m[1]) };
  m = txt.match(/SL\s+([\d.]+)%\s+below\s+(ema|sma)\s*(\d+)/i);
  if (m) return { kind: m[2].toLowerCase(), pct: Number(m[1]), period: Number(m[3]) };
  return null;
}

// ---- Dhan API --------------------------------------------------------------
function httpsJson(opts, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error('HTTP ' + res.statusCode + ': ' + d.slice(0, 200)));
        try { resolve(JSON.parse(d)); } catch (e) { reject(new Error('bad JSON: ' + d.slice(0, 120))); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => res.statusCode >= 400 ? reject(new Error('HTTP ' + res.statusCode)) : resolve(d));
    }).on('error', reject);
  });
}

// same column logic as server.js loadEquityInstrumentMap, trimmed to NSE/BSE equity
function parseCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
async function loadSecurityMap() {
  const csv = await fetchText('https://images.dhan.co/api-data/api-scrip-master-detailed.csv');
  const lines = csv.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines.shift() || '').map(h => h.trim());
  const idx = names => names.map(n => headers.indexOf(n)).find(i => i >= 0);
  const iSec = idx(['SECURITY_ID', 'SEM_SMST_SECURITY_ID']);
  const symIdx = ['UNDERLYING_SYMBOL', 'SM_SYMBOL', 'SYMBOL_NAME', 'TRADING_SYMBOL']
    .map(n => headers.indexOf(n)).filter(i => i >= 0);
  const iExch = idx(['EXCH_ID', 'EXCHANGE']), iSeg = idx(['SEGMENT']), iSeries = idx(['SERIES']);
  const map = {};
  lines.forEach(line => {
    const row = parseCsvLine(line);
    const symbol = String(symIdx.map(i => row[i]).find(Boolean) || '').replace(/\s/g, '').toUpperCase();
    const sec = String(row[iSec] || '').trim();
    const exch = String(row[iExch] || '').toUpperCase();
    const seg = String(row[iSeg] || '').toUpperCase();
    const series = String(row[iSeries] || '').toUpperCase();
    if (!symbol || !sec) return;
    if (exch && !['NSE', 'NSE_EQ', 'BSE', 'BSE_EQ'].includes(exch)) return;
    if (seg && !['E', 'EQ', 'NSE_EQ', 'BSE_EQ'].includes(seg)) return;
    const key = exch.startsWith('BSE') ? 'BSE' : 'NSE';
    if (!map[symbol] || key === 'NSE' || series === 'EQ') map[symbol] = sec;
  });
  return map;
}

async function fetchDailyCandles(token, securityId, fromDate, toDate) {
  const body = JSON.stringify({
    securityId: String(securityId), exchangeSegment: 'NSE_EQ', instrument: 'EQUITY',
    expiryCode: 0, oi: false, fromDate, toDate,
  });
  const res = await httpsJson({
    hostname: 'api.dhan.co', port: 443, path: '/v2/charts/historical', method: 'POST',
    headers: { 'access-token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, body);
  const close = res.close || [], ts = res.timestamp || [];
  return ts.map((t, i) => ({ date: istDateOf(new Date(t * 1000).toISOString()), close: Number(close[i]) }))
    .filter(c => c.date && Number.isFinite(c.close));
}

function emaAt(closes, period) {
  if (closes.length < period) return null;
  let v = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;   // SMA seed
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return v;
}
function smaAt(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// indicator value as of entryDate; withToday=true includes the entry day's bar
// (matches a scan read off the forming candle), false stops at the prior close.
function indicatorAsOf(candles, entryDate, kind, period, withToday) {
  const upto = candles.filter(c => withToday ? c.date <= entryDate : c.date < entryDate).map(c => c.close);
  if (upto.length < period + 30) return null;                     // need convergence headroom
  return kind === 'sma' ? smaAt(upto, period) : emaAt(upto, period);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function serverRunning() {
  return new Promise(resolve => {
    const s = net.connect({ host: '127.0.0.1', port: PORT, timeout: 700 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}

(async () => {
  const rows = readJson(ORDER_LOG_FILE);
  if (!Array.isArray(rows)) { console.error('Cannot read ' + ORDER_LOG_FILE); process.exit(1); }
  const store = readJson(DHAN_TOKEN_FILE);
  if (!store?.token) { console.error('No Dhan token in ' + DHAN_TOKEN_FILE + ' - run on the server box.'); process.exit(1); }

  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const atCost = rows.filter(closedAtCost);
  const wiped = atCost.filter(r => {
    const e = num(r.entryPrice ?? r.price), sl = num(r.slPrice);
    return e && sl && Math.abs(sl - e) / e < 0.001 && !num(r.slPriceOriginal);
  });
  const truth = atCost.filter(r => {
    const e = num(r.entryPrice ?? r.price), sl = num(r.slPrice);
    return e && sl && sl < e * 0.999;
  });
  const targets = MODE === 'validate' ? truth : wiped;
  console.log('Rows: ' + rows.length + ' total, ' + atCost.length + ' closed at cost, '
    + wiped.length + ' wiped, ' + truth.length + ' with true SL intact.');
  console.log('Mode: ' + MODE + ' -> ' + targets.length + ' row(s) to process.\n');
  if (!targets.length) process.exit(0);

  // resolve security ids (row field first, instrument master for the rest)
  let secMap = null;
  const secIdOf = async r => {
    if (r.securityId) return String(r.securityId);
    if (!secMap) { console.log('Fetching Dhan instrument master (no securityId on some rows)...'); secMap = await loadSecurityMap(); }
    const sym = String(r.symbol || '').replace(/\s/g, '').toUpperCase();
    return secMap['NSE:' + sym] || secMap[sym] || null;
  };

  // one candle fetch per symbol, spanning every entry date that needs it
  const bySymbol = {};
  targets.forEach(r => { (bySymbol[r.symbol] = bySymbol[r.symbol] || []).push(r); });
  const results = [];
  for (const sym of Object.keys(bySymbol)) {
    const group = bySymbol[sym];
    const rule0 = parseStopRule(group[0]);
    let candles = null, candleErr = '';
    if (rule0 && rule0.kind !== 'entry') {
      const secId = await secIdOf(group[0]);
      if (secId) {
        const dates = group.map(r => istDateOf(r.recordedAt)).filter(Boolean).sort();
        const from = new Date(new Date(dates[0]).getTime() - 400 * 86400000).toISOString().slice(0, 10);
        const to = dates[dates.length - 1];
        try { candles = await fetchDailyCandles(store.token, secId, from, to); if (!candles.length) candleErr = 'API returned no candles'; }
        catch (e) { candleErr = 'candle fetch failed: ' + e.message; console.log('  ' + sym + ': ' + candleErr); }
        await sleep(350);                                  // stay well inside Dhan rate limits
      } else { candleErr = 'no security id found'; console.log('  ' + sym + ': ' + candleErr); }
    }
    for (const r of group) {
      const rule = parseStopRule(r);
      const e = num(r.entryPrice ?? r.price), q = num(r.qty) || 0;
      const entryDate = istDateOf(r.recordedAt);
      let est = null, estPrev = null, how = '';
      if (rule && e) {
        if (rule.kind === 'entry') { est = estPrev = e * (1 - rule.pct / 100); how = rule.pct + '% below entry (exact)'; }
        else if (candles && candles.length) {
          const vT = indicatorAsOf(candles, entryDate, rule.kind, rule.period, true);
          const vP = indicatorAsOf(candles, entryDate, rule.kind, rule.period, false);
          if (vT) est = vT * (1 - rule.pct / 100);
          if (vP) estPrev = vP * (1 - rule.pct / 100);
          how = rule.pct + '% below ' + rule.kind + rule.period
            + (!vT && !vP ? ' - not enough candle history (need ' + (rule.period + 30) + '+ bars)' : '');
        } else how = candleErr || 'no candles';
      } else if (!rule) how = 'unparseable exitCriteria: ' + String(r.exitCriteria || '(empty)').slice(0, 40);
      results.push({ id: r.id, symbol: r.symbol, date: entryDate, entry: e, qty: q,
        trueSl: MODE === 'validate' ? num(r.slPrice) : null, est, estPrev, how });
    }
  }

  if (MODE === 'validate') {
    let sumT = 0, sumP = 0, n = 0;
    const table = results.map(x => {
      if (!x.est || !x.trueSl) return { symbol: x.symbol, note: 'no estimate (' + x.how + ')' };
      const rT = (x.entry - x.est) - (x.entry - x.trueSl);
      const rP = x.estPrev ? (x.entry - x.estPrev) - (x.entry - x.trueSl) : null;
      const pctT = rT / (x.entry - x.trueSl) * 100;
      const pctP = rP !== null ? rP / (x.entry - x.trueSl) * 100 : null;
      sumT += Math.abs(pctT); if (pctP !== null) sumP += Math.abs(pctP); n++;
      return { symbol: x.symbol, date: x.date, entry: x.entry, trueSl: x.trueSl,
        estWithEntryDay: round2(x.est), errPct: round2(pctT),
        estPrevClose: x.estPrev ? round2(x.estPrev) : null, errPrevPct: pctP !== null ? round2(pctP) : null };
    });
    console.table(table);
    if (n) {
      console.log('Avg |risk error|  with entry-day bar: ' + round2(sumT / n) + '%   prior-close only: ' + round2(sumP / n) + '%');
      console.log('\nVerdict: apply is reasonable if the better variant is under ~10%.');
    }
    process.exit(0);
  }

  // dry-run / apply: choose per-row estimate (entry-day variant; validation
  // decides whether that or prev-close is used - swap with --prev-close)
  const usePrev = process.argv.includes('--prev-close');
  const recoverable = results.filter(x => (usePrev ? x.estPrev : x.est) && x.entry);
  console.table(recoverable.map(x => ({ symbol: x.symbol, date: x.date, entry: x.entry, qty: x.qty,
    recoveredSl: round2(usePrev ? x.estPrev : x.est), how: x.how,
    lossSaved: round2((x.entry - (usePrev ? x.estPrev : x.est)) * x.qty) })));
  const totalSaved = recoverable.reduce((a, x) => a + (x.entry - (usePrev ? x.estPrev : x.est)) * x.qty, 0);
  console.log(recoverable.length + ' of ' + targets.length + ' recoverable. Additional loss-saved: Rs.' + round2(totalSaved));
  results.filter(x => !(usePrev ? x.estPrev : x.est)).forEach(x => console.log('  skip ' + x.symbol + ': ' + x.how));

  if (MODE !== 'apply') { console.log('\nDry-run only. Re-run with --apply to write slPriceOriginal.'); process.exit(0); }

  if (await serverRunning()) {
    console.error('\nREFUSING to write: the server is running on port ' + PORT + '.');
    console.error('Stop it first (pm2 stop stockkar), run --apply, then pm2 start stockkar.');
    process.exit(1);
  }
  const byId = new Map(recoverable.map(x => [x.id, x]));
  const out = rows.map(r => {
    const x = byId.get(r.id);
    if (!x) return r;
    return { ...r, slPriceOriginal: round2(usePrev ? x.estPrev : x.est), slPriceOriginalEstimated: true };
  });
  try { fs.renameSync(ORDER_LOG_FILE, ORDER_LOG_FILE + '.bak'); } catch {}
  fs.writeFileSync(ORDER_LOG_FILE, JSON.stringify(out, null, 2));
  console.log('\nWrote slPriceOriginal on ' + byId.size + ' row(s). Previous file kept as order_log.json.bak.');
  console.log('Start the server again: pm2 start stockkar');
})().catch(e => { console.error('FATAL: ' + (e && e.message || e)); process.exit(1); });
