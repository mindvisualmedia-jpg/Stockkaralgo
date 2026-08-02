'use strict';

// Google Sheet as a screener source.
//
// A connected sheet's TABS become screeners: each tab is a symbol list the algo
// pipeline consumes exactly like a built-in screener (it produces the same
// `screenerStocks` shape). Nothing here touches the engine, brokers, or any
// open position - it only turns a sheet into rows of symbols.
//
// No API key, no OAuth, zero dependencies (node:https only). The user shares the
// sheet "anyone with the link can view", or publishes it to web. We read tabs
// and their cells over Google's public gviz / export endpoints.
//
// IMPORTANT: Google's private HTML formats change. listTabs() therefore tries
// several strategies and, on failure, returns a raw diagnostic sample so the
// exact format can be confirmed against a REAL sheet instead of guessed.

const https = require('https');

// ---- fetch (follow redirects; Google bounces a lot) ------------------------
function httpsGetFollow(url, opts, cb, depth) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  depth = depth || 0;
  if (depth > 6) return cb(new Error('too many redirects'));
  let req;
  try {
    req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 Stockkar', 'Accept': '*/*', ...(opts.headers || {}) } }, res => {
      const loc = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
        res.resume();
        const next = /^https?:\/\//.test(loc) ? loc : new URL(loc, url).toString();
        return httpsGetFollow(next, opts, cb, depth + 1);
      }
      let data = '';
      res.on('data', c => { data += c; if (data.length > (opts.maxBytes || 8e6)) req.destroy(); });
      res.on('end', () => cb(null, { status: res.statusCode, body: data, url, contentType: String(res.headers['content-type'] || '') }));
    });
  } catch (e) { return cb(e); }
  req.on('error', e => cb(e));
  req.setTimeout(opts.timeout || 15000, () => req.destroy(new Error('sheet fetch timed out')));
}

// ---- URL / id --------------------------------------------------------------
function parseSheetId(url) {
  const s = String(url || '').trim();
  let m = s.match(/\/spreadsheets\/d\/(?:e\/)?([a-zA-Z0-9-_]{20,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9-_]{20,}$/.test(s)) return s;   // a bare id
  return null;
}
function gidFromUrl(url) {
  const m = String(url || '').match(/[#&?]gid=(\d+)/);
  return m ? m[1] : null;
}

// ---- symbol cleaning (shared shape with the built-in screener) -------------
// One cell -> a bare NSE symbol, or null if it clearly isn't one.
function cleanSymbol(raw) {
  let s = String(raw == null ? '' : raw).trim().toUpperCase();
  if (!s) return null;
  s = s.replace(/^NSE:/, '').replace(/^BSE:/, '');
  s = s.replace(/\.(NS|BO|NSE|BSE)$/i, '');
  s = s.replace(/[^A-Z0-9&-]/g, '');               // symbols are alnum + & -
  if (!s || s.length > 25) return null;
  if (/^\d+$/.test(s)) return null;                // a pure number is not a symbol
  return s;
}

// ---- CSV -------------------------------------------------------------------
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  const src = String(text || '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c === '\r') { /* skip */ }
    else cur += c;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

// A sheet cell -> a JS value. "8,056.00" becomes 8056 so the screener table can
// right-align and colour it; anything carrying a unit ("2.82%") stays a string
// so its meaning is not silently dropped.
function cellValue(raw) {
  const t = String(raw == null ? '' : raw).trim();
  if (!t) return '';
  if (/^-?[\d,]+(\.\d+)?$/.test(t)) {
    const n = Number(t.replace(/,/g, ''));
    if (Number.isFinite(n)) return n;
  }
  return t;
}

