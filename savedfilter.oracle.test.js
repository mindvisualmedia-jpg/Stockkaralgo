'use strict';
// Saved-screener parity with stockkar.in PRODUCTION code (2026-10-13).
//
// Owner, 2026-10-13: "Saved filters are not fetching correctly, as we have
// added new filters and changes, can you audit and fix all filters."
//
// The site had added MACD (2026-09-17), quarter-over-quarter trends on the three
// growth meters (09-29), chart presets and a breakout rule (09-28), and on
// 10-13 RSI vs its moving average, Bollinger Bands, the smoothed SMA and ADX.
// The port knew none of it. Screens using MACD, Bollinger Bands or ADX were
// REFUSED by the name guard ("cannot map yet"); worse, RSI-average conditions
// and meter trends rode on names the guard already accepts, so they were
// DROPPED SILENTLY - a wider basket, wrong stocks.
//
// Live captures need a logged-in browser. The expected queries here come from
// scripts/savedfilter-site-oracle.js instead: it runs the Stocklab page's own
// production code headless (applyFilterState -> loadData -> fetchStocks) and
// records the request it sends. The oracle itself is proven: at the site
// commit of 2026-09-09 it reproduces all 69 live captures byte-for-byte
// (savedfilter.parity.test.js holds those captures).
//
// Coverage: all 71 real saved screeners (including the two the capture test
// skips - the site's 13 Sep fix ended that inconsistency) + 30 configs that
// exercise every new card, the way the site saves them.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const rd = require('./rollingdates');
const { buildSavedFilterQuery, HANDLED_FILTER_NAMES } = require('./savedfilter-query');
const { unknownSavedFilterNames } = require('./savedfilter');

