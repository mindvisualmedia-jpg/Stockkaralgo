'use strict';
// rollingdates.test.js — the saved-filter rolling-date resolver.
//
// Stockkar saved filters persist dates as { rolling: true, back: N } and the
// website re-resolves them on load. We read the raw saved JSON, so we must
// resolve them the SAME way — a descriptor that reaches URLSearchParams
// stringifies to "[object Object]" and the screener returns zero stocks (this
// is what broke every re-saved dated screener). These lock the semantics to the
// website's resolver (utils/rollingDates.js): calendar sorted ASC, then
// idx = max(0, len - 1 - back).
const { test } = require('node:test');
const assert = require('node:assert');
const { isRollingDesc, rollingToDate, resolveRollingFilterDates } = require('./rollingdates');

// Newest-first, exactly as /api/global-filter/valid-trading-dates returns it —
// the resolver must sort internally, not trust the order.
const DAILY = ['2026-07-14', '2026-07-13', '2026-07-10', '2026-07-09', '2026-07-08', '2026-07-07', '2026-07-06'];
const WEEKLY = ['2026-07-13', '2026-07-06', '2026-06-29'];
const MONTHLY = ['2026-07-01', '2026-06-01', '2026-05-01'];
const CALS = { daily: DAILY, weekly: WEEKLY, monthly: MONTHLY };

test('isRollingDesc: only {rolling:true, back:<int>} counts', () => {
  assert.equal(isRollingDesc({ rolling: true, back: 0 }), true);
  assert.equal(isRollingDesc({ rolling: true, back: 6 }), true);
  assert.equal(isRollingDesc({ rolling: true }), false);          // no back
  assert.equal(isRollingDesc({ rolling: true, back: 1.5 }), false); // not an int
  assert.equal(isRollingDesc('2026-07-10'), false);               // legacy string
  assert.equal(isRollingDesc(null), false);
  assert.equal(isRollingDesc([{ rolling: true, back: 1 }]), false); // array, not a desc
});

test('rollingToDate: back:0 = latest; back:N walks back N trading periods (DESC input)', () => {
  assert.equal(rollingToDate({ rolling: true, back: 0 }, DAILY), '2026-07-14');
  assert.equal(rollingToDate({ rolling: true, back: 1 }, DAILY), '2026-07-13');
  assert.equal(rollingToDate({ rolling: true, back: 2 }, DAILY), '2026-07-10'); // skips the weekend
  assert.equal(rollingToDate({ rolling: true, back: 6 }, DAILY), '2026-07-06');
});

test('rollingToDate: back beyond the calendar clamps to the earliest date', () => {
  assert.equal(rollingToDate({ rolling: true, back: 999 }, DAILY), '2026-07-06');
});

test('rollingToDate: legacy absolute string passes through; empty calendar -> null', () => {
  assert.equal(rollingToDate('2026-05-12', DAILY), '2026-05-12');
  assert.equal(rollingToDate({ rolling: true, back: 1 }, []), null);
});

test('the real bug: a Turnaround demand window resolves to real dates, never [object Object]', () => {
  // Shape of a re-saved "Turnaround" filter: the dates are descriptors.
  const saved = {
    activeFilters: ['Big Player Score', 'Golden Valuation'],
    demandStartDate: { rolling: true, back: 6 },
    demandEndDate: { rolling: true, back: 0 },
    bigPlayerScoreStart: [30, 60],
    bigPlayerScoreEnd: [60, 100],
  };
  const out = resolveRollingFilterDates(saved, CALS);
  assert.equal(out.demandStartDate, '2026-07-06');
  assert.equal(out.demandEndDate, '2026-07-14');
  // The failure mode we are preventing:
  assert.notEqual(String(out.demandStartDate), '[object Object]');
  // Non-date fields must survive untouched.
  assert.deepEqual(out.bigPlayerScoreStart, [30, 60]);
  assert.deepEqual(out.activeFilters, ['Big Player Score', 'Golden Valuation']);
});

test('calendar is chosen per timeframe, inferred from the key name', () => {
  const saved = {
    fyocDaily: [{ date: { rolling: true, back: 1 } }],
    fyocWeekly: [{ date: { rolling: true, back: 1 } }],
    fyocMonthly: [{ date: { rolling: true, back: 1 } }],
  };
  const out = resolveRollingFilterDates(saved, CALS);
  assert.equal(out.fyocDaily[0].date, '2026-07-13');   // daily calendar
  assert.equal(out.fyocWeekly[0].date, '2026-07-06');  // weekly calendar
  assert.equal(out.fyocMonthly[0].date, '2026-06-01'); // monthly calendar
});

test('timeframe is INHERITED down the tree from the key that named it', () => {
  // dateFrom/dateTo carry no timeframe hint — they must inherit "weekly".
  const saved = { fyocWeekly: [{ dateFrom: { rolling: true, back: 2 }, dateTo: { rolling: true, back: 0 } }] };
  const out = resolveRollingFilterDates(saved, CALS);
  assert.equal(out.fyocWeekly[0].dateFrom, '2026-06-29');
  assert.equal(out.fyocWeekly[0].dateTo, '2026-07-13');
});

test('unresolvable descriptor (missing calendar) -> "" so the mapper DROPS the filter', () => {
  // Same as the website: better to omit the filter than to send garbage.
  const out = resolveRollingFilterDates({ fyocWeekly: [{ date: { rolling: true, back: 1 } }] }, { daily: DAILY });
  assert.equal(out.fyocWeekly[0].date, '');
});

test('legacy absolute-date filters are returned byte-identical', () => {
  const saved = { demandStartDate: '2026-05-04', demandEndDate: '2026-05-12', marketCapRange: [401, 1726754] };
  assert.deepEqual(resolveRollingFilterDates(saved, CALS), saved);
});

test('non-object input is passed through unchanged', () => {
  assert.equal(resolveRollingFilterDates(null, CALS), null);
  assert.equal(resolveRollingFilterDates('x', CALS), 'x');
});
