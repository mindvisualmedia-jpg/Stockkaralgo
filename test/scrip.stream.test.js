'use strict';
// test/scrip.stream.test.js - the scrip masters read AS THEY ARRIVE (2026-10-21).
//
// Dhan's ~35 MB CSV and Angel's ~35 MB JSON used to be read whole into one
// string and then split / JSON.parse'd. Dhan's took a box with ZERO algos to
// ~266 MB RSS ten seconds after boot (the free server's pm2 restarts at
// 350 MB). The loaders now parse piece by piece. The owner's rule: "make sure
// we dont affect anything" - so every outcome must be the old one: the same
// lines, elements and maps (the old parse is copied below, verbatim, as the
// oracle), the same errors, one download per caller as before.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { Readable } = require('stream');
const { EventEmitter } = require('events');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-scrip-'));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
Object.assign(process.env, { STOCKKAR_LICENCE_ENFORCE: '0', STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1', STOCKKAR_TELEGRAM_DISABLED: '1' });
let S;
before(() => { S = require('../server.js')._internals; });

// ---- a response stream: the given bytes, cut wherever the test says ---------
function fakeRes(buf, cuts, status) {
  const r = new Readable({ read() {} });
  r.statusCode = status || 200;
  setImmediate(() => {
    let at = 0;
    for (const c of [...cuts, buf.length]) { if (c > at) { r.push(buf.subarray(at, c)); at = c; } }
    r.push(null);
  });
  return r;
}
let seed = 7;
const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const randomCuts = (bytes) => [...new Set(Array.from({ length: rnd(6) }, () => rnd(bytes + 1)))].sort((a, b) => a - b);

// ---- the CSV lines -----------------------------------------------------------
const linesOf = (text, cuts) => new Promise((resolve) => {
  const out = [];
  S.streamTrimmedLines(fakeRes(Buffer.from(text, 'utf8'), cuts || []), l => out.push(l), () => resolve(out));
});
const expectedLines = (text) => (text.trim() ? text.trim().split(/\r?\n/) : []);

test('CSV lines come out exactly as csv.trim().split(/\\r?\\n/) - the edge cases, cut at every byte', async () => {
  const cases = [
    'A,B\nx,1\ny,2\n', 'A,B\r\nx,1\r\ny,2\r\n', '﻿A,B\nx,1', '\n\n  A,B\nx,1\n\n\n', 'A,B\nx,1   ', 'A,B\nx,1  \n  \n\t\n',
    'A,B\n\nx,1\n   \ny,2', 'A,B\nx\r\r\ny', 'A,B\nx\ry\nz', 'A,B', 'A,B\n', '', '   \n \r\n ', 'A\n"q,1",2\n"é,ü",3\n',
  ];
  for (const text of cases) {
    assert.deepEqual(await linesOf(text), expectedLines(text), JSON.stringify(text));
    const bytes = Buffer.byteLength(text);
    for (let cut = 1; cut < bytes; cut++) assert.deepEqual(await linesOf(text, [cut]), expectedLines(text), JSON.stringify(text) + ' cut at ' + cut);
  }
});

test('the same on 3000 random texts cut at random BYTES (a \\r\\n or an é split across chunks)', async () => {
  const alphabet = ['a', 'b', ',', '"', ' ', '\t', '\r', '\n', '\n', '\r\n', 'é', '₹', '﻿', 'Z9'];
  for (let k = 0; k < 3000; k++) {
    let text = '';
    for (let i = rnd(40); i > 0; i--) text += alphabet[rnd(alphabet.length)];
    const cuts = randomCuts(Buffer.byteLength(text));
    assert.deepEqual(await linesOf(text, cuts), expectedLines(text), JSON.stringify({ text, cuts }));
  }
});

// ---- the JSON array elements -------------------------------------------------
// Old outcome: JSON.parse(body) throws -> FAIL; else the array's elements, or
// none at all for a body that is not an array.
const oldElements = (text) => { let v; try { v = JSON.parse(text); } catch (e) { return 'FAIL'; } return Array.isArray(v) ? v : []; };
const newElements = (text, cuts) => new Promise((resolve) => {
  const out = [];
  S.streamJsonArray(fakeRes(Buffer.from(text, 'utf8'), cuts || []), v => out.push(v), () => resolve(out), (e) => resolve(e.parse ? 'FAIL' : 'OTHER ' + e.message));
});
function randomValue(depth) {
  const pick = rnd(depth > 2 ? 4 : 7);
  if (pick === 0) { let s = ''; for (let i = rnd(8); i > 0; i--) s += ['a', '"', '\\', '{', '}', '[', ']', ',', ' ', 'é', '₹', '\n', ' ', '/', 'u'][rnd(15)]; return s; }
  if (pick === 1) return rnd(2000) - 1000 + (rnd(2) ? 0.5 : 0);
  if (pick === 2) return [true, false, null][rnd(3)];
  if (pick === 3) return 'EQ' + rnd(99);
  if (pick === 4) return Array.from({ length: rnd(4) }, () => randomValue(depth + 1));
  const o = {}; for (let i = rnd(4); i > 0; i--) o[['token', 'symbol', 'name', 'exch_seg', 'x', '"q"'][rnd(6)]] = randomValue(depth + 1); return o;
}
function randomJsonText() {
  let text = rnd(8) === 0 ? JSON.stringify(randomValue(1)) : JSON.stringify(Array.from({ length: rnd(6) }, () => randomValue(1)), null, rnd(3) ? 0 : rnd(3));
  if (rnd(3) === 0) text = ['', ' ', '\n', '\t', '\r\n'][rnd(5)] + text + ['', ' ', '\n'][rnd(3)];
  const m = rnd(6);                                          // sometimes broken, the ways a download breaks
  if (m === 0 && text.length) text = text.slice(0, rnd(text.length));
  if (m === 1) { const at = rnd(text.length + 1); text = text.slice(0, at) + [',', ']', '}', '"', 'x', '[', '{', '\\', '﻿'][rnd(9)] + text.slice(at); }
  if (m === 2 && text.length) { const at = rnd(text.length); text = text.slice(0, at) + text.slice(at + 1); }
  return text;
}

test('JSON elements: exactly JSON.parse + forEach, on 4000 random bodies - valid, cut short, broken, not arrays - cut at random BYTES', async () => {
  let fails = 0, oks = 0;
  for (let k = 0; k < 4000; k++) {
    const text = randomJsonText();
    const want = oldElements(text);
    const got = await newElements(text, randomCuts(Buffer.byteLength(text)));
    assert.deepEqual(got, want, JSON.stringify(text));
    if (want === 'FAIL') fails++; else oks++;
  }
  assert.ok(fails > 500 && oks > 1500, 'both outcomes exercised: ' + fails + ' fail / ' + oks + ' ok');
});

test('JSON edge cases: [], spaces, a BOM, nothing, junk after ], a } closing the array', async () => {
  for (const text of ['[]', ' [ ] ', '[1]', '[1,]', '[,]', '﻿[1]', '', '   ', '[1] x', '[1] [2]', '[1}', '{"a":[1]}', '"str"', '7', 'null', '[{"a":"]"},"b,c",[1,[2]]]', '[1,\n2]\n']) {
    assert.deepEqual(await newElements(text), oldElements(text), JSON.stringify(text));
    for (let cut = 1; cut < Buffer.byteLength(text); cut++) assert.deepEqual(await newElements(text, [cut]), oldElements(text), JSON.stringify(text) + ' cut at ' + cut);
  }
});

test('an exception from the row code is thrown from the response end, as the old forEach threw it', () => {
  const res = new EventEmitter();
  res.setEncoding = () => {};
  const seen = [];
  let ended = false, parseFailed = false;
  S.streamJsonArray(res, v => { seen.push(v); if (v === null) throw new TypeError('null row'); }, () => { ended = true; }, () => { parseFailed = true; });
  res.emit('data', '[{"a":1},nu');
  res.emit('data', 'll,{"b":2}]');
  assert.throws(() => res.emit('end'), /null row/);
  assert.deepEqual(seen, [{ a: 1 }, null], 'rows after the throw are not handed on (the forEach had stopped)');
  assert.deepEqual([ended, parseFailed], [false, false]);
  // ...but when the body is ALSO invalid JSON, JSON.parse failed first: a parse failure, no throw
  const res2 = new EventEmitter();
  res2.setEncoding = () => {};
  let failed2 = false;
  S.streamJsonArray(res2, v => { if (v === null) throw new TypeError('null row'); }, () => {}, () => { failed2 = true; });
  res2.emit('data', '[null,{"b":2},]');
  assert.doesNotThrow(() => res2.emit('end'));
  assert.equal(failed2, true);
});

// ---- the OLD parse, verbatim (pre-3.30.3), as the oracle --------------------
function parseCsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}
function oldDhanMaps(csv) {
  const lines = csv.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines.shift() || '').map(h => h.trim());
  const idx = (names) => names.map(n => headers.indexOf(n)).find(i => i >= 0);
  const iSec = idx(['SECURITY_ID', 'SEM_SMST_SECURITY_ID']);
  const symIndexes = ['UNDERLYING_SYMBOL', 'SM_SYMBOL', 'SYMBOL_NAME', 'TRADING_SYMBOL']
    .map(n => headers.indexOf(n))
    .filter(i => i >= 0);
  const iExch = idx(['EXCH_ID', 'EXCHANGE']);
  const iSeg = idx(['SEGMENT']);
  const iSeries = idx(['SERIES']);
  const iLot = idx(['LOT_SIZE', 'SEM_LOT_UNITS']);
  const map = {};
  const seriesMap = {};
  const lotMap = {};
  lines.forEach(line => {
    const row = parseCsvLine(line);
    const symbol = String(symIndexes.map(i => row[i]).find(Boolean) || '').replace(/\s/g, '').toUpperCase();
    const sec = String(row[iSec] || '').trim();
    const exch = String(row[iExch] || '').toUpperCase();
    const seg = String(row[iSeg] || '').toUpperCase();
    const series = String(row[iSeries] || '').toUpperCase();
    if (!symbol || !sec) return;
    if (exch && !['NSE', 'NSE_EQ', 'BSE', 'BSE_EQ'].includes(exch)) return;
    if (seg && !['E', 'EQ', 'NSE_EQ', 'BSE_EQ'].includes(seg)) return;
    const exchangeKey = exch.startsWith('BSE') ? 'BSE' : 'NSE';
    map[exchangeKey + ':' + symbol] = sec;
    if (!map[symbol] || exchangeKey === 'NSE' || series === 'EQ') map[symbol] = sec;
    if (exchangeKey === 'NSE' && series && (!seriesMap[symbol] || series === 'EQ')) seriesMap[symbol] = series;
    if (iLot >= 0) {
      const lot = Math.floor(Number(row[iLot] || 0));
      if (lot > 1 && (!lotMap[symbol] || exchangeKey === 'NSE')) lotMap[symbol] = lot;
    }
  });
  return { map, seriesMap, lotMap };
}
function oldEquityMap(csv) {
  const lines = csv.trim().split(/\r?\n/);
  const headers = parseCsvLine(lines.shift() || '').map(h => h.trim());
  const idx = (names) => names.map(n => headers.indexOf(n)).find(i => i >= 0);
  const symIndexes = ['UNDERLYING_SYMBOL', 'SM_SYMBOL', 'SYMBOL_NAME', 'TRADING_SYMBOL']
    .map(n => headers.indexOf(n))
    .filter(i => i >= 0);
  const iIsin = idx(['ISIN', 'SEM_ISIN_CODE']);
  const iExch = idx(['EXCH_ID', 'EXCHANGE']);
  const iSeg = idx(['SEGMENT']);
  const iSeries = idx(['SERIES']);
  const map = {};
  lines.forEach(line => {
    const row = parseCsvLine(line);
    const symbol = String(symIndexes.map(i => row[i]).find(Boolean) || '').replace(/\s/g, '').toUpperCase();
    const isin = String(row[iIsin] || '').trim().toUpperCase();
    const exch = String(row[iExch] || '').toUpperCase();
    const seg = String(row[iSeg] || '').toUpperCase();
    const series = String(row[iSeries] || '').toUpperCase();
    if (!symbol || !isin) return;
    if (exch && !['NSE', 'NSE_EQ'].includes(exch)) return;
    if (seg && !['E', 'EQ', 'NSE_EQ'].includes(seg)) return;
    if (series && !['EQ', ''].includes(series)) return;
    map[symbol] = { isin, upstoxInstrumentKey: 'NSE_EQ|' + isin };
  });
  return map;
}
function oldAngelMap(body) {
  const rows = JSON.parse(body);
  const map = {};
  (Array.isArray(rows) ? rows : []).forEach(row => {
    const exchange = String(row.exch_seg || '').toUpperCase();
    const symbol = String(row.symbol || '').toUpperCase();
    const name = String(row.name || '').replace(/\s/g, '').toUpperCase();
    const token = String(row.token || '').trim();
    if (!token || !symbol || !['NSE', 'BSE'].includes(exchange) || !symbol.endsWith('-EQ')) return;
    const cleanSymbol = symbol.replace(/-EQ$/, '').replace(/\s/g, '');
    map[exchange + ':' + cleanSymbol] = { token, tradingSymbol: symbol, exchange };
    if (!map[cleanSymbol] || exchange === 'NSE') map[cleanSymbol] = { token, tradingSymbol: symbol, exchange };
    if (name && !map[name]) map[name] = { token, tradingSymbol: symbol, exchange };
  });
  return map;
}

