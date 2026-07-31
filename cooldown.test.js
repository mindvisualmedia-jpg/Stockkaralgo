'use strict';
// Re-entry cooldown: after this algo EXITS a stock, skip re-buying it for N days.
//
// The rule under test is the timestamp choice. The original implementation read
//   testClosedAt || reconciledAt || lastStatusCheckAt || recordedAt
// and the middle two are status-POLL stamps that move on every refresh, so on a
// live row (no testClosedAt) the cooldown restarted every time the poller
// touched the row — a long-closed stock could stay blocked forever.
//
// These tests pin the corrected behaviour: only closedAt / testClosedAt count as
// exits, poll stamps are ignored, and rejected rows never start a cooldown.
const test = require('node:test');
const assert = require('node:assert');

const DAY = 24 * 60 * 60 * 1000;
const ago = d => new Date(Date.now() - d * DAY).toISOString();

// Mirror of the server helpers (server.js is a monolith without exports).
function entryWasTaken(e) {
  const id = String(e.orderId || '').toUpperCase();
  if (!id || ['ERROR', 'SKIPPED', 'N/A'].includes(id)) return false;
  const txt = String(e.status || '') + ' ' + String(e.exitType || e.result || '');
  if (/REJECT|CANCEL|FAIL|INVALID|SECURITY ID NOT FOUND/i.test(txt)) return false;
  return true;
}
const isOpen = e => !/(TARGET HIT|SL HIT|EXITED|CLOSED|REJECT|CANCEL)/i.test(String(e.exitType || e.result || ''));
function recentlyExited(rows, cooldownDays) {
  const days = Number(cooldownDays || 0);
  if (!(days > 0)) return new Set();
  const cutoff = Date.now() - days * DAY;
  const set = new Set();
  rows.forEach(e => {
    if (!entryWasTaken(e)) return;
    if (isOpen(e)) return;
    const t = new Date(e.closedAt || e.testClosedAt || e.recordedAt || 0).getTime();
    if (!Number.isFinite(t) || t <= 0 || t < cutoff) return;
    const sym = String(e.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
    if (sym) set.add(sym);
  });
  return set;
}
const row = o => Object.assign({ orderId: '123', status: 'TRADED', exitType: 'TARGET HIT' }, o);

test('cooldown off (0) blocks nothing', () => {
  const s = recentlyExited([row({ symbol: 'AAA', closedAt: ago(0) })], 0);
  assert.strictEqual(s.size, 0);
});

test('a stock exited inside the window is blocked', () => {
  const s = recentlyExited([row({ symbol: 'AAA', closedAt: ago(2) })], 5);
  assert.ok(s.has('AAA'));
});

test('a stock exited outside the window is eligible again', () => {
  const s = recentlyExited([row({ symbol: 'AAA', closedAt: ago(9) })], 5);
  assert.ok(!s.has('AAA'));
});

test('THE BUG: poll stamps must not extend the window', () => {
  // Exited 30 days ago; the poller touched the row today.
  const r = row({ symbol: 'AAA', closedAt: ago(30), lastStatusCheckAt: ago(0), reconciledAt: ago(0) });
  assert.ok(!recentlyExited([r], 5).has('AAA'),
    'a refresh today must not restart a cooldown that lapsed weeks ago');
});

test('test-mode rows use testClosedAt', () => {
  assert.ok(recentlyExited([row({ symbol: 'BBB', testClosedAt: ago(1) })], 5).has('BBB'));
  assert.ok(!recentlyExited([row({ symbol: 'BBB', testClosedAt: ago(20) })], 5).has('BBB'));
});

test('rejected orders never start a cooldown', () => {
  const rows = [
    row({ symbol: 'AAA', orderId: 'N/A', status: 'REJECTED', exitType: 'REJECTED', closedAt: ago(1) }),
    row({ symbol: 'BBB', orderId: 'ERROR', status: 'FAILED', exitType: 'FAILED', closedAt: ago(1) }),
    row({ symbol: 'CCC', orderId: '', status: 'TRADED', closedAt: ago(1) }),
  ];
  const s = recentlyExited(rows, 5);
  assert.strictEqual(s.size, 0, 'nothing was bought, so nothing may be blocked');
});

test('an OPEN position is not a cooldown case', () => {
  // Still running: the duplicate-entry guard handles this, not the cooldown.
  const s = recentlyExited([row({ symbol: 'AAA', exitType: '', recordedAt: ago(1) })], 5);
  assert.ok(!s.has('AAA'));
});

test('a closed row with no exit stamp falls back to entry, and still lapses', () => {
  assert.ok(recentlyExited([row({ symbol: 'AAA', recordedAt: ago(1) })], 5).has('AAA'));
  assert.ok(!recentlyExited([row({ symbol: 'AAA', recordedAt: ago(40) })], 5).has('AAA'),
    'fail-open: never block a stock for good because a stamp is missing');
});

test('symbols are normalised so NSE: and spacing cannot dodge the block', () => {
  const s = recentlyExited([row({ symbol: 'NSE:aaa ', closedAt: ago(1) })], 5);
  assert.ok(s.has('AAA'));
});

test('only the exited symbol is blocked', () => {
  const s = recentlyExited([
    row({ symbol: 'AAA', closedAt: ago(1) }),
    row({ symbol: 'BBB', closedAt: ago(40) }),
  ], 5);
  assert.deepStrictEqual([...s], ['AAA']);
});
