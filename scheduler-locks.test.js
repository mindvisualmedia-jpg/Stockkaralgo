/**
 * scheduler-locks tests.
 *
 * The reported symptom: an algo card showing "Last: running", free slots, a
 * live-looking "Next check" countdown — and no trade ever again. The scheduler
 * skips any job flagged 'running', that flag is cleared only by the scan's
 * callback, and the guard sat BEFORE the new-day reset, so a check that never
 * called back blocked the job permanently.
 *
 * These tests pin both halves: a real in-flight check is never interrupted, and
 * a dead one can never block the job forever.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { staleRunningLock, lockedOut, MIN_LOCK_MS } = require('./scheduler-locks.js');

const NOW = Date.parse('2026-08-03T10:00:00Z');
const agoMs = ms => new Date(NOW - ms).toISOString();
const running = ms => ({ status: 'running', at: agoMs(ms) });

// ---- a genuine in-flight check must NEVER be interrupted -------------------

test('a check that just started is not stale', () => {
  assert.strictEqual(staleRunningLock(running(5 * 1000), 3, NOW), false);
  assert.strictEqual(staleRunningLock(running(60 * 1000), 3, NOW), false);
  assert.strictEqual(staleRunningLock(running(9 * 60 * 1000), 3, NOW), false);
});

test('the floor is 10 minutes even for a 1-minute interval', () => {
  assert.strictEqual(staleRunningLock(running(MIN_LOCK_MS - 1000), 1, NOW), false);
  assert.strictEqual(staleRunningLock(running(MIN_LOCK_MS + 1000), 1, NOW), true);
});

test('a long interval gets proportionally longer grace (3x)', () => {
  // 30-min interval -> 90 minutes before we override.
  assert.strictEqual(staleRunningLock(running(60 * 60 * 1000), 30, NOW), false, '60 min into a 30-min-interval job');
  assert.strictEqual(staleRunningLock(running(91 * 60 * 1000), 30, NOW), true);
});

// ---- a dead check must NEVER block the job forever ------------------------

test('THE BUG: a lock left over from hours ago is stale', () => {
  assert.strictEqual(staleRunningLock(running(3 * 60 * 60 * 1000), 3, NOW), true);
});

test('a lock left over from YESTERDAY is stale', () => {
  // The guard ran before the new-day reset, so this used to survive midnight
  // and skip the job for the rest of its life.
  assert.strictEqual(staleRunningLock(running(26 * 60 * 60 * 1000), 3, NOW), true);
});

test('a lock with no timestamp is stale — it can never expire on its own', () => {
  assert.strictEqual(staleRunningLock({ status: 'running' }, 3, NOW), true);
  assert.strictEqual(staleRunningLock({ status: 'running', at: '' }, 3, NOW), true);
  assert.strictEqual(staleRunningLock({ status: 'running', at: 'not-a-date' }, 3, NOW), true);
});

test('a lock stamped in the FUTURE is stale, not immortal', () => {
  // A clock jump must not create a lock that can never time out.
  assert.strictEqual(staleRunningLock({ status: 'running', at: new Date(NOW + 86400000).toISOString() }, 3, NOW), true);
});

// ---- every other status is not a lock at all -----------------------------

test('only "running" is a lock', () => {
  for (const status of ['monitoring', 'complete', 'failed', 'halted', 'paused', 'window-complete']) {
    assert.strictEqual(staleRunningLock({ status, at: agoMs(99 * 60 * 60 * 1000) }, 3, NOW), false, status);
  }
  assert.strictEqual(staleRunningLock(null, 3, NOW), false);
  assert.strictEqual(staleRunningLock(undefined, 3, NOW), false);
});

// ---- lockedOut: what the scheduler actually calls -------------------------

test('lockedOut skips a live check and releases a dead one', () => {
  assert.strictEqual(lockedOut({ lastResult: running(30 * 1000) }, 3, NOW), true, 'live check: skip');
  assert.strictEqual(lockedOut({ lastResult: running(5 * 60 * 60 * 1000) }, 3, NOW), false, 'dead lock: run anyway');
  assert.strictEqual(lockedOut({ lastResult: { status: 'monitoring' } }, 3, NOW), false);
  assert.strictEqual(lockedOut({}, 3, NOW), false, 'a job that never ran is not locked');
  assert.strictEqual(lockedOut(null, 3, NOW), false);
});
