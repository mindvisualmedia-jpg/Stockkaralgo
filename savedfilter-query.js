'use strict';
// savedfilter-query.js - a saved Stocklab screener -> the EXACT /api/global-filter/stocks
// query the stockkar.in page itself sends for it.
//
// WHY THIS EXISTS (2026-09-08). stockkar.in has no "stocks for saved filter X"
// endpoint: its page downloads the saved config and its frontend translates it
// in two layers - page.jsx buildFetchArgsFromFilters (config -> fetch args) and
// components/Services/FetchStocks.js (args -> URLSearchParams). server.js used to
// carry a hand-written approximation of that; measured against the owner's 71
// real screeners it matched 0 of them. This module is a faithful PORT of both
// layers, dependency-free, and is held to the site by savedfilter.parity.test.js:
// every saved screener's real config + the verbatim query the site sent for it.
//
// Rules of the port:
//   * mirror the site's code path, including its quirks (Math.floor on ranges,
//     latest-vs-historical demand mode, "Prev Price" -> close_price_*, names the
//     site silently ignores stay ignored - "Close Price", "TTM-PE Comparison",
//     "Consolidation Point - Daily" have no branch on the site either);
//   * where the checked-out `dev` source and the PRODUCTION capture disagree,
//     production wins (FYoC groups carry no trailing relationship segment);
//   * rolling-date descriptors are resolved by the caller (rollingdates.js)
//     against the same calendars the site uses, before this runs.
//
// Read-only with respect to stockkar.in: nothing here changes the site.

// ---- page.jsx constants -----------------------------------------------------
const LEGACY_FILTER_NAME_MAP = {
  'MA above MA': 'EMA above EMA',
  '% Daily EMA': '% Within EMA',
  '% Above Daily EMA': '% Within EMA',
  'Price vs EMA': '% Within EMA',
  'Price vs SMA': '% Within SMA',
  'Price Crossover': 'EMA Price Crossover',
  'MA Crossover': 'EMA Crossover',
  'Stock Has Fallen': 'Price Near High',
  'Supertrend': 'Fearless Indicator',
  'Fearless Zone': 'Pivot',
};
const SH_BUCKETS = { Public: 'public', FII: 'fii', DII: 'dii', Promoter: 'promoter' };
const FYOC_TF_FILTER_NAME = { daily: 'Form Your Own Candle - Daily', weekly: 'Form Your Own Candle - Weekly', monthly: 'Form Your Own Candle - Monthly' };
// "Form Your Own Chart" = the draw-a-pattern group, added to Stocklab by
// 2026-09-09 (9 groups / 46 filters). It arms pattern_filters, not cb_groups.
const FYOCHART_TF_FILTER_NAME = { daily: 'Form Your Own Chart - Daily', weekly: 'Form Your Own Chart - Weekly', monthly: 'Form Your Own Chart - Monthly' };
const DEFAULT_EMA_ALIGN = { emas: [5, 9, 20, 50, 100, 200], direction: 'bullish', spreadOn: true, spreadPct: 5, price: 'any' };
const DEMAND_FILTER_CONFIG = [
  { name: 'Big Player Score', latestStateKey: 'bigPlayerScore', startStateKey: 'bigPlayerScoreStart', endStateKey: 'bigPlayerScoreEnd', trendStateKey: 'bigPlayerTrend', startEnabledStateKey: 'bigPlayerStartEnabled', activeKey: 'bigPlayerScoreActive', latestMinKey: 'bigPlayerScoreMin', latestMaxKey: 'bigPlayerScoreMax', startMinKey: 'bigPlayerScoreStartMin', startMaxKey: 'bigPlayerScoreStartMax', endMinKey: 'bigPlayerScoreEndMin', endMaxKey: 'bigPlayerScoreEndMax' },
  { name: 'Growth Score', latestStateKey: 'growthScore', startStateKey: 'growthScoreStart', endStateKey: 'growthScoreEnd', trendStateKey: 'growthTrend', startEnabledStateKey: 'growthStartEnabled', activeKey: 'growthScoreActive', latestMinKey: 'growthScoreMin', latestMaxKey: 'growthScoreMax', startMinKey: 'growthScoreStartMin', startMaxKey: 'growthScoreStartMax', endMinKey: 'growthScoreEndMin', endMaxKey: 'growthScoreEndMax' },
  { name: 'Momentum Score', latestStateKey: 'momentumScore', startStateKey: 'momentumScoreStart', endStateKey: 'momentumScoreEnd', trendStateKey: 'momentumTrend', startEnabledStateKey: 'momentumStartEnabled', activeKey: 'momentumScoreActive', latestMinKey: 'momentumScoreMin', latestMaxKey: 'momentumScoreMax', startMinKey: 'momentumScoreStartMin', startMaxKey: 'momentumScoreStartMax', endMinKey: 'momentumScoreEndMin', endMaxKey: 'momentumScoreEndMax' },
];

// Every activeFilters name the site's builder ACTS on, plus names it carries
// but silently ignores (a screener using only those is still fully understood).
const HANDLED_FILTER_NAMES = [
  'Market Cap', 'Basket', 'Sector', 'Exchange', 'Prev Price', 'PE Ratio', 'ROE', 'ROCE', 'Debt Ratio',
  'Big Player Score', 'Growth Score', 'Momentum Score', 'Delivery %', '% Within EMA', '% Within SMA',
  'EMA above EMA', 'SMA above SMA', 'EMA Price Crossover', 'SMA Price Crossover', 'EMA Crossover', 'SMA Crossover',
  'RSI 14', 'RSI', 'Fearless Indicator', 'Pivot', 'EMA Alignment', 'Price Near High', 'Your Date, Your Volume',
  'Volume Traces', 'Quarterly EPS Growth', 'Form Your Own Candle', 'Form Your Own Candle - Daily',
  'Form Your Own Candle - Weekly', 'Form Your Own Candle - Monthly',
  // the draw-a-pattern group added to Stocklab by 2026-09-09
  'Form Your Own Chart - Daily', 'Form Your Own Chart - Weekly', 'Form Your Own Chart - Monthly',
  'Consolidation - Daily', 'Consolidation - Weekly',
  'Consolidation - Monthly', 'Consolidation – Daily', 'Consolidation – Weekly', 'Consolidation – Monthly',
  'Golden Valuation', 'Performance Meter', 'Growth Compounder Meter', 'Near Term Growth Meter',
  'Public', 'FII', 'DII', 'Promoter',
  ...Object.keys(LEGACY_FILTER_NAME_MAP),
  // carried by real saved filters, no branch on the site -> ignored there and here
  'Close Price', 'TTM-PE Comparison', 'Consolidation Point - Daily', 'Consolidation Point - Weekly', 'Consolidation Point - Monthly',
];

