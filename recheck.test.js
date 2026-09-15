'use strict';
// "revoked all but still showing active" (2026-09-15).
//
// The owner revoked all 335 pasted keys in one action, and every box carried on
// reading "Active". Nothing was broken: an ACTIVE box re-asks the licence
// service once a DAY, so a box last seen at 20:39 the previous evening simply
// had not asked yet. But during a migration that is the wrong rhythm - the
// owner cannot verify the thing they just did, and the boxes being retired are
// exactly the ones that need to hear quickly.
//
// A box on a retiring scheme now re-asks every 6 hours, hourly once the sunset
// date has passed, while a box already activated by mobile number keeps the
// settled once-a-day rhythm. Nothing may LENGTHEN the interval.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const activation = require('./activation.js');

const HOUR = 60 * 60 * 1000;

function boxLastCheckedHoursAgo(hours) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-recheck-'));
  fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({
    key: 'STK1.whatever',
    activation: { state: 'active', keyId: 'lic_46f940aa', lastTry: new Date(Date.now() - hours * HOUR).toISOString() },
  }));
  return dir;
}
// The service points at a dead port: a box that DOES ask comes back
// 'unreachable', a box the interval held back comes back 'already'. So the
// reason alone says whether the check was let through, with no network.
const DEAD = 'http://127.0.0.1:9/v1/activate';
const ask = (dir, over = {}) => activation.ensureActivated({ dir, key: 'STK1.whatever', keyId: 'lic_46f940aa', url: DEAD, timeoutMs: 300, ...over });

test('the settled rhythm: an active box does not re-ask within 24h', async () => {
  const r = await ask(boxLastCheckedHoursAgo(3));
  assert.equal(r.reason, 'already', 'it skipped the check, as it has always done');
  assert.equal(r.state, 'active');
});

test('INCIDENT: 19 hours after its last check, the old daily rhythm still says nothing', async () => {
  const r = await ask(boxLastCheckedHoursAgo(19));
  assert.equal(r.reason, 'already');
});

test('a box on a RETIRING scheme re-asks after 6 hours', async () => {
  const r = await ask(boxLastCheckedHoursAgo(7), { recheckMs: 6 * HOUR });
  assert.notEqual(r.reason, 'already', 'the interval let it through: ' + JSON.stringify(r));
});

test('and hourly once the sunset has passed', async () => {
  const r = await ask(boxLastCheckedHoursAgo(2), { recheckMs: HOUR });
  assert.notEqual(r.reason, 'already');
  const tooSoon = await ask(boxLastCheckedHoursAgo(0.25), { recheckMs: HOUR });
  assert.equal(tooSoon.reason, 'already', '15 minutes is still too soon - this is not a hammer');
});

test('the interval can only SHORTEN: a caller cannot make a box ask less often', async () => {
  const r = await ask(boxLastCheckedHoursAgo(30), { recheckMs: 90 * 24 * HOUR });
  assert.notEqual(r.reason, 'already', '30 hours is past the 24h ceiling, whatever was asked for');
});

test('omitting it keeps the old behaviour exactly', async () => {
  assert.equal((await ask(boxLastCheckedHoursAgo(5))).reason, 'already');
  assert.notEqual((await ask(boxLastCheckedHoursAgo(25))).reason, 'already');
});

// ---- the wiring ----------------------------------------------------------------
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('only boxes still on a retiring scheme get the faster rhythm', () => {
  assert.ok(src.includes("const onOldScheme = String((e.license || {}).grant || '') !== 'identity';"));
  assert.ok(src.includes('const recheckMs = onOldScheme ? (legacySunsetPassed() ? 60 * 60 * 1000 : 6 * 60 * 60 * 1000) : 0;'));
  assert.ok(src.includes('force: !!force, recheckMs })'));
});