// Which column holds the symbol, and where the data starts.
// Prefers a header named symbol/ticker/scrip; else the column with the most
// symbol-like cells. Returns { col, headerRow, rows }.
function detectSymbolColumn(rows) {
  const head = rows[0].map(h => String(h).trim().toLowerCase());
  const named = head.findIndex(h => ['symbol', 'ticker', 'scrip', 'stock', 'nse symbol', 'tradingsymbol'].includes(h));
  if (named >= 0) return { col: named, headerRow: true };
  const sample = rows.slice(0, 30);
  const width = Math.max(...sample.map(r => r.length));
  let best = 0, bestScore = -1;
  for (let c = 0; c < width; c++) {
    const score = sample.reduce((n, r) => n + (cleanSymbol(r[c]) ? 1 : 0), 0);
    if (score > bestScore) { bestScore = score; best = c; }
  }
  // a first row whose own cell is not symbol-like is a header
  return { col: best, headerRow: rows.length > 1 && !cleanSymbol(rows[0][best]) };
}

/**
 * Full rows from a tab, preserving EVERY column the sheet carries (LTP,
 * CHG_PCT, EMA20...), so the screener shows what the user actually maintains.
 * The symbol column is normalised into `Symbol`; other columns keep their
 * sheet header names.
 * @returns {{rows: object[], symbolKey: string, symbols: string[]}}
 */
function rowsFromCsv(text) {
  const raw = parseCsv(text).filter(r => r.some(c => String(c).trim()));
  if (!raw.length) return { rows: [], symbolKey: 'Symbol', symbols: [] };
  const { col, headerRow } = detectSymbolColumn(raw);
  const headers = headerRow
    ? raw[0].map((h, i) => String(h).trim() || ('Column ' + (i + 1)))
    : raw[0].map((_, i) => (i === col ? 'Symbol' : 'Column ' + (i + 1)));
  const body = headerRow ? raw.slice(1) : raw;
  const rows = [], symbols = [], seen = new Set();
  body.forEach(r => {
    const sym = cleanSymbol(r[col]);
    if (!sym || seen.has(sym)) return;
    seen.add(sym);
    symbols.push(sym);
    const obj = { Symbol: sym };
    headers.forEach((h, i) => {
      if (i === col) return;                       // already stored as Symbol
      const v = cellValue(r[i]);
      if (v !== '') obj[h] = v;
    });
    rows.push(obj);
  });
  return { rows, symbolKey: 'Symbol', symbols };
}