// ---- page.jsx helpers -------------------------------------------------------
function normalizeActiveFilterNames(filters) {
  return (Array.isArray(filters) ? filters : []).map(name => LEGACY_FILTER_NAME_MAP[name] || name);
}
function normalizeFallPctForApi(value) {
  const numeric = Math.max(0, Number(value) || 0);
  return numeric > 1 ? numeric / 100 : numeric;
}
function sanitizeSortBy(sortField, filters) {
  if (!sortField) return null;
  const active = Array.isArray(filters) ? filters : [];
  if (sortField === 'supertrend_pct' && !active.includes('Fearless Indicator')) return null;
  if (sortField === 'fearless_zone_close_distance_pct' && !active.includes('Pivot')) return null;
  if ((sortField === 'stock_fall_pct' || sortField === 'stock_fall_high_price' || sortField === 'stock_fall_high_date') && !active.includes('Price Near High')) return null;
  return sortField;
}
function normalizeMaProximity(item) {
  item = item || {};
  const numericPercent = Math.abs(Number(item.percent) || 0);
  const minPercent = Math.abs(Number(item.minPercent) || 0);
  const maxPercent = Math.abs(Number(item.maxPercent) || 0);
  const resolvedMin = item.minPercent !== undefined ? minPercent : numericPercent;
  const resolvedMax = item.maxPercent !== undefined ? maxPercent : numericPercent;
  return {
    field: item.field || ('daily_ema' + (Number(item.period) || 20)),
    minPercent: Math.min(resolvedMin, resolvedMax),
    maxPercent: Math.max(resolvedMin, resolvedMax),
    dir: item.dir || ((Number(item.percent) || 0) < 0 ? 'down' : 'up'),
  };
}
function normalizeMaPriceCrossover(item) {
  item = item || {};
  return { field: item.field || (item.ema ? 'daily_ema' + item.ema : 'daily_ema20'), dir: item.dir || 'gt' };
}
function normalizeMaPair(item) {
  item = item || {};
  return {
    left: item.left || (item.short ? 'daily_ema' + item.short : 'daily_ema20'),
    right: item.right || (item.long ? 'daily_ema' + item.long : 'daily_ema50'),
    dir: item.dir || 'gt',
  };
}
function normalizeFearlessZoneColor(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return ['green', 'blue', 'light_red', 'dark_red'].includes(normalized) ? normalized : 'all';
}
function buildFearlessZoneStateFromLegacy(saved) {
  saved = saved || {};
  const result = {
    fearlessZoneColor: normalizeFearlessZoneColor(saved.fearlessZoneColor),
    fearlessZoneWithinPct: saved.fearlessZoneWithinPct !== undefined && saved.fearlessZoneWithinPct !== null && saved.fearlessZoneWithinPct !== ''
      ? (Number(saved.fearlessZoneWithinPct) || 0) : '',
  };
  if (saved.pivotPct !== undefined && result.fearlessZoneWithinPct === '') result.fearlessZoneWithinPct = Number(saved.pivotPct) || 0;
  if (saved.pivotPosition) return { ...result, fearlessZoneWithinPct: 0 };   // every legacy position maps to 0 on the site
  return result;
}
function buildDemandFetchArgs(filters) {
  const activeFilterList = Array.isArray(filters && filters.activeFilterList) ? filters.activeFilterList : [];
  const hasAnyDemandFilter = DEMAND_FILTER_CONFIG.some(({ name }) => activeFilterList.includes(name));
  const useHistorical = Boolean(filters && filters.demandStartDate) && Boolean(filters && filters.demandEndDate) && hasAnyDemandFilter;
  const args = {};
  if (useHistorical) { args.demandStartDate = filters.demandStartDate; args.demandEndDate = filters.demandEndDate; }
  DEMAND_FILTER_CONFIG.forEach((config) => {
    const isActive = activeFilterList.includes(config.name);
    const latestRange = filters && filters[config.latestStateKey];
    const startRange = filters && filters[config.startStateKey];
    const endRange = filters && filters[config.endStateKey];
    args[config.activeKey] = !useHistorical && isActive;
    if (!useHistorical) {
      if (isActive && Array.isArray(latestRange)) { args[config.latestMinKey] = latestRange[0]; args[config.latestMaxKey] = latestRange[1]; }
      return;
    }
    if (!isActive) return;
    const trend = filters[config.trendStateKey];
    if (trend === 'increasing' || trend === 'decreasing' || trend === 'stable') args[config.trendStateKey] = trend;
    // START RANGE IS OPT-IN (re-measured 2026-09-09). Until 2026-09-08 production
    // always sent it; the site has since shipped the gate, so a start range left
    // at its 0-100 default is now OMITTED. Verified on five screeners whose start
    // was [0,100] (they lost the param) against three whose start was set (they
    // kept it). Saved filters from before the toggle carry no flag, so a
    // non-default range still counts as enabled - the site's own fallback.
    const startEnabled = filters[config.startEnabledStateKey];
    const startOn = (startEnabled !== undefined && startEnabled !== null) ? startEnabled
      : (Array.isArray(startRange) && (startRange[0] !== 0 || startRange[1] !== 100));
    if (startOn && Array.isArray(startRange)) { args[config.startMinKey] = startRange[0]; args[config.startMaxKey] = startRange[1]; }
    if (Array.isArray(endRange)) { args[config.endMinKey] = endRange[0]; args[config.endMaxKey] = endRange[1]; }
  });
  return args;
}

// ---- LAYER 1: page.jsx buildFetchArgsFromFilters -----------------------------
// The page's own initial state: what a config without the key falls back to.
const INITIAL_FILTERS = ['Market Cap', 'Basket', 'Sector', 'Prev Price', 'Exchange'];

