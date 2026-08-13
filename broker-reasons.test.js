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

// NOTE (2026-08-13): rate-limit wording used to belong in this list, because
// there was no fix to name. It is classified now - deliberately - since the
// gtt-limit rule was matching those messages and advising people to delete
// GTTs (live stops) in the broker app. Saying "this is a passing throttle, the
// app retries" is both true and safer than saying nothing. See the SOUTHWEST
// tests below.
test('unrelated failures stay unclassified', () => {
  const negatives = [
    'Insufficient funds to place order',
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


// ---- A hint must never send someone to delete their own stops --------------
// SOUTHWEST 2026-08-13: entry filled, protection refused by a FYERS throttle,
// and the row advised "The broker's GTT limit is full - delete unused GTTs in
// the broker app to free slots." The gtt-limit pattern had matched "gtt ...
// limit" across OUR OWN wrapper ("GTT protection (SL+target) FAILED: Request
// limit reached"). Acting on that hint means cancelling live protection.
test('a FYERS throttle is a throttle, never "your GTT book is full"', () => {
  const raw = 'FYERS entry filled but GTT protection (SL+target) FAILED: Request limit reached, retry after few mins.';
  const c = classify(raw);
  assert.equal(c && c.key, 'rate-limit');
  assert.ok(!/delete/i.test(c.hint), 'a hint for a transient error must not tell anyone to delete anything');
});

test('the wrapper text alone never trips the gtt-limit rule', () => {
  assert.equal((classify('GTT protection (SL+target) FAILED: Request limit reached') || {}).key, 'rate-limit');
  assert.equal(classify('FYERS GTT protection failed: something unexpected'), null, 'unknown stays unknown');
});

test('a GENUINE capacity message still gets the delete-some-GTTs hint', () => {
  ['Maximum GTT count reached for this account',
   'GTT limit exceeded',
   'You have reached the maximum number of GTT orders'].forEach(m => {
    assert.equal((classify(m) || {}).key, 'gtt-limit', m);
  });
});

test('other rate-limit wordings map to the throttle hint too', () => {
  ['HTTP 429 Too Many Requests', 'DH-904 breaching rate limits', 'Rate limit reached']
    .forEach(m => assert.equal((classify(m) || {}).key, 'rate-limit', m));
});
