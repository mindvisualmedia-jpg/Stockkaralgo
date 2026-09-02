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
