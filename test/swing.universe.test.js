'use strict';
// test/swing.universe.test.js - SWING SECTORS / SWING INDICES IN THE ALGO
// (2026-11-17).
// stockkar.in's Sector / Industry card offers two daily lists, "Swing
// sectors" and "Swing indices" (the Swing section of /rotation, turned into
// member stocks by the site every day). The Algo's sector picker offers the
// same two. Proof here, against a faked stockkar.in and a faked TradingView:
//  - a ticked list keeps today's members only (by fincode, or by symbol when a
//    row has none), counts like a picked sector (either is enough), and picked
//    industries still narrow; with nothing ticked nothing changes;
//  - a REAL scheduled check scans exactly those stocks;
//  - a list that cannot be loaded stops the check before any stock is
//    scanned, and an empty list matches nothing - never the whole basket;
//  - each list is loaded once per 5 minutes and shared by concurrent checks;
//  - the picker route and the preview route answer from the same lists.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

// Every broker host is a closed local port: nothing here reaches a broker.
const CLOSED_BROKERS = {};
for (const k of ['DHAN', 'KITE', 'FYERS', 'ANGEL']) {
  Object.assign(CLOSED_BROKERS, { ['STOCKKAR_' + k + '_API_HOST']: '127.0.0.1', ['STOCKKAR_' + k + '_API_PROTO']: 'http', ['STOCKKAR_' + k + '_API_PORT']: '9' });
}
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-swing-'));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
Object.assign(process.env, { STOCKKAR_LICENCE_ENFORCE: '0', STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1', ...CLOSED_BROKERS });

// ---- today's lists, as the site answers them (shapes from the live API, 17 Nov)
const row = (fincode, symbol, sector, industry) => ({ fincode, symbol, company_name: symbol || 'BSE ONLY', industry, sector, stock_exchange: 'BSE' });
function freshLists() {
  return {
    sectors: { date: '2026-11-17', names: ['Aviation', 'Realty'], rows: [
      row(222055, 'INDIGO', 'Aviation', 'Airlines'),
      row(132868, 'DLF', 'Realty', 'Construction - Real Estate'),
      row(219442, 'LODHA', 'Realty', 'Construction - Real Estate'),
      row(108929, null, 'Realty', 'Construction - Real Estate'),   // listed on BSE only: no symbol
    ] },
    indices: { date: '2026-11-17', names: ['Nifty Private Bank'], rows: [
      row(100180, 'HDFCBANK', 'Bank', 'Bank - Private'),
      row(100270, 'ICICIBANK', 'Bank', 'Bank - Private'),
      row(132868, 'DLF', 'Realty', 'Construction - Real Estate'),   // in both lists
    ] },
  };
}
let lists = freshLists();
const fail = {};                 // level -> HTTP status the site answers instead
const siteCalls = [];            // { path, level, offset, auth }
const tvCalls = [];              // tickers asked for, per scan

const fakeSite = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (u.pathname === '/api/global-filter/stocks') {
    const level = u.searchParams.get('swing');
    const offset = Number(u.searchParams.get('offset') || 0);
    const limit = Number(u.searchParams.get('limit') || 20);
    siteCalls.push({ path: u.pathname, level, offset, limit, auth: req.headers.authorization });
    if (fail[level]) return send(fail[level], { detail: (level === 'indices' ? 'Swing indices' : 'Swing sectors') + ' are not available yet: the rotation data has no usable date.' });
    if (!lists[level]) return send(400, { detail: "swing: '" + level + "' is not one of sectors, indices" });
    const all = lists[level].rows;
    return send(200, { count: all.length, data: all.slice(offset, offset + limit) });
  }
  if (u.pathname === '/api/global-filter/swing-universe') {
    siteCalls.push({ path: u.pathname, auth: req.headers.authorization });
    if (req.headers.authorization !== 'Bearer SKTOKEN') return send(401, { detail: 'Not authenticated' });
    const out = {};
    for (const level of ['sectors', 'indices']) out[level] = { label: level === 'sectors' ? 'Swing sectors' : 'Swing indices', date: lists[level].date, names: lists[level].names, unmapped: [] };
    return send(200, out);
  }
  send(404, { detail: 'Not Found' });
});
const fakeTv = http.createServer((req, res) => {
  let d = '';
  req.on('data', c => (d += c));
  req.on('end', () => {
    let tickers = [];
    try { tickers = JSON.parse(d).symbols.tickers; } catch { /* recorded empty */ }
    tvCalls.push(tickers);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ totalCount: 0, data: [] }));   // nothing qualifies: only the scanned list is under test
  });
});
const realRequest = https.request;
let sitePort = 0, tvPort = 0;
https.request = function (opts, cb) {
  if (opts && typeof opts === 'object' && opts.hostname === 'apii.stockkar.in') {
    return http.request({ host: '127.0.0.1', port: sitePort, path: opts.path, method: opts.method, headers: opts.headers }, cb);
  }
  if (opts && typeof opts === 'object' && opts.hostname === 'scanner.tradingview.com') {
    return http.request({ host: '127.0.0.1', port: tvPort, path: opts.path, method: opts.method, headers: opts.headers }, cb);
  }
  return realRequest.apply(this, arguments);
};

