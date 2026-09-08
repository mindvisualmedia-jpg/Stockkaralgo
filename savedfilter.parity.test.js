'use strict';
// Saved-screener PARITY (2026-09-08). The site's frontend is the canonical
// translator of a saved filter into a stocks query; server.js carries a hand
// copy. This pins the copy to a real saved filter captured from the site
// ('Copy of momtam screener', 2026-09-08) together with the EXACT query the
// site's own page sent for it. When the site changes, re-capture the pair and
// this test says which parameter drifted - before a user sees wrong stocks.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { unknownSavedFilterNames, KNOWN_SAVED_FILTER_NAMES } = require('./savedfilter');
const rd = require('./rollingdates');

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'test', 'fixtures', 'savedfilter-momtam.json'), 'utf8'));
// request #27 on stockkar.in, verbatim (limit/offset are paging, ignored below)
const SITE_QUERY = 'limit=20&offset=0&include_technicals=true&market_cap_min=1000&market_cap_max=1790696&short_term_growth_score_min=60&short_term_growth_score_max=100&stock_exchange=nse&sort_order=desc&ma_crossovers=daily_sma20-daily_sma50-gt&ma_crossovers=daily_sma50-daily_sma200-gt&rsi_range=daily%3A60%3A65';

// Run the mapper closure exactly as the handler does: rolling dates resolved
// first, then the closure with its enclosing-scope variables stubbed.
function runMapper(filters) {
  const start = src.indexOf('const withFilters = (f) => {');
  const end = src.indexOf('}; // end withFilters', start);
  assert.ok(start > 0 && end > start, 'mapper closure not found in server.js');
  const body = src.slice(start, end + '}; // end withFilters'.length);
  const cal = []; const d = new Date('2026-09-08T00:00:00Z');
  while (cal.length < 60) { if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) cal.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  const needsRoll = rd.hasRollingDates(filters);
  const resolved = needsRoll ? rd.resolveRollingFilterDates(filters, { daily: cal.reverse(), weekly: [], monthly: [] }) : filters;
  let captured = null;
  // the closure ends in a LINE comment ("}; // end withFilters"), so the return
  // must start on a fresh line or it is commented out
  const make = new Function('limit', 'STOCKKAR_MAX_LIMIT', 'config', 'sendJSON', 'stockkarGet', 'console', 'needsRoll', 'token', body + '\nreturn withFilters;');
  make(undefined, 2000, { name: 'fixture' }, () => {}, (q) => { captured = q; }, { log() {} }, needsRoll, 't')(resolved);
  assert.ok(captured, 'mapper sent no query');
  return new URLSearchParams(captured.split('?')[1]);
}
const asMap = (P) => { const m = {}; for (const k of new Set(P.keys())) if (k !== 'limit' && k !== 'offset') m[k] = P.getAll(k).sort().join(' | '); return m; };

test('PARITY: the mapper sends exactly what the site sent for a real saved filter', () => {
  const algo = asMap(runMapper(fixture));
  const site = asMap(new URLSearchParams(SITE_QUERY));
  for (const k of Object.keys(site)) assert.equal(algo[k], site[k], 'param ' + k + ' differs from the site');
  // Parameters the site did NOT send must not change the result. Demand did
  // (site 40 stocks, mapper 0 - proven 2026-09-08); these were proven harmless
  // by the same isolation and are tolerated, listed so a NEW extra fails here
  // instead of surprising a user.
  const tolerated = new Set(['close_price_min', 'close_price_max', 'rsi_min', 'rsi_max', 'include_technicals', 'sort_order']);
  const extras = Object.keys(algo).filter(k => !(k in site) && !tolerated.has(k));
  assert.deepEqual(extras, [], 'mapper sends parameters the site does not: ' + extras.join(', '));
});

test('demand dates are NOT sent unless Demand is an active filter (the frozen-basket bug)', () => {
  const p = runMapper(fixture);
  assert.equal(p.get('demand_start_date'), null);
  assert.equal(p.get('demand_end_date'), null);
});

test('demand dates ARE sent when Demand is active - the fix did not break Demand screeners', () => {
  const withDemand = { ...fixture, activeFilters: [...fixture.activeFilters, 'Demand'] };
  const p = runMapper(withDemand);
  assert.ok(p.get('demand_start_date'), 'start date missing');
  assert.ok(p.get('demand_end_date'), 'end date missing');
});

test('the real fixture is fully understood by the mapper (no unknown filter names)', () => {
  assert.deepEqual(unknownSavedFilterNames(fixture.activeFilters), []);
});

test('an unknown filter name is reported, known ones (fuzzy, like hasFilter) are not', () => {
  assert.deepEqual(unknownSavedFilterNames(['Market Cap', 'RSI (Multi-Timeframe)', 'Brand New Site Filter']), ['Brand New Site Filter']);
  assert.deepEqual(unknownSavedFilterNames([]), []);
  assert.deepEqual(unknownSavedFilterNames(null), []);
  assert.ok(KNOWN_SAVED_FILTER_NAMES.includes('Demand'));
});

test('the handler refuses a screener with an unknown filter instead of dropping it', () => {
  assert.ok(src.includes('unknownSavedFilterNames(rawFilters.activeFilters)'), 'guard not wired into /saved-filter-stocks');
  assert.ok(src.includes('if (err) notifyScreenerRefreshFailure(job, err);'), 'a failed refresh must alert');
});
