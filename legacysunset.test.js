'use strict';
// RETIRING THE OLD SCHEME COMPLETELY (2026-09-15). Owner: "revoke all legacy
// grandfather".
//
// Revoking keys at the licence service cannot reach a GRANDFATHERED box: it
// never had a key, it never calls the service, and it grants itself features
// from a local flag file. Those boxes are the oldest customers - the ones who
// bought before licensing existed - so this is the change most able to cut off
// someone who paid. It is therefore written to be boring and provable:
//
//   - before the date, absolutely nothing changes
//   - after the date, features are refused, which pauses NEW entries and
//     leaves open positions fully managed (same semantics as a revoked key)
//   - a box that has already switched to mobile activation is untouched, date
//     or no date
//   - the message tells the customer exactly what to do
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const licensing = require('./license.js');

const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-lic-'));   // no license.json: a grandfathered box

const grandfathered = (over = {}) => licensing.loadEntitlements({
  dir: emptyDir, legacyInstall: true, brokerClientIds: [], installId: 'i'.repeat(32), ...over,
});

test('BEFORE the date a grandfathered box is exactly as it was - full features, no ask', () => {
  const e = grandfathered({ legacySunsetPassed: false });
  assert.ok(e.features.length > 0, 'still entitled');
  assert.equal(e.license.legacyLifetime, true);
  assert.equal(e.license.reason, 'legacy-lifetime');
  assert.ok(!e.license.legacySunset);
});

test('AFTER the date the features are refused, and the reason says why', () => {
  const e = grandfathered({ legacySunsetPassed: true });
  assert.deepEqual(e.features, [], 'no features until they activate');
  assert.equal(e.license.legacyLifetime, false, 'the lifetime badge must not show over a retired box');
  assert.equal(e.license.legacySunset, true);
  assert.equal(e.license.reason, 'legacy-retired');
});

test('the message tells them what to do, and that their positions are safe', () => {
  const m = grandfathered({ legacySunsetPassed: true }).license.message;
  assert.match(m, /registered mobile number/);
  assert.match(m, /New entries are paused/);
  assert.match(m, /stop-losses, targets and exits all keep running/);
});

test('a box that is NOT grandfathered is unaffected by the date either way', () => {
  const before = licensing.loadEntitlements({ dir: emptyDir, legacyInstall: false, legacySunsetPassed: false, brokerClientIds: [] });
  const after = licensing.loadEntitlements({ dir: emptyDir, legacyInstall: false, legacySunsetPassed: true, brokerClientIds: [] });
  assert.equal(before.license.reason, 'unlicensed');
  assert.equal(after.license.reason, 'unlicensed', 'still just unlicensed - the sunset is not a new kind of refusal');
  assert.deepEqual(after.features, []);
});

test('the switch is OFF unless the caller passes it - no date, no change', () => {
  const e = grandfathered({});
  assert.equal(e.license.legacyLifetime, true, 'omitting the flag can never retire a box');
  assert.ok(e.features.length > 0);
});

// ---- the clock, and the banner that has to reach these boxes ----------------
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('ONE date governs both halves of the retirement', () => {
  assert.ok(src.includes("const LEGACY_KEY_SUNSET = String(process.env.STOCKKAR_LEGACY_KEY_SUNSET || '2026-09-22')"));
  assert.ok(src.includes('function legacySunsetPassed(now = Date.now()) {'));
  assert.ok(src.includes('legacySunsetPassed: legacySunsetPassed(),'), 'the licence gate is given the clock');
});

test('the header notice reaches a GRANDFATHERED box - the one that hears nothing otherwise', () => {
  assert.ok(src.includes('const onOldScheme = (L.installed && L.valid) || L.legacyLifetime || L.legacySunset;'));
  assert.ok(src.includes("if (String(L.grant || '') === 'identity') return null;"), 'and stops the moment they switch');
  assert.ok(src.includes('pastedKeySunset: legacyKeyNotice(L),'), 'the dashboard is told');
});
