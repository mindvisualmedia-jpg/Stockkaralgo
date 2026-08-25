'use strict';
// Entry-filter band decisions — pure, so they can be unit-tested without a
// broker or a market feed. server.js (buildAlgoCandidates) reads the numbers
// off the market data / screener row and hands them here.
//
// Two shapes:
//   VALUE BAND  — the indicator's own reading must sit inside [min, max].
//                 Used by the Stockkar scores and by RSI 14.
//   PRICE BAND  — the LTP's distance ABOVE the indicator must sit inside
//                 [minPct, withinPct]. "within 5%" is simply 0-5%, which is why
//                 minPct defaults to 0: a filter saved before ranges existed
//                 keeps behaving exactly as it did.

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// A READING, not a setting. null / undefined / '' are MISSING DATA — never 0.
// Number(null) and Number('') are both 0, so a blank RSI or score column would
// otherwise read as a genuine reading of zero and sail through a 0-40 band.
function reading(v) {
  if (v === null || v === undefined) return NaN;
  if (typeof v === 'string' && v.trim() === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// Normalise a [min, max] pair: clamped to the scale and never reversed (a
// reversed pair would silently match nothing).
function normalizeBand(min, max, scaleMax) {
  const hiLimit = num(scaleMax, 100);
  const a = clamp(num(min, 0), 0, hiLimit);
  const b = clamp(num(max, hiLimit), 0, hiLimit);
  return { low: Math.min(a, b), high: Math.max(a, b) };
}

// MARKET CAP (2026-08-24): read a market-cap value off a screener row, in
// Rs. CRORES. Stockkar screener rows carry LAKHS (the dashboard's own saved-
// stocks table divides by 100 to print Cr) and are recognised by their
// fincode / score columns — a deterministic source tell, never a magnitude
// guess. Any other source (sheet CSV, watchlist) is taken as crores as-is.
// Commas / currency noise in sheet cells are stripped. NaN = no usable column,
// and evaluateValueBand already treats NaN as "never passes".
const MCAP_FIELDS = ['market_cap', 'marketcap', 'market cap', 'mcap', 'market_capitalisation', 'market_capitalization', 'market cap (cr)', 'market_cap_cr', 'mcap_cr', 'market cap cr'];
function marketCapCrores(row) {
  if (!row || typeof row !== 'object') return NaN;
  const keys = Object.keys(row);
  const hit = keys.find(k => MCAP_FIELDS.includes(String(k).toLowerCase().trim()));
  if (!hit) return NaN;
  const raw = reading(String(row[hit]).replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(raw) || raw <= 0) return NaN;
  const stockkarRow = keys.some(k => ['fincode', 'stock_fincode', 'big_player_score', 'growth_score'].includes(String(k).toLowerCase()));
  return stockkarRow ? Math.round(raw) / 100 : raw;
}

// VALUE BAND: is the reading inside [min, max]?
// A missing reading NEVER passes — no data must not look like a match.
// scaleMax widens the band's scale beyond the default 0-100 (market cap bands
// are in crores); existing callers pass nothing and keep the 100 clamp.
function evaluateValueBand(opts) {
  const o = opts || {};
  const value = reading(o.value);
  const { low, high } = normalizeBand(o.min, o.max, o.scaleMax);
  const has = Number.isFinite(value);
  const pass = has && value >= low && value <= high;
  const shown = has ? Math.round(value * 100) / 100 : 'missing';
  return {
    pass,
    value: has ? value : NaN,
    low,
    high,
    text: String(o.label || 'Indicator') + ' ' + shown + ' in ' + low + '-' + high,
  };
}

// PRICE BAND: is the LTP between minPct and withinPct ABOVE the indicator?
// `distancePct` may be supplied directly (the Fearless Indicator ships its own
// percentage); otherwise it is derived from ltp vs the indicator value.
function evaluatePriceBand(opts) {
  const o = opts || {};
  const withinPct = num(o.withinPct, 0);
  // The floor can never exceed the ceiling, so a mis-typed pair degrades to the
  // plain "within X%" rule instead of matching nothing.
  const minPct = clamp(num(o.minPct, 0), 0, withinPct);
  const value = reading(o.value);
  const ltp = reading(o.ltp);
  const supplied = reading(o.distancePct);
  const distancePct = Number.isFinite(supplied)
    ? supplied
    : (Number.isFinite(value) && value && Number.isFinite(ltp) ? ((ltp - value) / value) * 100 : NaN);
  const bullish = o.bullish === undefined ? true : !!o.bullish;
  const has = Number.isFinite(distancePct);
  const pass = bullish && has && distancePct >= minPct && distancePct <= withinPct;
  const distanceText = has ? (distancePct >= 0 ? '+' : '') + distancePct.toFixed(2) : 'missing';
  return {
    pass,
    distancePct: has ? distancePct : NaN,
    minPct,
    withinPct,
    text: String(o.label || 'Indicator') + (o.signalText || '') + ' ' + distanceText
      + '% in ' + minPct + '-' + withinPct + '%',
  };
}

module.exports = { evaluateValueBand, evaluatePriceBand, normalizeBand, marketCapCrores };
