'use strict';
// test/backup.server.test.js - the nightly backup to Telegram and Restore from
// backup, through the REAL server (2026-10-26).
//
// Owner: customers' AWS accounts are expiring and "nobody will click download"
// - so the box sends its whole data folder to the customer's own Telegram
// every weekday evening, and a new server takes it back in one upload. Telegram
// is faked locally (https.request to api.telegram.org is redirected).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const backup = require('../backup');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-backupsrv-'));
const write = (n, v) => fs.writeFileSync(path.join(dataDir, n), typeof v === 'string' ? v : JSON.stringify(v));
const read = (n) => fs.readFileSync(path.join(dataDir, n), 'utf8');
const CLOSED_ROW = { id: 'r-closed', broker: 'dhan', symbol: 'TCS', action: 'BUY', qty: 5, orderId: 'ENTRY:1 | FOREVER:2', status: 'DHAN TARGET HIT', exitType: 'TARGET', recordedAt: '2026-10-20T04:00:00Z' };
write('order_log.json', [CLOSED_ROW]);
write('algo_schedule.json', { jobs: [{ id: 'job-1', enabled: true, config: { algoName: 'Swing' } }] });
write('dhan_token.json', { clientId: 'FAKECLIENT', token: 'old-server-token' });
write('telegram.json', { enabled: true, botToken: 'TESTBOT', chatId: '424242', alerts: { brokerExpiry: true } });
write('license.json', { key: 'STK1.old', identity: '+919876543210' });
write('install_id.json', { installId: 'c'.repeat(32) });
Object.assign(process.env, { STOCKKAR_LICENCE_ENFORCE: '0', STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1' });

// ---- Telegram, faked --------------------------------------------------------
const tg = { calls: [], status: 200, reply: { ok: true, result: { message_id: 1 } } };
const fakeTg = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    tg.calls.push({ path: req.url, type: req.headers['content-type'] || '', body: Buffer.concat(chunks) });
    res.writeHead(tg.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(tg.reply));
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
function multipart(call) {
  const boundary = /boundary=(.+)$/.exec(call.type)[1];
  const out = {};
  const body = call.body;
  let at = body.indexOf('--' + boundary);
  while (at >= 0) {
    const next = body.indexOf('\r\n--' + boundary, at + 2);
    if (next < 0) break;
    const part = body.subarray(at + boundary.length + 4, next);   // after "--boundary\r\n"
    const split = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, split).toString('utf8');
    const name = /name="([^"]+)"/.exec(head)[1];
    const filename = (/filename="([^"]+)"/.exec(head) || [])[1];
    out[name] = filename ? { filename, data: part.subarray(split + 4) } : part.subarray(split + 4).toString('utf8');
    at = next + 2;
  }
  return out;
}

// ---- the box ----------------------------------------------------------------
let S, app, appPort, cookie = '', restarts = 0;
// headers.cookie === null sends no cookie at all (a support pass on its own).
function call(method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : Buffer.isBuffer(body) ? body : JSON.stringify(body);
    const h = { 'content-type': Buffer.isBuffer(body) ? 'application/octet-stream' : 'application/json', 'content-length': Buffer.byteLength(payload),
      ...(cookie ? { cookie } : {}), ...(headers || {}) };
    if (h.cookie === null) delete h.cookie;
    const req = http.request({ hostname: '127.0.0.1', port: appPort, path: pathname, method, headers: h }, (res) => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, raw: d, headers: res.headers, body: (() => { try { return JSON.parse(d); } catch { return null; } })() }));
    });
    req.on('error', reject);
    if (payload.length) req.write(payload);
    req.end();
  });
}
const docsSent = () => tg.calls.filter(c => /\/sendDocument$/.test(c.path));
const run = (opts) => new Promise(res => S.runTelegramBackup(opts, (err, out) => res({ err, out })));
const IST = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi);   // getIstNow()'s shape: IST wall clock in local fields

