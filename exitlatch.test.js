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

// ── exit chase: convert a dead resting LIMIT to MARKET — guards ─────────────
// Verbatim copy of server.js findChaseableDhanExit (clock injected).

const EXIT_CHASE_MIN_AGE_MS = 10 * 60 * 1000;
function findChaseableDhanExit(entry, sym, orders, nowMs) {
  const chased = Array.isArray(entry.exitChasedIds) ? entry.exitChasedIds : [];
  const stopLevel = Number(entry.brokerSlPrice || entry.slPrice || 0);
  if (!(stopLevel > 0)) return null;
  const normSym = s => String(s || '').replace(/^(NSE|BSE):/i, '').replace('-EQ', '').replace(/\s/g, '').toUpperCase();
  return (orders || []).find(o => {
    if (String(o.transactionType || o.transaction_type || '').toUpperCase() !== 'SELL') return false;
    if (normSym(o.tradingSymbol || o.symbol || o.customSymbol) !== sym) return false;
    const st = String(o.orderStatus || o.status || '').toUpperCase();
    if (!/PENDING|OPEN/.test(st) || /REJECT|CANCEL|TRADED|PART/.test(st)) return false;
    if (String(o.orderType || '').toUpperCase() !== 'LIMIT') return false;
    const id = String(o.orderId || '').trim();
    if (!id || chased.includes(id)) return false;
    const trig = Number(o.triggerPrice || o.trigger_price || 0);
    const px = Number(o.price || 0);
    const trigMatch = trig > 0 && Math.abs(trig - stopLevel) / stopLevel <= 0.015;
    const pxMatch = px > 0 && px <= stopLevel * 1.015 && px >= stopLevel * 0.94;
    if (!trigMatch && !pxMatch) return false;
    const created = Date.parse(o.createTime || o.createdAt || o.updateTime || '') || 0;
    if (created) { if (nowMs - created < EXIT_CHASE_MIN_AGE_MS) return false; }
    else if (!entry.exitPending) return false;
    return true;
  }) || null;
}

const NOW = Date.parse('2026-07-24T07:00:00.000Z');
const AGED = new Date(NOW - 30 * 60 * 1000).toISOString();
const FRESH = new Date(NOW - 2 * 60 * 1000).toISOString();
const healthxRow = { exitPending: true, slPrice: 316.8, qty: 1 };
const sellLimit = (over = {}) => ({ transactionType: 'SELL', tradingSymbol: 'HEALTHX', orderStatus: 'PENDING',
  orderType: 'LIMIT', orderId: 'ORD1', price: 316.8, quantity: 1, createTime: AGED, ...over });

test('CHASE: the HEALTHX shape — aged SELL LIMIT at the stop level is chaseable', () => {
  const c = findChaseableDhanExit(healthxRow, 'HEALTHX', [sellLimit()], NOW);
  assert.equal(c && c.orderId, 'ORD1');
});

test('CHASE GUARD: a hand-priced sell away from the stop is NEVER touched', () => {
  assert.equal(findChaseableDhanExit(healthxRow, 'HEALTHX', [sellLimit({ price: 340 })], NOW), null,
    'a deliberate sell-high limit above the stop must never be converted');
  assert.equal(findChaseableDhanExit(healthxRow, 'HEALTHX', [sellLimit({ price: 290 })], NOW), null,
    'a limit far below the stop (>6%) is not our stop leg');
});

test('THE REAL HEALTHX ORDER: stop moved to cost 322.2, resting limit 316.8 (trigger-buffer below) IS chaseable', () => {
  // 316.8 is 1.68% under 322.2 — outside the old naive ±1.5% band. The
  // trigger-buffer means the fired leg's LIMIT always sits below the stop.
  const row = { exitPending: true, slPrice: 322.2, qty: 1 };
  const byPrice = sellLimit({ price: 316.8, triggerPrice: 0 });
  assert.equal(findChaseableDhanExit(row, 'HEALTHX', [byPrice], NOW)?.orderId, 'ORD1', 'price-band match');
  const byTrigger = sellLimit({ price: 316.8, triggerPrice: 322.2 });
  assert.equal(findChaseableDhanExit(row, 'HEALTHX', [byTrigger], NOW)?.orderId, 'ORD1', 'trigger match');
});

test('CHASE GUARD: MARKET orders and partial fills are left alone', () => {
  assert.equal(findChaseableDhanExit(healthxRow, 'HEALTHX', [sellLimit({ orderType: 'MARKET' })], NOW), null);
  assert.equal(findChaseableDhanExit(healthxRow, 'HEALTHX', [sellLimit({ orderStatus: 'PART_TRADED' })], NOW), null);
});

test('CHASE GUARD: a fresh order gets time to fill on its own', () => {
  assert.equal(findChaseableDhanExit(healthxRow, 'HEALTHX', [sellLimit({ createTime: FRESH })], NOW), null);
});

test('CHASE GUARD: one conversion per order id, ever', () => {
  const row = { ...healthxRow, exitChasedIds: ['ORD1'] };
  assert.equal(findChaseableDhanExit(row, 'HEALTHX', [sellLimit()], NOW), null);
});

test('CHASE GUARD: no create-time -> only chase once the row is already latched', () => {
  const noTime = sellLimit({ createTime: undefined });
  assert.equal(findChaseableDhanExit({ ...healthxRow, exitPending: false }, 'HEALTHX', [noTime], NOW), null);
  assert.equal(findChaseableDhanExit(healthxRow, 'HEALTHX', [noTime], NOW)?.orderId, 'ORD1');
});
