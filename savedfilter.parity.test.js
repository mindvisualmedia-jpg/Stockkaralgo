'use strict';
// Saved-screener PARITY (2026-09-08).
//
// stockkar.in has no "stocks for saved filter X" endpoint; its page translates
// the saved config into a /api/global-filter/stocks query in the browser.
// savedfilter-query.js is a faithful port of that translation. This test holds
// the port to the site with the owner's 71 REAL saved screeners: each fixture
// is the config the site served + the VERBATIM query the site's own page sent
// for it (captured in Chrome, 2026-09-08), plus the page's live defaults that
// day. When the site changes, re-capture and this test names the parameter
// that drifted - before any user sees wrong stocks.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const rd = require('./rollingdates');
const { buildSavedFilterQuery, normalizeActiveFilterNames, HANDLED_FILTER_NAMES, INITIAL_FILTERS } = require('./savedfilter-query');
const { unknownSavedFilterNames } = require('./savedfilter');

const DIR = path.join(__dirname, 'test', 'fixtures', 'savedfilters');
const QDOC = JSON.parse(fs.readFileSync(path.join(DIR, '_site-queries.json'), 'utf8'));
const QUERIES = QDOC.queries;
// Screeners the SITE is currently self-inconsistent about (see _site-queries.json
// .excluded): parity against a moving target proves nothing, so they are skipped
// by name and listed, never silently dropped.
const EXCLUDED = QDOC.excluded || {};
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(DIR, '_site-defaults.json'), 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, '_manifest.json'), 'utf8'));

// The site's calendar on capture day: latest trading date 2026-09-07. Rolling
// descriptors ({rolling:true, back:N}) resolve against it exactly as the page
// does; a weekday calendar reproduces every captured demand date.
const CAL = []; const d = new Date(DEFAULTS.latestTradingDate || '2026-09-07T00:00:00Z');
while (CAL.length < 80) { if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) CAL.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
CAL.reverse();

const IGNORE = new Set(['limit', 'offset']);
const asMap = (P) => { const m = {}; for (const k of new Set(P.keys())) if (!IGNORE.has(k)) m[k] = P.getAll(k).map(decodeURIComponent).sort().join(' | '); return m; };
const portQuery = (filters) => {
  const resolved = rd.hasRollingDates(filters) ? rd.resolveRollingFilterDates(filters, { daily: CAL, weekly: [], monthly: [] }) : filters;
  return asMap(buildSavedFilterQuery(resolved, { limit: 20, offset: 0, defaults: DEFAULTS }));
};

test('corpus is complete: every fixture has its site query and vice versa', () => {
  const slugs = MANIFEST.map(m => m.slug);
  assert.ok(slugs.length >= 71, 'expected the 71-screener corpus, got ' + slugs.length);
  for (const s of slugs) assert.ok(QUERIES[s], 'no site query captured for ' + s);
  for (const s of Object.keys(QUERIES)) assert.ok(slugs.includes(s), 'site query without fixture: ' + s);
});

for (const m of MANIFEST) {
  // A screener the SITE is currently self-inconsistent about is skipped BY NAME
  // and with its reason - parity against a moving target proves nothing, and a
  // silent drop would hide it.
  if (EXCLUDED[m.slug]) { test('PARITY ' + m.slug + ' SKIPPED - ' + EXCLUDED[m.slug], { skip: true }, () => {}); continue; }
  test('PARITY ' + m.slug + ' "' + m.name + '"', () => {
    const fx = JSON.parse(fs.readFileSync(path.join(DIR, m.slug + '.json'), 'utf8'));
    const algo = portQuery(fx.filters);
    const site = asMap(new URLSearchParams(QUERIES[m.slug]));
    const onlyAlgo = Object.keys(algo).filter(k => !(k in site));
    const onlySite = Object.keys(site).filter(k => !(k in algo));
    const differ = Object.keys(algo).filter(k => k in site && algo[k] !== site[k]);
    assert.deepEqual(onlyAlgo, [], 'port sends params the site did not: ' + onlyAlgo.map(k => k + '=' + algo[k]).join(', '));
    assert.deepEqual(onlySite, [], 'port misses params the site sent: ' + onlySite.map(k => k + '=' + site[k]).join(', '));
    assert.deepEqual(differ, [], 'values differ: ' + differ.map(k => k + ': port=' + algo[k] + ' site=' + site[k]).join(', '));
  });
}

test('every filter name in the corpus is one the port handles (nothing silently dropped)', () => {
  const seen = new Set();
  for (const m of MANIFEST) normalizeActiveFilterNames(m.activeFilters).forEach(n => seen.add(n));
  const unknown = [...seen].filter(n => !HANDLED_FILTER_NAMES.includes(n));
  assert.deepEqual(unknown, [], 'unhandled names in real use: ' + unknown.join(', '));
});

test('the guard reports a name the port does not handle, and nothing else', () => {
  assert.deepEqual(unknownSavedFilterNames(['Market Cap', '% Above Daily EMA', 'Stock Has Fallen', 'Brand New Site Filter']), ['Brand New Site Filter']);
  assert.deepEqual(unknownSavedFilterNames([]), []);
  assert.deepEqual(unknownSavedFilterNames(null), []);
});

test('a config without activeFilters behaves like the page: INITIAL_FILTERS + live defaults', () => {
  const q = portQuery({});
  assert.deepEqual(INITIAL_FILTERS, ['Market Cap', 'Basket', 'Sector', 'Prev Price', 'Exchange']);
  assert.equal(q.market_cap_min, String(Math.floor(DEFAULTS.ranges.market_cap[0])));
  assert.equal(q.market_cap_max, String(Math.floor(DEFAULTS.ranges.market_cap[1])));
  assert.equal(q.close_price_min, '0');
  assert.equal(q.sort_order, 'desc');
});

test('server.js uses the port, not a hand mapper, for saved screeners', () => {
  const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert.ok(src.includes("require('./savedfilter-query')"), 'server.js must build saved-screener queries with savedfilter-query.js');
  assert.ok(!src.includes('const withFilters = (f) => {'), 'the old hand mapper closure must be gone');
  assert.ok(src.includes('unknownSavedFilterNames('), 'the unknown-filter guard must stay wired');
  assert.ok(src.includes('if (err) notifyScreenerRefreshFailure(job, err);'), 'a failed refresh must alert');
});
