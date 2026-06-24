'use strict';
// Test: Max Open Positions throttle + auto-refill.
//
// Reproduces the exact predicate (isOpenOrderLogEntry) and slot arithmetic
// from server.js (runScheduledAlgo) so the refill behaviour can be asserted
// without a live broker. If these copies drift from server.js, update both.

// ---- verbatim copy of server.js isOpenOrderLogEntry ----
function isOpenOrderLogEntry(entry) {
  const statusText = String(entry.status || '').toUpperCase();
  const resultText = String(entry.exitType || entry.result || '').toUpperCase();
  if (['ERROR', 'SKIPPED', 'N/A'].includes(String(entry.orderId || '').toUpperCase())) return false;
  if (entry.manualClose) return false;
  if (/(TARGET HIT|SL HIT|REJECT|CANCEL|FAILED|FAIL|INVALID|EXITED|CLOSED)/.test(statusText + ' ' + resultText)) return false;
  return true;
}

// ---- verbatim copy of server.js openPositionsForJob (log passed in) ----
function openPositionsForJob(rows, jobId) {
  if (!jobId) return 0;
  return rows.filter(e => e.jobId === jobId && isOpenOrderLogEntry(e)).length;
}

// ---- verbatim copy of the runScheduledAlgo entry-limit math ----
function entryLimitFor(rows, cfg, job) {
  const maxTrades = Number(cfg.maxTrades || 0);
  const tradedToday = new Set();
  const remainingTrades = maxTrades > 0 ? Math.max(0, maxTrades - tradedToday.size) : Infinity;
  const maxOpenPositions = Number(cfg.maxOpenPositions || 0);
  const openNow = maxOpenPositions > 0 ? openPositionsForJob(rows, job.id) : 0;
  const remainingOpenSlots = maxOpenPositions > 0 ? Math.max(0, maxOpenPositions - openNow) : Infinity;
  return { entryLimit: Math.min(remainingTrades, remainingOpenSlots), openNow, remainingOpenSlots };
}

let passed = 0, failed = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error('FAIL: ' + msg + '\n  expected ' + e + '\n  got      ' + a); }
}

const JOB = { id: 'job-1' };
const cfg = { maxTrades: 0, maxOpenPositions: 3 }; // the new config: no per-day cap

// --- isOpenOrderLogEntry: closed rows must not count ---
eq(isOpenOrderLogEntry({ status: 'OPEN', orderId: '123' }), true, 'plain open row counts');
eq(isOpenOrderLogEntry({ status: 'TEST: TARGET HIT @110', orderId: 'X' }), false, 'TARGET HIT in status -> closed');
eq(isOpenOrderLogEntry({ status: 'OPEN', exitType: 'SL HIT', orderId: 'X' }), false, 'SL HIT in exitType -> closed');
eq(isOpenOrderLogEntry({ status: 'EXITED', orderId: 'X' }), false, 'EXITED -> closed');
eq(isOpenOrderLogEntry({ status: 'CLOSED (manual)', manualClose: true, orderId: 'X' }), false, 'manual close -> closed');
eq(isOpenOrderLogEntry({ orderId: 'ERROR' }), false, 'ERROR orderId -> closed');
eq(isOpenOrderLogEntry({ orderId: 'SKIPPED' }), false, 'SKIPPED orderId -> closed');

// --- Refill scenario, cap = 3, no per-day trade cap ---
const log = [];

// Cycle 1: empty log -> 3 free slots.
let r = entryLimitFor(log, cfg, JOB);
eq([r.openNow, r.entryLimit], [0, 3], 'cycle1: 0 open, can take 3');
log.push({ jobId: 'job-1', orderId: '1', status: 'OPEN' });
log.push({ jobId: 'job-1', orderId: '2', status: 'OPEN' });
log.push({ jobId: 'job-1', orderId: '3', status: 'OPEN' });

// Cycle 2: cap full -> 0 slots, even though more candidates qualify.
r = entryLimitFor(log, cfg, JOB);
eq([r.openNow, r.entryLimit], [3, 0], 'cycle2: 3 open, cap full, take 0');

// Cycle 3: one position hits TARGET -> 1 slot frees.
log[0].status = 'TARGET HIT @110';
log[0].exitType = 'TARGET HIT';
r = entryLimitFor(log, cfg, JOB);
eq([r.openNow, r.entryLimit], [2, 1], 'cycle3: 1 closed by target, refill 1');
log.push({ jobId: 'job-1', orderId: '4', status: 'OPEN' }); // refilled

// Cycle 4: the remaining two original positions hit SL -> only order 4 stays open.
log[1].status = 'SL HIT @97'; log[1].exitType = 'SL HIT';
log[2].status = 'SL HIT @97'; log[2].exitType = 'SL HIT';
const openIds = log.filter(e => isOpenOrderLogEntry(e)).map(e => e.orderId).sort();
eq(openIds, ['4'], 'after target+2 SL: only order 4 open');
r = entryLimitFor(log, cfg, JOB);
eq([r.openNow, r.entryLimit], [1, 2], 'cycle4 precise: 1 open, refill 2 to reach cap 3');

// --- maxOpenPositions = 0 (unset) means no cap ---
const noCap = entryLimitFor(log, { maxTrades: 0, maxOpenPositions: 0 }, JOB);
eq(noCap.entryLimit, Infinity, 'maxOpenPositions=0 -> unlimited (Infinity)');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
