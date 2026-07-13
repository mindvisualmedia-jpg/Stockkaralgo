# Stockkar API — Built‑in Screeners, Saved Screeners & Watchlists

How Stockkaralgo consumes the Stockkar backend for stock baskets. Endpoints and
shapes verified against the live consumer (`server.js`) and the API source
(`Stockkar 4.O/stockkar-api/app/routes/*`). Updated 2026-07-09.

---

## 0. Connection basics

| | |
|---|---|
| **Base host** | `https://apii.stockkar.in` (double‑i) — constant `STOCKKAR_HOST` in `server.js:15` |
| **Fallback hosts** | `stockkar.in`, `www.stockkar.in` (tried in order if the API host misses) |
| **Prefix** | Most routers are mounted under `/api` |
| **Transport** | HTTPS :443, JSON |
| **Timeout** | 15 s client‑side (fail fast before nginx's ~60 s 504) |

### Auth headers (every request) — `stockkarHostGet`, `server.js:2472`
```
Authorization: Bearer <JWT>
Cookie: <session cookies>            (optional, sent if stored)
Origin:  https://www.stockkar.in
Referer: https://www.stockkar.in/profile/watchlist
Accept:  application/json, text/plain, */*
Content-Type: application/json
User-Agent: ...StockkarAlgo/1.0
```
The JWT is the logged‑in Stockkar user token (`getStoredToken()`); it identifies
the user for `/saved-filter/*` and `/watchlist/*`, which are per‑user. Built‑in
screeners are public data but are still called with the token.

**Resilience pattern:** every surface is fetched by trying a list of candidate
paths/hosts and pinning the first `2xx` (`stockkarTryGet`, `server.js:4676`).
That's why several path variants appear below — the first that works wins.

---

## 1. Built‑in screeners

Curated, server‑computed screeners. The list Stockkaralgo shows comes from its
own constant, not the API (`BUILTIN_SCREENERS`, `server.js:310`; also served at
`GET /screeners-list` locally):

| Name | slug |
|---|---|
| Stock Attitude | `stock-attitude` |
| Retail Trap | `retail-trap` |
| Volume Dead | `volume-dead` |
| Giant Ride | `giant-ride-system` (alias `giant-ride`) |

### 1a. Get today's matches — `fetchCurrentScreener` (`server.js:4324`)
Tries, in order, and pins the first that returns rows:
```
GET /api/screeners/{slug}/stocks
GET /api/screeners/{slug}/latest
GET /api/screeners/{slug}/results
GET /api/screeners/{slug}
```
Slug aliases are expanded via `SCREENER_SLUG_ALIASES` (`server.js:317`), e.g.
`giant-ride-system` also tries `giant-ride`.

### 1b. Fallback — latest backtest day — `fetchLatestScreenerBacktest` (`server.js:4271`)
If none of the above return rows, fall back to the most recent backtest slice:
```
GET /api/screeners/{slug}/backtest/range?start_date={d}&end_date={d}&limit={n}&offset={o}
```

### 1c. Raw "free" screener endpoints (API source of truth)
The API mounts each screener under `/api/screeners/...` (`routes/screeners/routes.py`).
All are `GET`, paginated with `limit` (1–500, default 100) & `offset` (default 0),
and return `{ "count": <int>, "data": [ <row>… ] }`:

| Screener | Endpoint(s) |
|---|---|
| EMA Golden Cross | `/api/screeners/free/ema/golden-cross?sort_by=&sort_order=` |
| Price over EMA | `/api/screeners/free/ema/price-over/{20\|50\|100\|200}` |
| Candlestick | `/api/screeners/free/candlestick/{bullish-engulfing\|hammer\|marubozu\|doji}` |
| Contraction | `/api/screeners/free/contraction/{nr7\|last15}` |
| Near resistance | `/api/screeners/free/near-resistance/{52w\|26w\|30d\|7d}` |
| Shakeout | `/api/screeners/free/shakeout/{ema50\|ema200}` |
| Diwali | `/api/screeners/free/diwali/{swing\|positional}` |
| Retail Trap | `/api/screeners/retail-trap` (+ `/backtest/dates\|counts\|signals\|range`) |
| Giant Ride | `/api/screeners/giant-ride` (+ `/backtest/dates\|range`) |
| Stock Attitude | `/api/screeners/stock-attitude` (+ `/dates`, `/backtest/dates\|range`) |
| Volume Dead | `/api/screeners/volume-dead` (+ `/backtest/dates\|range`) |

**Row shape** (EMA example, `ema_screeners.py`):
```json
{
  "fincode": 100325, "company_name": "…", "symbol": "RELIANCE",
  "stock_exchange": "nse", "close_price": 1234.5,
  "ema20": …, "ema50": …, "ema100": …, "ema200": …,
  "last_signal_date": "2026-07-08",
  "big_player_score": …, "momentum_score": …, "growth_score": …,
  "market_cap": …, "sector": "…", "industry": "…",
  "returns_efficiency": …, "long_term": …, "short_term": …,
  "pct_from_ema20": …, "pct_from_ema50": …, "pct_from_ema100": …, "pct_from_ema200": …
}
```
`symbol` is the trading symbol Stockkaralgo feeds to the broker; `fincode` is
Stockkar's internal instrument id (used by watchlists/saved filters).

---

## 2. Saved screeners (a.k.a. Saved / Custom filters)

Per‑user saved filter definitions. API router prefix `/api/saved-filter`
(`routes/user/saved_filter.py`). All require the user JWT.

### 2a. List saved filters — used by Stockkaralgo `/saved-filters` (`server.js:9401`)
```
GET /api/saved-filter/saved
```
Response — array:
```json
[{
  "id": 42, "name": "My Breakouts",
  "subtitle": "Describe your screener in a sentence",
  "type": "Custom Filter",
  "filters": { … filter definition (object) … },
  "created_at": "2026-07-08T12:30:00+05:30",
  "slug": "a1b2c3d4e5f6"
}]
```

### 2b. Get a filter's matching stocks — `fetchSavedFilterStocks` (`server.js:4464`)
Tries, in order (id = slug or numeric id):
```
GET /api/saved-filter/slug/{id}/stocks?include_technicals=true
GET /api/saved-filter/{id}/stocks?include_technicals=true
GET /api/saved-filter/stocks/{id}?include_technicals=true
GET /api/saved-filter/saved/{id}/stocks?include_technicals=true
GET /api/custom-filter/{id}/stocks?include_technicals=true      (+ slug/ , stocks/ variants)
```

### 2c. Get a filter's definition (metadata) — fallback when /stocks misses (`server.js:4486`)
```
GET /api/saved-filter/slug/{id}
GET /api/saved-filter/{id}
GET /api/custom-filter/slug/{id}
GET /api/custom-filter/{id}
```
Returns `{ id, name, subtitle, type, filters, created_at, slug, user_id }`.
If only the definition resolves, Stockkaralgo runs the `filters` itself (TV
scanner / local resolver, `/saved-filter-stocks`, `server.js:9434`).

### 2d. Mutations (API source — not currently called by Stockkaralgo)
| Action | Endpoint | Body |
|---|---|---|
| Create | `POST /api/saved-filter/save` | `{ name, subtitle?, type?, filters }` → `{ slug }` |
| Update | `PUT /api/saved-filter/update/{filter_id}` | `{ name, subtitle?, type?, filters }` |
| Delete | `DELETE /api/saved-filter/delete/{filter_id}` | — |
| Get by slug (pro) | `GET /api/saved-filter/slug/{slug}` | pro‑only; owner must be pro |
| Duplicate (pro) | `POST /api/saved-filter/duplicate/{slug}` | → new `{ slug }` |

---

## 3. Watchlists

Per‑user watchlists with stocks. API router prefix `/api/watchlist`
(`routes/user/watchlist.py`). All require the user JWT.

### 3a. List watchlists **with** stocks — `fetchWatchlists` (`server.js:4689`)
Primary call, with host/path fallbacks:
```
GET /api/watchlist/my-with-stocks
GET /api/watchlists/my-with-stocks      (variant)
GET /watchlist/my-with-stocks           (no /api prefix)
GET /watchlists/my-with-stocks          (variant)
```
Response (server‑side cached ~1 h, invalidated on any mutation):
```json
{ "watchlists": [{
  "id": "uuid", "name": "Swing", "created_at": "2026-07-08T…",
  "stocks": [{
    "stock_fincode": "100325", "symbol": "RELIANCE", "company_name": "…",
    "added_at": "…", "note": "…",
    "live_price": 1234.5, "percent_change_from_add_date": 3.2,
    "big_player_score": …, "growth_score": …, "momentum_score": …,
    "market_cap": …, "industry": "…", "returns_efficiency": …,
    "long_term": …, "short_term": …,
    "pct_from_ema20": …, "pct_from_ema50": …, "pct_from_ema100": …, "pct_from_ema200": …
  }]
}]}
```
Stockkaralgo selects one watchlist by `id` / `slug` / `name`, then maps
`stocks[]` via `normalizeWatchlistStockRow` (`server.js:4561`, ~4705).

### 3b. List watchlists **without** stocks (API source)
```
GET /api/watchlist/my   →  { "watchlists": [{ id, name, created_at }] }
```

### 3c. Mutations (API source — not currently called by Stockkaralgo)
| Action | Endpoint | Body |
|---|---|---|
| Create | `POST /api/watchlist/create` | `{ name }` → `{ watchlist_id }` |
| Rename | `PUT /api/watchlist/update` | `{ watchlist_id, new_name }` |
| Delete | `DELETE /api/watchlist/delete` | `{ watchlist_id }` (cascades stocks) |
| Add stock | `POST /api/watchlist/add-stock` | `{ watchlist_id, fincode, note? }` (upsert) |
| Update note | `PUT`/`POST /api/watchlist/update-note` (or `POST /set-note`) | `{ watchlist_id, fincode, note }` |
| Remove stock | `DELETE /api/watchlist/remove-stock` | `{ watchlist_id, fincode }` |

`fincode` (string) is the instrument key across watchlists & filters — the same
`fincode` returned by screener rows.

---

## 4. Errors & gotchas

- **`include_technicals=true`** on saved‑filter/stocks pulls EMA/score columns;
  omit for a lighter payload.
- **404 vs empty**: a `404` from one path is not "no data" — the resolver keeps
  trying variants. Only after **all** candidates miss is it treated as empty.
- **HTML instead of JSON**: an unauthenticated/expired token can return the
  Stockkar web page HTML; the consumer detects a string body and falls back to
  `extractWatchlistsFromHtml` (`server.js:4700`). Treat a non‑JSON body as an
  auth failure — refresh the token.
- **Pagination cap**: free screeners cap `limit` at 500; Stockkaralgo further
  clamps to `STOCKKAR_MAX_LIMIT`.
- **Pro‑gated**: `saved-filter/slug/{slug}` and `duplicate` require the caller
  (and filter owner) to be a `pro` user → `403` otherwise.
