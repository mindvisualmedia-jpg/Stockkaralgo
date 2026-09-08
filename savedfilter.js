'use strict';
// Saved-screener parity helpers (2026-09-08).
//
// stockkar.in has NO "stocks for saved filter X" endpoint: its own web page
// downloads the filter config and its FRONTEND translates that into a
// /api/global-filter/stocks query. The mapper in server.js is a hand copy of
// that translation. A copy goes stale every time the site changes, and until
// now a filter the copy did not know was silently DROPPED - a less restrictive
// query, a wider universe, wrong stocks traded, discovered days later (eleven
// mapper-repair commits Jun-Aug 2026). This module names what the copy knows,
// so the unknown is refused loudly instead.
//
// Pure and dependency-free so it unit-tests without a server.

// Every activeFilters name the server.js mapper has a branch for (its
// hasFilter('...') calls) plus the ones it handles without a name check.
const KNOWN_SAVED_FILTER_NAMES = [
  '% Above Daily EMA', '% Within EMA', '% Within SMA', 'Big Player Score',
  'Consolidation - Daily', 'Consolidation - Monthly', 'Consolidation - Weekly',
  'Debt Ratio', 'EMA Crossover', 'EMA Price Crossover', 'EMA above EMA', 'Exchange',
  'Fearless Indicator', 'Fearless Zone', 'Form Your Own Candle - Daily',
  'Form Your Own Candle - Monthly', 'Form Your Own Candle - Weekly', 'Golden Valuation',
  'Growth Compounder Meter', 'Growth Score', 'Momentum Score', 'Near Term Growth Meter',
  'PE Ratio', 'Performance Meter', 'Pivot', 'Price Near High', 'Price vs EMA',
  'Quarterly EPS Growth', 'ROCE', 'ROE', 'RSI 14', 'RSI', 'SMA Crossover',
  'SMA Price Crossover', 'SMA above SMA', 'Supertrend',
  // handled without a hasFilter() check (by field presence or exact af.includes)
  'Market Cap', 'Basket', 'Sector', 'Industry', 'Demand',
  'Close Price', 'Prev Price', 'Volume Traces', 'Your Date, Your Volume', 'Delivery %',
  'Public', 'Promoter', 'DII', 'FII',                       // shareholding -> sh_filters
  // site RENAMES the mapper now aliases (2026-09-08: both were silently dropped)
  'TTM-PE Comparison',                                     // was 'Golden Valuation'
  'Consolidation Point - Daily', 'Consolidation Point - Weekly', 'Consolidation Point - Monthly',
];

const norm = (s) => String(s || '').trim().toLowerCase();

// Mirrors the mapper's own fuzzy hasFilter rule EXACTLY (either name contains
// the other), so "known" here means "the mapper would act on it".
function filterNameMatches(activeName, knownName) {
  const a = norm(activeName), k = norm(knownName);
  return !!a && !!k && (a === k || a.includes(k) || k.includes(a));
}

function unknownSavedFilterNames(activeFilters, known = KNOWN_SAVED_FILTER_NAMES) {
  return (Array.isArray(activeFilters) ? activeFilters : [])
    .map(n => String(n || '').trim())
    .filter(n => n && !known.some(k => filterNameMatches(n, k)));
}

module.exports = { KNOWN_SAVED_FILTER_NAMES, filterNameMatches, unknownSavedFilterNames };
