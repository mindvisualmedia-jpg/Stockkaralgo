'use strict';
// test/settle.test.js - the helper the fake-broker tests wait on (test/settle.js).
// Its contract: settled() resolves only when no HTTP request is open and no
// short timer is pending - across a chain of them, like an engine pass.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const settle = require('./settle');

const listen = () => new Promise(res => { const s = http.createServer((q, r) => r.end('{}')); s.listen(0, '127.0.0.1', () => { s.unref(); res(s); }); });   // unref: a failed test must not hold the process
function get(port, path, cb) {
  http.request({ host: '127.0.0.1', port, path }, r => { r.resume(); r.on('end', cb); }).end();
}

test('waits through a chain: a reply, then a paced timer, then a second request (Dhan\'s order pacing)', async () => {
  const s = await listen();
  const port = s.address().port, log = [];
  try {
    get(port, '/snapshot', () => { log.push('snapshot'); setTimeout(() => get(port, '/place', () => log.push('placed')), 300); });
    await settle.settled();
    assert.deepEqual(log, ['snapshot', 'placed']);
  } finally { s.closeAllConnections(); s.close(); }
});

test('a cleared timer does not hold it, and a long timer (not pass work) is not counted', async () => {
  clearTimeout(setTimeout(() => {}, 5000));
  const long = setTimeout(() => {}, 60000);
  const t0 = Date.now();
  await settle.settled();
  clearTimeout(long);
  assert.ok(Date.now() - t0 < 1000, 'settled at once');
});

test('it fails loudly instead of hanging', async () => {
  const t = setTimeout(() => {}, 3000);
  await assert.rejects(settle.settled(200), /did not settle within 200 ms/);
  clearTimeout(t);
});
