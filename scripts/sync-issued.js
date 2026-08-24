#!/usr/bin/env node
'use strict';

/* Push the OFFLINE issuing ledger to the activation server, so the licence
 * console shows every allotted key - not just the ones that have called home.
 *
 *   node scripts/sync-issued.js --url https://stockkaralgo-key.vercel.app --token <admin token>
 *
 * Runs on YOUR machine (where ~/.stockkar-licensing/ledger.json lives).
 * Sends keyId, name, product, expiry, issue date - deliberately NOT emails or
 * phone numbers; contact details stay local. Idempotent: re-run any time,
 * existing activation records are annotated, never disturbed.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = process.env.STOCKKAR_LICENSE_HOME || path.join(os.homedir(), '.stockkar-licensing');
const LEDGER = path.join(HOME, 'ledger.json');

const arg = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i > -1 ? process.argv[i + 1] : '';
};
const url = (arg('url') || process.env.STOCKKAR_ACTIVATION_URL || '').replace(/\/v1\/activate$/, '').replace(/\/+$/, '');
const token = arg('token') || process.env.STOCKKAR_ACTIVATION_ADMIN_TOKEN || '';
if (!url || !token) {
  console.error('Usage: node scripts/sync-issued.js --url https://<activation-host> --token <admin token>');
  process.exit(1);
}

let ledger;
try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch (e) {
  console.error('Cannot read the issuing ledger at ' + LEDGER + ' - run this on the machine that issues keys.');
  process.exit(1);
}
const rows = (Array.isArray(ledger) ? ledger : []).map(r => ({
  keyId: r.id || r.keyId || '', to: r.to || '', product: r.product || '',
  exp: r.exp || null, issuedAt: r.issuedAt || r.iat || '',
})).filter(r => r.keyId);
if (!rows.length) { console.error('The ledger has no keys.'); process.exit(1); }

// Small batches: the standalone server caps request bodies at 8KB.
const BATCH = 50;
const post = (body) => fetch(url + '/v1/admin/import', {
  method: 'POST',
  headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
  body: JSON.stringify(body),
}).then(async (res) => {
  const b = await res.json().catch(() => ({}));
  if (res.status === 401) throw new Error('admin token refused');
  if (!res.ok || b.ok === false) throw new Error(b.error || ('HTTP ' + res.status));
  return b;
});

(async () => {
  let added = 0, updated = 0, skipped = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const b = await post({ action: 'import', rows: rows.slice(i, i + BATCH) });
    added += b.added; updated += b.updated; skipped += b.skipped;
    process.stdout.write('\r' + Math.min(i + BATCH, rows.length) + '/' + rows.length + ' sent');
  }
  console.log('\nDone: ' + added + ' added, ' + updated + ' updated, ' + skipped + ' skipped of ' + rows.length + ' issued keys.');
  console.log('Open the console - every allotted key is now listed with its status.');
})().catch((e) => { console.error('\nSync failed: ' + e.message); process.exit(1); });
