'use strict';
// rollingdates.js — resolve rolling-date descriptors in Stockkar saved filters.
//
// Stockkar saved filters no longer store absolute dates. A "last 7 days" screener
// froze forever, so dates are persisted as a RELATIVE descriptor
//   { rolling: true, back: N }   // N trading periods before the LATEST date
// and re-resolved against the current calendar every time the filter is read.
//
// We consume the raw saved-filter JSON, so we must resolve these ourselves —
// otherwise a descriptor reaches URLSearchParams, stringifies to the literal
// "[object Object]", and the screener silently returns ZERO stocks. That is
// exactly what broke every re-saved dated screener ("Copy of Turnaround", 7/14).
//
// Semantics mirror the website's resolver EXACTLY (its utils/rollingDates.js):
//  - the calendar is sorted ASCENDING, then idx = max(0, len - 1 - back)
//    (so the newest-first order the API returns is fine — we sort, not trust)
//  - the calendar is chosen per timeframe, inferred from the KEY NAME on the way
//    down (…week… -> weekly, …month… -> monthly, …daily… -> daily, else inherit
//    from the parent). Generic by design: a newly-added dated filter rolls
//    automatically — a per-field whitelist is what silently froze dates before.
//  - a legacy absolute date STRING passes through untouched
//  - an unresolvable descriptor (empty calendar) becomes "" — same as the site,
//    which makes the mapper DROP that filter rather than send garbage.

function isRollingDesc(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && v.rolling === true && Number.isInteger(v.back);
}

function timeframeFromKey(key) {
  if (typeof key !== 'string') return null;
  const k = key.toLowerCase();
  if (k.includes('week')) return 'weekly';
  if (k.includes('month')) return 'monthly';
  if (k.includes('daily')) return 'daily';
  return null; // inherit parent
}

function calendarFor(tf, calendars) {
  if (tf === 'weekly') return calendars.weekly || [];
  if (tf === 'monthly') return calendars.monthly || [];
  return calendars.daily || [];
}

// Descriptor -> concrete "YYYY-MM-DD" against the CURRENT calendar.
function rollingToDate(desc, dates) {
  if (!isRollingDesc(desc)) return desc;            // legacy absolute string / plain value
  if (!Array.isArray(dates) || !dates.length) return null;
  const sorted = dates.map(d => (typeof d === 'string' ? d.split('T')[0] : d)).sort();
  const idx = Math.max(0, sorted.length - 1 - desc.back);
  return sorted[idx];
}

// Walk the whole filter blob, resolving every descriptor found at any depth.
function resolveRollingFilterDates(filters, calendars) {
  if (!filters || typeof filters !== 'object') return filters;
  const cal = {
    daily: (calendars && calendars.daily) || [],
    weekly: (calendars && calendars.weekly) || [],
    monthly: (calendars && calendars.monthly) || [],
  };
  const walk = (value, tf) => {
    if (Array.isArray(value)) return value.map(v => walk(v, tf));
    if (value && typeof value === 'object') {
      if (isRollingDesc(value)) return rollingToDate(value, calendarFor(tf, cal)) || '';
      const out = {};
      Object.keys(value).forEach(k => { out[k] = walk(value[k], timeframeFromKey(k) || tf); });
      return out;
    }
    return value;
  };
  return walk(filters, 'daily');
}

// Cheap pre-check: only pay for the calendar fetches when a descriptor exists
// (legacy absolute-date filters need no resolution at all).
function hasRollingDates(filters) {
  try { return JSON.stringify(filters || {}).includes('"rolling":true'); } catch { return false; }
}

module.exports = { isRollingDesc, rollingToDate, resolveRollingFilterDates, hasRollingDates, timeframeFromKey };