before(async () => {
  await new Promise(r => fakeTg.listen(0, '127.0.0.1', () => { tgPort = fakeTg.address().port; r(); }));
  S = require('../server.js')._internals;
  S.setRestoreRestartHook(() => { restarts++; });
  app = http.createServer(S.handleRequest);
  await new Promise(r => app.listen(0, '127.0.0.1', () => { appPort = app.address().port; r(); }));
  const setup = await call('POST', '/app-lock/setup', { pin: '654321', dob: '1990-01-01' });
  assert.equal(setup.status, 200, setup.raw);
  cookie = String(setup.headers['set-cookie'][0]).split(';')[0];
  assert.match(cookie, /=/, 'unlocked with the PIN');
});
after(() => { https.request = realRequest; return new Promise(r => app.close(() => fakeTg.close(() => r()))); });

test('the evening backup reaches the owner\'s Telegram as ONE file that unpacks to the whole data folder', async () => {
  tg.calls = [];
  const r = await run({ now: IST(2026, 10, 26, 18, 30) });            // Monday
  assert.equal(r.err, null);
  assert.equal(r.out.sent, true);
  assert.equal(docsSent().length, 1);
  assert.equal(docsSent()[0].path, '/botTESTBOT/sendDocument');
  const m = multipart(docsSent()[0]);
  assert.equal(m.chat_id, '424242');
  assert.equal(m.parse_mode, 'HTML');
  assert.match(m.caption, /Stockkar backup — 26 Oct 2026/);
  assert.match(m.caption, /Keep this file private/);
  assert.match(m.caption, /Restore from backup/);
  assert.equal(m.document.filename, 'stockkar-backup-2026-10-26.json.gz');
  const files = Object.fromEntries(backup.unpack(m.document.data).files.map(f => [f.name, f.data.toString('utf8')]));
  for (const n of ['order_log.json', 'algo_schedule.json', 'dhan_token.json', 'telegram.json', 'license.json', 'install_id.json']) assert.equal(files[n], read(n), n + ' travels');
  assert.ok(!('app_lock.json' in files), 'the PIN stays with this server');
});

test('once per evening, weekdays only; the owner\'s switch holds; "Send backup now" works any time', async () => {
  tg.calls = [];
  assert.equal((await run({ now: IST(2026, 10, 26, 21, 0) })).out.skipped, 'sent-today');
  assert.equal((await run({ now: IST(2026, 10, 27, 17, 59) })).out.skipped, 'window');
  assert.equal((await run({ now: IST(2026, 10, 31, 19, 0) })).out.skipped, 'weekend');
  const saved = await call('POST', '/telegram/save', { enabled: true, alerts: { brokerExpiry: true, dailyBackup: false } });
  assert.equal(saved.body.ok, true, saved.raw);
  assert.equal((await call('GET', '/telegram/status')).body.alerts.dailyBackup, false);
  assert.equal((await run({ now: IST(2026, 10, 27, 18, 30) })).out.skipped, 'backup-off');
  assert.equal(docsSent().length, 0, 'nothing was sent');
  const now = await call('POST', '/backup/send-now', {});
  assert.equal(now.body.ok, true, now.raw);
  assert.equal(docsSent().length, 1, 'the button sends even with the evening backup off');
  assert.equal(JSON.parse(read('backup_state.json')).lastSentDay, '2026-10-26', 'a button press is not the evening backup');
  await call('POST', '/telegram/save', { enabled: true, alerts: { brokerExpiry: true } });   // an older page: no flag sent
  assert.equal((await call('GET', '/telegram/status')).body.alerts.dailyBackup, true, 'missing means on');
});

test('a Telegram refusal is recorded and retried - but not all night', async () => {
  tg.status = 403; tg.reply = { ok: false, description: 'Forbidden: bot was blocked by the user' };
  for (let i = 0; i < 6; i++) assert.match(String((await run({ now: IST(2026, 10, 28, 18, 30 + i) })).err), /bot was blocked/);
  assert.equal((await run({ now: IST(2026, 10, 28, 19, 0) })).out.skipped, 'gave-up-today');
  const st = await call('GET', '/backup/status');
  assert.match(st.body.lastError, /bot was blocked/);
  tg.status = 200; tg.reply = { ok: true, result: { message_id: 2 } };
  assert.equal((await run({ now: IST(2026, 10, 29, 18, 10) })).out.sent, true, 'the next evening starts afresh');
});

