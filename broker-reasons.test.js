/**
 * broker-reasons tests.
 *
 * The DDPI positives are the point: a user without DDPI has EVERY protective
 * SELL rejected, and until now the app just showed the broker's jargon. The
 * negatives matter as much — a wrong match sends someone to enable DDPI when
 * their actual problem is funds or a rate limit.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { classify, withHint } = require('./broker-reasons.js');

// ---- DDPI family: every phrasing the brokers actually use ------------------

test('DDPI: the wordings Dhan and Zerodha actually send', () => {
  const positives = [
    'RMS:Debit transaction not allowed as DDPI/POA is not active',
    'DDPI not enabled for this account',
    'EDIS authorization required to sell holdings',
    'e-DIS verification pending',
    'TPIN verification required',
    'POA not registered for demat account',
    'You are not authorised to sell this holding',
    'Demat debit authorization missing',
    'Debit not allowed: complete eDIS/TPIN first',
  ];
  positives.forEach(msg => {
    const c = classify(msg);
    assert.ok(c, 'should classify: ' + msg);
    assert.strictEqual(c.key, 'ddpi', msg + ' -> ' + (c && c.key));
  });
});

test('DDPI hint names the fix, not just the failure', () => {
  const c = classify('DDPI/POA is not active');
  assert.match(c.hint, /Enable it once/i);
  assert.match(c.hint, /Dhan app/i, 'tells a Dhan user exactly where to tap');
});

// ---- adjacent recognised causes --------------------------------------------

test('GTT limit and holdings-lag are recognised separately', () => {
  assert.strictEqual(classify('Maximum GTT limit reached for the account').key, 'gtt-limit');
  assert.strictEqual(classify('Insufficient holding quantity in demat').key, 'holdings-unavailable');
  assert.strictEqual(classify('Holding not available for sell').key, 'holdings-unavailable');
});

// ---- negatives: must NOT match ---------------------------------------------

test('unrelated failures stay unclassified', () => {
  const negatives = [
    'Insufficient funds to place order',
    'Rate limit exceeded, too many requests',
    'Invalid token, please login again',
    'Market is closed',
    'Circuit limit reached for this scrip',
    'Invalid quantity for SME scrip',
    'Order rejected: price out of circuit range',
    'depositor account frozen',              // contains no DDPI wording
    '',
  ];
  negatives.forEach(msg => {
    assert.strictEqual(classify(msg), null, 'must NOT classify: ' + msg);
  });
});

// ---- withHint: safe on every input -----------------------------------------

test('withHint appends the fix only when recognised, and never throws', () => {
  assert.match(withHint('EDIS authorization required'), /DDPI is not enabled/);
  assert.strictEqual(withHint('Insufficient funds'), 'Insufficient funds');
  assert.strictEqual(withHint(''), '');
  assert.strictEqual(withHint(null), '');
  assert.strictEqual(withHint(undefined), '');
  assert.strictEqual(withHint(42), '42', 'broker libs sometimes pass non-strings');
});

// ---- Angel AB4036: surveillance-flagged scrips are API-blocked --------------
test('AB4036 cautionary-listing wording gets the it-is-not-your-token hint', () => {
  const raw = 'Angel One entry order failed: The order cannot be processed as the token is categorised under cautionary listings by the exchange.';
  assert.equal(classify(raw)?.key, 'angel-caution-block');
  assert.match(withHint(raw), /skipped for today/);
  assert.match(withHint(raw), /Nothing is wrong with your token/);
});

test('AB4036 hint never fires on ordinary rejects', () => {
  assert.equal(classify('Insufficient funds for this order'), null);
  assert.equal(classify('Invalid token'), null);
});
