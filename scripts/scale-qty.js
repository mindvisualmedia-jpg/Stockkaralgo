#!/usr/bin/env node
/* One-time operator tool: multiply the qty of CLOSED order-log rows by a
 * factor (default 10), scaling the rupee fields that derive from qty so the
 * record stays internally consistent (Order Log, Dashboard, share PDF).
 *
 * Only touches THIS box's data file - every install has its own order_log.json,
 * so other users are untouched by definition. Only CLOSED rows are eligible:
 * open rows mirror live broker positions and protection audits, and scaling
 * those would make the app disagree with the broker.
 *
 * Scaled per row: qty, realisedPnl, splitLegAQty/splitLegBQty, splitT1Pnl,
 * mtmRemainingQty. Prices and percents are untouched. Originals are kept on
 * the row (preScale) and each row is flagged (qtyScaledBy) so re-running can
 * never double-scale.
 *
 * Modes:
 *   node scripts/scale-qty.js               dry-run: table of what would change
 *   node scripts/scale-qty.js --apply       write (refuses while server runs;
 *                                           keeps order_log.prescale-<date>.json)
 *   node scripts/scale-qty.js --revert      restore preScale values on flagged rows
 *   Optional: --factor 10
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');

const DATA_DIR = process.env.STOCKKAR_DATA_DIR || path.join(__dirname, '..');
const FILE = path.join(DATA_DIR, 'order_log.json');
const PORT = Number(process.env.PORT || 7777);
const APPLY = process.argv.includes('--apply');
const REVERT = process.argv.includes('--revert');
const fIdx = process.argv.indexOf('--factor');
const FACTOR = fIdx >= 0 ? Number(process.argv[fIdx + 1]) : 10;
if (!(FACTOR > 1)) { console.error('Bad --factor'); process.exit(1); }

function isClosed(r) {
  const s = (String(r.status || '') + ' ' + String(r.exitType || r.result || '')).toUpperCase();
  if (['ERROR', 'SKIPPED', 'N/A'].includes(String(r.orderId || '').toUpperCase())) return false;
  if (/REJECT|CANCEL|FAIL|INVALID/.test(s)) return false;
  return !!r.manualClose || /TARGET HIT|SL HIT|EXITED|CLOSED/.test(s);
}
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const r2 = v => Math.round(v * 100) / 100;

// rupee/quantity fields that must scale together; percents & prices stay
const SCALE_FIELDS = ['qty', 'realisedPnl', 'realizedPnl', 'splitLegAQty', 'splitLegBQty', 'splitT1Pnl', 'mtmRemainingQty'];

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

  if (REVERT) {
    const flagged = rows.filter(r => r.qtyScaledBy && r.preScale);
    console.log(flagged.length + ' scaled row(s) to revert.');
    if (!flagged.length) process.exit(0);
    if (!APPLY) { console.log('Add --apply together with --revert to write the restore.'); process.exit(0); }
    if (await serverRunning()) { console.error('Stop the server first (pm2 stop stockkar).'); process.exit(1); }
    const out = rows.map(r => {
      if (!(r.qtyScaledBy && r.preScale)) return r;
      const { preScale, qtyScaledBy, ...rest } = r;
      return { ...rest, ...preScale };
    });
    fs.writeFileSync(FILE + '.prescale-revert-bak', JSON.stringify(rows, null, 2));
    fs.writeFileSync(FILE, JSON.stringify(out, null, 2));
    console.log('Reverted ' + flagged.length + ' row(s).');
    process.exit(0);
  }

  const targets = rows.filter(r => isClosed(r) && !r.qtyScaledBy && num(r.qty) > 0);
  const skippedScaled = rows.filter(r => r.qtyScaledBy).length;
  console.log('Rows: ' + rows.length + ' total · ' + targets.length + ' closed to scale x' + FACTOR
    + (skippedScaled ? ' · ' + skippedScaled + ' already scaled (skipped)' : ''));
  if (!targets.length) process.exit(0);

  console.table(targets.map(r => ({
    symbol: r.symbol, closed: String(r.closedAt || r.testClosedAt || '').slice(0, 10),
    qty: num(r.qty), qtyNew: num(r.qty) * FACTOR,
    pnl: num(r.realisedPnl ?? r.realizedPnl), pnlNew: r2((num(r.realisedPnl ?? r.realizedPnl) || 0) * FACTOR),
  })));
  const tot = targets.reduce((a, r) => a + (num(r.realisedPnl ?? r.realizedPnl) || 0), 0);
  console.log('Realised P&L across these rows: Rs.' + r2(tot) + '  ->  Rs.' + r2(tot * FACTOR));

  if (!APPLY) { console.log('\nDry-run only. Re-run with --apply to write.'); process.exit(0); }
  if (await serverRunning()) {
    console.error('\nREFUSING to write: server running on port ' + PORT + '. pm2 stop stockkar first.');
    process.exit(1);
  }
  const stamp = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(FILE.replace(/\.json$/, '') + '.prescale-' + stamp + '.json', JSON.stringify(rows, null, 2));
  const ids = new Set(targets.map(r => r.id));
  const out = rows.map(r => {
    if (!ids.has(r.id)) return r;
    const pre = {};
    const next = { ...r };
    SCALE_FIELDS.forEach(f => {
      const v = num(r[f]);
      if (v !== null && r[f] !== '' && r[f] !== undefined) { pre[f] = r[f]; next[f] = r2(v * FACTOR); }
    });
    next.preScale = pre;
    next.qtyScaledBy = FACTOR;
    return next;
  });
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2));
  console.log('\nScaled ' + ids.size + ' row(s) x' + FACTOR + '. Pre-scale copy kept as order_log.prescale-' + stamp + '.json');
  console.log('Start the server again: pm2 start stockkar');
})();
