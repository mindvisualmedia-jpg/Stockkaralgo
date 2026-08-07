'use strict';
// entryNoFillDecision — the entry-fill guard (#37, inventory A2).
// GNA 2026-08-04: a Dhan entry was rejected as "expired - no fill" by an order
// book that lied, while 1 share sat in holdings - an untracked, unprotected
// position. The rule: holdings outrank the book; a "no fill" verdict needs
// BOTH sources to agree, and no verdict at all is written without evidence.

const test = require('node:test');
const assert = require('node:assert');
const { entryNoFillDecision } = require('./mtm');

test('GNA fixture: dead book but shares HELD -> protect (the book lied)', () => {
  assert.strictEqual(entryNoFillDecision({ bookDead: true, filledQty: 0, held: true, heldKnown: true }), 'protect');
});

test('held outranks everything - even a non-terminal book', () => {
  assert.strictEqual(entryNoFillDecision({ bookDead: false, filledQty: 0, held: true, heldKnown: true }), 'protect');
});

test('dead book + confirmed not held -> reject (both sources agree)', () => {
  assert.strictEqual(entryNoFillDecision({ bookDead: true, filledQty: 0, held: false, heldKnown: true }), 'reject');
});

test('dead book but holdings UNREADABLE -> wait, never reject blind', () => {
  assert.strictEqual(entryNoFillDecision({ bookDead: true, filledQty: 0, held: false, heldKnown: false }), 'wait');
});

test('book not terminal, not held -> wait (entry still working)', () => {
  assert.strictEqual(entryNoFillDecision({ bookDead: false, filledQty: 0, held: false, heldKnown: true }), 'wait');
});

test('dead book with a partial fill -> wait (the fill branch owns partials, not the reject path)', () => {
  assert.strictEqual(entryNoFillDecision({ bookDead: true, filledQty: 1, held: false, heldKnown: true }), 'wait');
});
