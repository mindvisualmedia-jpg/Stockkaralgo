'use strict';
const test = require('node:test');
const assert = require('node:assert');
const g = require('./sources/gsheet');

test('parseSheetId pulls the id from every URL shape', () => {
  const id = '1AbC-dEfG_hIjKlMnOpQrStUvWxYz0123456789ab';
  assert.strictEqual(g.parseSheetId('https://docs.google.com/spreadsheets/d/' + id + '/edit#gid=0'), id);
  assert.strictEqual(g.parseSheetId('https://docs.google.com/spreadsheets/d/' + id + '/edit?usp=sharing'), id);
  assert.strictEqual(g.parseSheetId(id), id);
  assert.strictEqual(g.parseSheetId('not a sheet'), null);
});

test('gidFromUrl reads the active tab', () => {
  assert.strictEqual(g.gidFromUrl('https://x/edit#gid=1789'), '1789');
  assert.strictEqual(g.gidFromUrl('https://x/edit'), null);
});

test('cleanSymbol normalises and rejects non-symbols', () => {
  assert.strictEqual(g.cleanSymbol(' nse:tatapower '), 'TATAPOWER');
  assert.strictEqual(g.cleanSymbol('RELIANCE.NS'), 'RELIANCE');
  assert.strictEqual(g.cleanSymbol('M&M'), 'M&M');
  assert.strictEqual(g.cleanSymbol('123456'), null);          // a number is not a symbol
  assert.strictEqual(g.cleanSymbol(''), null);
});

test('symbolsFromCsv: header named "symbol" wins, header dropped, deduped', () => {
  const csv = 'Symbol,Note\nTATAPOWER,x\nIRFC,y\nTATAPOWER,dup\n';
  assert.deepStrictEqual(g.symbolsFromCsv(csv), ['TATAPOWER', 'IRFC']);
});

test('symbolsFromCsv: no header - picks the most symbol-like column', () => {
  const csv = '100,TATAPOWER,buy\n200,IRFC,buy\n300,HAL,sell\n';
  assert.deepStrictEqual(g.symbolsFromCsv(csv), ['TATAPOWER', 'IRFC', 'HAL']);
});

test('symbolsFromCsv: a plain one-column list works', () => {
  assert.deepStrictEqual(g.symbolsFromCsv('BEL\nBDL\nHAL\n'), ['BEL', 'BDL', 'HAL']);
});

test('extractTabs: bootstrap sheetId/title pattern', () => {
  const html = 'x{"index":0,"sheetId":0,"title":"Control"}y{"index":1,"sheetId":178,"title":"Momentum screener"}z';
  assert.deepStrictEqual(g.extractTabs(html), [
    { gid: '0', name: 'Control' },
    { gid: '178', name: 'Momentum screener' },
  ]);
});

test('extractTabs: htmlview button pattern', () => {
  const html = '<li id="sheet-button-0"><a>Feed</a></li><li id="sheet-button-42"><a>Swing Screener</a></li>';
  assert.deepStrictEqual(g.extractTabs(html), [
    { gid: '0', name: 'Feed' },
    { gid: '42', name: 'Swing Screener' },
  ]);
});

test('extractTabs: unknown format yields no tabs (caller returns a diagnostic)', () => {
  assert.deepStrictEqual(g.extractTabs('<html>nothing familiar</html>'), []);
});

test('extractTabs: real htmlview items.push pattern (confirmed against Google)', () => {
  const html = 'x items.push({name: "Control", pageUrl: "https:\/\/docs.google.com\/spreadsheets\/d\/ID\/pubhtml?gid=0&single=true"});'
    + ' items.push({name: "Momentum screener", pageUrl: "https:\/\/x\/pubhtml?gid=178&single=true"}); y';
  const tabs = g.extractTabs(html);
  assert.deepStrictEqual(tabs, [{ gid: "0", name: "Control" }, { gid: "178", name: "Momentum screener" }]);
});


// ---- full-row extraction (a real Stockkar-style sheet) ---------------------
const SHEET_CSV = [
  'SYMBOL,LTP,CHG_PCT,VOLUME,EMA20',
  'DIVISLAB,"8,056.00",2.82%,793919,"7,333.84"',
  'TITAN,"4,875.20",0.52%,1003314,"4,674.36"',
].join('\n') + '\n';

test('rowsFromCsv keeps every column, typing numbers and preserving units', () => {
  const out = g.rowsFromCsv(SHEET_CSV);
  assert.deepStrictEqual(out.symbols, ['DIVISLAB', 'TITAN']);
  assert.strictEqual(out.rows.length, 2);
  assert.strictEqual(out.rows[0].Symbol, 'DIVISLAB');
  assert.strictEqual(out.rows[0].LTP, 8056);            // commas stripped -> number
  assert.strictEqual(out.rows[0].EMA20, 7333.84);
  assert.strictEqual(out.rows[0].CHG_PCT, '2.82%');     // unit preserved
  assert.strictEqual(typeof out.rows[0].VOLUME, 'number');
});

test('rowsFromCsv dedupes by symbol and skips rows with no symbol', () => {
  const csv = ['SYMBOL,LTP', 'BEL,100', ',', 'BEL,101', 'HAL,200'].join('\n') + '\n';
  const out = g.rowsFromCsv(csv);
  assert.deepStrictEqual(out.symbols, ['BEL', 'HAL']);
  assert.strictEqual(out.rows[0].LTP, 100, 'first occurrence wins');
});

test('rowsFromCsv works with no header row', () => {
  const out = g.rowsFromCsv(['BEL,100', 'HAL,200'].join('\n') + '\n');
  assert.deepStrictEqual(out.symbols, ['BEL', 'HAL']);
  assert.strictEqual(out.rows[0].Symbol, 'BEL');
});

test('cellValue: numbers vs units vs text', () => {
  assert.strictEqual(g.cellValue('1,234.5'), 1234.5);
  assert.strictEqual(g.cellValue('2.82%'), '2.82%');
  assert.strictEqual(g.cellValue('Pharma'), 'Pharma');
  assert.strictEqual(g.cellValue(''), '');
});