// `defaults` = the page's LIVE state defaults, which production uses whenever a
// saved config lacks a field (legacy configs) and ALWAYS for Quarterly EPS
// Growth (production never restores the saved quarter/range - proven by three
// captured screeners all sending the same live quarter and bounds):
//   { ranges: {market_cap:[lo,hi], pe_ratio, roe, roce, debt_ratio, close_price, eps_growth},
//     latestQuarter: '202509 vs 202409' }
// Both come from stockkar.in (/api/global-filter/filters/ranges, /available-quarters).
function buildFetchArgsFromFilters(saved, defaults) {
  if (!saved || typeof saved !== 'object') return {};
  const D = (defaults && defaults.ranges) || {};
  const range = (savedRange, key) => Array.isArray(savedRange) ? savedRange : (Array.isArray(D[key]) ? D[key] : null);
  // applyFilterState only replaces activeFilters when the KEY is present; an
  // absent key keeps INITIAL_FILTERS (an explicit [] is honoured as empty).
  const af = normalizeActiveFilterNames(Array.isArray(saved.activeFilters) ? saved.activeFilters : INITIAL_FILTERS);
  const has = (name) => af.includes(name);
  const sanitizedSortBy = sanitizeSortBy(saved.sort_by, af);
  const activeShBuckets = new Set(Object.entries(SH_BUCKETS).filter(([name]) => af.includes(name)).map(([, key]) => key));
  const args = { activeFilters: af, offset: 0, limit: 20 };
  if (sanitizedSortBy) args.sort_by = sanitizedSortBy;
  args.sort_order = saved.sort_order || 'desc';                        // page state default
  if (has('Exchange') && saved.stockExchange) { args.exchangeActive = true; args.exchangeValue = saved.stockExchange; }
  if (has('Sector')) { args.industryActive = true; args.industryValue = saved.selectedIndustries || []; }
  if (has('Basket')) { args.basketsActive = true; args.basketsArray = saved.selectedBaskets || []; }
  const mc = range(saved.marketCapRange, 'market_cap');
  if (has('Market Cap') && mc) { args.marketCapActive = true; args.marketCapMin = mc[0]; args.marketCapMax = mc[1]; }
  const pe = range(saved.peRatioRange, 'pe_ratio');
  if (has('PE Ratio') && pe) { args.peRatioActive = true; args.peRatioMin = pe[0]; args.peRatioMax = pe[1]; }
  const roe = range(saved.roeRange, 'roe');
  if (has('ROE') && roe) { args.roeActive = true; args.roeMin = roe[0]; args.roeMax = roe[1]; }
  const roce = range(saved.roceRange, 'roce');
  if (has('ROCE') && roce) { args.roceActive = true; args.roceMin = roce[0]; args.roceMax = roce[1]; }
  const de = range(saved.debtRatioRange, 'debt_ratio');
  if (has('Debt Ratio') && de) { args.deRatioActive = true; args.deRatioMin = de[0]; args.deRatioMax = de[1]; }
  // "Prev Price" is the filter that becomes close_price_* (previous close); the
  // site has no branch for a "Close Price" name.
  const cp0 = range(saved.closePriceRange, 'close_price');
  if (has('Prev Price') && cp0) { args.closePriceActive = true; args.closePriceMin = cp0[0]; args.closePriceMax = cp0[1]; }
  Object.assign(args, buildDemandFetchArgs({
    activeFilterList: af, historicalDemandActive: saved.historicalDemandActive,
    demandStartDate: saved.demandStartDate || '', demandEndDate: saved.demandEndDate || '',
    bigPlayerScore: saved.bigPlayerScore, growthScore: saved.growthScore, momentumScore: saved.momentumScore,
    bigPlayerScoreStart: saved.bigPlayerScoreStart, bigPlayerScoreEnd: saved.bigPlayerScoreEnd,
    growthScoreStart: saved.growthScoreStart, growthScoreEnd: saved.growthScoreEnd,
    momentumScoreStart: saved.momentumScoreStart, momentumScoreEnd: saved.momentumScoreEnd,
    bigPlayerTrend: saved.bigPlayerTrend, growthTrend: saved.growthTrend, momentumTrend: saved.momentumTrend,
    bigPlayerStartEnabled: saved.bigPlayerStartEnabled, growthStartEnabled: saved.growthStartEnabled, momentumStartEnabled: saved.momentumStartEnabled,
  }));
  if (has('Delivery %') && Array.isArray(saved.deliveryRange)) { args.deliveryActive = true; args.deliveryMin = saved.deliveryRange[0]; args.deliveryMax = saved.deliveryRange[1]; }
  if (has('% Within EMA') && Array.isArray(saved.emaProximities)) args.emaProximities = saved.emaProximities.map(normalizeMaProximity);
  if (has('% Within SMA') && Array.isArray(saved.smaProximities)) args.smaProximities = saved.smaProximities.map(normalizeMaProximity);
  if (has('EMA above EMA') && Array.isArray(saved.emaCrossovers)) args.emaCrossovers = saved.emaCrossovers.map(normalizeMaPair);
  if (has('SMA above SMA') && Array.isArray(saved.smaCrossovers)) args.smaCrossovers = saved.smaCrossovers.map(normalizeMaPair);
  if (has('EMA Price Crossover')) {
    if (Array.isArray(saved.priceCrossovers)) args.priceCrossovers = saved.priceCrossovers.map(normalizeMaPriceCrossover);
    if (saved.priceCrossRefDate) args.priceCrossRefDate = saved.priceCrossRefDate;
    if (saved.priceCrossFrom !== undefined) args.priceCrossFrom = saved.priceCrossFrom || '';
    if (saved.priceCrossTo !== undefined) args.priceCrossTo = saved.priceCrossTo || '';
  }
  if (has('SMA Price Crossover')) {
    if (Array.isArray(saved.smaPriceCrossovers)) args.smaPriceCrossovers = saved.smaPriceCrossovers.map(normalizeMaPriceCrossover);
    if (saved.priceCrossRefDate) args.priceCrossRefDate = saved.priceCrossRefDate;
    if (saved.priceCrossFrom !== undefined) args.priceCrossFrom = saved.priceCrossFrom || '';
    if (saved.priceCrossTo !== undefined) args.priceCrossTo = saved.priceCrossTo || '';
  }
  if (has('EMA Crossover')) {
    if (Array.isArray(saved.historicalEmaCrossovers)) args.historicalEmaCrossovers = saved.historicalEmaCrossovers.map(normalizeMaPair);
    if (saved.emaCrossFrom !== undefined) args.emaCrossFrom = saved.emaCrossFrom || '';
    if (saved.emaCrossTo !== undefined) args.emaCrossTo = saved.emaCrossTo || '';
  }
  if (has('SMA Crossover')) {
    if (Array.isArray(saved.historicalSmaCrossovers)) args.historicalSmaCrossovers = saved.historicalSmaCrossovers.map(normalizeMaPair);
    if (saved.emaCrossFrom !== undefined) args.emaCrossFrom = saved.emaCrossFrom || '';
    if (saved.emaCrossTo !== undefined) args.emaCrossTo = saved.emaCrossTo || '';
  }
  if (has('RSI 14') && Array.isArray(saved.rsiRange)) { args.rsiMin = saved.rsiRange[0]; args.rsiMax = saved.rsiRange[1]; }
  if (has('RSI') && Array.isArray(saved.rsiFilters)) args.rsiRangeList = saved.rsiFilters;
  if (has('Fearless Indicator') && saved.supertrendSignal) args.supertrendSignal = saved.supertrendSignal;
  if (has('Fearless Indicator') && saved.supertrendPct !== undefined) args.supertrendPct = saved.supertrendPct;
  if (has('Pivot')) Object.assign(args, buildFearlessZoneStateFromLegacy(saved));
  if (has('EMA Alignment') && saved.emaAlign) args.emaAlign = { ...DEFAULT_EMA_ALIGN, ...saved.emaAlign };
  if (has('Price Near High')) {
    // ADVANCED NEAR-HIGH IS LIVE (re-measured 2026-09-09). On 2026-09-08 the
    // captured "52 week high" sent fall_days/fall_pct; it now sends
    // nh_days/nh_pct/nh_side/nh_when/nh_when_days. The legacy path ignores side
    // and "when" entirely, so this is a REAL selection difference, not cosmetic.
    const advWhen = saved.nearHighWhen || 'any';
    const advSide = saved.nearHighSide || 'below';
    if (advWhen !== 'any' || advSide === 'above') {
      args.nearHighAdv = { days: saved.fallDays || 30, pct: Math.max(0, Number(saved.fallPct) || 0), when: advWhen, side: advSide };
    } else {
      if (saved.fallDays) args.fallDays = saved.fallDays;
      if (saved.fallPct !== undefined) args.fallPct = normalizeFallPctForApi(saved.fallPct);
    }
  }
  if (has('Your Date, Your Volume') && saved.volumeSpike && saved.volumeSpike.date) args.volumeSpike = saved.volumeSpike;
  if (has('Volume Traces')) {
    if (saved.volumeDays !== undefined) args.volumeDays = saved.volumeDays;
    if (saved.volumeMultiplier !== undefined) args.volumeMultiplier = saved.volumeMultiplier;
    args.volumePlayActive = true;
  }
  if (has('Quarterly EPS Growth')) {
    // PRODUCTION never restores the saved quarter/range: the page's live state
    // (latest available quarter, eps_growth bounds from /filters/ranges) is what
    // goes out. Saved values are the fallback only when no live defaults exist.
    const quarter = (defaults && defaults.latestQuarter) || saved.quarterlyEpsQuarter;
    const eps = Array.isArray(D.eps_growth) ? D.eps_growth : (Array.isArray(saved.quarterlyEpsRange) ? saved.quarterlyEpsRange : null);
    if (quarter && eps) { args.quarterlyEpsActive = true; args.quarterlyEpsQuarter = quarter; args.quarterlyEpsMin = eps[0]; args.quarterlyEpsMax = eps[1]; }
  }
  const anyCandle = has('Form Your Own Candle') || ['daily', 'weekly', 'monthly'].some(tf => has(FYOC_TF_FILTER_NAME[tf]));
  const anyChart = ['daily', 'weekly', 'monthly'].some(tf => has(FYOCHART_TF_FILTER_NAME[tf]));
  if (anyCandle || anyChart) {
    const hasAny = (arr) => Array.isArray(arr) && arr.length > 0;
    if (hasAny(saved.fyocDaily) || hasAny(saved.fyocWeekly) || hasAny(saved.fyocMonthly)) {
      args.fyocActive = true; args.fyocDaily = saved.fyocDaily || []; args.fyocWeekly = saved.fyocWeekly || []; args.fyocMonthly = saved.fyocMonthly || [];
    }
    // DRAW-A-PATTERN IS LIVE (re-measured 2026-09-09) as the "Form Your Own
    // Chart" group. It sends pattern_filters AND forces sort_by=pattern_similarity.
    // Either name arms it for a timeframe: the new "Form Your Own Chart - <TF>"
    // (proven by a screener created for this test) and the old
    // "Form Your Own Candle - <TF>" (proven by 'higher high', whose saved drawing
    // now goes out although its activeFilters only names the Candle filter).
    const savedPatterns = saved.drawPatterns || (saved.drawPattern && saved.drawPattern.points && saved.drawPattern.points.length >= 2 ? { daily: saved.drawPattern } : null);
    if (savedPatterns) {
      const pf = ['daily', 'weekly', 'monthly']
        .filter((tf) => (has(FYOC_TF_FILTER_NAME[tf]) || has(FYOCHART_TF_FILTER_NAME[tf]))
          && savedPatterns[tf] && Array.isArray(savedPatterns[tf].points) && savedPatterns[tf].points.length >= 2)
        .map((tf) => ({ timeframe: tf, points: savedPatterns[tf].points, horizon: savedPatterns[tf].horizon, strictness: savedPatterns[tf].strictness, breakout: !!savedPatterns[tf].breakout }));
      if (pf.length) {
        args.patternFilters = pf;
        if (!args.sort_by || args.sort_by === 'market_cap') { args.sort_by = 'pattern_similarity'; args.sort_order = 'desc'; }
      }
    }
  }
  const hasCp = (tf) => has('Consolidation - ' + tf) || has('Consolidation – ' + tf);
  if (hasCp('Daily') || hasCp('Weekly') || hasCp('Monthly')) {
    const cp = saved.cp || {};
    const g = (tf) => (cp && cp[tf]) || {};
    const make = (tf) => {
      const c = g(tf);
      const o = {
        timeframe: tf,
        points_min: (c.points && c.points[0] !== undefined && c.points[0] !== null) ? c.points[0] : 1,
        points_max: (c.points && c.points[1] !== undefined && c.points[1] !== null) ? c.points[1] : 14,
        ref_from: c.refFrom || null, ref_to: c.refTo || null, status: c.status || 'partial',
      };
      if (c.refLabel && c.refLabel !== 'any') o.ref_label = c.refLabel;
      o.ref_body_min = (c.body && c.body[0] !== undefined && c.body[0] !== null) ? c.body[0] : 0;
      o.ref_body_max = (c.body && c.body[1] !== undefined && c.body[1] !== null) ? c.body[1] : 100;
      o.ref_size_min = (c.size && c.size[0] !== undefined && c.size[0] !== null) ? c.size[0] : 0;
      o.ref_size_max = (c.size && c.size[1] !== undefined && c.size[1] !== null) ? c.size[1] : 100;
      return o;
    };
    const filters = [];
    const dailyAuto = !!(saved.cpAuto && saved.cpAuto.active);
    if (hasCp('Daily') && !dailyAuto) filters.push(make('daily'));
    if (hasCp('Weekly')) filters.push(make('weekly'));
    if (hasCp('Monthly')) filters.push(make('monthly'));
    if (filters.length) { args.cpActive = true; args.cpFilters = filters; }
    if (hasCp('Daily') && dailyAuto) args.cpAuto = saved.cpAuto;
  }
  if (has('Golden Valuation')) {
    if (saved.dailyTtmPeOp !== undefined) args.dailyTtmPeOp = saved.dailyTtmPeOp;
    if (Array.isArray(saved.dailyTtmPeRange)) {
      args.dailyTtmPeMin = Math.max(0, Math.min(100, Number(saved.dailyTtmPeRange[0]) || 0));
      args.dailyTtmPeMax = Math.max(0, Math.min(100, Number(saved.dailyTtmPeRange[1]) || 0));
    } else if (saved.dailyTtmPePct !== undefined) {
      args.dailyTtmPeMin = 0; args.dailyTtmPeMax = Math.max(0, Math.min(100, Number(saved.dailyTtmPePct) || 0));
    }
  }
  const nz = (v, d) => (v === undefined || v === null) ? d : v;
  if (has('Performance Meter')) { args.returnsEfficiencyActive = true; args.returnsEfficiencyMin = nz(saved.returnsEffMin, 0); args.returnsEfficiencyMax = nz(saved.returnsEffMax, 100); }
  if (has('Growth Compounder Meter')) { args.longTermGrowthActive = true; args.longTermGrowthMin = nz(saved.longTermGrowthMin, 0); args.longTermGrowthMax = nz(saved.longTermGrowthMax, 100); }
  if (has('Near Term Growth Meter')) { args.shortTermGrowthActive = true; args.shortTermGrowthMin = nz(saved.shortTermGrowthMin, 0); args.shortTermGrowthMax = nz(saved.shortTermGrowthMax, 100); }
  const savedShFilters = Array.isArray(saved.shFilters) ? saved.shFilters : [];
  const shFiltersForApi = savedShFilters.filter((f) => activeShBuckets.has(f.bucket));
  if (shFiltersForApi.length) {
    args.shareholdingActive = true;
    args.shFilters = shFiltersForApi.map(({ bucket, mode, window, label, bandLo, bandHi }) => ({ bucket, mode, window: Number(window), label, band: Number(bandLo) + '-' + Number(bandHi) }));
  }
  return args;
}