// The basket an algo holds: rows from the site (fincode + sector) and rows from
// sources that only carry a symbol.
const BASKET = [
  { symbol: 'INDIGO', fincode: 222055, sector: 'Aviation', industry: 'Airlines' },
  { symbol: 'DLF', fincode: 132868, sector: 'Realty', industry: 'Construction - Real Estate' },
  { symbol: 'TCS', fincode: 5400, sector: 'IT', industry: 'IT - Software' },
  { symbol: 'INFY', fincode: 5401, sector: 'IT', industry: 'IT - Software' },
  { symbol: 'HDFCBANK', fincode: 100180, sector: 'Bank', industry: 'Bank - Private' },
  { symbol: 'LODHA' },                    // symbol only: matched by symbol
  { symbol: 'ICICIBANK-EQ' },             // a series suffix on the symbol
];
const syms = (rows) => rows.map(r => String(r.symbol).replace(/-EQ$/, '')).sort();

function call(port, method, pathname, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(headers || {}) } }, (res) => {
      let d = ''; res.on('data', c => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, raw: d, body: (() => { try { return JSON.parse(d); } catch { return null; } })() }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('no answer to ' + method + ' ' + pathname + ' in 10 s')));
    if (payload.length) req.write(payload);
    req.end();
  });
}

let S, app, appPort;
const box = (method, pathname, body) => call(appPort, method, pathname, body, { 'x-stockkar-internal': S.INTERNAL_SECRET });
const resolveSwing = (levels, token) => new Promise(r => S.resolveSwingFilter(levels, token, (err, sw) => r({ err, sw })));
const runCheck = (cfgPatch) => new Promise((resolve) => {
  const job = { id: 'job-swing-' + Math.random().toString(16).slice(2, 8), enabled: true, config: {
    broker: 'dhan', testMode: true, stockkarToken: 'SKTOKEN', screenerSlug: 'swing-test', algoName: 'Swing test',
    screenerStocks: BASKET, slMethod: 'pct', slPct: 3, t1Pct: 5, t1Qty: 50, t2Pct: 10, capital: 10000, maxOpenPositions: 5,
    entryFilters: [], ...cfgPatch } };
  S.runScheduledAlgo(job, (err, result) => resolve({ err, result }));
});

before(async () => {
  await new Promise(r => fakeSite.listen(0, '127.0.0.1', () => { sitePort = fakeSite.address().port; r(); }));
  await new Promise(r => fakeTv.listen(0, '127.0.0.1', () => { tvPort = fakeTv.address().port; r(); }));
  S = require('../server.js')._internals;
  app = http.createServer(S.handleRequest);
  await new Promise(r => app.listen(0, '127.0.0.1', () => { appPort = app.address().port; r(); }));
});
after(() => {
  https.request = realRequest;
  app.closeAllConnections();
  return new Promise(r => app.close(() => fakeSite.close(() => fakeTv.close(() => r()))));
});
beforeEach(() => {
  lists = freshLists();
  for (const k of Object.keys(fail)) delete fail[k];
  siteCalls.length = 0;
  tvCalls.length = 0;
  S.resetSwingCache();
});

