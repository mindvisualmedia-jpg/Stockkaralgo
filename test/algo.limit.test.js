'use strict';
// test/algo.limit.test.js - how many algos can be ON at once (2026-10-21: the
// owner raised the free-server limit from 10 to 15, then 20). Through the real
// routes: the 20th algo starts, the 21st is refused in words, and a paused algo cannot
// be switched back on past the limit. Paused algos never count.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-algolimit-'));
const cfg = (i) => ({ algoName: 'Algo ' + i, screenerSlug: 'screener-' + i, runTime: '09:15', endTime: '15:00', checkIntervalMinutes: 5,
  broker: 'dhan', segment: 'CNC', slMethod: 'pct', slPct: 5, t1Pct: 10, t1Qty: 50, t2Pct: 20 });
const now = new Date().toISOString();
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'algo_schedule.json'), JSON.stringify({ jobs: [
  ...Array.from({ length: 19 }, (_, i) => ({ id: 'job-on-' + i, enabled: true, status: 'active', createdAt: now, updatedAt: now, config: cfg(i) })),
  { id: 'job-paused', enabled: false, status: 'paused', createdAt: now, updatedAt: now, config: cfg('paused') },
] }));
delete process.env.STOCKKAR_MAX_ALGO_JOBS;   // the shipped default, not a box override
Object.assign(process.env, { STOCKKAR_LICENCE_ENFORCE: '0', STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1', STOCKKAR_TELEGRAM_DISABLED: '1' });

let app, appPort, cookie = '';
function call(method, pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : '';
    const req = http.request({ hostname: '127.0.0.1', port: appPort, path: pathname, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(cookie ? { cookie } : {}) } }, (res) => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, raw: d, headers: res.headers, body: (() => { try { return JSON.parse(d); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

before(async () => {
  const S = require('../server.js')._internals;
  app = http.createServer(S.handleRequest);
  await new Promise(res => app.listen(0, '127.0.0.1', () => { appPort = app.address().port; res(); }));
  const setup = await call('POST', '/app-lock/setup', { pin: '654321', dob: '1990-01-01' });
  assert.equal(setup.status, 200, setup.raw);
  cookie = String(setup.headers['set-cookie'][0]).split(';')[0];
});
after(() => new Promise(res => app.close(() => res())));

test('with 19 on, the 20th algo starts - and the limit the page reads is 20', async () => {
  const r = await call('POST', '/algo-schedule', { enabled: true, config: cfg(20) });
  assert.equal(r.body && r.body.ok, true, r.raw);
  assert.equal(r.body.limits.maxAlgoJobs, 20);
});

test('with 20 on, a 21st is refused and the owner is told what to do', async () => {
  const r = await call('POST', '/algo-schedule', { enabled: true, config: cfg(21) });
  assert.equal(r.body && r.body.ok, false, r.raw);
  assert.match(r.body.error, /max 20 active algos\. Pause or cancel an algo before starting another\./);
});

test('a paused algo cannot be switched back on past the limit', async () => {
  const r = await call('POST', '/algo-schedule', { id: 'job-paused', action: 'resume' });
  assert.equal(r.body && r.body.ok, false, r.raw);
  assert.match(r.body.error, /max 20 active algos/);
  const sched = JSON.parse(fs.readFileSync(path.join(dataDir, 'algo_schedule.json'), 'utf8'));
  assert.equal(sched.jobs.filter(j => j.enabled).length, 20, 'still exactly 20 on');
});
