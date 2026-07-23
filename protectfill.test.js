'use strict';
// Protect-after-fill status texts + day-key helper.
//
// Reproduces the exact predicates from server.js (isOpenOrderLogEntry,
// awaitingFillStatusText, istKeyOfIso) so the interplay can be asserted without
// a live broker. If these copies drift from server.js, update both.
//
// Why this matters (2026-07-21 incident): Dhan showed Nahar 0/38 PENDING and
// Eris 1/6 PART_TRADED while the Order Log said "DHAN ENTRY + 2x FOREVER OCO"
// — protection was placed on ACCEPTANCE, and the log read as executed. The log
// must state the broker's truth while an entry works, and that wording must
// never contain a token that makes isOpenOrderLogEntry read the row as CLOSED
// (the row would vanish from every safety pass while real money is pending).

const { test } = require('node:test');
const assert = require('node:assert');

// ---- verbatim copy of server.js isOpenOrderLogEntry ----
function isOpenOrderLogEntry(entry) {
  const statusText = String(entry.status || '').toUpperCase();
  const resultText = String(entry.exitType || entry.result || '').toUpperCase();
  if (['ERROR', 'SKIPPED', 'N/A'].includes(String(entry.orderId || '').toUpperCase())) return false;
  if (entry.manualClose) return false;
  if (/(TARGET HIT|SL HIT|REJECT|CANCEL|FAILED|FAIL|INVALID|EXITED|CLOSED)/.test(statusText + ' ' + resultText)) return false;
  return true;
}

// ---- verbatim copy of server.js awaitingFillStatusText ----
function awaitingFillStatusText(broker, filled, ordered) {
  const b = String(broker || '').toUpperCase();
  const f = Math.max(0, Math.floor(Number(filled) || 0));
  const q = Math.max(0, Math.floor(Number(ordered) || 0));
  if (f > 0) return b + ' ENTRY PARTIALLY FILLED — ' + f + '/' + q + ' at broker, waiting for remainder, protection on completion';
  return b + ' ENTRY PENDING at broker — 0/' + q + ' filled, protection on fill';
}

// ---- verbatim copy of server.js istDateKey + istKeyOfIso (fixed date input) ----
function istDateKey(date) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}
function istKeyOfIso(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return istDateKey(new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })));
}

// ── the incident, as the log should now tell it ─────────────────────────────

test('Nahar 0/38 pending reads as PENDING at broker, not executed', () => {
  const txt = awaitingFillStatusText('dhan', 0, 38);
  assert.equal(txt, 'DHAN ENTRY PENDING at broker — 0/38 filled, protection on fill');
});

test('Eris 1/6 partial reads as PARTIALLY FILLED with the live count', () => {
  const txt = awaitingFillStatusText('dhan', 1, 6);
  assert.equal(txt, 'DHAN ENTRY PARTIALLY FILLED — 1/6 at broker, waiting for remainder, protection on completion');
});

// ── the wording must keep the row OPEN ──────────────────────────────────────

test('pending/partial wording never trips a closed-token in isOpenOrderLogEntry', () => {
  for (const [f, q] of [[0, 38], [1, 6], [5, 6], [0, 1]]) {
    for (const broker of ['dhan', 'zerodha', 'fyers']) {
      const row = { status: awaitingFillStatusText(broker, f, q), orderId: 'ENTRY:123' };
      assert.equal(isOpenOrderLogEntry(row), true,
        'row must stay OPEN for status: ' + row.status);
    }
  }
});

test('the terminal texts written by the watchers DO close the row', () => {
  for (const status of [
    'REJECTED (entry rejected — no protection placed)',
    'REJECTED (entry expired — no fill, no protection placed)',
  ]) {
    assert.equal(isOpenOrderLogEntry({ status, orderId: 'x' }), false, status);
  }
});

// ── day-key: the cross-day branch fires only on a genuinely earlier IST day ──

test('same IST day -> same key (cross-day branch must NOT fire intraday)', () => {
  // 03:45 UTC = 09:15 IST market open; 10:00 UTC = 15:30 IST close. Same day.
  assert.equal(istKeyOfIso('2026-07-21T03:45:00.000Z'), istKeyOfIso('2026-07-21T10:00:00.000Z'));
});

test('IST rolls the day before UTC does: 19:00 UTC = next day 00:30 IST', () => {
  assert.equal(istKeyOfIso('2026-07-21T19:00:00.000Z'), '2026-07-22');
  assert.notEqual(istKeyOfIso('2026-07-21T10:00:00.000Z'), istKeyOfIso('2026-07-21T19:00:00.000Z'));
});

test('unparseable timestamp -> "" (never accidentally equals today)', () => {
  assert.equal(istKeyOfIso('not-a-date'), '');
  assert.equal(istKeyOfIso(''), '');
});
