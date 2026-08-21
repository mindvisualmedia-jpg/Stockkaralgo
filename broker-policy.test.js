'use strict';
// Single-active-broker policy. The assertions that matter most are the
// fail-open ones: this feature limits NEW entries, and no bug in it may ever
// block the one broker a customer actually uses.

const test = require('node:test');
const assert = require('node:assert');
const { readLooksBroken, isRateLimitError, entryProtectionBlock } = require('./broker-policy');
const { entryAllowed, deriveActiveBroker, zerodhaInstrumentGate, probeFailureKind, probeMarksAuthFailure } = require('./broker-policy');

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

// ---- #14: Zerodha entry instrument gate ------------------------------------
test('#14: EQ series and BSE pass; SME and T2T series are refused with the reason', () => {
  assert.strictEqual(zerodhaInstrumentGate({ symbol: 'RELIANCE', exchange: 'NSE', series: 'EQ' }), '');
  assert.strictEqual(zerodhaInstrumentGate({ symbol: 'ANYTHING', exchange: 'BSE', series: '' }), '');
  assert.match(zerodhaInstrumentGate({ symbol: 'BAHETI', exchange: 'NSE', series: 'SM', lot: 375 }), /SME scrip .*lots of 375/);
  assert.match(zerodhaInstrumentGate({ symbol: 'KALAHRIDHAAN', exchange: 'NSE', series: 'ST' }), /SME scrip/);
  assert.match(zerodhaInstrumentGate({ symbol: 'INDOAMIN', exchange: 'NSE', series: 'BE' }), /T2T scrip .*RMS-rejected/);
});

test('#14: other non-EQ series name the real Kite symbol (the mapping made visible)', () => {
  assert.match(zerodhaInstrumentGate({ symbol: 'SOMEIDR', exchange: 'NSE', series: 'IV' }), /trades as SOMEIDR-IV on Kite/);
});

test('#14 FAIL-OPEN: no series data and no master verdict -> entry proceeds', () => {
  assert.strictEqual(zerodhaInstrumentGate({ symbol: 'NEWLISTING', exchange: 'NSE', series: '', nseKnown: null }), '');
  assert.strictEqual(zerodhaInstrumentGate({ symbol: 'NEWLISTING', exchange: 'NSE', series: '' }), '');
});

test('#14: unknown to a LOADED scrip master is refused; suffixed broker symbols pass through', () => {
  assert.match(zerodhaInstrumentGate({ symbol: 'GONECO', exchange: 'NSE', series: '', nseKnown: false }), /not in the NSE scrip master/);
  assert.strictEqual(zerodhaInstrumentGate({ symbol: 'IWEL-BE', exchange: 'NSE', series: '', nseKnown: false }), '', 'broker-sourced suffixed symbol: fail open');
});

// ---- Liveness-probe failure classification (the 2026-08-11 regression) -----
// A correct Dhan token showed "Not connected / Broker rejected the
// credentials" because ANY probe error counted as proof of rejection. These
// fixtures are the real error strings the adapters emit.
test('probe: transient failures are NEVER credential rejections', () => {
  ['HTTP 429 /v2/orders', 'Too many requests', 'orders: HTTP 503 /v2/orders',
   'timeout /v2/orders', 'ETIMEDOUT', 'socket hang up', 'ECONNRESET',
   'getaddrinfo EAI_AGAIN api.dhan.co', 'HTTP 502 /orders'].forEach(e => {
    assert.equal(probeFailureKind(e), 'transient', e);
    assert.equal(probeMarksAuthFailure(e, 1), false, e);
  });
});

test('probe: real credential refusals ARE auth failures', () => {
  ['HTTP 401 /v2/orders', 'orders: HTTP 403 /orders', 'Unauthorized',
   'Invalid token', 'access token is expired', 'session expired',
   'Invalid API key', 'gtt: HTTP 401 /gtt/orders s=error'].forEach(e => {
    assert.equal(probeFailureKind(e), 'auth', e);
    assert.equal(probeMarksAuthFailure(e, 1), true, e);
  });
});

test('probe: Dhan Invalid IP is an auth failure (persistent + actionable)', () => {
  assert.equal(probeFailureKind('DH-905 Invalid IP address'), 'auth');
  assert.equal(probeFailureKind('Your IP is not whitelisted'), 'auth');
});

test('probe: unknown wording stays transient, but PERSISTENT failure escalates', () => {
  const weird = 'something went wrong';
  assert.equal(probeFailureKind(weird), 'transient');
  assert.equal(probeMarksAuthFailure(weird, 1), false);
  assert.equal(probeMarksAuthFailure(weird, 2), false);
  assert.equal(probeMarksAuthFailure(weird, 3), true, '3 consecutive failures is itself evidence');
});

