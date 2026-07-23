'use strict';
// Order-log retention tests.
//
// Reproduces the exact prune logic from server.js (pruneOrderLog) with the
// clock and limits injected, plus the verbatim isOpenOrderLogEntry predicate.
// If these copies drift from server.js, update both.
//
// Why this matters (2026-07-23 incident): a swing algo showed OPEN 6/10 while
// Dhan held 10 of its positions. The 4 oldest rows had aged past the 30-day
// retention cutoff — pruneOrderLog dropped them on every read, so the
// open-position cap, broker attribution and trailing all went blind while the
// positions were still live at the broker. Rule: an OPEN row is NEVER pruned,
// by age or by the row cap. Terminal rows age out from when they CLOSED.

const { test } = require('node:test');
const assert = require('node:assert');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-23T10:00:00.000Z').getTime();
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

// ---- verbatim copy of server.js isOpenOrderLogEntry (text-fallback core) ----
function isOpenOrderLogEntry(entry) {
  const statusText = String(entry.status || '').toUpperCase();
  const resultText = String(entry.exitType || entry.result || '').toUpperCase();
  if (['ERROR', 'SKIPPED', 'N/A'].includes(String(entry.orderId || '').toUpperCase())) return false;
  if (entry.manualClose) return false;
  if (/(TARGET HIT|SL HIT|REJECT|CANCEL|FAILED|FAIL|INVALID|EXITED|CLOSED)/.test(statusText + ' ' + resultText)) return false;
  return true;
}

// ---- server.js pruneOrderLog with clock + limits injected (same logic) ----
function pruneOrderLog(rows, { retentionDays, maxRows, now }) {
  const cutoff = now - retentionDays * DAY;
  const open = [], terminal = [];
  rows.forEach(e => (isOpenOrderLogEntry(e) ? open : terminal).push(e));
  const keptTerminal = terminal
    .filter(e => {
      const t = new Date(e.closedAt || e.testClosedAt || e.recordedAt).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))
    .slice(0, Math.max(0, maxRows - open.length));
  return [...open, ...keptTerminal].sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));
}

const LIMITS = { retentionDays: 90, maxRows: 1000, now: NOW };
const openRow = (id, daysAgo) => ({ id, orderId: 'E' + id, status: 'DHAN ENTRY + FOREVER OCO', recordedAt: iso(daysAgo) });
const closedRow = (id, recordedDaysAgo, closedDaysAgo) => ({ id, orderId: 'E' + id, status: 'TARGET HIT', exitType: 'TARGET HIT',
  recordedAt: iso(recordedDaysAgo), ...(closedDaysAgo != null ? { closedAt: iso(closedDaysAgo) } : {}) });

// ── the rule: open rows are immortal ────────────────────────────────────────

test('an OPEN row far older than retention is NEVER pruned', () => {
  const kept = pruneOrderLog([openRow('a', 200)], LIMITS);
  assert.equal(kept.length, 1);
});

test('THE INCIDENT: 10 open swing rows, 4 older than retention -> all 10 survive', () => {
  const rows = Array.from({ length: 10 }, (_, i) => openRow('p' + i, i < 4 ? 100 + i : 5 + i));
  const kept = pruneOrderLog(rows, LIMITS);
  assert.equal(kept.filter(isOpenOrderLogEntry).length, 10, 'the open-position count must see all 10');
});

test('the row cap never evicts open rows — terminal rows absorb the trim', () => {
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => openRow('o' + i, 100 + i)),      // 5 old OPEN
    ...Array.from({ length: 5 }, (_, i) => closedRow('t' + i, 10 + i, 9 + i)),
  ];
  const kept = pruneOrderLog(rows, { ...LIMITS, maxRows: 3 });
  assert.equal(kept.filter(isOpenOrderLogEntry).length, 5, 'all open rows kept even over the cap');
  assert.equal(kept.filter(e => !isOpenOrderLogEntry(e)).length, 0, 'cap fully consumed by open rows');
});

test('terminal trim keeps the NEWEST terminal rows', () => {
  const rows = Array.from({ length: 5 }, (_, i) => closedRow('t' + i, 10 + i, 9 + i)); // t0 newest
  const kept = pruneOrderLog(rows, { ...LIMITS, maxRows: 2 });
  assert.deepEqual(kept.map(e => e.id), ['t0', 't1']);
});

// ── terminal rows age from their CLOSE, not their entry ─────────────────────

test('a long-held position that closed YESTERDAY stays for the full window', () => {
  // Bought 120 days ago (past retention), exited yesterday. The old
  // recordedAt-based rule would have deleted the exit row instantly.
  const kept = pruneOrderLog([closedRow('x', 120, 1)], LIMITS);
  assert.equal(kept.length, 1);
});

test('a terminal row closed beyond retention is pruned', () => {
  const kept = pruneOrderLog([closedRow('x', 200, 100)], LIMITS);
  assert.equal(kept.length, 0);
});

test('a terminal row without closedAt falls back to recordedAt (legacy rows)', () => {
  assert.equal(pruneOrderLog([closedRow('in', 30, null)], LIMITS).length, 1);
  assert.equal(pruneOrderLog([closedRow('out', 100, null)], LIMITS).length, 0);
});

test('output stays sorted newest-first across the open/terminal merge', () => {
  const kept = pruneOrderLog([openRow('old-open', 150), closedRow('new-closed', 2, 1), openRow('new-open', 1)], LIMITS);
  assert.deepEqual(kept.map(e => e.id), ['new-open', 'new-closed', 'old-open']);
});