// ---- Restore from backup ------------------------------------------------------
function sourceBackup() {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-src-'));
  const put = (n, v) => fs.writeFileSync(path.join(src, n), JSON.stringify(v));
  put('order_log.json', [{ ...CLOSED_ROW, id: 'src-row' }]);
  put('algo_schedule.json', { jobs: [{ id: 'job-src', enabled: true, config: { algoName: 'From the old server' } }] });
  put('dhan_token.json', { clientId: 'SRCCLIENT', token: 'src-token' });
  put('telegram.json', { enabled: true, botToken: 'SRCBOT', chatId: '99', alerts: { brokerExpiry: true, dailyBackup: true } });
  put('license.json', { key: 'STK1.src', identity: '+919000000000' });
  put('install_id.json', { installId: 'd'.repeat(32) });
  put('app_lock.json', { pin: 'old server pin' });                 // never travels
  return { src, buffer: backup.pack(src).buffer };
}
async function upload(buffer, parts, headers) {
  const size = Math.ceil(buffer.length / parts);
  let last;
  for (let i = 0; i < parts; i++) {
    last = await call('POST', '/backup/restore?id=testupload01&part=' + i + '&parts=' + parts, buffer.subarray(i * size, Math.min(buffer.length, (i + 1) * size)), headers);
  }
  return last;
}

test('a server already trading is refused - Restore is for a NEW server - and nothing changes', async () => {
  const OPEN = { id: 'r-open', broker: 'dhan', symbol: 'INFY', action: 'BUY', qty: 3, orderId: 'ENTRY:7 | FOREVER:8', status: 'DHAN ENTRY + FOREVER OCO', recordedAt: '2026-10-26T04:00:00Z' };
  write('order_log.json', [OPEN]);
  const r = await upload(sourceBackup().buffer, 1);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /already managing 1 open position\. Restore is for a NEW server - nothing was changed\./);
  assert.equal(JSON.parse(read('order_log.json'))[0].id, 'r-open');
  assert.equal(restarts, 0);
  write('order_log.json', [CLOSED_ROW]);
});

test('a file that is not a backup is refused in plain words', async () => {
  const r = await upload(Buffer.from('this is a photo, not a backup'), 1);
  assert.equal(r.body.ok, false);
  assert.match(r.body.error, /not a Stockkar backup file/);
  assert.equal((await call('POST', '/backup/restore?part=0&parts=1', Buffer.from('x'))).status, 400, 'an upload without its id is refused');
});

test('a support pass cannot restore or send backups', async () => {
  const g = await call('POST', '/support/grant', { hours: 2 });
  assert.equal(g.status, 200, g.raw);
  const pass = { 'x-stockkar-support': g.body.token, cookie: null };
  const r = await call('POST', '/backup/restore?id=testupload02&part=0&parts=1', sourceBackup().buffer, pass);
  assert.equal(r.status, 403, r.raw);
  assert.equal(r.body.supportReadOnly, true);
  assert.equal((await call('POST', '/backup/send-now', {}, pass)).status, 403);
  assert.equal(restarts, 0);
});

test('RESTORE: the backup arrives in pieces, everything moves (broker login, Telegram, licence), the PIN stays, and the server restarts', async () => {
  const { src, buffer } = sourceBackup();
  const lockBefore = read('app_lock.json');
  const r = await upload(buffer, 3);
  assert.equal(r.body.ok, true, r.raw);
  assert.equal(r.body.restarting, true);
  assert.equal(restarts, 1, 'the server restarts on the restored data');
  for (const n of ['order_log.json', 'algo_schedule.json', 'dhan_token.json', 'telegram.json', 'license.json', 'install_id.json']) {
    assert.equal(read(n), fs.readFileSync(path.join(src, n), 'utf8'), n + ' restored');
  }
  assert.equal(read('app_lock.json'), lockBefore, 'this server keeps the PIN its owner just set');
  assert.equal((await call('GET', '/backup/status')).status, 200, 'and the owner is still signed in');
  const kept = fs.readdirSync(dataDir).filter(n => /^pre-restore-.*\.json\.gz$/.test(n));
  assert.equal(kept.length, 1, 'what was replaced is kept');
  assert.equal(JSON.parse(backup.unpack(fs.readFileSync(path.join(dataDir, kept[0]))).files.find(f => f.name === 'dhan_token.json').data).token, 'old-server-token');
});
