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

// ---- the three sellable products ------------------------------------------
test('each product resolves to the right entitlements on a box', () => {
  const cases = [
    ['gsheet_only', ['gsheet'], 'Google Sheet only'],
    ['stockkar_only', ['stockkar'], 'Stockkar Algo only'],
    ['both', ['gsheet', 'stockkar'], 'Google Sheet + Stockkar Algo'],
  ];
  cases.forEach(([id, expected, label]) => {
    const spec = lic.PRODUCTS[id];
    const key = mint(base({ features: spec.features, suppress: spec.suppress, product: id }));
    withLicenseFile(key, dir => {
      const e = lic.loadEntitlements({ dir, publicKey: PUB });
      assert.deepStrictEqual(e.features.sort(), expected.sort(), id);
      assert.strictEqual(lic.describeProduct(e.features), label, id);
    });
  });
});

test('upgrade path: a Stockkar box that pastes a "both" key gains gsheet, keeps stockkar', () => {
  const spec = lic.PRODUCTS.both;
  withLicenseFile(mint(base({ features: spec.features, suppress: spec.suppress })), dir => {
    const e = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.strictEqual(e.has('stockkar'), true);
    assert.strictEqual(e.has('gsheet'), true);
  });
});

test('no key at all = Stockkar Algo only (the 200 existing installs)', () => {
  withLicenseFile(null, dir => {
    const e = lic.loadEntitlements({ dir, publicKey: PUB });
    assert.strictEqual(lic.describeProduct(e.features), 'Stockkar Algo only');
  });
});

// ---- lifetime keys ---------------------------------------------------------
test('a key with NO exp never expires (lifetime)', () => {
  const { exp, ...noExp } = base();
  const key = mint(noExp);
  withLicenseFile(key, dir => {
    const now = lic.loadEntitlements({ dir, publicKey: PUB, now: new Date('2026-08-02') });
    const far = lic.loadEntitlements({ dir, publicKey: PUB, now: new Date('2060-01-01') });
    assert.strictEqual(now.has('gsheet'), true);
    assert.strictEqual(far.has('gsheet'), true, 'lifetime key must still work in 2060');
    assert.strictEqual(far.license.expires, null);
    assert.strictEqual(far.license.expiringSoon, false, 'lifetime must never warn about expiry');
  });
});

// ---- binding is broker-agnostic and may name several accounts --------------
test('binding matches ANY connected broker, not just Dhan', () => {
  const payload = { bind: { type: 'brokerClientId', value: 'ZR9988' } };
  // a Zerodha id present alongside Dhan's must satisfy the binding
  assert.strictEqual(lic.checkBinding(payload, { brokerClientIds: ['1100AAA', 'zr9988'] }).ok, true);
  assert.strictEqual(lic.checkBinding(payload, { brokerClientIds: ['1100AAA'] }).ok, false);
});

test('a licence can name SEVERAL client-ids (broker switch without reissue)', () => {
  const many = { bind: { type: 'brokerClientId', values: ['1100AAA', 'ZR9988', 'FY77'] } };
  ['1100aaa', 'zr9988', 'fy77'].forEach(id => {
    assert.strictEqual(lic.checkBinding(many, { brokerClientIds: [id] }).ok, true, id);
  });
  assert.strictEqual(lic.checkBinding(many, { brokerClientIds: ['NOPE1'] }).ok, false);
  assert.strictEqual(lic.checkBinding(many, { brokerClientIds: [] }).reason, 'grace-no-broker');
});

test('comma separated ids in a single value string also work', () => {
  const p = { bind: { type: 'brokerClientId', value: '1100AAA, ZR9988' } };
  assert.strictEqual(lic.checkBinding(p, { brokerClientIds: ['ZR9988'] }).ok, true);
  assert.strictEqual(lic.checkBinding(p, { brokerClientIds: ['OTHER'] }).ok, false);
});

test('multi-bound licence end to end: right account unlocks, wrong one falls back', () => {
  const key = mint(base({ bind: { type: 'brokerClientId', values: ['1100AAA', 'ZR9988'] } }));
  withLicenseFile(key, dir => {
    assert.strictEqual(lic.loadEntitlements({ dir, publicKey: PUB, brokerClientIds: ['ZR9988'] }).has('gsheet'), true);
    assert.deepStrictEqual(lic.loadEntitlements({ dir, publicKey: PUB, brokerClientIds: ['XX1'] }).features, ['stockkar']);
  });
});

// ---- account slots: WE set the count, the BOX discovers the ids ------------
test('reconcileAccounts claims free slots and refuses beyond the limit', () => {
  assert.deepStrictEqual(lic.reconcileAccounts([], ['a'], 2).accounts, ['A']);
  assert.deepStrictEqual(lic.reconcileAccounts(['A'], ['b'], 2).accounts, ['A', 'B']);
  const full = lic.reconcileAccounts(['A', 'B'], ['c'], 2);
  assert.deepStrictEqual(full.accounts, ['A', 'B'], 'a third id must not be locked');
  assert.strictEqual(full.covered, false);
  assert.strictEqual(full.full, true);
  assert.strictEqual(lic.reconcileAccounts(['A', 'B'], [], 2).covered, true, 'no broker connected = grace');
  assert.strictEqual(lic.reconcileAccounts(['A'], ['x'], 0).covered, true, 'limit 0 = unlimited');
});

test('two-account licence: locks the first two seen, refuses a third, keeps working on either', () => {
  const key = mint(base({ maxAccounts: 2 }));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stk-lic-'));
  try {
    fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify({ key }));
    const at = ids => lic.loadEntitlements({ dir, publicKey: PUB, brokerClientIds: ids });
    assert.strictEqual(at(['1100AAA']).has('gsheet'), true);
    assert.strictEqual(at(['ZR9988']).has('gsheet'), true);            // 2nd slot claimed
    const third = at(['FY777']);
    assert.deepStrictEqual(third.features, ['stockkar'], 'third broker is not covered');
    assert.strictEqual(third.license.reason, 'account-limit');
    assert.strictEqual(at(['1100AAA']).has('gsheet'), true, 'a registered account still works');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'license.json'), 'utf8'));
    assert.deepStrictEqual(saved.accounts, ['1100AAA', 'ZR9988'], 'slots persist on disk');
    assert.strictEqual(saved.key, key, 'the key itself must survive the accounts write');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a licence with no maxAccounts is unlimited (unchanged behaviour)', () => {
  withLicenseFile(mint(base()), dir => {
    ['A1', 'B2', 'C3', 'D4'].forEach(id => {
      assert.strictEqual(lic.loadEntitlements({ dir, publicKey: PUB, brokerClientIds: [id] }).has('gsheet'), true, id);
    });
  });
});