const DIR = path.join(__dirname, 'test', 'fixtures', 'savedfilters');
const ORACLE = JSON.parse(fs.readFileSync(path.join(DIR, '_oracle-queries.json'), 'utf8'));
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(DIR, '_site-defaults.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, '_manifest.json'), 'utf8'));
const NEW = JSON.parse(fs.readFileSync(path.join(DIR, '_new-filters-2026-10.json'), 'utf8'));

// The same inputs the oracle was run with (and the capture test uses).
const CAL = []; const d = new Date((DEFAULTS.latestTradingDate || '2026-09-07') + 'T00:00:00Z');
while (CAL.length < 80) { if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) CAL.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
CAL.reverse();
const IGNORE = new Set(['limit', 'offset']);
const asMap = (P) => { const m = {}; for (const k of new Set(P.keys())) if (!IGNORE.has(k)) m[k] = P.getAll(k).sort().join(' | '); return m; };
const portMap = (filters) => {
  const resolved = rd.hasRollingDates(filters) ? rd.resolveRollingFilterDates(filters, { daily: CAL, weekly: [], monthly: [] }) : filters;
  return asMap(buildSavedFilterQuery(resolved, { limit: 20, offset: 0, defaults: DEFAULTS }));
};
const assertSame = (algo, site) => {
  const onlyAlgo = Object.keys(algo).filter(k => !(k in site));
  const onlySite = Object.keys(site).filter(k => !(k in algo));
  const differ = Object.keys(algo).filter(k => k in site && algo[k] !== site[k]);
  assert.deepEqual(onlyAlgo, [], 'port sends params the site does not: ' + onlyAlgo.map(k => k + '=' + algo[k]).join(', '));
  assert.deepEqual(onlySite, [], 'port misses params the site sends: ' + onlySite.map(k => k + '=' + site[k]).join(', '));
  assert.deepEqual(differ, [], 'values differ: ' + differ.map(k => k + ': port=' + algo[k] + ' site=' + site[k]).join(', '));
};

test('the oracle file covers every real screener and every new-filter config', () => {
  assert.match(ORACLE.siteRef, /^[0-9a-f]{40}$/, 'pinned to an exact site commit');
  for (const m of MANIFEST) assert.ok(ORACLE.queries[m.slug], 'no production query for ' + m.slug);
  for (const c of NEW) assert.ok(ORACLE.queries[c.slug], 'no production query for ' + c.slug);
});

for (const m of MANIFEST) {
  test('PRODUCTION ' + m.slug + ' "' + m.name + '"', () => {
    const fx = JSON.parse(fs.readFileSync(path.join(DIR, m.slug + '.json'), 'utf8'));
    assertSame(portMap(fx.filters), asMap(new URLSearchParams(ORACLE.queries[m.slug])));
  });
}
for (const c of NEW) {
  test('NEW FILTERS ' + c.slug + ' - ' + c.name, () => {
    assertSame(portMap(c.filters), asMap(new URLSearchParams(ORACLE.queries[c.slug])));
  });
}

test('every card the site offers is one the port handles (production catalog, 2026-10-13)', () => {
  // stockkar-app app/components/GlobalFilter/AddFilters.jsx groupedFilters at the pinned commit
  const CATALOG = ['ROE', 'ROCE', 'PE Ratio', 'Debt Ratio', 'Prev Price', 'Exchange', 'Quarterly EPS Growth',
    'Performance Meter', 'Growth Compounder Meter', 'Near Term Growth Meter', 'Golden Valuation',
    'Your Date, Your Volume', 'Delivery %', 'Volume Traces',
    'EMA above EMA', 'SMA above SMA', '% Within EMA', '% Within SMA', 'EMA Price Crossover', 'SMA Price Crossover',
    'EMA Crossover', 'SMA Crossover', 'RSI', 'MACD', 'Bollinger Bands', 'ADX', 'Fearless Indicator', 'Pivot',
    'Price Near High', 'EMA Alignment', 'Big Player Score', 'Growth Score', 'Momentum Score',
    'Form Your Own Candle - Daily', 'Form Your Own Candle - Weekly', 'Form Your Own Candle - Monthly',
    'Consolidation - Daily', 'Consolidation - Weekly', 'Consolidation - Monthly',
    'Form Your Own Chart - Daily', 'Form Your Own Chart - Weekly', 'Form Your Own Chart - Monthly',
    'Public', 'FII', 'DII', 'Promoter', 'Market Cap', 'Basket', 'Sector'];
  assert.deepEqual(CATALOG.filter(n => !HANDLED_FILTER_NAMES.includes(n)), []);
});

test('every card the site offers is EXERCISED by at least one verified case', () => {
  // Handling a name proves nothing if no case ever sends it (2026-10-14: EMA
  // Alignment and Form Your Own Chart - Monthly had no case until this test).
  const { normalizeActiveFilterNames } = require('./savedfilter-query');
  const cfgs = MANIFEST.map(m => JSON.parse(fs.readFileSync(path.join(DIR, m.slug + '.json'), 'utf8')).filters).concat(NEW.map(c => c.filters));
  const seen = new Set();
  cfgs.forEach(f => normalizeActiveFilterNames(Array.isArray(f.activeFilters) ? f.activeFilters : [], f).forEach(n => seen.add(n)));
  const unexercised = HANDLED_FILTER_NAMES.filter(n => !seen.has(n)
    // legacy spellings and names the site ignores are covered through their mapped / sibling names
    && !['Form Your Own Candle', 'Consolidation – Daily', 'Consolidation – Weekly', 'Consolidation – Monthly', 'RSI 14',
      'Close Price', 'TTM-PE Comparison', 'Consolidation Point - Daily', 'Consolidation Point - Weekly', 'Consolidation Point - Monthly',
      'MA above MA', '% Daily EMA', '% Above Daily EMA', 'Price vs EMA', 'Price vs SMA', 'Price Crossover', 'MA Crossover',
      'Stock Has Fallen', 'Supertrend', 'Fearless Zone'].includes(n));
  assert.deepEqual(unexercised, []);
});

test('EMA Alignment matches its LIVE capture (ZZ TEST - EMA Alignment, 2026-09-09)', () => {
  const live = JSON.parse(fs.readFileSync(path.join(DIR, '_site-queries.json'), 'utf8')).pending.d9094336789c.query;
  const c = NEW.find(x => x.slug === 'syn-ema-align-default');
  assertSame(portMap(c.filters), asMap(new URLSearchParams(live)));
});

test('the guard now passes MACD, Bollinger Bands and ADX, and still refuses an unknown card', () => {
  assert.deepEqual(unknownSavedFilterNames(['Market Cap', 'MACD', 'Bollinger Bands', 'ADX', 'RSI']), []);
  assert.deepEqual(unknownSavedFilterNames(['MACD', 'Some Future Card']), ['Some Future Card']);
});

test('the silent drops are closed: RSI averages, meter trends and chart presets reach the query', () => {
  const by = Object.fromEntries(NEW.map(c => [c.slug, portMap(c.filters)]));
  assert.equal(by['syn-rsi-ma']['rsi_ma'], 'daily:sma14:above:any: | weekly:sma9:any:up:3');
  assert.equal(by['syn-rsi-old-empty']['rsi_range'], 'weekly:40:60', 'an old RSI screen with no range keeps the page default');
  assert.equal(by['syn-growth-trends']['short_term_growth_trend_quarters'], '4', 'an unknown quarter count falls back to 4');
  assert.ok(!('returns_efficiency_trend' in by['syn-growth-trend-off']), 'a trend is sent only while its meter is on');
  assert.ok(by['syn-pattern-preset']['pattern_filters'].includes('"preset":"rising-wedge"'));
  assert.ok(by['syn-pattern-breakout-low']['pattern_filters'].includes('"breakout":false'), 'a shape ending low cannot ask for a breakout');
  assert.equal(by['syn-macd-nokey']['macd_cross'], 'bullish', 'MACD on with nothing saved runs the card defaults');
  assert.equal(by['syn-bb-nokey']['bb'], 'daily:any:up:3:any');
  assert.equal(by['syn-adx-nokey']['adx'], 'daily:25::any::any:any:');
  assert.equal(by['syn-fyoc-orphan']['cb_groups'], 'daily|2025-10-08..2025-10-08|green|75|0|0|5-100|', 'saved candle groups apply even with the card removed, as on the site');
});