test('probe: a rate limit stays transient no matter how it is worded', () => {
  assert.equal(probeFailureKind('HTTP 429 unauthorized-looking text'), 'transient',
    'transient patterns are checked FIRST so a 429 can never read as auth');
});

// ---- Dhan speaks in HTTP 400 + DH-9xx codes (2026-08-11 Oracle box) --------
test('Dhan DH-901 expired token is AUTH even though it arrives as HTTP 400', () => {
  const raw = 'orders: HTTP 400 /v2/orders DH-901 Invalid_Authentication Client ID or user generated access token is invalid or expired.';
  assert.equal(probeFailureKind(raw), 'auth');
  assert.equal(probeMarksAuthFailure(raw, 1), true);
});

test('Dhan DH-904 rate limit stays TRANSIENT even though it also arrives as 400/429', () => {
  const raw = 'HTTP 429 /v2/trades DH-904 Rate_Limit Too many requests on server from single user breaching rate limits.';
  assert.equal(probeFailureKind(raw), 'transient');
  assert.equal(probeMarksAuthFailure(raw, 1), false);
});

test('Dhan DH-908/909 (server/network) are transient, not credential problems', () => {
  assert.equal(probeFailureKind('HTTP 500 /v2/orders DH-908 Internal_Server_Error'), 'transient');
  assert.equal(probeFailureKind('HTTP 400 /v2/orders DH-909 Network_Error'), 'transient');
});

test('a bare HTTP 400 with no code is still UNPROVEN until it persists', () => {
  assert.equal(probeFailureKind('HTTP 400 /v2/orders'), 'transient');
  assert.equal(probeMarksAuthFailure('HTTP 400 /v2/orders', 1), false);
  assert.equal(probeMarksAuthFailure('HTTP 400 /v2/orders', 3), true, 'persistent failure still surfaces');
});


// ---- Read sanity + rate limits (2026-08-13 FYERS incident) ------------------
// The GTT list was parsed from the wrong key, so the fetch yielded zero ids
// while eight were known. The legacy sweep caught it; the engine did not, and
// re-armed four positions - cancelling live stops it could not see.
test('readLooksBroken: not one known id in the fetch -> suspect the reader', () => {
  assert.equal(readLooksBroken(['A1', 'A2', 'B1'], new Set()), true, 'empty list + known ids = the 2026-08-13 shape');
  assert.equal(readLooksBroken(['A1', 'A2'], new Set(['X9', 'Y8'])), true, 'a list of strangers is still no match');
});

test('readLooksBroken: ONE match is enough to trust the read', () => {
  assert.equal(readLooksBroken(['A1', 'A2', 'B1'], new Set(['A2'])), false,
    'a genuinely cancelled A1/B1 must still be flaggable when the read is proven good');
});

test('readLooksBroken: nothing known -> nothing to doubt (fresh account, no protections yet)', () => {
  assert.equal(readLooksBroken([], new Set()), false);
  assert.equal(readLooksBroken(null, null), false);
  assert.equal(readLooksBroken([''], new Set()), false, 'blank ids are not knowledge');
});

test('readLooksBroken: accepts an array as well as a Set, and compares as strings', () => {
  assert.equal(readLooksBroken(['1001'], ['1001']), false);
  assert.equal(readLooksBroken([1001], new Set(['1001'])), false, 'numeric id must match its string form');
});

test('isRateLimitError: the FYERS wording that exhausted ARIS three attempts', () => {
  assert.equal(isRateLimitError('FYERS SL re-place failed: Request limit reached, retry after few mins'), true);
  assert.equal(isRateLimitError('HTTP 429 Too Many Requests'), true);
  assert.equal(isRateLimitError('DH-904 breaching rate limits'), true);
});

test('isRateLimitError: a real refusal is NOT a throttle (it must still burn an attempt)', () => {
  assert.equal(isRateLimitError('RMS: insufficient holdings for this GTT'), false);
  assert.equal(isRateLimitError('Invalid symbol'), false);
  assert.equal(isRateLimitError(''), false);
});


// ---- Never open a position you cannot protect (SOUTHWEST, 2026-08-13) ------
// The entry filled and its GTT was refused for "Request limit reached". The
// broker had already refused protective writes minutes earlier; entry
// placement simply never asked.
const NOW_MS = 1_800_000_000_000;

test('a throttling broker blocks NEW entries', () => {
  const why = entryProtectionBlock({ throttledUntil: NOW_MS + 60_000, capacityBlockedUntil: 0, now: NOW_MS });
  assert.ok(why && /rate-limiting/.test(why));
  assert.ok(/skipped/.test(why), 'the reason must say the entry was skipped, not that something failed');
});