test('nothing ticked: the sector / industry filter is exactly what it was', async () => {
  assert.strictEqual(S.filterStocksBySectorIndustry(BASKET, [], [], null), BASKET, 'no filter = the same list, untouched');
  assert.strictEqual(S.filterStocksBySectorIndustry(BASKET, [], []), BASKET);
  assert.deepEqual(syms(S.filterStocksBySectorIndustry(BASKET, ['it'], [])), ['INFY', 'TCS']);
  assert.deepEqual(syms(S.filterStocksBySectorIndustry(BASKET, ['it', 'bank'], ['bank - private'])), ['HDFCBANK']);
  const { err, sw } = await resolveSwing([], 'SKTOKEN');
  assert.equal(err, null);
  assert.equal(sw, null, 'no level ticked = no Swing filter at all');
  assert.equal(siteCalls.length, 0, 'and nothing is asked of the site');
});

test('Swing sectors keeps today\'s members only: by fincode, or by symbol when a row has none', async () => {
  const { err, sw } = await resolveSwing(['sectors'], 'SKTOKEN');
  assert.equal(err, null);
  assert.deepEqual(sw.levels, ['sectors']);
  assert.equal(sw.counts.sectors, 4);
  assert.deepEqual(syms(S.filterStocksBySectorIndustry(BASKET, [], [], sw)), ['DLF', 'INDIGO', 'LODHA']);
  assert.equal(siteCalls[0].path, '/api/global-filter/stocks');
  assert.equal(siteCalls[0].level, 'sectors');
  assert.equal(siteCalls[0].auth, 'Bearer SKTOKEN', 'the algo\'s own Stockkar token rides along');
});

test('a Swing list counts like a picked sector (either is enough); picked industries still narrow', async () => {
  const { sw } = await resolveSwing(['sectors'], 'SKTOKEN');
  assert.deepEqual(syms(S.filterStocksBySectorIndustry(BASKET, ['IT'], [], sw)), ['DLF', 'INDIGO', 'INFY', 'LODHA', 'TCS']);
  assert.deepEqual(syms(S.filterStocksBySectorIndustry(BASKET, ['it'], ['airlines', 'it - software'], sw)), ['INDIGO', 'INFY', 'TCS']);
  assert.deepEqual(syms(S.filterStocksBySectorIndustry(BASKET, [], ['airlines'], sw)), ['INDIGO'], 'Swing members, then only Airlines');
});

test('both lists = every member of either, in the site\'s order; anything else is dropped', async () => {
  assert.deepEqual(S.normalizeSwingLevels(['indices', 'SECTORS', 'bogus', '']), ['sectors', 'indices']);
  assert.deepEqual(S.normalizeSwingLevels('sectors'), [], 'a bare string is not a list (the site ignores it too)');
  assert.deepEqual(S.normalizeSwingLevels(undefined), []);
  const { err, sw } = await resolveSwing(['indices', 'sectors'], 'SKTOKEN');
  assert.equal(err, null);
  assert.deepEqual(sw.levels, ['sectors', 'indices']);
  assert.deepEqual(syms(S.filterStocksBySectorIndustry(BASKET, [], [], sw)), ['DLF', 'HDFCBANK', 'ICICIBANK', 'INDIGO', 'LODHA']);
  const junk = await resolveSwing(['bogus'], 'SKTOKEN');
  assert.equal(junk.sw, null, 'an unknown level is no filter and is never sent to the site');
  assert.equal(siteCalls.filter(c => c.level === 'bogus').length, 0);
});