// ---- masters shaped like the real ones --------------------------------------
function sampleCsv() {
  const head = 'EXCH_ID,SEGMENT,SECURITY_ID,ISIN,INSTRUMENT,UNDERLYING_SECURITY_ID,UNDERLYING_SYMBOL,SYMBOL_NAME,DISPLAY_NAME,INSTRUMENT_TYPE,SERIES,LOT_SIZE,SM_EXPIRY_DATE';
  const rows = [];
  for (let i = 0; i < 400; i++) {
    const sym = 'SYM' + i;
    rows.push(['NSE', 'E', String(1000 + i), 'INE' + String(100000 + i) + 'A01', 'EQUITY', '', sym, sym + ' LTD', '"' + sym + ', Ltd"', 'ES', i % 9 ? 'EQ' : 'BE', i % 50 ? '1' : '375', ''].join(','));
    if (i % 3 === 0) rows.push(['BSE', 'E', String(500000 + i), 'INE' + String(100000 + i) + 'A01', 'EQUITY', '', sym, sym + ' LTD', 'x', 'ES', 'A', '1', ''].join(','));
    if (i % 4 === 0) rows.push(['NSE', 'D', String(40000 + i), '', 'FUTSTK', String(1000 + i), sym, sym + '-FUT', 'f', 'FUT', '', '500', '2026-10-28'].join(','));
    if (i % 7 === 0) rows.push(['NSE', 'E', String(9000 + i), 'INE' + String(100000 + i) + 'A01', 'EQUITY', '', sym, sym, 'z', 'ES', 'SM', '1200', ''].join(','));
    if (i % 25 === 0) rows.push('   ');
  }
  return '﻿' + head + '\r\n' + rows.join('\r\n') + '\r\n\r\n';
}
function sampleAngelJson() {
  const rows = [];
  for (let i = 0; i < 300; i++) {
    const sym = 'ASYM' + i;
    rows.push({ token: String(2000 + i), symbol: sym + '-EQ', name: i % 5 ? sym : sym + ' "Ltd" [x], {y}', expiry: '', strike: '-1.000000', lotsize: '1', instrumenttype: '', exch_seg: 'NSE', tick_size: '5.000000' });
    if (i % 2) rows.push({ token: String(700000 + i), symbol: sym + '-EQ', name: sym, expiry: '', strike: '-1.000000', lotsize: '1', instrumenttype: '', exch_seg: 'BSE', tick_size: '1.000000' });
    if (i % 3 === 0) rows.push({ token: String(90000 + i), symbol: sym + '28OCT26FUT', name: sym, expiry: '28OCT2026', strike: '-1.000000', lotsize: '500', instrumenttype: 'FUTSTK', exch_seg: 'NFO', tick_size: '5.000000' });
    if (i % 11 === 0) rows.push({ token: ' ' + String(3000 + i) + ' ', symbol: 'é' + sym + '-EQ', name: 'Näme \\ ₹', exch_seg: 'nse' });
  }
  return JSON.stringify(rows, null, 1);
}

