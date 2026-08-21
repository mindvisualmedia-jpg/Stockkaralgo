'use strict';
// hangguard.test.js - the 2026-08-21 wedge class: a broker that ACCEPTS the
// socket and never answers (Angel's rate limiter does this) used to hang its
// caller forever - angelGet/angelRequest had an error handler but no timeout,
// so the "Angel one test" algo check died silently every time it drew a
// stalled socket. Every raw request in server.js now carries
// BROKER_HTTP_TIMEOUT_MS; this test pins the guard with a silent server.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-hang-'));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
Object.assign(process.env, {
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ANGEL_API_HOST: '127.0.0.1', STOCKKAR_ANGEL_API_PROTO: 'http',
  STOCKKAR_BROKER_HTTP_TIMEOUT_MS: '1200', STOCKKAR_TELEGRAM_DISABLED: '1',
});

let S, srv;
before(async () => {
  srv = net.createServer(() => { /* accept and say NOTHING - the wedge */ });
  await new Promise(res => srv.listen(0, '127.0.0.1', () => {
    process.env.STOCKKAR_ANGEL_API_PORT = String(srv.address().port);
    res();
  }));
  S = require('./server.js')._internals;
});
after(() => new Promise(r => srv.close(r)));

test('a stalled broker socket calls back with a timeout instead of hanging forever', async () => {
  assert.equal(S.BROKER_HTTP_TIMEOUT_MS, 1200, 'env floor honoured for the test');
  const t0 = Date.now();
  const result = await Promise.race([
    new Promise(res => S.angelGet('/rest/secure/angelbroking/order/v1/getOrderBook',
      { clientId: 'k' }, 'token', (err) => res({ err, ms: Date.now() - t0 }))),
    new Promise(res => setTimeout(() => res({ err: 'STILL HUNG', ms: Date.now() - t0 }), 6000)),
  ]);
  assert.notEqual(result.err, 'STILL HUNG', 'the callback MUST fire - this hang was the bug');
  assert.match(String(result.err), /timed out/);
  assert.ok(result.ms >= 1000 && result.ms < 5000, 'fired at the configured timeout, took ' + result.ms + 'ms');
});
