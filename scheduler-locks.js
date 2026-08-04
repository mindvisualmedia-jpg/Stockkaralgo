/**
 * scheduler-locks.js — expiry for the algo scheduler's "running" lock.
 *
 * THE BUG THIS EXISTS FOR
 *
 * Before each check the scheduler writes lastResult = { status: 'running' } and
 * then SKIPS the job while that flag is set, so two checks can never overlap.
 * The flag is cleared only by runScheduledAlgo's callback.
 *
 * If that callback never fires — the app restarts mid-scan, a broker request
 * hangs, an exception escapes — nothing clears it. And because the guard
 * returns BEFORE the new-day reset further down, the flag survived midnight
 * too: the job was skipped FOREVER while the card still showed a live-looking
 * "Next check" countdown from the last successful run. The user sees "Last:
 * running", free slots, and an algo that never trades again.
 *
 * A lock with no expiry is not a lock, it is a trap. This gives it a deadline.
 */
'use strict';

const MIN_LOCK_MS = 10 * 60 * 1000;   // never expire a lock younger than this

/**
 * Has a 'running' lock outlived any plausible real check?
 *
 * Generous on purpose: a genuine scan finishes in seconds, so waiting several
 * check-intervals (at least 10 minutes) before overriding means a slow-but-alive
 * scan is never interrupted, while a dead one cannot block the day.
 *
 * @param {object} lastResult   job.lastResult
 * @param {number} intervalMin  the job's check interval, in minutes
 * @param {number} [nowMs]      defaults to Date.now()
 * @returns {boolean} true when the lock should be ignored
 */
function staleRunningLock(lastResult, intervalMin, nowMs) {
  const lr = lastResult || {};
  if (lr.status !== 'running') return false;
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const startedAt = Date.parse(lr.at || '');
  // A lock with no usable timestamp cannot be trusted to expire on its own, so
  // treat it as dead rather than let it block the job indefinitely.
  if (!Number.isFinite(startedAt)) return true;
  // A clock jump backwards must not make a fresh lock look ancient... but it
  // must not make a dead one immortal either, so a future timestamp is stale.
  if (startedAt > now) return true;
  const limit = Math.max(MIN_LOCK_MS, Math.max(1, Number(intervalMin) || 3) * 3 * 60 * 1000);
  return (now - startedAt) >= limit;
}

/** Should the scheduler skip this job because a check is genuinely in flight? */
function lockedOut(job, intervalMin, nowMs) {
  const lr = job && job.lastResult;
  if (!lr || lr.status !== 'running') return false;
  return !staleRunningLock(lr, intervalMin, nowMs);
}

module.exports = { staleRunningLock, lockedOut, MIN_LOCK_MS };
