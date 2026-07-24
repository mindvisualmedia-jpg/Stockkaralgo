'use strict';
// Exit-pending latch tests (HEALTHX 2026-07-24 re-arm loop).
//
// Distilled copies of the DECISION ORDER in server.js — the verify passes
// (verifyDhanForeverProtection / verifyFyersGttProtection candidate branch)
// and the restore pass's dhan candidate filter. If these copies drift from
// server.js, update both.
//
// The incident: a stop FIRED and its MARKET SELL sat unfilled (no buyers).
// The fired Forever then DROPPED OFF Dhan's list, so the old condition
// (fired-evidence AND open sell) un-latched exitPending -> grace ->
// UNPROTECTED -> restore re-armed -> new stop fired instantly -> RMS-rejected
// ("sell more than held") -> loop, burning all 3 restore attempts and ending
// in "UNPROTECTED - SL RESTORE FAILED, PLACE MANUALLY" on a position that was
// exiting correctly the whole time. Rule: THE STANDING SELL IS THE LATCH.

const { test } = require('node:test');
const assert = require('node:assert');

// ---- distilled copy: verify-pass branch order (dhan/fyers identical) ----
function verifyDecision(e, c) {
  if (c.protectedNow && e.protectionUnverified) return 'unflag-reverify';
  if (e.protectionUnverified && c.openSell && !c.exited) return 'flag-to-latch'; // FLAG CORRECTION
  if (e.protectionUnverified) return 'leave-flagged';
  if (!(c.held && !c.protectedNow && !c.exited)) return 'clear-strikes';
  if (c.openSell) return e.exitPending ? 'stay-latched' : 'latch-and-alert';
  if (e.exitPending) return 'unlatch-rejoin-rearm-flow';
  return 'grace-then-unprotected';
}

// ---- distilled copy: restore-pass dhan candidate filter ----
function restoreDecision(entry, sym, ctx) {
  if (entry.exitPending) return 'excluded-prefilter';        // openRows filter
  if (!ctx.dhanActive || !ctx.dhanHeld || !ctx.dhanSells) return 'skip-unverified';
  if (!ctx.dhanHeld.has(sym)) return 'skip-not-held';
  if (ctx.dhanSells.has(sym)) return 'latch-exit-in-flight'; // NEVER re-arm past a standing SELL
  if (ctx.dhanActive.syms.has(sym)) return 'skip-protected';
  return 'restore';
}

// ── the loop, killed at both ends ───────────────────────────────────────────

test('THE LOOP: fired Forever vanished from the list, SELL still standing -> latch HOLDS', () => {
  // protectedNow=false because the fired Forever is GONE — the old code
  // un-latched here; the standing SELL must sustain the latch alone.
  const d = verifyDecision({ exitPending: true }, { protectedNow: false, held: true, exited: false, openSell: true });
  assert.equal(d, 'stay-latched');
});

test('first sight of the episode needs NO fired-id evidence: open SELL alone latches', () => {
  const d = verifyDecision({ exitPending: false }, { protectedNow: false, held: true, exited: false, openSell: true });
  assert.equal(d, 'latch-and-alert');
});

test('restore NEVER re-arms past a standing SELL — it latches instead', () => {
  const ctx = { dhanActive: { syms: new Set() }, dhanHeld: new Set(['HEALTHX']), dhanSells: new Set(['HEALTHX']) };
  assert.equal(restoreDecision({ exitPending: false }, 'HEALTHX', ctx), 'latch-exit-in-flight');
});

test('unreadable order book -> restore places NOTHING (never place blind)', () => {
  const ctx = { dhanActive: { syms: new Set() }, dhanHeld: new Set(['HEALTHX']), dhanSells: null };
  assert.equal(restoreDecision({ exitPending: false }, 'HEALTHX', ctx), 'skip-unverified');
});

// ── the terminal state heals itself ─────────────────────────────────────────

test('HEALTHX terminal state: UNPROTECTED flag + standing SELL -> flag swapped for latch', () => {
  // protectionUnverified=true with attempts burned; a standing SELL proves the
  // truth is exit-in-flight, so the row must heal without manual action.
  const d = verifyDecision({ exitPending: false, protectionUnverified: true },
    { protectedNow: false, held: true, exited: false, openSell: true });
  assert.equal(d, 'flag-to-latch');
});

test('flagged with NO standing sell stays flagged (restore/manual own it)', () => {
  const d = verifyDecision({ protectionUnverified: true }, { protectedNow: false, held: true, exited: false, openSell: false });
  assert.equal(d, 'leave-flagged');
});

// ── the latch releases only for the right reasons ───────────────────────────

test('SELL cancelled (e.g. DAY order died overnight) -> unlatch, rejoin the re-arm flow', () => {
  const d = verifyDecision({ exitPending: true }, { protectedNow: false, held: true, exited: false, openSell: false });
  assert.equal(d, 'unlatch-rejoin-rearm-flow');
});

test('SELL filled (position exited) -> normal clear path, not the latch', () => {
  const d = verifyDecision({ exitPending: true }, { protectedNow: false, held: false, exited: true, openSell: false });
  assert.equal(d, 'clear-strikes');
});

test('a genuinely naked position with no sell still reaches the re-arm flow', () => {
  const d = verifyDecision({ exitPending: false }, { protectedNow: false, held: true, exited: false, openSell: false });
  assert.equal(d, 'grace-then-unprotected');
  const ctx = { dhanActive: { syms: new Set() }, dhanHeld: new Set(['ABC']), dhanSells: new Set() };
  assert.equal(restoreDecision({ exitPending: false }, 'ABC', ctx), 'restore');
});
