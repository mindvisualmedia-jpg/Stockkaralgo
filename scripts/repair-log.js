#!/usr/bin/env node
/* Repair the order-log inconsistencies surfaced by scripts/audit-log.js:
 *
 *   A. Closed rows with an exit price but NO recorded realisedPnl get
 *      realisedPnl = (exit - entry) x qty (flagged pnlRepairedAt). Rows whose
 *      pnl exists but drifts from the price maths are NOT touched - a broker
 *      fill figure beats level maths.
 *   B. Closed rows still carrying a stale unrealisedPnl lose it.
 *   C. Closed rows with no close date get closedAt from reconciledAt /
 *      lastStatusCheckAt / recordedAt (flagged closedAtEstimated).
 *   D. --set-qty <idSuffix> <qty>: explicit single-row qty correction for a
 *      log/broker mismatch (e.g. partial fill never trimmed the row). Also
 *      aligns mtmRemainingQty when it matched the old qty. Never guessed,
 *      only ever done when YOU name the row.
 *
 * Dry-run by default. --apply refuses while the server is running and keeps
 * order_log.prerepair-<date>.json.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');

const DATA_DIR = process.env.STOCKKAR_DATA_DIR || path.join(__dirname, '..');
const FILE = path.join(DATA_DIR, 'order_log.json');
const PORT = Number(process.env.PORT || 7777);
const APPLY = process.argv.includes('--apply');
const qIdx = process.argv.indexOf('--set-qty');
const SET_QTY = qIdx >= 0 ? { id: String(process.argv[qIdx + 1] || ''), qty: Number(process.argv[qIdx + 2]) } : null;
if (SET_QTY && (!SET_QTY.id || !(SET_QTY.qty > 0))) { console.error('Usage: --set-qty <idSuffix> <qty>'); process.exit(1); }

const num = v => { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const r2 = v => Math.round(v * 100) / 100;
function rowState(r) {
  const s = (String(r.status || '') + ' ' + String(r.exitType || r.result || '')).toUpperCase();
  if (['ERROR', 'SKIPPED', 'N/A'].includes(String(r.orderId || '').toUpperCase())) return 'rejected';
  if (r.manualClose || /TARGET HIT|SL HIT|EXITED|CLOSED/.test(s)) return 'closed';
  if (/REJECT|CANCEL|FAIL|INVALID|SECURITY ID NOT FOUND/.test(s)) return 'rejected';
  return 'open';
}
const tag = r => (r.symbol || '?') + '#' + String(r.id || '').slice(-6);

function serverRunning() {
  return new Promise(res => {
    const s = net.connect({ host: '127.0.0.1', port: PORT, timeout: 700 });
    s.on('connect', () => { s.destroy(); res(true); });
    s.on('error', () => res(false));
    s.on('timeout', () => { s.destroy(); res(false); });
  });
}

(async () => {
  let rows;
  try { rows = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { console.error('Cannot read ' + FILE); process.exit(1); }

  const changes = [];
  const out = rows.map(r => {
    let next = r;
    const st = rowState(r);
    if (st === 'closed') {
      const qty = num(r.qty), entry = num(r.entryPrice ?? r.price), exit = num(r.exitPrice);
      const pnl = num(r.realisedPnl ?? r.realizedPnl);
      // A: missing pnl, computable from prices
      if (pnl === null && qty > 0 && entry > 0 && exit > 0) {
        const v = r2((exit - entry) * qty);
        next = { ...next, realisedPnl: v, pnlRepairedAt: new Date().toISOString() };
        changes.push(tag(r) + ': realisedPnl (none) -> ' + v + '  [(exit ' + exit + ' - entry ' + entry + ') x ' + qty + ']');
      }
      // B: stale unrealised remnant
      if (next.unrealisedPnl !== undefined && next.unrealisedPnl !== null && next.unrealisedPnl !== '') {
        changes.push(tag(r) + ': drop stale unrealisedPnl ' + next.unrealisedPnl);
        const { unrealisedPnl, ...rest } = next;
        next = rest;
      }
      // C: missing close date
      if (!next.closedAt && !next.testClosedAt) {
        const est = next.reconciledAt || next.lastStatusCheckAt || next.recordedAt;
        if (est) { next = { ...next, closedAt: est, closedAtEstimated: true }; changes.push(tag(r) + ': closedAt (none) -> ' + est + ' (estimated)'); }
      }
    }
    // D: explicit qty correction
    if (SET_QTY && String(r.id || '').endsWith(SET_QTY.id)) {
      const oldQty = num(r.qty);
      next = { ...next, qty: SET_QTY.qty, qtyBeforeRepair: oldQty };
      if (num(r.mtmRemainingQty) === oldQty) next.mtmRemainingQty = SET_QTY.qty;
      changes.push(tag(r) + ': qty ' + oldQty + ' -> ' + SET_QTY.qty + ' (explicit --set-qty' + (num(r.mtmRemainingQty) === oldQty ? ', mtmRemainingQty aligned' : '') + ')');
    }
    return next;
  });

  if (SET_QTY && !changes.some(c => c.includes('--set-qty'))) {
    console.error('No row id ends with "' + SET_QTY.id + '" - nothing matched.');
    process.exit(1);
  }
  if (!changes.length) { console.log('Nothing to repair - log is clean.'); process.exit(0); }
  console.log(changes.length + ' repair(s):\n');
  changes.forEach(c => console.log('  - ' + c));

  if (!APPLY) { console.log('\nDry-run only. Re-run with --apply to write.'); process.exit(0); }
  if (await serverRunning()) {
    console.error('\nREFUSING to write: server running on port ' + PORT + '. pm2 stop it first.');
    process.exit(1);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(FILE.replace(/\.json$/, '') + '.prerepair-' + stamp + '.json', JSON.stringify(rows, null, 2));
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2));
  console.log('\nApplied. Pre-repair copy kept as order_log.prerepair-' + stamp + '.json');
})();
