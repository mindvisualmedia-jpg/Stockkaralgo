'use strict';
// THE REASON, NOT JUST THE SYMPTOM (2026-09-12). The Angel box went blind on a
// Friday; the alert said "cannot read your ANGELONE account" and the owner had
// to work out for himself that the day's token had never been renewed.
// Owner: "in the alert we should give them a reason that your broker was not
// renewed today."
//
// brokerPolicy.renewalReason turns the token record into two sentences: WHY
// (in the broker's own words when it spoke) and WHAT TO DO. It is pure - the
// caller reads the store and supplies today's IST date key.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { renewalReason } = require('./broker-policy');

const TODAY = '2026-09-12';
const YESTERDAY = '2026-09-11';
const ask = (broker, status, over = {}) => renewalReason(broker, status, { todayKey: TODAY, ...over });

// ---- the incident ------------------------------------------------------------
test('INCIDENT: Angel auto-renew FAILED today -> the broker\'s own words, plus the login to redo', () => {
  const r = ask('angelone', {
    configured: true, status: 'active', canAutoRenew: true, renewalTimeIst: '16:00',
    lastRenewalDate: YESTERDAY, lastRenewalError: 'Invalid refreshToken',
  }, { tokenDay: YESTERDAY });
  assert.match(r.why, /automatic ANGELONE renewal at 16:00 IST FAILED today/);
  assert.match(r.why, /the broker answered: Invalid refreshToken/);
  assert.match(r.why, /Last renewed: 2026-09-11/);
  assert.match(r.action, /Angel One login again/);
});

test('no renewal ran at all today, nothing failed: still says it was not renewed today', () => {
  const r = ask('angelone', {
    configured: true, status: 'active', canAutoRenew: true, renewalTimeIst: '16:00',
    lastRenewalDate: YESTERDAY, lastRenewalError: null,
  }, { tokenDay: YESTERDAY });
  assert.match(r.why, /has not been renewed today/);
  assert.match(r.why, /the automatic renewal runs at 16:00 IST/);
});

test('an EXPIRED token names the expiry AND the missing renewal', () => {
  const r = ask('dhan', {
    configured: true, status: 'expired', minutesLeft: -40, canAutoRenew: true,
    renewalTimeIst: '07:00 & 17:00', lastRenewalDate: YESTERDAY,
  }, { tokenDay: YESTERDAY });
  assert.match(r.why, /DHAN token has EXPIRED and was not renewed today/);
  assert.match(r.why, /07:00 & 17:00 IST/);
  assert.match(r.action, /fresh token at Dhan/);
});

test('the broker REJECTED a token that looks fine by the clock: its answer is quoted', () => {
  const r = ask('zerodha', {
    configured: true, status: 'auth-failed', verifyError: 'Incorrect `api_key` or `access_token`.',
    lastRenewalDate: TODAY,
  }, { tokenDay: TODAY });
  assert.match(r.why, /REJECTED the saved ZERODHA token/);
  assert.match(r.why, /Incorrect/);
  assert.match(r.action, /Renew Zerodha Token/);
});

test('a manual-login broker refreshed TODAY is not accused of a missed renewal', () => {
  // zerodha/fyers never write lastRenewalDate - the token's own IST day proves it
  const r = ask('fyers', { configured: true, status: 'active', canAutoRenew: false, lastRenewalDate: null }, { tokenDay: TODAY });
  assert.equal(r.why, '', 'nothing to say about the token: the read failed for some other reason');
  assert.equal(r.action, '');
});

test('a manual-login broker last logged in YESTERDAY: named as a daily login, not an auto-renewal', () => {
  const r = ask('fyers', { configured: true, status: 'active', canAutoRenew: false, lastRenewalDate: null }, { tokenDay: YESTERDAY });
  assert.match(r.why, /has not been renewed today/);
  assert.match(r.why, /needs a fresh login every day/);
  assert.ok(!/automatic renewal runs/.test(r.why));
  assert.match(r.action, /Login to FYERS/);
});

test('no login saved at all, and credentials-saved-but-no-token, are different sentences', () => {
  const none = ask('angelone', { configured: false, status: 'missing', credentialsConfigured: false });
  assert.match(none.why, /no ANGELONE login is saved on this box/);
  const half = ask('angelone', { configured: false, status: 'needs-renew', credentialsConfigured: true });
  assert.match(half.why, /login is saved, but today’s token was never generated/);
  assert.match(half.action, /Settings/);
});

test('a healthy token renewed today says NOTHING - a blind read there is not a token problem', () => {
  const r = ask('dhan', { configured: true, status: 'active', canAutoRenew: true, lastRenewalDate: TODAY }, { tokenDay: TODAY });
  assert.deepEqual(r, { why: '', action: '' });
});

test('an old renewal error is not re-blamed once the token was refreshed today', () => {
  const r = ask('angelone', { configured: true, status: 'active', canAutoRenew: true, renewalTimeIst: '16:00',
    lastRenewalDate: TODAY, lastRenewalError: 'Invalid refreshToken' }, { tokenDay: TODAY });
  assert.ok(!/FAILED today/.test(r.why), 'today’s renewal succeeded; the stale error is not the headline');
  assert.match(r.why, /the last ANGELONE renewal failed/);
});

test('never throws on junk, and always offers an action when it has a why', () => {
  [undefined, null, {}, { configured: true }].forEach(s => {
    const r = renewalReason('nosuchbroker', s, {});
    assert.equal(typeof r.why, 'string');
    assert.equal(typeof r.action, 'string');
    if (r.why) assert.ok(r.action, 'a reason without an action helps nobody');
  });
  const unknown = ask('nosuchbroker', { configured: false, status: 'missing' });
  assert.match(unknown.action, /Settings/);
});

test('the broker\'s answer is capped so one alert cannot become a wall of text', () => {
  const r = ask('dhan', { configured: true, status: 'active', lastRenewalDate: YESTERDAY, lastRenewalError: 'x'.repeat(500) }, { tokenDay: YESTERDAY });
  assert.ok(r.why.length < 260, 'why stays readable on a phone: ' + r.why.length);
});

// ---- the wiring ---------------------------------------------------------------
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('the blind-broker alert carries the reason and the action', () => {
  assert.ok(src.includes('function brokerRenewalReason(brokerId) {'));
  assert.ok(src.includes("return brokerPolicy.renewalReason(b, st, { todayKey: istDateKey(), tokenDay: istKeyOfIso(iso) });"));
  assert.ok(src.includes("const rr = brokerRenewalReason(brokerName);"));
  assert.ok(src.includes("(rr.why ? '\\n\\n<b>Why:</b> ' + rr.why + '\\n<b>What to do:</b> ' + rr.action : '')"));
  assert.ok(!src.includes('regenerate the ' + "' + brokerName + '" + ' token in Settings'), 'the guessed hint is gone');
});

test('the daily digest reports a broker with open positions even when NO token is saved', () => {
  assert.ok(src.includes('const hasRows = brokers.includes(b2);'));
  assert.ok(src.includes("if (!hasTok(b2) && !hasRows) return;"));
  assert.ok(src.includes("if (!hasTok(b2)) dark.push(b2.toUpperCase() + ': no login saved' + why);"));
  assert.ok(src.includes("const why = rr.why ? ' \\u2014 ' + rr.why : '';"));
  assert.ok(src.includes('open positions are NOT being managed until it clears'));
});
