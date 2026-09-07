'use strict';
// Weekly EMA as the SL anchor (2026-09-02) — 'like entry'.
//
// The contract: slMethod 'indicator' + slIndicatorTimeframe '1W' anchors the
// stop to the WEEKLY EMA (stock.emaW), exactly the convention entry filters
// use ('EMA<p>|1W'). Everything else must not move: daily stays the default,
// and non-EMA indicators ignore the timeframe entirely.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const slice = (name) => {
  const i = src.indexOf('function ' + name + '(');
  assert.ok(i > 0, name + ' not found in server.js');
  const j = src.indexOf('\nfunction ', i + 1);
  return src.slice(i, j > 0 ? j : i + 4000);
};

// getIndicatorValue's EMA branch has no external deps; stub the rest so the
// extracted source runs as-is.
const factory = new Function(
  'numberFromValue', 'findTechnicalField', 'getFearlessIndicatorData', 'findTechnicalValue', 'getStockkarScoreValue', 'marketCapCrores',
  slice('getIndicatorValue') + '; return getIndicatorValue;');
const getIndicatorValue = factory(v => Number(v), () => undefined, () => ({ value: NaN }), () => undefined, () => NaN, () => NaN);

const stock = { ema: { 200: 1364 }, ema200: 1364, emaW: { 200: 1296 }, rsi: 55 };

test('no timeframe reads the DAILY EMA — every saved algo is unchanged', () => {
  assert.equal(getIndicatorValue('ema200', stock, {}), 1364);
  assert.equal(getIndicatorValue('ema200', stock, {}, ''), 1364);
  assert.equal(getIndicatorValue('ema200', stock, {}, '1D'), 1364);
});

test("'1W' reads the WEEKLY EMA, case-insensitively", () => {
  assert.equal(getIndicatorValue('ema200', stock, {}, '1W'), 1296);
  assert.equal(getIndicatorValue('ema200', stock, {}, '1w'), 1296);
});

test("a non-EMA indicator ignores '1W' — RSI stays the daily reading", () => {
  assert.equal(getIndicatorValue('rsi14', stock, {}, '1W'), 55);
});

test("weekly requested but weekly data missing -> undefined, never the daily value (missing data never passes)", () => {
  const noW = { ema: { 200: 1364 }, ema200: 1364 };
  assert.equal(getIndicatorValue('ema200', noW, {}, '1W'), undefined);
});

// ---- wiring contracts: the timeframe must actually REACH the SL math --------

test('buildAlgoCandidates anchors slBase with cfg.slIndicatorTimeframe', () => {
  const body = src.slice(src.indexOf('function buildAlgoCandidates('), src.indexOf('function buildAlgoCandidates(') + 12000);
  assert.match(body, /getIndicatorValue\(cfg\.slIndicator,\s*stock,\s*row,\s*cfg\.slIndicatorTimeframe\)/,
    'the SL base must pass the configured timeframe');
});

test('every scan already carries the weekly EMA columns (EMA<p>|1W)', () => {
  assert.ok(src.includes("'EMA' + p + '|1W'"), 'weekly EMA columns must ride the market-data scan');
});

test('the algo-preview endpoint plumbs slIndicatorTimeframe through', () => {
  const hits = src.split('slIndicatorTimeframe').length - 1;
  assert.ok(hits >= 3, 'expected destructure + pass-through + SL math (got ' + hits + ')');
});

// ---- WEEKLY TRAILING (2026-09-02) -----------------------------------------
// The trail reads its EMA through the same reader, so weekly must work there
// too - and the entry-EMA FLOOR must use the entry filter's own timeframe.

const trailSrc = slice('trailingEmaValue');
const readerSrc = slice('emaValueFromRow');

test("the trail EMA is read with the row OWN trail timeframe", () => {
  assert.ok(trailSrc.includes("emaValueFromRow(entry.emaTrailingIndicator || 'ema20', tvRow, entry.emaTrailingTimeframe)"),
    "the trail must read its EMA with the row own timeframe");
});

test('the entry-EMA floor is read with the ENTRY filter timeframe, not daily', () => {
  assert.ok(trailSrc.includes("emaValueFromRow(entry.entryEmaIndicator, tvRow, entry.entryEmaTimeframe)"),
    "the floor must read the entry EMA on the entry filter timeframe");
});

test('the reader itself resolves 1W to the weekly series', () => {
  assert.ok(readerSrc.includes('emaW'), 'emaValueFromRow must read stock.emaW for 1W');
});

test('indicator and timeframe come from the SAME entry filter (cannot disagree)', () => {
  const pick = new Function(src.slice(src.indexOf('function entryEmaFilterFrom('), src.indexOf('function emaValueFromRow(')) +
    '; return { ind: entryEmaIndicatorFromFilters, tf: entryEmaTimeframeFromFilters };')();
  // daily ema20 + weekly ema200 -> the slowest wins, and it is the WEEKLY one
  const filters = [{ indicator: 'ema20', timeframe: '1D' }, { indicator: 'ema200', timeframe: '1W' }];
  assert.equal(pick.ind(filters), 'ema200');
  assert.equal(pick.tf(filters), '1W');
  // all-daily stays blank, so every saved row behaves exactly as before
  assert.equal(pick.tf([{ indicator: 'ema200' }]), '');
  assert.equal(pick.ind([]), '');
});

test('a weekly trail row carries its timeframe end to end', () => {
  assert.ok(src.includes('entryEmaTimeframe: entryEmaTimeframeFromFilters(cfg.entryFilters)'),
    'rows must be stamped with the entry-EMA timeframe');
  assert.ok(!src.includes("emaTrailingTimeframe: '1D', emaTrailingTrigger"),
    'the adopt route must no longer hardcode a daily trail');
});