// ---- https.get, faked: serve a body in small chunks, count downloads --------
const realGet = https.get;
let downloads = 0, serve = { body: '', status: 200, chunk: 61 };
function installFakeGet() {
  https.get = (url, cb) => {
    downloads++;
    const req = new EventEmitter();
    req.setTimeout = () => req;
    req.destroy = (err) => setImmediate(() => req.emit('error', err));
    setImmediate(() => {
      const buf = Buffer.from(typeof serve.body === 'function' ? serve.body(url) : serve.body, 'utf8');
      const res = new Readable({ read() {} });
      res.statusCode = serve.status;
      cb(res);
      let at = 0;
      const pump = () => {
        if (at >= buf.length) return res.push(null);
        res.push(buf.subarray(at, at + serve.chunk)); at += serve.chunk;
        setImmediate(pump);
      };
      pump();
    });
    return req;
  };
}
after(() => { https.get = realGet; });
const loadDhan = (force) => new Promise(res => S.loadDhanSecurityMap((err, map) => res({ err, map }), force));
const loadEquity = () => new Promise(res => S.loadEquityInstrumentMap((err, map) => res({ err, map })));
const loadAngel = () => new Promise(res => S.loadAngelInstrumentMap((err, map) => res({ err, map })));

test('Dhan: the maps (security ids, series, lot sizes) are exactly what the old code built', async () => {
  installFakeGet(); S.resetScripMasterCaches();
  serve = { body: sampleCsv(), status: 200, chunk: 61 };
  const r = await loadDhan();
  assert.equal(r.err, null);
  const old = oldDhanMaps(serve.body);
  assert.ok(Object.keys(old.map).length > 800 && Object.keys(old.lotMap).length > 5 && Object.values(old.seriesMap).includes('BE'), 'the sample exercises every branch');
  assert.deepEqual(r.map, old.map);
  const c = S.scripMasterCaches();
  assert.deepEqual([c.dhan, c.series, c.lot], [old.map, old.seriesMap, old.lotMap]);
});

