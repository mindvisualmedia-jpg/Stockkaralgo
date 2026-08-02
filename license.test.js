'use strict';
// Licence verification + entitlement resolution.
//
// The security-critical assertions here are the NEGATIVE ones: a tampered,
// forged, expired or foreign key must never grant a feature, and no failure
// mode may take away the base product (a bricked trading app is worse than an
// unlicensed one).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lic = require('./license');

// ---- test issuer ----------------------------------------------------------
const issuer = crypto.generateKeyPairSync('ed25519');
const PUB = issuer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const other = crypto.generateKeyPairSync('ed25519');

function mint(payload, priv = issuer.privateKey) {
  const seg = lic.b64urlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.sign(null, Buffer.from(seg, 'utf8'), priv);
  return 'STK1.' + seg + '.' + lic.b64urlEncode(sig);
}
const base = (over = {}) => ({
  v: 1, id: 'lic_test', to: 'Test User', features: ['gsheet'], suppress: [],
  bind: { type: 'none' }, iat: '2026-01-01', exp: '2099-01-01', ...over,
});

function withLicenseFile(key, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-lic-'));
  try {
    if (key !== null) fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key }));
    return fn(dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// ---- verifyLicense --------------------------------------------------------
test('valid key verifies', () => {
  const r = lic.verifyLicense(mint(base()), { publicKey: PUB });
  assert.strictEqual(r.valid, true);
  assert.strictEqual(r.payload.id, 'lic_test');
});

test('tampered payload is rejected (signature covers the exact segment)', () => {
  const key = mint(base({ features: ['gsheet'] }));
  const [p, seg, sig] = key.split('.');
  const evil = lic.b64urlEncode(Buffer.from(JSON.stringify(base({ features: ['gsheet', 'stockkar'], to: 'Attacker' })), 'utf8'));
  const r = lic.verifyLicense([p, evil, sig].join('.'), { publicKey: PUB });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'bad-signature');
});

test('key signed by a DIFFERENT issuer is rejected', () => {
  const r = lic.verifyLicense(mint(base(), other.privateKey), { publicKey: PUB });
  assert.strictEqual(r.reason, 'bad-signature');
});

test('garbage and wrong prefix are rejected', () => {
  ['', 'nonsense', 'STK2.a.b', 'STK1.only-two-parts'].forEach(k => {
    assert.strictEqual(lic.verifyLicense(k, { publicKey: PUB }).valid, false);
  });
});

test('expired key is rejected; last day is still valid', () => {
  const k = mint(base({ exp: '2026-08-02' }));
  assert.strictEqual(lic.verifyLicense(k, { publicKey: PUB, now: new Date('2026-08-02T10:00:00Z') }).valid, true);
  const r = lic.verifyLicense(k, { publicKey: PUB, now: new Date('2026-08-03T10:00:00Z') });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.reason, 'expired');
});

test('unsupported version is rejected', () => {
  assert.strictEqual(lic.verifyLicense(mint(base({ v: 2 })), { publicKey: PUB }).reason, 'unsupported-version');
});

test('no public key in the build cannot accidentally accept a key', () => {
  assert.strictEqual(lic.verifyLicense(mint(base()), { publicKey: '' }).reason, 'no-public-key');
});

// ---- binding --------------------------------------------------------------
test('binding: matches, mismatches, and grace before a broker is connected', () => {
  const p = base({ bind: { type: 'brokerClientId', value: '1100AAA' } }).bind;
  const payload = { bind: p };
  assert.strictEqual(lic.checkBinding(payload, { brokerClientIds: ['1100aaa'] }).ok, true);   // case-insensitive
  assert.strictEqual(lic.checkBinding(payload, { brokerClientIds: ['9999xyz'] }).ok, false);
  assert.strictEqual(lic.checkBinding(payload, { brokerClientIds: [] }).reason, 'grace-no-broker');
});

// ---- loadEntitlements -----------------------------------------------------
test('no licence file = exactly today\'s product', () => {
  withLicenseFile(null, dir => {
    const e = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.deepStrictEqual(e.features, ['stockkar']);
    assert.strictEqual(e.has('gsheet'), false);
    assert.strictEqual(e.license.installed, false);
  });
});

test('valid licence ADDS gsheet, keeps stockkar', () => {
  withLicenseFile(mint(base()), dir => {
    const e = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.strictEqual(e.has('stockkar'), true);
    assert.strictEqual(e.has('gsheet'), true);
    assert.strictEqual(e.license.valid, true);
  });
});

test('sheet-only: suppress removes stockkar', () => {
  withLicenseFile(mint(base({ features: ['gsheet'], suppress: ['stockkar'] })), dir => {
    const e = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.deepStrictEqual(e.features, ['gsheet']);
    assert.strictEqual(e.has('stockkar'), false);
  });
});

test('FAIL-SAFE: forged key never grants, never removes the base product', () => {
  withLicenseFile(mint(base({ features: ['gsheet'], suppress: ['stockkar'] }), other.privateKey), dir => {
    const e = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.deepStrictEqual(e.features, ['stockkar'], 'suppression from an invalid key must be ignored');
    assert.strictEqual(e.has('gsheet'), false);
    assert.strictEqual(e.license.valid, false);
  });
});

test('FAIL-SAFE: expired sheet-only licence leaves a usable app', () => {
  withLicenseFile(mint(base({ features: ['gsheet'], suppress: ['stockkar'], exp: '2020-01-01' })), dir => {
    const e = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.deepStrictEqual(e.features, ['stockkar']);
    assert.strictEqual(e.license.reason, 'expired');
  });
});

test('binding mismatch denies the feature but keeps the base product', () => {
  withLicenseFile(mint(base({ bind: { type: 'brokerClientId', value: '1100AAA' } })), dir => {
    const e = lic.loadEntitlements({ dir, publicKey: PUB, brokerClientIds: ['2200ZZZ'] });
    assert.deepStrictEqual(e.features, ['stockkar']);
    assert.strictEqual(e.license.reason, 'bound-mismatch');
  });
});

test('expiring soon is flagged with days left', () => {
  withLicenseFile(mint(base({ exp: '2026-08-06' })), dir => {
    const e = lic.loadEntitlements({ dir, publicKey: PUB, now: new Date('2026-08-02T00:00:00Z') });
    assert.strictEqual(e.license.valid, true);
    assert.strictEqual(e.license.daysLeft, 4);
    assert.strictEqual(e.license.expiringSoon, true);
  });
});

test('unknown feature names in a key are ignored', () => {
  withLicenseFile(mint(base({ features: ['gsheet', 'wire-me-money'] })), dir => {
    const e = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.deepStrictEqual(e.features.sort(), ['gsheet', 'stockkar']);
  });
});

test('corrupt licence.json degrades to the base product', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-lic-'));
  try {
    fs.writeFileSync(path.join(dir, 'license.json'), '{not json');
    assert.deepStrictEqual(lic.loadEntitlements({ dir, publicKey: PUB }).features, ['stockkar']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
