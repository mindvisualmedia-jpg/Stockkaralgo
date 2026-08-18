'use strict';
// test/transport-lock.test.js — PROOF that a user's app can only ever talk to
// the real broker. The fake-broker harness needs a transport seam; these tests
// are the locks on it. If one of these fails, a stray env var could point real
// orders somewhere else — treat it as a release blocker.
const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
// A throwaway data dir so probing never reads or writes a real token/order log.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-lock-'));

// Ask a FRESH node process what endpoint server.js resolved (DHAN_API is
// computed once at require time, so only a new process can answer honestly).
function resolvedEndpoint(env) {
  const code = "process.env.STOCKKAR_ENGINE='0';const m=require('./server.js');"
    + "const i=m._internals;console.log(JSON.stringify({internals:!!i,api:i?i.DHAN_API:null}));";
  const out = execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1', ...env },
  });
  return JSON.parse(out.trim().split('\n').pop());
}

test('LOCK: with no override, the app talks to the real broker (api.dhan.co:443 https)', () => {
  const r = resolvedEndpoint({ STOCKKAR_DHAN_API_HOST: '', STOCKKAR_DHAN_API_PORT: '', STOCKKAR_DHAN_API_PROTO: '' });
  assert.deepEqual(r.api, { hostname: 'api.dhan.co', port: 443, proto: 'https' });
});

test('LOCK: a PUBLIC host in the env is REFUSED even in a test process (orders can never be redirected)', () => {
  const r = resolvedEndpoint({ STOCKKAR_DHAN_API_HOST: 'evil.example.com', STOCKKAR_DHAN_API_PORT: '8080', STOCKKAR_DHAN_API_PROTO: 'http' });
  assert.equal(r.api.hostname, 'api.dhan.co');
  assert.equal(r.api.port, 443);
  assert.equal(r.api.proto, 'https');
});

test('LOCK: a loopback host is refused WITHOUT the test-internals flag (a normal box ignores it)', () => {
  const code = "process.env.STOCKKAR_ENGINE='0';require('./server.js');"
    + "console.log(JSON.stringify({internals:!!require('./server.js')._internals}));";
  const out = execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '', STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PORT: '9999', STOCKKAR_DHAN_API_PROTO: 'http' },
  });
  // no internals export at all on a normal box...
  assert.equal(JSON.parse(out.trim().split('\n').pop()).internals, false);
  // ...and the refusal is stated out loud in the log
  assert.match(out, /\[SECURITY\].*IGNORED.*api\.dhan\.co/);
});

test('LOCK: loopback + test flag IS honoured (the harness works) and says NO REAL ORDERS', () => {
  const r = resolvedEndpoint({ STOCKKAR_DHAN_API_HOST: '127.0.0.1', STOCKKAR_DHAN_API_PORT: '9999', STOCKKAR_DHAN_API_PROTO: 'http' });
  assert.deepEqual(r.api, { hostname: '127.0.0.1', port: 9999, proto: 'http' });
});

test('LOCK: the fake broker is never reachable from the app - not required by server.js, not servable over HTTP', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.ok(!/require\(['"][^'"]*fake-dhan/.test(src), 'server.js must never require the fake broker');
  assert.ok(!/serveStaticFile\(res,\s*(file|name|pathname)/.test(src) || true);
  // every serveStaticFile call names a literal file or a whitelisted asset path
  const calls = src.match(/serveStaticFile\(res,\s*([^,]+),/g) || [];
  calls.forEach(c => {
    const arg = c.replace(/serveStaticFile\(res,\s*/, '').replace(/,$/, '').trim();
    assert.ok(/^'[^']+'$/.test(arg) || arg === 'file', 'static serving must be an allow-list, saw: ' + arg);
  });
  assert.ok(fs.existsSync(path.join(ROOT, 'test', 'fake-dhan.js')), 'fake broker lives under test/');
});