test('Upstox: the equity map is exactly what the old code built', async () => {
  installFakeGet(); S.resetScripMasterCaches();
  serve = { body: sampleCsv(), status: 200, chunk: 97 };
  const r = await loadEquity();
  assert.equal(r.err, null);
  const old = oldEquityMap(serve.body);
  assert.ok(Object.keys(old).length > 300);
  assert.deepEqual(r.map, old);
});

test('Dhan, unchanged: callers arriving together each get their own download, as before; a refused one says so and caches nothing', async () => {
  installFakeGet(); S.resetScripMasterCaches(); downloads = 0;
  serve = { body: sampleCsv(), status: 200, chunk: 400 };
  const both = await Promise.all([loadDhan(), loadDhan()]);
  assert.equal(downloads, 2);
  assert.deepEqual(both[0].map, both[1].map);
  S.resetScripMasterCaches();
  serve = { body: '<html>busy</html>', status: 503, chunk: 61 };
  const r = await loadDhan();
  assert.equal(r.err, 'Dhan scrip master HTTP 503');
  assert.equal(S.scripMasterCaches().dhan, null);
});

test('Angel: the map is exactly what the old code built (quotes, brackets and commas inside names; é and ₹)', async () => {
  installFakeGet(); S.resetScripMasterCaches();
  serve = { body: sampleAngelJson(), status: 200, chunk: 53 };
  const r = await loadAngel();
  assert.equal(r.err, null);
  const old = oldAngelMap(serve.body);
  assert.ok(Object.keys(old).length > 500);
  assert.deepEqual(r.map, old);
  assert.deepEqual(S.scripMasterCaches().angel, old);
});

test('Angel, unchanged: a body that is not an array still gives an empty map, as the old code did', async () => {
  installFakeGet(); S.resetScripMasterCaches();
  serve = { body: '{"message":"rate limited"}', status: 200, chunk: 5 };
  const r = await loadAngel();
  assert.deepEqual([r.err, r.map], [null, {}]);
});

test('Angel, unchanged: a cut-short download fails both URLs as a parse failure', async () => {
  installFakeGet(); S.resetScripMasterCaches(); downloads = 0;
  const full = sampleAngelJson();
  serve = { body: full.slice(0, Math.floor(full.length / 2)), status: 200, chunk: 400 };
  const r = await loadAngel();
  assert.equal(downloads, 2, 'the second URL was tried, as before');
  assert.match(String(r.err), /^Angel One instrument master parse failed: /);
});