// ---- LAYER 2: FetchStocks.js (params only; axios removed) --------------------
function fetchStocksParams(a) {
  a = a || {};
  const activeFilters = Array.isArray(a.activeFilters) ? a.activeFilters : [];
  const emaProximities = Array.isArray(a.emaProximities) ? a.emaProximities : [];
  const params = new URLSearchParams();
  params.set('limit', String(a.limit === undefined ? 20 : a.limit));
  params.set('offset', String(a.offset === undefined ? 0 : a.offset));

  const technicalFiltersRequested =
    activeFilters.some(n => ['% Within EMA', '% Within SMA', 'EMA above EMA', 'SMA above SMA', 'EMA Price Crossover', 'SMA Price Crossover', 'EMA Crossover', 'SMA Crossover', 'RSI 14', 'RSI', 'Fearless Indicator', 'Supertrend', 'Pivot', 'Fearless Zone', 'Price Near High', 'Stock Has Fallen'].includes(n)) ||
    emaProximities.length > 0 ||
    (Array.isArray(a.priceCrossovers) && a.priceCrossovers.length > 0) ||
    (Array.isArray(a.historicalEmaCrossovers) && a.historicalEmaCrossovers.length > 0) ||
    (a.rsiMin !== undefined && a.rsiMin !== null) || (a.rsiMax !== undefined && a.rsiMax !== null) ||
    Boolean(a.supertrendSignal) || (a.supertrendPct !== undefined && a.supertrendPct !== null) ||
    ((activeFilters.includes('Pivot') || activeFilters.includes('Fearless Zone')) &&
      ((a.fearlessZoneColor !== undefined && a.fearlessZoneColor !== null && a.fearlessZoneColor !== '' && a.fearlessZoneColor !== 'all') ||
       (a.fearlessZoneWithinPct !== undefined && a.fearlessZoneWithinPct !== null && a.fearlessZoneWithinPct !== '')));
  if (technicalFiltersRequested) params.set('include_technicals', 'true');

  if (a.industryActive) {
    if (Array.isArray(a.industryValue) && a.industryValue.length > 0) a.industryValue.forEach(v => params.append('industry', v));
    else if (typeof a.industryValue === 'string' && a.industryValue !== 'All') params.append('industry', a.industryValue);
  }
  if (a.basketsActive && Array.isArray(a.basketsArray) && a.basketsArray.length > 0) a.basketsArray.forEach(b => params.append('baskets', b));
  if (a.marketCapActive) { params.set('market_cap_min', String(Math.floor(a.marketCapMin))); params.set('market_cap_max', String(Math.floor(a.marketCapMax))); }
  if (a.peRatioActive) { params.set('pe_ratio_min', String(Math.floor(a.peRatioMin))); params.set('pe_ratio_max', String(Math.floor(a.peRatioMax))); }
  if (a.roeActive) { params.set('roe_min', String(Math.floor(a.roeMin))); params.set('roe_max', String(Math.floor(a.roeMax))); }
  if (a.roceActive) { params.set('roce_min', String(Math.floor(a.roceMin))); params.set('roce_max', String(Math.floor(a.roceMax))); }
  if (a.deRatioActive) { params.set('de_ratio_min', String(Math.floor(a.deRatioMin))); params.set('de_ratio_max', String(Math.floor(a.deRatioMax))); }
  if (a.closePriceActive) { params.set('close_price_min', String(Math.floor(a.closePriceMin))); params.set('close_price_max', String(Math.floor(a.closePriceMax))); }

  const def = (v) => v !== undefined;
  if (a.bigPlayerScoreActive && def(a.bigPlayerScoreMin) && def(a.bigPlayerScoreMax)) { params.set('big_player_score_min', String(a.bigPlayerScoreMin)); params.set('big_player_score_max', String(a.bigPlayerScoreMax)); }
  if (a.demandStartDate) params.set('demand_start_date', a.demandStartDate);
  if (a.demandEndDate) params.set('demand_end_date', a.demandEndDate);
  if (def(a.bigPlayerScoreStartMin) && def(a.bigPlayerScoreStartMax)) { params.set('big_player_score_start_min', String(a.bigPlayerScoreStartMin)); params.set('big_player_score_start_max', String(a.bigPlayerScoreStartMax)); }
  if (def(a.bigPlayerScoreEndMin) && def(a.bigPlayerScoreEndMax)) { params.set('big_player_score_end_min', String(a.bigPlayerScoreEndMin)); params.set('big_player_score_end_max', String(a.bigPlayerScoreEndMax)); }
  if (a.growthScoreActive && def(a.growthScoreMin) && def(a.growthScoreMax)) { params.set('growth_score_min', String(a.growthScoreMin)); params.set('growth_score_max', String(a.growthScoreMax)); }
  if (def(a.growthScoreStartMin) && def(a.growthScoreStartMax)) { params.set('growth_score_start_min', String(a.growthScoreStartMin)); params.set('growth_score_start_max', String(a.growthScoreStartMax)); }
  if (def(a.growthScoreEndMin) && def(a.growthScoreEndMax)) { params.set('growth_score_end_min', String(a.growthScoreEndMin)); params.set('growth_score_end_max', String(a.growthScoreEndMax)); }
  if (a.momentumScoreActive && def(a.momentumScoreMin) && def(a.momentumScoreMax)) { params.set('momentum_score_min', String(a.momentumScoreMin)); params.set('momentum_score_max', String(a.momentumScoreMax)); }
  if (def(a.momentumScoreStartMin) && def(a.momentumScoreStartMax)) { params.set('momentum_score_start_min', String(a.momentumScoreStartMin)); params.set('momentum_score_start_max', String(a.momentumScoreStartMax)); }
  if (def(a.momentumScoreEndMin) && def(a.momentumScoreEndMax)) { params.set('momentum_score_end_min', String(a.momentumScoreEndMin)); params.set('momentum_score_end_max', String(a.momentumScoreEndMax)); }
  ['bigPlayerTrend', 'growthTrend', 'momentumTrend'].forEach((k, i) => {
    const v = a[k]; if (v === 'increasing' || v === 'decreasing' || v === 'stable') params.set(['big_player_trend', 'growth_trend', 'momentum_trend'][i], v);
  });
  if (a.dailyTtmPeOp) params.set('daily_ttm_pe_op', a.dailyTtmPeOp);
  if (a.dailyTtmPeMin !== undefined && a.dailyTtmPeMin !== null) params.set('daily_ttm_pe_min', String(a.dailyTtmPeMin));
  if (a.dailyTtmPeMax !== undefined && a.dailyTtmPeMax !== null) { params.set('daily_ttm_pe_max', String(a.dailyTtmPeMax)); params.set('daily_ttm_pe_pct', String(a.dailyTtmPeMax)); }
  const nn = (v) => v !== undefined && v !== null;
  if (a.returnsEfficiencyActive && nn(a.returnsEfficiencyMin) && nn(a.returnsEfficiencyMax)) { params.set('returns_efficiency_score_min', String(a.returnsEfficiencyMin)); params.set('returns_efficiency_score_max', String(a.returnsEfficiencyMax)); }
  if (a.longTermGrowthActive && nn(a.longTermGrowthMin) && nn(a.longTermGrowthMax)) { params.set('long_term_growth_score_min', String(a.longTermGrowthMin)); params.set('long_term_growth_score_max', String(a.longTermGrowthMax)); }
  if (a.shortTermGrowthActive && nn(a.shortTermGrowthMin) && nn(a.shortTermGrowthMax)) { params.set('short_term_growth_score_min', String(a.shortTermGrowthMin)); params.set('short_term_growth_score_max', String(a.shortTermGrowthMax)); }
  if (a.quarterlyEpsActive && a.quarterlyEpsQuarter && nn(a.quarterlyEpsMin) && nn(a.quarterlyEpsMax)) { params.set('quarter', a.quarterlyEpsQuarter); params.set('eps_growth_min', String(a.quarterlyEpsMin)); params.set('eps_growth_max', String(a.quarterlyEpsMax)); }
  if (a.exchangeActive && a.exchangeValue && a.exchangeValue !== 'all') params.set('stock_exchange', String(a.exchangeValue).toLowerCase());
  if (a.sort_by) params.set('sort_by', a.sort_by);
  if (a.sort_order) params.set('sort_order', a.sort_order);

  const LEGACY = /^daily_ema(\d+)$/;
  // EMA above EMA (current state): legacy daily-EMA pairs -> short/long/dir triplets, else ma_crossovers
  const crossNow = [].concat(Array.isArray(a.emaCrossovers) ? a.emaCrossovers : [], Array.isArray(a.smaCrossovers) ? a.smaCrossovers : []);
  crossNow.forEach((cross) => {
    const left = (cross && cross.left) || (cross && cross.short ? 'daily_ema' + cross.short : null);
    const right = (cross && cross.right) || (cross && cross.long ? 'daily_ema' + cross.long : null);
    const l = LEGACY.exec(left || ''), r = LEGACY.exec(right || '');
    if (l && r && cross.dir) { params.append('ema_cross_short', l[1]); params.append('ema_cross_long', r[1]); params.append('ema_cross_dir', cross.dir); }
    else if (left && right && cross.dir) params.append('ma_crossovers', left + '-' + right + '-' + cross.dir);
  });
  if (a.deliveryActive) { params.set('delivery_min', String(a.deliveryMin)); params.set('delivery_max', String(a.deliveryMax)); }
  if (a.volumePlayActive) { params.set('volume_days', String(a.volumeDays)); params.set('volume_multiplier', String(a.volumeMultiplier)); }
  [].concat(emaProximities, Array.isArray(a.smaProximities) ? a.smaProximities : []).forEach(({ field, period, percent, minPercent, maxPercent, dir }) => {
    const resolvedField = field || ('daily_ema' + (Number(period) || 20));
    const legacyPeriod = (LEGACY.exec(resolvedField) || [])[1] || null;
    if (minPercent !== undefined || maxPercent !== undefined) {
      const minMag = Math.abs(Number(minPercent) || 0) / 100, maxMag = Math.abs(Number(maxPercent) || 0) / 100;
      const lo = Math.min(minMag, maxMag), hi = Math.max(minMag, maxMag);
      const rangeMin = dir === 'down' ? -hi : lo, rangeMax = dir === 'down' ? -lo : hi;
      if (legacyPeriod) { params.append('ema_proximity_range', legacyPeriod + ':' + rangeMin + ':' + rangeMax); params.append('ema_proximity', legacyPeriod + ':' + (dir === 'down' ? rangeMin : rangeMax)); }
      else params.append('ma_proximity_range', resolvedField + ':' + rangeMin + ':' + rangeMax);
      return;
    }
    const mag = Math.abs(Number(percent) || 0) / 100;
    const pct = dir === 'down' ? -mag : dir === 'up' ? mag : (Number(percent) || 0) / 100;
    if (legacyPeriod) params.append('ema_proximity', legacyPeriod + ':' + pct); else params.append('ma_proximity', resolvedField + ':' + pct);
  });
  [].concat(Array.isArray(a.priceCrossovers) ? a.priceCrossovers : [], Array.isArray(a.smaPriceCrossovers) ? a.smaPriceCrossovers : []).forEach((item) => {
    const field = (item && item.field) || (item && item.ema ? 'daily_ema' + item.ema : null);
    if (!(field && item.dir)) return;
    const legacyPeriod = (LEGACY.exec(field) || [])[1] || null;
    if (legacyPeriod) {
      if (a.priceCrossFrom) params.set('price_cross_from', a.priceCrossFrom);
      if (a.priceCrossTo) params.set('price_cross_to', a.priceCrossTo);
      if (!a.priceCrossFrom && !a.priceCrossTo && a.priceCrossRefDate) params.set('price_cross_ref_date', a.priceCrossRefDate);
      params.append('price_crossovers', legacyPeriod + '-' + item.dir);
    } else {
      if (a.priceCrossFrom) params.set('ma_price_cross_from', a.priceCrossFrom);
      if (a.priceCrossTo) params.set('ma_price_cross_to', a.priceCrossTo);
      if (!a.priceCrossFrom && !a.priceCrossTo && a.priceCrossRefDate) params.set('ma_price_cross_ref_date', a.priceCrossRefDate);
      params.append('ma_price_crossovers', field + '-' + item.dir);
    }
  });
  [].concat(Array.isArray(a.historicalEmaCrossovers) ? a.historicalEmaCrossovers : [], Array.isArray(a.historicalSmaCrossovers) ? a.historicalSmaCrossovers : []).forEach((item) => {
    const left = (item && item.left) || (item && item.short ? 'daily_ema' + item.short : null);
    const right = (item && item.right) || (item && item.long ? 'daily_ema' + item.long : null);
    if (!(left && right && item.dir)) return;
    const l = LEGACY.exec(left), r = LEGACY.exec(right);
    if (l && r) {
      if (a.emaCrossFrom) params.set('ema_cross_from', a.emaCrossFrom);
      if (a.emaCrossTo) params.set('ema_cross_to', a.emaCrossTo);
      if (!a.emaCrossFrom && !a.emaCrossTo && a.historicalEmaDate) params.set('ema_cross_ref_date', a.historicalEmaDate);
      params.append('ema_crossovers', l[1] + '-' + r[1] + '-' + item.dir);
    } else {
      if (a.emaCrossFrom) params.set('ma_cross_from', a.emaCrossFrom);
      if (a.emaCrossTo) params.set('ma_cross_to', a.emaCrossTo);
      if (!a.emaCrossFrom && !a.emaCrossTo && a.historicalEmaDate) params.set('ma_cross_ref_date', a.historicalEmaDate);
      params.append('ma_crossovers', left + '-' + right + '-' + item.dir);
    }
  });
  if (activeFilters.includes('RSI 14')) { if (nn(a.rsiMin)) params.set('rsi_min', String(a.rsiMin)); if (nn(a.rsiMax)) params.set('rsi_max', String(a.rsiMax)); }
  if (activeFilters.includes('RSI') && Array.isArray(a.rsiRangeList)) {
    a.rsiRangeList.forEach((row) => {
      if (!row || !row.timeframe) return;
      const lo = row.min === '' || row.min === undefined || row.min === null ? '' : String(row.min);
      const hi = row.max === '' || row.max === undefined || row.max === null ? '' : String(row.max);
      if (lo === '' && hi === '') return;
      params.append('rsi_range', row.timeframe + ':' + lo + ':' + hi);
    });
  }
  const fi = activeFilters.includes('Fearless Indicator') || activeFilters.includes('Supertrend');
  if (fi && a.supertrendSignal) params.set('supertrend_signal', a.supertrendSignal);
  if (fi && nn(a.supertrendPct) && a.supertrendPct !== '') params.set('supertrend_pct', String(a.supertrendPct));
  if (activeFilters.includes('Pivot') || activeFilters.includes('Fearless Zone')) {
    const hasDistance = nn(a.fearlessZoneWithinPct) && a.fearlessZoneWithinPct !== '' && Number.isFinite(Number(a.fearlessZoneWithinPct));
    if (a.fearlessZoneColor && a.fearlessZoneColor !== 'all') params.set('fearless_zone_color', a.fearlessZoneColor);
    if (hasDistance) params.set('fearless_zone_within_pct', String(Number(a.fearlessZoneWithinPct)));
  }
  if (activeFilters.includes('Price Near High') || activeFilters.includes('Stock Has Fallen')) {
    if (a.fallDays && a.fallPct !== undefined && a.fallPct !== null && a.fallPct !== '') { params.set('fall_days', String(a.fallDays)); params.set('fall_pct', String(Number(a.fallPct))); }
  }
  if (Array.isArray(a.patternFilters) && a.patternFilters.length) params.set('pattern_filters', JSON.stringify(a.patternFilters));
  if (a.cpAuto && a.cpAuto.active) {
    params.set('consol_auto_days', String(a.cpAuto.days || 10));
    const rp = Array.isArray(a.cpAuto.rangePct) ? a.cpAuto.rangePct : [0, 100];
    params.set('consol_auto_min_pct', String(rp[0] === undefined || rp[0] === null ? 0 : rp[0]));
    params.set('consol_auto_max_pct', String(rp[1] === undefined || rp[1] === null ? 100 : rp[1]));
    (a.cpAuto.nearHighs || []).forEach((d) => params.append('near_highs', d + ':' + (a.cpAuto.nearHighPct === undefined || a.cpAuto.nearHighPct === null ? 10 : a.cpAuto.nearHighPct)));
    (a.cpAuto.emas || []).forEach((p) => params.append('consol_emas', p + ':' + (a.cpAuto.emaPct === undefined || a.cpAuto.emaPct === null ? 3 : a.cpAuto.emaPct)));
  }
  if (activeFilters.includes('EMA Alignment') && a.emaAlign && Array.isArray(a.emaAlign.emas) && a.emaAlign.emas.length >= 2) {
    const asc = a.emaAlign.emas.map(Number).sort((x, y) => x - y);
    params.set('ema_align', a.emaAlign.direction === 'bearish' ? asc.slice().reverse().join('>') : a.emaAlign.direction === 'any' ? asc.join(',') : asc.join('>'));
    if (a.emaAlign.spreadOn && Number.isFinite(Number(a.emaAlign.spreadPct))) params.set('ema_align_spread_max', String(Math.max(0, Number(a.emaAlign.spreadPct))));
    if (a.emaAlign.price === 'above' || a.emaAlign.price === 'below') params.set('ema_align_price', a.emaAlign.price);
  }
  if (a.nearHighAdv && a.nearHighAdv.days && nn(a.nearHighAdv.pct)) {
    params.set('nh_days', String(a.nearHighAdv.days)); params.set('nh_pct', String(a.nearHighAdv.pct));
    params.set('nh_side', a.nearHighAdv.side === 'above' ? 'above' : 'below');
    const w = String(a.nearHighAdv.when || 'any');
    if (w.startsWith('within:') || w.startsWith('before:')) { const [d, n] = w.split(':'); params.set('nh_when', d); params.set('nh_when_days', String(parseInt(n, 10) || 30)); }
  }
  if (activeFilters.includes('Your Date, Your Volume') && a.volumeSpike && a.volumeSpike.date) {
    params.set('volume_spike_date', String(a.volumeSpike.date).split('T')[0]);
    if (a.volumeSpike.multiplier) params.set('volume_spike_multiplier', String(a.volumeSpike.multiplier));
    if (a.volumeSpike.days) params.set('volume_spike_days', String(a.volumeSpike.days));
  }
  const fyocEnabled = a.fyocActive || activeFilters.some(n => ['Form Your Own Candle', FYOC_TF_FILTER_NAME.daily, FYOC_TF_FILTER_NAME.weekly, FYOC_TF_FILTER_NAME.monthly].includes(n))
    || (a.fyocDaily && a.fyocDaily.length) || (a.fyocWeekly && a.fyocWeekly.length) || (a.fyocMonthly && a.fyocMonthly.length);
  if (fyocEnabled) {
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    const clamp = (v) => Math.max(0, Math.min(100, v));
    const rangeOrSingle = (item, rangeKey, singleKey) => {
      const r = item && item[rangeKey];
      if (Array.isArray(r) && r.length === 2 && isNum(r[0]) && isNum(r[1])) { const lo = clamp(r[0]), hi = clamp(r[1]); return Math.min(lo, hi) + '-' + Math.max(lo, hi); }
      const s = item && item[singleKey]; return isNum(s) ? String(s) : '';
    };
    const pushGroup = (tf, item) => {
      if (!item) return;
      const rawFrom = String(item.dateFrom || item.date || ''), rawTo = String(item.dateTo || item.dateFrom || item.date || '');
      const from = rawFrom ? rawFrom.split('T')[0] : '', to = rawTo ? rawTo.split('T')[0] : '';
      if (!from) return;
      const label = item.label === 'green' || item.label === 'red' ? item.label : '';
      let cmin = 0, cmax = 100;
      if (Array.isArray(item.consol) && item.consol.length === 2 && isNum(item.consol[0]) && isNum(item.consol[1])) { cmin = clamp(item.consol[0]); cmax = clamp(item.consol[1]); if (cmin > cmax) { const t = cmin; cmin = cmax; cmax = t; } }
      // EIGHT SEGMENTS, ALWAYS (re-measured 2026-09-09). The 8th is the candle
      // RELATIONSHIP layer; the site now emits it unconditionally, so a group
      // with no relationships ends in a bare trailing '|' - proven by the
      // 'All FIlters screener' capture, whose cb_groups gained exactly that.
      const rels = Array.isArray(item.rels) && item.rels.length ? item.rels.join(',') : '';
      const group = tf + '|' + from + '..' + (to || from) + '|' + label + '|' + rangeOrSingle(item, 'bodyRange', 'body') + '|' + rangeOrSingle(item, 'upperRange', 'upper') + '|' + rangeOrSingle(item, 'lowerRange', 'lower') + '|' + cmin + '-' + cmax + '|' + rels;
      params.append('cb_groups', group);
    };
    (a.fyocDaily || []).slice(0, 7).forEach((it) => pushGroup('daily', it));
    (a.fyocWeekly || []).slice(0, 7).forEach((it) => pushGroup('weekly', it));
    (a.fyocMonthly || []).slice(0, 7).forEach((it) => pushGroup('monthly', it));
  }
  if (a.cpActive && Array.isArray(a.cpFilters) && a.cpFilters.length > 0) {
    if (a.cpFilters.length === 1) {
      const f = a.cpFilters[0] || {};
      if (f.timeframe) params.set('cp_timeframe', String(f.timeframe));
      if (f.ref_from) params.set('cp_ref_from', String(f.ref_from));
      if (f.ref_to) params.set('cp_ref_to', String(f.ref_to));
      if (nn(f.points_min)) params.set('cp_points_min', String(f.points_min));
      if (nn(f.points_max)) params.set('cp_points_max', String(f.points_max));
      if (f.status) params.set('cp_status', String(f.status));
      if (f.ref_label) params.set('ref_label', String(f.ref_label));
      if (nn(f.ref_body_min)) params.set('ref_body_min', String(f.ref_body_min));
      if (nn(f.ref_body_max)) params.set('ref_body_max', String(f.ref_body_max));
      if (nn(f.ref_size_min)) params.set('ref_size_min', String(f.ref_size_min));
      if (nn(f.ref_size_max)) params.set('ref_size_max', String(f.ref_size_max));
    } else { params.set('cp_active', '1'); params.set('cp_filters', JSON.stringify(a.cpFilters)); }
  }
  if (a.shareholdingActive || (Array.isArray(a.shFilters) && a.shFilters.length > 0)) { try { params.set('sh_filters', JSON.stringify(a.shFilters || [])); } catch (e) { /* fail-safe like the site */ } }
  return params;
}

// ---- the one call server.js makes -------------------------------------------
// savedFilters: the saved filter's `filters` object, rolling dates ALREADY resolved.
// opts: { limit, offset, defaults } - see buildFetchArgsFromFilters for `defaults`.
function buildSavedFilterQuery(savedFilters, opts) {
  const args = buildFetchArgsFromFilters(savedFilters, opts && opts.defaults);
  if (opts && opts.limit !== undefined) args.limit = opts.limit;
  if (opts && opts.offset !== undefined) args.offset = opts.offset;
  return fetchStocksParams(args);
}

module.exports = {
  buildSavedFilterQuery, buildFetchArgsFromFilters, fetchStocksParams, normalizeActiveFilterNames,
  LEGACY_FILTER_NAME_MAP, HANDLED_FILTER_NAMES, DEMAND_FILTER_CONFIG, INITIAL_FILTERS,
};
