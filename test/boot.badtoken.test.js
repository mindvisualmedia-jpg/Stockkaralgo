'use strict';
// test/boot.badtoken.test.js - THE 650-RESTART CRASH LOOP (2026-09-10, a
// customer box behind nginx: 502 after every reboot). Its saved Dhan client id
// carried a character HTTP headers do not allow; the token-renewal check that
// runs the moment the server listens threw ERR_INVALID_CHAR; nothing caught it.
//
// Proof here: the REAL server.js, booted with exactly that token file, stays
// up and reports Running; and the credential cleaner strips what a paste can
// carry. A boot smoke on an EMPTY data dir could never have caught this.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { cleanHeaderValue } = require('../broker-policy');

test('cleanHeaderValue keeps printable ASCII only: newline, CR, zero-width space, tab, NBSP all go', () => {
  assert.equal(cleanHeaderValue('1100123456\n'), '1100123456');
  assert.equal(cleanHeaderValue('  1100123456\r\n'), '1100123456');
  assert.equal(cleanHeaderValue('1100​123456'), '1100123456');
  assert.equal(cleanHeaderValue('tok\ten '), 'token');
  assert.equal(cleanHeaderValue('eyJhbGciOi.JIUzUxMiJ9-_'), 'eyJhbGciOi.JIUzUxMiJ9-_', 'a real token is untouched');
  assert.equal(cleanHeaderValue(null), '');
  assert.equal(cleanHeaderValue(12345), '12345');
});

test('the real server boots and STAYS UP with a Dhan client id that carries a newline and a zero-width space', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-badtoken-'));
  fs.writeFileSync(path.join(dir, 'order_log.json'), '[]');
  // a token saved 20h ago so the renewal is DUE at boot (the code path that threw)
  const savedAt = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(dir, 'dhan_token.json'), JSON.stringify({
    clientId: '1100​123456\n', token: 'abc.def\r\n', savedAt, updatedAt: savedAt, renewedAt: savedAt, source: 'settings', validityHours: 24,
  }));
  fs.writeFileSync(path.join(dir, 'broker_tokens.json'), JSON.stringify({ brokers: { dhan: { clientId: '1100​123456\n', accessToken: 'abc.def\r\n', savedAt } } }));
  const p = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, STOCKKAR_DATA_DIR: dir, PORT: '0', STOCKKAR_TELEGRAM_DISABLED: '1', STOCKKAR_TEST_INTERNALS: '1',
      // the renewal must not reach the real broker: point Dhan at a closed local port
      STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PROTO: 'http', STOCKKAR_DHAN_API_PORT: '9' },
  });
  let out = '';
  p.stdout.on('data', d => (out += d));
  p.stderr.on('data', d => (out += d));
  let exited = null;
  p.on('exit', (code) => { exited = code; });
  await new Promise(r => setTimeout(r, 7000));
  try { p.kill(); } catch {}
  assert.ok(/STOCKKAR TRADER - Running!/.test(out), 'server reached listen:\n' + out.slice(-1500));
  assert.equal(exited, null, 'the process must still be alive after 7s (it used to die at listen):\n' + out.slice(-1500));
  assert.ok(!/ERR_INVALID_CHAR/.test(out), 'no invalid-header crash:\n' + out.slice(-1500));
  assert.ok(!/\[FATAL\]/.test(out), 'no fatal line');
});

test('digits typed on a Marathi / Hindi / Gujarati / fullwidth keyboard become plain digits, never an empty id', () => {
  assert.equal(cleanHeaderValue('\u0967\u0967\u0966\u0966\u0967\u0968\u0969\u096a\u096b\u096c'), '1100123456', 'Devanagari');
  assert.equal(cleanHeaderValue('\u0ae7\u0ae7\u0ae6\u0ae6'), '1100', 'Gujarati');
  assert.equal(cleanHeaderValue('\u09e7\u09e7\u09e6\u09e6'), '1100', 'Bengali');
  assert.equal(cleanHeaderValue('\uff11\uff11\uff10\uff10'), '1100', 'fullwidth');
  assert.equal(cleanHeaderValue('\u0967\u0967\u0966\u0966\u200b\n'), '1100', 'digits folded, junk still dropped');
  assert.equal(require('../broker-policy').foldDigits('abc'), 'abc');
});
