/**
 * Enforcement matrix — may this box open a NEW position?
 *
 * Every state a real customer can be in, checked explicitly. The gate sits on
 * the single entry choke point (placeBrokerSuperOrder), so a false negative
 * here means a PAYING customer's algo silently stops trading. That has to be
 * impossible to introduce by accident, which is what this file is for.
 *
 * The rule under test: ANY product permits entries. Both sellable products are
 * trading products. Which product a customer holds decides what they can SEE,
 * never whether they may trade.
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const lic = require('./license.js');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const PUB = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Mints keys exactly as scripts/license-admin.js does — including `suppress`,
// which is what makes gsheet_only actually hide the Stockkar feature. A fake
// key that omits it does not represent any real customer.
function mint(o = {}) {
  const spec = lic.PRODUCTS[o.product || 'both'];
  const payload = {
    v: 1, id: o.id || 'lic_enf01', to: 'Enforcement Test',
    product: o.product || 'both',
    features: spec.features,
    suppress: spec.suppress,
    iat: '2026-08-01',
    exp: o.exp === undefined ? '2027-08-01' : o.exp,
  };
  const body = b64u(JSON.stringify(payload));
  return 'STK1.' + body + '.' + b64u(crypto.sign(null, Buffer.from(body), privateKey));
}

function box(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-enf-'));
  if (o.file) fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify(o.file));
  return lic.loadEntitlements({
    dir, publicKey: PUB,
    legacyInstall: !!o.legacy,
    now: new Date((o.on || '2026-08-02') + 'T06:00:00Z'),
  });
}

// ---- MUST BE ALLOWED — a paying customer trading normally ------------------

test('"both" licence may open new positions', () => {
  assert.strictEqual(lic.allowsNewEntries(box({ file: { key: mint({ product: 'both' }) } })), true);
});

test('"Stockkar Algo only" licence may open new positions', () => {
  assert.strictEqual(lic.allowsNewEntries(box({ file: { key: mint({ product: 'stockkar_only' }) } })), true);
});

test('REGRESSION: "Google Sheet only" licence may open new positions', () => {
  // gsheet_only grants ['gsheet'] and SUPPRESSES 'stockkar'. An earlier version
  // of the gate asked has('stockkar') and would have blocked every paying
  // Google-Sheet customer from trading at all. "Sheet only" is the sheet-driven
  // ALGO, not a viewer.
  const ent = box({ file: { key: mint({ product: 'gsheet_only' }) } });
  assert.strictEqual(ent.has('stockkar'), false, 'precondition: the product does suppress stockkar');
  assert.strictEqual(lic.allowsNewEntries(ent), true, 'but it is still a trading product');
});

test('lifetime licence (no expiry) may open new positions', () => {
  assert.strictEqual(lic.allowsNewEntries(box({ file: { key: mint({ exp: null }) }, on: '2099-01-01' })), true);
});

test('existing user inside the legacy grace window may open new positions', () => {
  assert.strictEqual(lic.allowsNewEntries(box({ legacy: true, on: '2026-08-31' })), true);
  assert.strictEqual(lic.allowsNewEntries(box({ legacy: true, on: '2026-09-01' })), true, 'the boundary day itself');
});

// ---- MUST BE BLOCKED — no valid licence -----------------------------------

test('no key at all blocks new positions', () => {
  assert.strictEqual(lic.allowsNewEntries(box({})), false);
});

test('expired licence blocks new positions', () => {
  assert.strictEqual(lic.allowsNewEntries(box({ file: { key: mint({ exp: '2026-07-01' }) } })), false);
});

test('legacy user AFTER the grace window blocks new positions', () => {
  assert.strictEqual(lic.allowsNewEntries(box({ legacy: true, on: '2026-09-02' })), false);
});

test('a key claimed by another install blocks new positions', () => {
  const ent = box({ file: { key: mint(), activation: { state: 'refused', keyId: 'lic_enf01' } } });
  assert.strictEqual(ent.license.reason, 'key-in-use');
  assert.strictEqual(lic.allowsNewEntries(ent), false);
});

test('forged key blocks new positions', () => {
  const forged = 'STK1.' + b64u(JSON.stringify({ v: 1, id: 'x', features: ['stockkar'] })) + '.' + b64u('nope');
  assert.strictEqual(lic.allowsNewEntries(box({ file: { key: forged } })), false);
});

// ---- FAIL-OPEN — a bug in our code must never stop a customer trading ------

test('the pure policy stays strict; fail-open is server.js\'s job alone', () => {
  // Mirrors server.js: anything it cannot understand is treated as "allowed",
  // because a licence bug must never become a trading outage.
  for (const junk of [null, undefined, {}, { features: null }, { features: 'stockkar' }]) {
    assert.strictEqual(lic.allowsNewEntries(junk), false,
      'a shape with no feature list is not itself permission - server.js catches the throw instead');
  }
  // The real fail-open lives in server.js entryAllowedByLicence(): it returns
  // true when entitlements() THROWS, and entitlements() itself already returns
  // the base product on error. Both are proved by the entitlements-error test
  // in license.test.js; this asserts the pure policy stays strict so the
  // fail-open decision is made in exactly one place.
});

test('the policy asks about features, not about a specific product', () => {
  assert.strictEqual(lic.allowsNewEntries({ features: ['gsheet'] }), true);
  assert.strictEqual(lic.allowsNewEntries({ features: ['stockkar'] }), true);
  assert.strictEqual(lic.allowsNewEntries({ features: ['stockkar', 'gsheet'] }), true);
  assert.strictEqual(lic.allowsNewEntries({ features: [] }), false);
});
