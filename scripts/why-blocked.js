#!/usr/bin/env node
/* Read-only: explain, per algo, exactly WHICH stocks are consuming its
 * position slots — the question behind "No free slots, broker-truth open
 * count is 4 of 3".
 *
 * The cap uses max(openNow, algoHeldPositionCount):
 *   openNow  = rows this job has OPEN in the order log.
 *   algoHeld = symbols held at the broker RIGHT NOW that this job has EVER
 *              traded (source=auto) — open or closed, with no date limit.
 * The second is deliberately pessimistic: if the log and the broker disagree,
 * the broker wins, because opening a position the app cannot protect is worse
 * than missing one. But it also means a stock this algo closed weeks ago, or
 * one you now hold for another reason, still occupies a slot.
 *
 * This tool names those stocks and says why each one counts, so you can tell a
 * settlement lag from a genuine drift.
 *
 *   node scripts/why-blocked.js
 *   node scripts/why-blocked.js --held BEL,HAL,TATASTEEL
 *
 * --held skips the broker call and uses the symbols you name, so the question
 * can be answered from the holdings screen alone when a token has lapsed.
 *
 * Touches nothing. Dhan only (that is where the broker-truth backstop reads).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = process.env.STOCKKAR_DATA_DIR || path.join(__dirname, '..');
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return null; } };
const norm = s => String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();

// Mirrors isOpenOrderLogEntry's spirit: structured flags first, text last.
function isOpen(e) {
  const st = (String(e.status || '') + ' ' + String(e.exitType || e.result || '')).toUpperCase();
  if (['ERROR', 'SKIPPED', 'N/A'].includes(String(e.orderId || '').toUpperCase())) return false;
  if (e.manualClose) return false;
  if (!e.exitType && !e.result) {
    if (e.protectionUnverified || e.awaitingFill || e.reopenedAt) return true;
    if (/UNPROTECTED/.test(st)) return true;
  }
  if (/^ENTRY PLACED BUT/.test(st)) return true;
  if (/(TARGET HIT|SL HIT|REJECT|CANCEL|FAILED|FAIL|INVALID|EXITED|CLOSED)/.test(st)) return false;
  return true;
}

function dhanGet(token, pathname) {
  return new Promise(res => {
    const req = https.request({ hostname: 'api.dhan.co', port: 443, path: pathname, method: 'GET',
      headers: { 'access-token': token, 'Content-Type': 'application/json' } }, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => { try { const p = JSON.parse(d); res(Array.isArray(p) ? p : (Array.isArray(p?.data) ? p.data : [])); } catch { res([]); } });
    });
    req.on('error', () => res([]));
    req.setTimeout(15000, () => { req.destroy(); res([]); });
    req.end();
  });
}

(async () => {
  const log = read('order_log.json') || [];
  const sched = read('algo_schedule.json') || {};
  const dhan = read('dhan_token.json');
  const jobs = (sched.jobs || []).filter(j => j.enabled);
  if (!jobs.length) return console.log('No enabled algos.');
  const hIdx = process.argv.indexOf('--held');
  const manualHeld = hIdx >= 0 ? String(process.argv[hIdx + 1] || '').split(/[,\s]+/).map(norm).filter(Boolean) : null;
  if (!manualHeld && (!dhan || !dhan.token)) return console.log('No Dhan token saved — pass --held SYM,SYM from your holdings screen instead.');

  // Same union the app uses: holdings + positions, every quantity bucket, so a
  // freshly bought (unsettled) holding never reads as not-held.
  const held = new Set(manualHeld || []);
  const holdings = manualHeld ? [] : await dhanGet(dhan.token, '/v2/holdings');
  holdings.forEach(h => {
    const q = Math.max(Number(h.totalQty) || 0, (Number(h.dpQty) || 0) + (Number(h.t1Qty) || 0),
      Number(h.availableQty) || 0, Number(h.quantity) || 0);
    const s = norm(h.tradingSymbol || h.symbol);
    if (s && q > 0) held.add(s);
  });
  const positions = manualHeld ? [] : await dhanGet(dhan.token, '/v2/positions');
  positions.forEach(p => {
    const s = norm(p.tradingSymbol || p.symbol);
    const q = Number(p.netQty ?? p.netQuantity ?? p.buyQty ?? 0);
    if (s && q > 0) held.add(s);
  });

  console.log('Held at Dhan right now: ' + (held.size ? [...held].join(', ') : '(none)') + '\n');

  jobs.forEach(job => {
    const cfg = job.config || {};
    const name = cfg.algoName || cfg.screenerName || job.id;
    const cap = Number(cfg.maxOpenPositions) > 0 ? Number(cfg.maxOpenPositions) : 5;
    const mine = log.filter(e => String(e.jobId || '') === String(job.id) && e.source === 'auto' && !e.testMode);
    const openRows = mine.filter(isOpen);
    const openNow = openRows.length;

    // The backstop: any symbol this job EVER traded that is held right now.
    const everSyms = new Set(mine.map(e => norm(e.symbol)).filter(Boolean));
    const counted = [...held].filter(s => everSyms.has(s));
    const openSyms = new Set(openRows.map(e => norm(e.symbol)));

    const eff = Math.max(openNow, counted.length);
    console.log('=== ' + name + '  (cap ' + cap + ')');
    console.log('    log says open      : ' + openNow + (openNow ? '  [' + [...openSyms].join(', ') + ']' : ''));
    console.log('    broker-truth count : ' + counted.length);
    counted.forEach(s => {
      if (openSyms.has(s)) return console.log('      - ' + s + '  OPEN in the log too (agreed)');
      const rows = mine.filter(e => norm(e.symbol) === s);
      const last = rows[rows.length - 1] || {};
      const when = String(last.reconciledAt || last.lastStatusCheckAt || last.recordedAt || '').slice(0, 10);
      console.log('      - ' + s + '  log says CLOSED (' + (last.exitType || 'no exitType') + ', ' + (when || 'no date') + ')'
        + '  <- eats a slot: settlement lag, held for another reason, or a missed exit');
    });
    console.log('    effective          : ' + eff + ' of ' + cap + (eff >= cap ? '   => BLOCKED' : '   => ' + (cap - eff) + ' free'));
    console.log('');
  });
})();
