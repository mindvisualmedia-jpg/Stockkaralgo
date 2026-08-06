'use strict';
// Single-active-broker policy. The assertions that matter most are the
// fail-open ones: this feature limits NEW entries, and no bug in it may ever
// block the one broker a customer actually uses.

const test = require('node:test');
const assert = require('node:assert');
const { entryAllowed, deriveActiveBroker } = require('./broker-policy');

// ---- entryAllowed ----------------------------------------------------------
test('active broker takes entries; any other broker is refused', () => {
  assert.strictEqual(entryAllowed({ orderBroker: 'fyers', activeBroker: 'fyers', multiBroker: false, enforce: true }), true);
  assert.strictEqual(entryAllowed({ orderBroker: 'dhan', activeBroker: 'fyers', multiBroker: false, enforce: true }), false);
  assert.strictEqual(entryAllowed({ orderBroker: 'zerodha', activeBroker: 'fyers', multiBroker: false, enforce: true }), false);
});

test('multibroker add-on lifts the limit entirely', () => {
  assert.strictEqual(entryAllowed({ orderBroker: 'dhan', activeBroker: 'fyers', multiBroker: true, enforce: true }), true);
});

test('FAIL-OPEN: no recorded active broker means no enforcement', () => {
  assert.strictEqual(entryAllowed({ orderBroker: 'dhan', activeBroker: null, multiBroker: false, enforce: true }), true);
  assert.strictEqual(entryAllowed({ orderBroker: 'dhan', activeBroker: '', multiBroker: false, enforce: true }), true);
});

test('FAIL-OPEN: env escape hatch disables the gate', () => {
  assert.strictEqual(entryAllowed({ orderBroker: 'dhan', activeBroker: 'fyers', multiBroker: false, enforce: false }), true);
});

test('comparison is case-insensitive and defaults a missing order broker to dhan', () => {
  assert.strictEqual(entryAllowed({ orderBroker: 'FYERS', activeBroker: 'fyers', multiBroker: false, enforce: true }), true);
  assert.strictEqual(entryAllowed({ orderBroker: undefined, activeBroker: 'dhan', multiBroker: false, enforce: true }), true);
  assert.strictEqual(entryAllowed({ orderBroker: undefined, activeBroker: 'fyers', multiBroker: false, enforce: true }), false);
});

// ---- deriveActiveBroker ----------------------------------------------------
test('derivation: most recent token activity wins', () => {
  assert.strictEqual(deriveActiveBroker([
    { broker: 'dhan', configured: true, lastAuthAt: '2026-08-05T04:00:00Z' },
    { broker: 'fyers', configured: true, lastAuthAt: '2026-08-06T03:30:00Z' },
  ]), 'fyers');
});

test('derivation: unconfigured brokers never win, whatever their timestamps', () => {
  assert.strictEqual(deriveActiveBroker([
    { broker: 'zerodha', configured: false, lastAuthAt: '2026-08-06T09:00:00Z' },
    { broker: 'dhan', configured: true, lastAuthAt: '2026-08-01T04:00:00Z' },
  ]), 'dhan');
});

test('derivation: nothing configured -> null (and null fails open above)', () => {
  assert.strictEqual(deriveActiveBroker([]), null);
  assert.strictEqual(deriveActiveBroker([{ broker: 'dhan', configured: false }]), null);
  assert.strictEqual(deriveActiveBroker(null), null);
});

test('derivation: a configured broker with no timestamp still beats nothing', () => {
  assert.strictEqual(deriveActiveBroker([{ broker: 'dhan', configured: true, lastAuthAt: null }]), 'dhan');
});
