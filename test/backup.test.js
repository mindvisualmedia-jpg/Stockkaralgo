'use strict';
// test/backup.test.js - the data folder as ONE file and back (backup.js, 2026-10-26).
// Owner: customers' AWS accounts are expiring; "everything broker telegram etc
// moves". What must hold: every customer file travels byte for byte (broker
// logins, Telegram and the licence included); nothing that belongs to the OLD
// server travels; a restore keeps what it replaced; a file that is not ours -
// or a crafted one - changes nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const backup = require('../backup');

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-' + tag + '-'));
const CUSTOMER = {
  'order_log.json': JSON.stringify([{ id: 'r1', symbol: 'TCS', qty: 5, status: 'DHAN ENTRY + FOREVER OCO' }]),
  'algo_schedule.json': JSON.stringify({ jobs: [{ id: 'job-1', enabled: true, config: { algoName: 'Swing ₹ ✓' } }] }),
  'dhan_token.json': JSON.stringify({ clientId: '1100123456', token: 'eyJ-live-token' }),
  'broker_tokens.json': JSON.stringify({ brokers: { zerodha: { clientId: 'kiteapi', accessToken: 'kite-token' } } }),
  'telegram.json': JSON.stringify({ enabled: true, botToken: '123:ABC', chatId: '42' }),
  'license.json': JSON.stringify({ key: 'STK1.grant', identity: '+919876543210' }),
  'install_id.json': JSON.stringify({ installId: 'a'.repeat(32) }),
  'test_order_log.json': '[]',
};
const BOX_ONLY = ['app_lock.json', 'update_pin.json', 'support_access.json', 'boot_loop.json', 'update_status.json',
  'backup_state.json', 'payload_samples.jsonl', 'angel_instruments.json', 'pre-restore-2026-10-25.json.gz', 'order_log.json.tmp'];
const BINARY = Buffer.from([0xff, 0x00, 0xfe, 0x80, 0x41]);

function oldServer() {
  const dir = tmp('old');
  for (const [n, v] of Object.entries(CUSTOMER)) fs.writeFileSync(path.join(dir, n), v);
  for (const n of BOX_ONLY) fs.writeFileSync(path.join(dir, n), '{"old":"server"}');
  fs.writeFileSync(path.join(dir, 'blob.bin'), BINARY);
  fs.mkdirSync(path.join(dir, 'subfolder')); fs.writeFileSync(path.join(dir, 'subfolder', 'x.json'), '{}');
  return dir;
}

test('every customer file travels byte for byte - broker logins, Telegram and the licence included; nothing of the old server does', () => {
  const packed = backup.pack(oldServer(), { appVersion: '3.30.5' });
  assert.deepEqual(packed.files, [...Object.keys(CUSTOMER), 'blob.bin'].sort());
  const un = backup.unpack(packed.buffer);
  assert.equal(un.appVersion, '3.30.5');
  const got = Object.fromEntries(un.files.map(f => [f.name, f.data]));
  for (const [n, v] of Object.entries(CUSTOMER)) assert.equal(got[n].toString('utf8'), v, n);
  assert.ok(got['blob.bin'].equals(BINARY), 'a non-text file survives (base64)');
  for (const n of BOX_ONLY) assert.ok(!(n in got), n + ' stays with the old server');
});

test('restore: the backup replaces the files, the new server keeps its own PIN, and what was replaced is kept', () => {
  const packed = backup.pack(oldServer());
  const fresh = tmp('new');
  fs.writeFileSync(path.join(fresh, 'app_lock.json'), '{"pin":"the new server\'s"}');
  fs.writeFileSync(path.join(fresh, 'order_log.json'), '[]');
  fs.writeFileSync(path.join(fresh, 'risk_settings.json'), '{"noSlLive":false}');   // only on the new server
  const out = backup.restore(fresh, backup.unpack(packed.buffer), { now: new Date('2026-10-26T13:00:00Z') });
  assert.equal(out.restored, Object.keys(CUSTOMER).length + 1);
  for (const [n, v] of Object.entries(CUSTOMER)) assert.equal(fs.readFileSync(path.join(fresh, n), 'utf8'), v, n);
  assert.equal(fs.readFileSync(path.join(fresh, 'app_lock.json'), 'utf8'), '{"pin":"the new server\'s"}');
  assert.equal(fs.readFileSync(path.join(fresh, 'risk_settings.json'), 'utf8'), '{"noSlLive":false}', 'a file the backup lacks is left alone');
  assert.equal(out.keptAs, 'pre-restore-2026-10-26T13-00-00-000Z.json.gz');
  const kept = Object.fromEntries(backup.unpack(fs.readFileSync(path.join(fresh, out.keptAs))).files.map(f => [f.name, f.data.toString('utf8')]));
  assert.equal(kept['order_log.json'], '[]', 'the replaced data can be put back');
  assert.ok(!fs.readdirSync(fresh).some(n => /\.tmp$/.test(n)), 'no half-written file left');
  assert.ok(!backup.pack(fresh).files.includes(out.keptAs), 'the kept copy never rides in a later backup');
});

test('a file that is not a backup changes nothing and says so plainly', () => {
  const doc = (x) => zlib.gzipSync(Buffer.from(JSON.stringify(x)));
  const file = (name) => ({ name, encoding: 'utf8', data: '{}' });
  const cases = [
    [Buffer.from('PK\x03\x04 a zip, not ours'), /could not be opened/],
    [zlib.gzipSync(Buffer.from('hello')), /unreadable/],
    [doc({ kind: 'something-else', format: 1, files: [file('a.json')] }), /not a Stockkar backup/],
    [doc({ kind: backup.KIND, format: 2, files: [file('a.json')] }), /newer Stockkar/],
    [doc({ kind: backup.KIND, format: 1, files: [] }), /holds no files/],
    [doc({ kind: backup.KIND, format: 1, files: [file('../etc/passwd')] }), /unexpected file name/],
    [doc({ kind: backup.KIND, format: 1, files: [file('sub/x.json')] }), /unexpected file name/],
    [doc({ kind: backup.KIND, format: 1, files: [file('.hidden')] }), /unexpected file name/],
    [doc({ kind: backup.KIND, format: 1, files: [file('a.json'), file('a.json')] }), /unexpected file name/],
    [doc({ kind: backup.KIND, format: 1, files: [{ name: 'a.json', encoding: 'hex', data: '00' }] }), /unknown form/],
  ];
  for (const [buf, msg] of cases) assert.throws(() => backup.unpack(buf), msg);
  assert.throws(() => backup.unpack(zlib.gzipSync(Buffer.alloc(2 * 1024 * 1024)), { maxBytes: 1024 * 1024 }), /could not be opened/,
    'a file that inflates past the limit is refused, never inflated in full');
});

test('a crafted backup carrying the old server\'s PIN or support passes cannot plant them', () => {
  const crafted = zlib.gzipSync(Buffer.from(JSON.stringify({ kind: backup.KIND, format: 1, files: [
    { name: 'order_log.json', encoding: 'utf8', data: '[]' },
    { name: 'app_lock.json', encoding: 'utf8', data: '{"pin":"attacker"}' },
    { name: 'support_access.json', encoding: 'utf8', data: '{"grants":["x"]}' },
  ] })));
  const un = backup.unpack(crafted);
  assert.deepEqual(un.files.map(f => f.name), ['order_log.json']);
});