// From a tab's CSV, pull the symbol column. Prefer a header named
// symbol/ticker/scrip; else the first column whose cells mostly look like
// symbols. Header row (if detected) is dropped.
function symbolsFromCsv(text) {
  const rows = parseCsv(text).filter(r => r.some(c => String(c).trim()));
  if (!rows.length) return [];
  const head = rows[0].map(h => String(h).trim().toLowerCase());
  const named = head.findIndex(h => ['symbol', 'ticker', 'scrip', 'stock', 'nse symbol', 'tradingsymbol'].includes(h));
  let col = named, body = rows;
  if (named >= 0) { body = rows.slice(1); }
  else {
    // pick the column with the most symbol-like cells across the first ~30 rows
    const sample = rows.slice(0, 30);
    const width = Math.max(...sample.map(r => r.length));
    let best = 0, bestScore = -1;
    for (let c = 0; c < width; c++) {
      const score = sample.reduce((n, r) => n + (cleanSymbol(r[c]) ? 1 : 0), 0);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    col = best;
    // drop a header row if its own cell in this column is not symbol-like
    if (rows.length > 1 && !cleanSymbol(rows[0][col])) body = rows.slice(1);
  }
  const out = [];
  const seen = new Set();
  body.forEach(r => { const sym = cleanSymbol(r[col]); if (sym && !seen.has(sym)) { seen.add(sym); out.push(sym); } });
  return out;
}

// ---- tabs ------------------------------------------------------------------
// Best-effort list of {name, gid}. Google exposes this in the doc's own HTML,
// whose exact shape is undocumented and changes - so we try known patterns and
// hand back a raw sample when none match, to be finalised against a real sheet.
function extractTabs(html) {
  const tabs = [];
  const seen = new Set();
  const push = (gid, name) => {
    const g = String(gid), n = String(name || '').trim();
    if (!g || seen.has(g)) return;
    seen.add(g);
    tabs.push({ gid: g, name: n || ('Sheet ' + (tabs.length + 1)) });
  };
  const unesc = str => { try { return JSON.parse('"' + str + '"'); } catch { return str; } };
  // Pattern 1 (CONFIRMED against a real htmlview page): the page switcher builds
  //   items.push({name: "Momentum screener", pageUrl: "...gid=178..."})
  // one per tab, in sheet order. The gid lives inside pageUrl.
  let re = /items\.push\(\{name:\s*"((?:[^"\\]|\\.)*)",\s*pageUrl:\s*"((?:[^"\\]|\\.)*)"/g, m;
  while ((m = re.exec(html))) {
    const url = m[2].replace(/\\\//g, '/');
    const gm = url.match(/gid=(-?\d+)/);
    push(gm ? gm[1] : String(tabs.length), unesc(m[1]));
  }
  // Pattern 2: bootstrap JSON pairs  ..."sheetId":123..."title":"Name"...
  if (!tabs.length) {
    re = /\{"[^{}]*?"sheetId":(\d+)[^{}]*?"title":"((?:[^"\\]|\\.)*)"/g;
    while ((m = re.exec(html))) push(m[1], unesc(m[2]));
  }
  // Pattern 3: htmlview tab buttons  id="sheet-button-<gid>">Name</a>
  if (!tabs.length) {
    re = /id="sheet-button-(\d+)"[^>]*>(?:<[^>]+>)*([^<]+)</g;
    while ((m = re.exec(html))) push(m[1], m[2]);
  }
  return tabs;
}

function listTabs(id, cb) {
  // htmlview renders every tab and is the most parse-friendly page.
  const url = 'https://docs.google.com/spreadsheets/d/' + id + '/htmlview';
  httpsGetFollow(url, { maxBytes: 6e6 }, (err, res) => {
    if (err) return cb(err);
    if (res.status >= 400) return cb(new Error('Sheet not reachable (HTTP ' + res.status + '). Make sure it is shared: Anyone with the link can view.'));
    const html = res.body || '';
    if (/Request access|Sign in|accounts\.google\.com/i.test(html.slice(0, 4000)) && !/sheet-button|sheetId/.test(html)) {
      return cb(new Error('The sheet is private. In Google Sheets: Share -> General access -> Anyone with the link -> Viewer.'));
    }
    const tabs = extractTabs(html);
    if (!tabs.length) {
      // Return a diagnostic so the format can be confirmed from the real sheet.
      return cb(null, { tabs: [], rawSample: html.replace(/\s+/g, ' ').slice(0, 1200), note: 'no tabs parsed' });
    }
    cb(null, { tabs });
  });
}

// ---- a tab's symbols -------------------------------------------------------
function fetchTabSymbols(id, tab, cb) {
  const gid = tab && tab.gid != null ? String(tab.gid) : null;
  const name = tab && tab.name ? String(tab.name) : null;
  const url = gid != null
    ? 'https://docs.google.com/spreadsheets/d/' + id + '/export?format=csv&gid=' + encodeURIComponent(gid)
    : 'https://docs.google.com/spreadsheets/d/' + id + '/gviz/tq?tqx=out:csv&sheet=' + encodeURIComponent(name || '');
  httpsGetFollow(url, {}, (err, res) => {
    if (err) return cb(err);
    if (res.status >= 400) return cb(new Error('Could not read that tab (HTTP ' + res.status + ').'));
    if (/^\s*</.test(res.body) || /text\/html/.test(res.contentType)) {
      return cb(new Error('That tab did not return data - check the sheet is shared for viewing.'));
    }
    const out = rowsFromCsv(res.body);
    cb(null, { symbols: out.symbols, rows: out.rows, symbolKey: out.symbolKey });
  });
}

module.exports = {
  parseSheetId, gidFromUrl, cleanSymbol,
  parseCsv, symbolsFromCsv, rowsFromCsv, cellValue, detectSymbolColumn, extractTabs,
  httpsGetFollow, listTabs, fetchTabSymbols,
};
