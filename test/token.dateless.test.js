'use strict';
// test/token.dateless.test.js - A TOKEN FILE WITH NO DATES (2026-10-26).
// A dhan_token.json holding only the client id and the token (hand-made, cut
// short, or very old) made getDhanTokenStatus() throw "Invalid time value".
// The Algo page reads token health on load, so the first page load killed the
// process and pm2 restarted it into the same throw; the token checks that run
// every minute threw the same way. A date that is not a date in
// broker_tokens.json did it in the Kite / FYERS / Angel One / Upstox maths.
//
// Proof here: the token pages answer, an age nobody knows reads "unknown"
// (never "active", never a throw), the owner hears about it once a day, and
// the REAL server.js booted with such files stays up through its token ticks.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { settled, sleep } = require('./settle');   // before any server work starts
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

const DATELESS_DHAN = { clientId: 'OLDCLIENT', token: 'old-token' };
const GARBLED_BROKERS = { brokers: {
  zerodha: { clientId: 'kite-app', accessToken: 'kite-tok', updatedAt: 'not a date' },
  fyers: { clientId: 'FYAPP-100', accessToken: 'fyers-tok', savedAt: 'garbled' },
  angelone: { clientId: 'angel-key', accessToken: 'angel-tok', accountId: 'A123', refreshToken: 'angel-refresh', renewedAt: 'yesterday' },
  upstox: { clientId: 'upstox-key', accessToken: 'upstox-tok', renewedAt: '2026-02-30T25:61:00Z' },
  fivepaisa: { clientId: 'fp-key', accessToken: 'fp-tok' },   // no branch of its own: the plain 24h lifetime
} };
// Every broker host the server can call is a closed local port: nothing here
// reaches a real broker.
const CLOSED_BROKERS = {};
for (const k of ['DHAN', 'KITE', 'FYERS', 'ANGEL']) {
  Object.assign(CLOSED_BROKERS, { ['STOCKKAR_' + k + '_API_HOST']: '127.0.0.1', ['STOCKKAR_' + k + '_API_PROTO']: 'http', ['STOCKKAR_' + k + '_API_PORT']: '9' });
}
function seed(dir) {
  fs.writeFileSync(path.join(dir, 'order_log.json'), '[]');
  fs.writeFileSync(path.join(dir, 'dhan_token.json'), JSON.stringify(DATELESS_DHAN));
  fs.writeFileSync(path.join(dir, 'broker_tokens.json'), JSON.stringify(GARBLED_BROKERS));
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-dateless-'));
seed(dataDir);
Object.assign(process.env, { STOCKKAR_LICENCE_ENFORCE: '0', STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1', ...CLOSED_BROKERS });

// ---- Telegram, faked --------------------------------------------------------
const tg = [];
const fakeTg = http.createServer((req, res) => {
  let d = '';
  req.on('data', c => (d += c));
  req.on('end', () => {
    tg.push({ path: req.url, body: d });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"ok":true,"result":{"message_id":1}}');
  });
});
const realRequest = https.request;
let tgPort = 0;
https.request = function (opts, cb) {
  if (opts && typeof opts === 'object' && opts.hostname === 'api.telegram.org') {
    return http.request({ host: '127.0.0.1', port: tgPort, path: opts.path, method: opts.method, headers: opts.headers }, cb);
  }
  return realRequest.apply(this, arguments);
};

function call(port, method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(headers || {}) } }, (res) => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, raw: d, headers: res.headers, body: (() => { try { return JSON.parse(d); } catch { return null; } })() }));
    });
    req.on('error', reject);
    // a handler that threw never answers: fail in seconds, never hang the suite
    req.setTimeout(10000, () => req.destroy(new Error('no answer to ' + method + ' ' + pathname + ' in 10 s')));
    if (payload.length) req.write(payload);
    req.end();
  });
}

let S, app, appPort;
const box = (pathname) => call(appPort, 'GET', pathname, undefined, { 'x-stockkar-internal': S.INTERNAL_SECRET });
before(async () => {
  await new Promise(r => fakeTg.listen(0, '127.0.0.1', () => { tgPort = fakeTg.address().port; r(); }));
  S = require('../server.js')._internals;
  app = http.createServer(S.handleRequest);
  await new Promise(r => app.listen(0, '127.0.0.1', () => { appPort = app.address().port; r(); }));
});
after(() => {
  https.request = realRequest;
  app.closeAllConnections();
  return new Promise(r => app.close(() => fakeTg.close(() => r())));
});