test('a FULL GTT book blocks entries and says how to clear it', () => {
  const why = entryProtectionBlock({ throttledUntil: 0, capacityBlockedUntil: NOW_MS + 60_000, now: NOW_MS });
  assert.ok(why && /full/.test(why));
  assert.ok(/cancel unused GTTs/i.test(why), 'a block must name the action that lifts it');
});

test('capacity outranks throttle when both are set (it needs a human)', () => {
  const why = entryProtectionBlock({ throttledUntil: NOW_MS + 60_000, capacityBlockedUntil: NOW_MS + 60_000, now: NOW_MS });
  assert.ok(/full/.test(why));
});

test('expired blocks do not stop anything', () => {
  assert.equal(entryProtectionBlock({ throttledUntil: NOW_MS - 1, capacityBlockedUntil: NOW_MS - 1, now: NOW_MS }), null);
  assert.equal(entryProtectionBlock({ now: NOW_MS }), null, 'nothing recorded -> fail open');
  assert.equal(entryProtectionBlock({ throttledUntil: 0, capacityBlockedUntil: 0, now: NOW_MS }), null);
});

// ---- MTF support is ONE table; a non-MTF broker REFUSES, never downgrades ----
// (2026-08-17 audit) FYERS hard-coded productType 'CNC' and Angel mapped every
// non-INTRADAY segment to DELIVERY, so an algo set to MTF quietly placed CNC on
// both. The customer believed they were leveraged and paid full cash. Silent
// downgrade is a misrepresentation of what was bought.
const { MTF_SUPPORT, brokerSupportsMtf, mtfEntryBlock } = require('./broker-policy');

test('MTF support: Dhan and Zerodha yes; FYERS, Angel One, Upstox no', () => {
  assert.equal(brokerSupportsMtf('dhan'), true);
  assert.equal(brokerSupportsMtf('zerodha'), true);
  assert.equal(brokerSupportsMtf('fyers'), false);
  assert.equal(brokerSupportsMtf('angelone'), false);
  assert.equal(brokerSupportsMtf('upstox'), false);
  assert.ok(Object.isFrozen(MTF_SUPPORT), 'the table is the truth; nothing may mutate it at runtime');
});

test('an MTF entry to a non-MTF broker is REFUSED with a reason that names the broker', () => {
  const r = mtfEntryBlock({ broker: 'fyers', segment: 'MTF' });
  assert.match(r, /not offered on FYERS/);
  assert.match(r, /NOT be quietly placed as CNC/i, 'the message must promise there is no silent downgrade');
});

test('CNC (or no segment) is never blocked, on any broker', () => {
  ['dhan', 'zerodha', 'fyers', 'angelone'].forEach(b => {
    assert.equal(mtfEntryBlock({ broker: b, segment: 'CNC' }), '', b + ' CNC');
    assert.equal(mtfEntryBlock({ broker: b }), '', b + ' default');
  });
});

test('MTF on an MTF broker passes the gate (per-scrip eligibility is the broker\'s call, later)', () => {
  assert.equal(mtfEntryBlock({ broker: 'dhan', segment: 'MTF' }), '');
  assert.equal(mtfEntryBlock({ broker: 'zerodha', segment: 'mtf' }), '', 'case-insensitive');
});

test('readLooksBroken: the suspicion EXPIRES - persistence releases the gate (GFLLIMITED 2026-08-21)', () => {
  // Every tracked bracket was genuinely gone; the gate read 0/8 as "broken
  // read" every pass and deadlocked for FOUR DAYS while a +13% position sat
  // naked. Suspicion is a glitch hypothesis, and glitches are transient:
  // after 3 consecutive suspect passes the engine believes the broker.
  assert.equal(readLooksBroken(['A1'], new Set(), { consecutiveSuspects: 0 }), true, 'first sight: gate');
  assert.equal(readLooksBroken(['A1'], new Set(), { consecutiveSuspects: 2 }), true, 'still within the glitch window');
  assert.equal(readLooksBroken(['A1'], new Set(), { consecutiveSuspects: 3 }), false, 'persisted ~6-8 min: believe it, act loudly');
  // strangers-present releases the same way - and NOT instantly, because a
  // wrong-key parse regression (the 2026-08-13 shape) can fabricate strangers
  assert.equal(readLooksBroken(['A1'], new Set(['X9']), { listNonEmpty: true, consecutiveSuspects: 0 }), true);
  assert.equal(readLooksBroken(['A1'], new Set(['X9']), { listNonEmpty: true, consecutiveSuspects: 3 }), false);
});