test('a REAL scheduled check scans exactly the Swing stocks', async () => {
  const { err, result } = await runCheck({ swingUniverse: ['sectors'] });
  assert.equal(err, null, String(err));
  assert.equal(result.scanned, 3, JSON.stringify(result));
  assert.equal(tvCalls.length, 1);
  assert.deepEqual(tvCalls[0].slice().sort(), ['NSE:DLF', 'NSE:INDIGO', 'NSE:LODHA']);
  // and an algo with nothing ticked scans the whole basket, as before
  const plain = await runCheck({});
  assert.equal(plain.err, null, String(plain.err));
  assert.equal(plain.result.scanned, BASKET.length);
  assert.equal(siteCalls.length, 1, 'the plain algo never asked the site for a Swing list');
});

test('a list that cannot be loaded stops the check: nothing is scanned, the next check tries again', async () => {
  fail.sectors = 503;
  const { err, result } = await runCheck({ swingUniverse: ['sectors'] });
  assert.equal(result, undefined);
  assert.match(String(err), /Could not load today's Swing sectors from Stockkar \(HTTP 503: Swing sectors are not available yet/);
  assert.match(String(err), /No stocks were scanned this check; the next check tries again/);
  assert.equal(tvCalls.length, 0, 'never fell back to the whole basket');
  // the site answering again is picked up once the retry pause is over
  delete fail.sectors;
  S.resetSwingCache();
  const again = await runCheck({ swingUniverse: ['sectors'] });
  assert.equal(again.err, null, String(again.err));
  assert.equal(again.result.scanned, 3);
});

test('a site that cannot be reached stops the check too', async () => {
  const savedPort = sitePort;
  sitePort = 9;   // closed
  try {
    const { err } = await runCheck({ swingUniverse: ['indices'] });
    assert.match(String(err), /Could not load today's Swing indices from Stockkar/);
    assert.equal(tvCalls.length, 0);
  } finally { sitePort = savedPort; }
});

test('an empty list matches nothing, never the whole basket', async () => {
  lists.sectors.rows = [];
  lists.sectors.names = [];
  const { err } = await runCheck({ swingUniverse: ['sectors'] });
  assert.equal(String(err), 'No stocks from configured basket after sector/industry filters (Swing sectors today: 0 stocks)');
  assert.equal(tvCalls.length, 0);
  // a picked sector still counts on its own
  const withIt = await runCheck({ swingUniverse: ['sectors'], sectorFilters: ['it'] });
  assert.equal(withIt.err, null, String(withIt.err));
  assert.deepEqual(tvCalls[0].slice().sort(), ['NSE:INFY', 'NSE:TCS']);
});

test('each list is loaded once per 5 minutes and shared by checks running together; a failure is not re-asked for a minute', async () => {
  const [a, b] = await Promise.all([resolveSwing(['sectors'], 'SKTOKEN'), resolveSwing(['sectors'], 'SKTOKEN')]);
  assert.equal(a.err, null);
  assert.equal(b.err, null);
  await resolveSwing(['sectors'], 'SKTOKEN');
  assert.equal(siteCalls.filter(c => c.level === 'sectors').length, 1, JSON.stringify(siteCalls));
  fail.indices = 500;
  const f1 = await resolveSwing(['indices'], 'SKTOKEN');
  const f2 = await resolveSwing(['indices'], 'SKTOKEN');
  assert.match(String(f1.err), /HTTP 500/);
  assert.equal(f2.err, f1.err);
  assert.equal(siteCalls.filter(c => c.level === 'indices').length, 1, 'the failed list was asked for once');
});

test('a long list is read page by page', async () => {
  lists.indices.rows = Array.from({ length: 2500 }, (_, i) => row(900000 + i, 'SYM' + i, 'Bank', 'Bank - Private'));
  const { err, sw } = await resolveSwing(['indices'], 'SKTOKEN');
  assert.equal(err, null);
  assert.equal(sw.fincodes.size, 2500);
  assert.equal(sw.counts.indices, 2500);
  assert.deepEqual(siteCalls.map(c => c.offset), [0, 2000]);
  assert.ok(siteCalls.every(c => c.limit === 2000));
});

test('the picker route gives names, date, counts and members; without a token the members still load', async () => {
  const r = await box('POST', '/swing-universe', { token: 'SKTOKEN' });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.ok, true);
  const s = r.body.levels.sectors, i = r.body.levels.indices;
  assert.equal(s.label, 'Swing sectors');
  assert.equal(s.date, '2026-11-17');
  assert.deepEqual(s.names, ['Aviation', 'Realty']);
  assert.equal(s.count, 4);
  assert.deepEqual(s.fincodes.slice().sort(), ['108929', '132868', '219442', '222055']);
  assert.deepEqual(s.symbols.slice().sort(), ['DLF', 'INDIGO', 'LODHA']);
  assert.equal(s.error, null);
  assert.deepEqual(i.names, ['Nifty Private Bank']);
  assert.equal(i.count, 3);
  // the names need the user's token; the members do not
  S.resetSwingCache();
  const anon = await box('POST', '/swing-universe', { token: 'WRONG' });
  assert.equal(anon.body.ok, true);
  assert.deepEqual(anon.body.levels.sectors.names, []);
  assert.equal(anon.body.levels.sectors.date, null);
  assert.equal(anon.body.levels.sectors.count, 4);
  // a list the site cannot give says so, the other still answers
  S.resetSwingCache();
  fail.indices = 503;
  const half = await box('POST', '/swing-universe', { token: 'SKTOKEN' });
  assert.match(half.body.levels.indices.error, /Could not load today's Swing indices/);
  assert.equal(half.body.levels.sectors.error, null);
  assert.equal(half.body.levels.sectors.count, 4);
});

test('the preview (/algo-scan) filters by the same lists, and stops when a list fails or leaves nothing', async () => {
  const body = { symbols: syms(BASKET), screenerStocks: BASKET, entryFilters: [], slMethod: 'pct', slPct: 3, rrRatio: 2, capitalPerTrade: 10000, sectorFilters: [], industryFilters: [] };
  const r = await box('POST', '/algo-scan', { ...body, swingUniverse: ['indices'], token: 'SKTOKEN' });
  assert.equal(r.status, 200, r.raw);
  assert.equal(r.body.ok, true, r.raw);
  assert.deepEqual(tvCalls[0].slice().sort(), ['NSE:DLF', 'NSE:HDFCBANK', 'NSE:ICICIBANK']);
  // nothing ticked: the page's own symbols, as before
  const plain = await box('POST', '/algo-scan', body);
  assert.equal(plain.body.ok, true, plain.raw);
  assert.equal(tvCalls[1].length, BASKET.length);
  // a failed list: no scan
  S.resetSwingCache();
  fail.sectors = 503;
  const failed = await box('POST', '/algo-scan', { ...body, swingUniverse: ['sectors'] });
  assert.equal(failed.body.ok, false);
  assert.match(failed.body.error, /Could not load today's Swing sectors/);
  // a list that leaves nothing: no scan of an empty ticker list
  delete fail.sectors;
  S.resetSwingCache();
  lists.sectors.rows = [];
  const empty = await box('POST', '/algo-scan', { ...body, swingUniverse: ['sectors'] });
  assert.equal(empty.body.ok, false);
  assert.equal(empty.body.error, 'No stocks in the selected sector/industry filters (Swing sectors today: 0 stocks).');
  assert.equal(tvCalls.length, 2, 'only the two good previews reached the market-data call');
});

test('the algo list shows the ticked lists, cleaned, in the site\'s order', async () => {
  fs.writeFileSync(path.join(dataDir, 'algo_schedule.json'), JSON.stringify({ jobs: [
    { id: 'job-a', enabled: false, status: 'paused', config: { screenerSlug: 'a', runTime: '09:15', swingUniverse: ['indices', 'bogus', 'sectors'] } },
    { id: 'job-b', enabled: false, status: 'paused', config: { screenerSlug: 'b', runTime: '09:15' } },
  ] }));
  const r = await box('GET', '/algo-schedule/status');
  assert.equal(r.status, 200, r.raw);
  const byId = Object.fromEntries(r.body.jobs.map(j => [j.id, j]));
  assert.deepEqual(byId['job-a'].config.swingUniverse, ['sectors', 'indices']);
  assert.deepEqual(byId['job-b'].config.swingUniverse, []);
});
