'use strict';
// FYERS duplicate-entry guard (last line before placement).
//
// Verbatim copies of server.js hasOpenSameDayFyersOrder + isOpenOrderLogEntry +
// isSameIstDate and the held-set comparison, so the guard's decisions can be
// asserted without a live broker. If these drift from server.js, update both.
//
// Why (2026-07): a FYERS algo re-entered a stock already in holdings. The
// selection-level broker-truth skip (v2.61.6) fixed the common case; this guard
// is the belt-and-suspenders Dhan already had — blocks at placement on either an
// open same-day FYERS row OR a live holding.

const { test } = require('node:test');
const assert = require('node:assert');

function isOpenOrderLogEntry(entry) {
  const statusText = String(entry.status || '').toUpperCase();
  const resultText = String(entry.exitType || entry.result || '').toUpperCase();
  if (['ERROR', 'SKIPPED', 'N/A'].includes(String(entry.orderId || '').toUpperCase())) return false;
  if (entry.manualClose) return false;
  if (/(TARGET HIT|SL HIT|REJECT|CANCEL|FAILED|FAIL|INVALID|EXITED|CLOSED)/.test(statusText + ' ' + resultText)) return false;
  return true;
}
const istKey = d => new Date(new Date(d).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })).toDateString();
function isSameIstDate(a, b) { return istKey(a) === istKey(b); }

// hasOpenSameDayFyersOrder with the log + "now" injected.
function hasOpenSameDayFyersOrder(symbol, log, now) {
  const clean = String(symbol || '').replace(/^(NSE|BSE):/i, '').replace('-EQ', '').replace(/\s/g, '').toUpperCase();
  return log.some(entry =>
    String(entry.broker || '').toLowerCase() === 'fyers' &&
    String(entry.symbol || '').replace(/^(NSE|BSE):/i, '').replace('-EQ', '').replace(/\s/g, '').toUpperCase() === clean &&
    isSameIstDate(entry.recordedAt || entry.time || now, now) &&
    isOpenOrderLogEntry(entry));
}
// The held-set comparison from placeFyersOrder.
function heldBlocks(symRaw, heldSet) { return !!heldSet && heldSet.has(symRaw.replace('-EQ', '')); }

const NOW = new Date('2026-07-25T06:00:00.000Z'); // 11:30 IST
const today = new Date('2026-07-25T05:00:00.000Z').toISOString();
const yday = new Date('2026-07-24T05:00:00.000Z').toISOString();
const openRow = (over = {}) => ({ broker: 'fyers', symbol: 'SBIN', status: 'FYERS ENTRY + GTT OCO', orderId: 'GTT:1', recordedAt: today, ...over });

// ── log guard ───────────────────────────────────────────────────────────────

test('open same-day FYERS row for the symbol blocks', () => {
  assert.equal(hasOpenSameDayFyersOrder('SBIN', [openRow()], NOW), true);
});

test('a CLOSED same-day row does NOT block (position already exited)', () => {
  assert.equal(hasOpenSameDayFyersOrder('SBIN', [openRow({ status: 'TARGET HIT', exitType: 'TARGET HIT' })], NOW), false);
});

test("yesterday's open row does not block a fresh day", () => {
  assert.equal(hasOpenSameDayFyersOrder('SBIN', [openRow({ recordedAt: yday })], NOW), false);
});

test('a DHAN row for the same symbol never blocks a FYERS entry', () => {
  assert.equal(hasOpenSameDayFyersOrder('SBIN', [openRow({ broker: 'dhan' })], NOW), false);
});

test('symbol normalization matches across -EQ / NSE: / case forms', () => {
  assert.equal(hasOpenSameDayFyersOrder('sbin', [openRow({ symbol: 'NSE:SBIN-EQ' })], NOW), true);
  assert.equal(hasOpenSameDayFyersOrder('NSE:SBIN', [openRow({ symbol: 'SBIN' })], NOW), true);
});

test('a different symbol does not block', () => {
  assert.equal(hasOpenSameDayFyersOrder('TCS', [openRow()], NOW), false);
});

// ── held-set guard ────────────────────────────────────────────────────────────

test('a symbol held at FYERS blocks; -EQ forms normalise', () => {
  assert.equal(heldBlocks('SBIN', new Set(['SBIN'])), true);
  assert.equal(heldBlocks('SBIN-EQ', new Set(['SBIN'])), true);
  assert.equal(heldBlocks('TCS', new Set(['SBIN'])), false);
});

test('FAIL-SAFE: a null held set (fetch error) never blocks — trading must not halt', () => {
  assert.equal(heldBlocks('SBIN', null), false);
});
