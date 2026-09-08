# Saved-screener parity with stockkar.in

**Goal:** a saved Stocklab screener gives Stockkar Algo exactly the stocks the website shows.
**Status (2026-09-08):** 71 of the owner's 71 saved screeners produce a byte-identical query.

## How it works

stockkar.in has **no** "stocks for saved filter X" endpoint. Its page downloads the saved
config (`GET /api/saved-filter/slug/<id>`) and its **frontend** translates that into
`GET /api/global-filter/stocks?...` in two layers:

| Site layer | File on the site (read-only for us) | Our port |
|---|---|---|
| config → fetch args | `stockkar-app/app/(main)/stocklab/global-filter/page.jsx` `buildFetchArgsFromFilters` + the state path | `savedfilter-query.js` `buildFetchArgsFromFilters` |
| fetch args → query params | `stockkar-app/app/components/Services/FetchStocks.js` | `savedfilter-query.js` `fetchStocksParams` |

`server.js` `/saved-filter-stocks` feeds the port the same three inputs the page uses:

1. the saved config, with rolling-date descriptors resolved against the live calendars
   (`rollingdates.js`, same rule and same calendars as the site);
2. the page's **live defaults** — `/api/global-filter/filters/ranges` and the *last* entry of
   `/api/global-filter/available-quarters` — used for any field a legacy config lacks and
   **always** for Quarterly EPS Growth (production ignores the saved quarter/range);
3. `limit`/`offset`.

Where the checked-out `dev` source of the site differs from **production**, production wins
(the captured queries are the truth): no Draw-a-Pattern, no advanced near-high `nh_*`,
score `_start` ranges always sent in historical mode, FYoC groups carry seven segments.

## The safety net (Algo side)

* **Unknown-filter guard** (`savedfilter.js`): a screener whose `activeFilters` contains a
  name the port does not handle is **refused** — wizard error + Telegram naming the filter —
  never silently dropped into a wider universe.
* **Refresh alerts**: a failed/empty daily basket refresh reaches Telegram once per screener
  per day, saying the basket was NOT updated.
* **Parity test** (`savedfilter.parity.test.js`): every fixture in `test/fixtures/savedfilters/`
  (config + the verbatim query the site sent + that day's live defaults) must match the port.

## When the site changes or adds a filter — the 10-minute routine

1. **Add or change the filter on the site** as usual.
2. **Capture the truth** for one saved screener that uses it. In Chrome, logged in:
   DevTools → Network → open `stocklab/global-filter?saved=<slug>` → copy the
   `/api/global-filter/stocks?...` request URL. Also copy the config
   (`GET https://apii.stockkar.in/api/saved-filter/slug/<slug>` in the address bar).
3. **Drop them in**: `test/fixtures/savedfilters/<slug>.json` (`{slug, name, filters}`) and the
   query string under `queries` in `_site-queries.json`. If the ranges/quarters moved, refresh
   `_site-defaults.json` from `/filters/ranges` and `/available-quarters`.
4. `node --test savedfilter.parity.test.js` — it names the exact parameter that differs.
5. Port the change into `savedfilter-query.js` mirroring the site's code (both layers), and add
   the filter's name to `HANDLED_FILTER_NAMES`. Re-run until green. Until that lands, boxes
   refuse screeners using the new filter (guard) instead of trading a wrong basket.

Or ask Claude: "the site added filter X — re-capture and port it"; the capture can be driven
through Chrome in minutes for all screeners at once.

## The durable fix (site side, not done — owner's call)

`GET /api/saved-filter/slug/<id>/stocks` on stockkar.in, resolved by the site's own translator
and returning the same `{count, data}` shape as `/global-filter/stocks`. The Algo already tries
that exact path **first** (`fetchSavedFilterDirect`), so the day it exists every box switches
with no Algo release and the port becomes a fallback. Until then the port + this routine keep
parity, measured rather than assumed.

## Re-check 2026-09-09 — the site shipped its dev branch, parity restored

Stocklab was redesigned (9 groups, **46 filters**, "Create with AI", and a new
**Form Your Own Chart** group = draw-a-pattern). Several places where production had
disagreed with the checked-out `dev` source on 2026-09-08 have now caught up, so the
"production wins" calls made that day were inverted. Measured, then ported:

| Change | Evidence |
|---|---|
| Advanced near-high replaces the legacy path | `52 week high`: `fall_days/fall_pct` → `nh_days/nh_pct/nh_side/nh_when/nh_when_days`. **Real selection difference** — the legacy path ignores side and "when". |
| Demand **start** range is now opt-in | five screeners whose start was `[0,100]` lost `*_start_min/max`; three with a set start kept it |
| Draw-a-pattern is live | `pattern_filters` + forced `sort_by=pattern_similarity`, armed by **either** `Form Your Own Chart - <TF>` or the old `Form Your Own Candle - <TF>` |
| `cb_groups` always has 8 segments | the 8th (candle relationships) is emitted even when empty → a bare trailing `\|` |
| Live default ranges move intraday | `market_cap` went `400.36–1772088.95` → `401.23–1751519.49` inside one session. **Re-capture `_site-defaults.json` in the SAME session as the queries.** |

### Open site bug (not mirrored) — rolling demand windows

For a screener whose demand window is a rolling descriptor (`{rolling:true, back:N}`),
one page load now fires **two contradictory queries**: the results table uses *latest*
score mode with no dates, while the count probe uses *historical* with `start` and `end`
**collapsed to the same day** (`2026-09-08..2026-09-08`) despite the saved 6-day window.
Reproducible across reloads on `6439f387c9c9` and `2bf0495079eb`; both calendars
(`/api/demand/available-dates`, `/valid-trading-dates`) are healthy with 30 dates, so the
resolver is being handed a near-empty calendar, not a missing one.

Those two are listed in `_site-queries.json` `.excluded` and the parity test **skips them by
name with the reason** — parity against a self-inconsistent target proves nothing. Stockkar
Algo keeps resolving rolling dates properly (`rollingdates.js`), which is closer to the
saved intent than what the site currently sends. Re-include them once the site settles.

### Coverage

Of the 46 live filters, 44 are exercised by the corpus. Two gaps were closed by creating
throwaway screeners (`ZZ TEST - EMA Alignment`, `ZZ TEST - FYoChart Daily`); their configs
are still to be folded in — see `_site-queries.json` `.pending`.