test('no usable date: Dhan reads "unknown" with no expiry; Kite / FYERS / Angel / Upstox count from now, as a missing date always did', { timeout: 30000 }, async () => {
  const r = await box('/algo-schedule/status');
  assert.equal(r.status, 200, r.raw);
  const dhan = r.body.dhanTokenStatus;
  assert.equal(dhan.configured, true);
  assert.equal(dhan.status, 'unknown', 'an age nobody knows is never "active"');
  assert.equal(dhan.expiresAt, '');
  assert.equal(dhan.minutesLeft, null);
  assert.match(dhan.message, /no date, so its expiry is unknown/);
  for (const b of ['zerodha', 'fyers', 'angelone', 'upstox']) {
    const st = r.body.brokerTokenStatuses[b];
    assert.equal(st.configured, true, b);
    assert.ok(Date.parse(st.expiresAt) > Date.now(), b + ': a real expiry, counted from now (' + st.expiresAt + ')');
    assert.ok(st.minutesLeft > 0, b + ' minutes left: ' + st.minutesLeft);
  }
  const plain = await box('/broker-token-status?broker=fivepaisa');
  assert.equal(plain.status, 200, plain.raw);
  assert.equal(plain.body.data.status, 'unknown');
  assert.equal(plain.body.data.expiresAt, '');
  assert.equal(plain.body.data.minutesLeft, null);
  const d = await box('/dhan/token-status');
  assert.equal(d.status, 200, d.raw);
  assert.equal(d.body.data.status, 'unknown');
  await settled();   // the liveness probes (to the closed port) finish here
});

test('the owner hears ONCE a day that the Dhan token has no date', { timeout: 30000 }, async () => {
  fs.writeFileSync(path.join(dataDir, 'telegram.json'), JSON.stringify({ enabled: true, botToken: 'TESTBOT', chatId: '424242', alerts: { brokerExpiry: true } }));
  tg.length = 0;
  const dhanAlerts = () => tg.filter(c => /Dhan token has no date/.test(c.body));
  S.checkTelegramTokenAlerts();
  await settled();
  assert.equal(dhanAlerts().length, 1, JSON.stringify(tg));
  const msg = JSON.parse(dhanAlerts()[0].body);
  assert.equal(dhanAlerts()[0].path, '/botTESTBOT/sendMessage');
  assert.equal(msg.chat_id, '424242');
  assert.match(msg.text, /Dhan token has no date - expiry unknown/);
  assert.match(msg.text, /Generate a fresh token and save it in Settings/);
  S.checkTelegramTokenAlerts();
  await settled();
  assert.equal(dhanAlerts().length, 1, 'the same state is not repeated the same day');
});

// ---- the REAL server --------------------------------------------------------
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const count = (text, re) => (text.match(re) || []).length;

test('the REAL server booted with these files serves the Algo page and stays up through its token ticks', { timeout: 90000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-dateless-boot-'));
  seed(dir);
  const port = await freePort();
  const p = spawn(process.execPath, ['server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, ...CLOSED_BROKERS, STOCKKAR_DATA_DIR: dir, PORT: String(port), HOST: '127.0.0.1',
      STOCKKAR_TELEGRAM_DISABLED: '1', STOCKKAR_TEST_INTERNALS: '1', STOCKKAR_LICENCE_ENFORCE: '0',
      // every token check ticks each second, and both renewals are due at
      // any hour - so each tick reads the dateless status, day or night
      STOCKKAR_TEST_TOKEN_TICK_MS: '1000', DHAN_RENEW_TIMES_IST: '00:00', DHAN_RENEW_HOUR_IST: '0', DHAN_RENEW_MINUTE_IST: '0' },
  });
  let out = '';
  p.stdout.on('data', d => (out += d));
  p.stderr.on('data', d => (out += d));
  const waitFor = async (cond, ms) => {
    const until = Date.now() + ms;
    while (!cond() && p.exitCode === null && Date.now() < until) await sleep(100);
    return cond();
  };
  try {
    assert.ok(await waitFor(() => /STOCKKAR TRADER - Running!/.test(out), 20000), 'server reached listen:\n' + out.slice(-1500));
    const setup = await call(port, 'POST', '/app-lock/setup', { pin: '654321', dob: '1990-01-01' });
    assert.equal(setup.status, 200, setup.raw);
    const cookie = String(setup.headers['set-cookie'][0]).split(';')[0];
    // the request the Algo page makes on load - it used to kill the process
    const first = await call(port, 'GET', '/algo-schedule/status', undefined, { cookie });
    assert.equal(first.status, 200, first.raw + '\n' + out.slice(-1500));
    assert.ok(['unknown', 'renew-failed'].includes(first.body.dhanTokenStatus.status), first.body.dhanTokenStatus.status);
    // several ticks of BOTH renewal checks, each reading a dateless status
    const ticked = await waitFor(() => count(out, /\[DHAN TOKEN\] renew failed @00:00/g) >= 4 && count(out, /\[ANGELONE TOKEN\] renew failed/g) >= 3, 20000);
    assert.ok(ticked, 'the token ticks ran:\n' + out.slice(-2500));
    const again = await call(port, 'GET', '/algo-schedule/status', undefined, { cookie });
    assert.equal(again.status, 200, again.raw);
    assert.equal(again.body.dhanTokenStatus.status, 'renew-failed', 'the failed renewal is the fact shown');
    assert.equal(again.body.dhanTokenStatus.expiresAt, '');
    assert.equal(p.exitCode, null, 'still alive:\n' + out.slice(-1500));
    assert.ok(!/\[FATAL\]/.test(out), 'no fatal line:\n' + out.slice(-1500));
    assert.ok(!/Invalid time value/.test(out), 'no date throw anywhere:\n' + out.slice(-1500));
    assert.ok(!/\[TICK\]/.test(out), 'no tick needed its safety net:\n' + out.slice(-1500));
  } finally {
    try { p.kill(); } catch {}
  }
});
