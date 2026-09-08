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
