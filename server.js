const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const { exec } = require('child_process');

const PORT = process.env.PORT || 7777;
const HOST = process.env.HOST || '127.0.0.1';
const CHROME_COOKIES_PATH = (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\User Data\\Default\\Network\\Cookies';
const STOCKKAR_HOST = 'apii.stockkar.in';
const STOCKKAR_MAX_LIMIT = 2000;
const DATA_DIR = process.env.STOCKKAR_DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const ALGO_SCHEDULE_FILE = path.join(DATA_DIR, 'algo_schedule.json');
const ORDER_LOG_FILE = path.join(DATA_DIR, 'order_log.json');
const DHAN_TOKEN_FILE = path.join(DATA_DIR, 'dhan_token.json');
const BROKER_TOKEN_FILE = path.join(DATA_DIR, 'broker_tokens.json');
const ORDER_LOG_RETENTION_DAYS = 30;
const DHAN_TOKEN_VALIDITY_HOURS = Number(process.env.DHAN_TOKEN_VALIDITY_HOURS || 24);
const DHAN_RENEW_HOUR_IST = Number(process.env.DHAN_RENEW_HOUR_IST || 16);
const DHAN_RENEW_MINUTE_IST = Number(process.env.DHAN_RENEW_MINUTE_IST || 0);
const BROKER_TOKEN_VALIDITY_HOURS = { dhan: DHAN_TOKEN_VALIDITY_HOURS, upstox: 24 };

// ── Auth file (written by Electron main process) ─────────────────────────
const AUTH_FILE = require('path').join(
  process.env.APPDATA || require('os').homedir(),
  'stockkar-trader', 'stockkar_auth.json'
);

function readStoredAuth() {
  try { return JSON.parse(require('fs').readFileSync(AUTH_FILE, 'utf8')); }
  catch { return null; }
}

function getStoredToken() {
  const auth = readStoredAuth();
  return auth?.token || null;
}

function getStoredCookies() {
  const auth = readStoredAuth();
  return auth?.cookies || null;
}

const BUILTIN_SCREENERS = [
  { name: 'Stock Attitude',  slug: 'stock-attitude' },
  { name: 'Retail Trap',     slug: 'retail-trap' },
  { name: 'Volume Dead',     slug: 'volume-dead' },
  { name: 'Giant Ride',      slug: 'giant-ride-system' },
];

const SCREENER_SLUG_ALIASES = {
  'giant-ride-system': ['giant-ride-system', 'giant-ride'],
  'giant-ride': ['giant-ride-system', 'giant-ride'],
};

const BROKERS = [
  { id: 'dhan', name: 'Dhan', status: 'active', supports: ['super_order', 'token_renew'] },
  { id: 'zerodha', name: 'Zerodha Kite', status: 'active', supports: ['regular_order', 'gtt_two_leg'] },
  { id: 'upstox', name: 'Upstox', status: 'active', supports: ['regular_order'] },
  { id: 'angelone', name: 'Angel One SmartAPI', status: 'planned', supports: ['regular_order'] },
  { id: 'fyers', name: 'FYERS', status: 'planned', supports: ['regular_order'] },
  { id: 'aliceblue', name: 'Alice Blue', status: 'planned', supports: ['regular_order'] },
];

function readAlgoSchedule() {
  try {
    const data = JSON.parse(fs.readFileSync(ALGO_SCHEDULE_FILE, 'utf8'));
    if (Array.isArray(data.jobs)) return data;
    if (data.config) {
      return {
        jobs: [{
          id: data.id || 'job-' + Date.now(),
          enabled: !!data.enabled,
          createdAt: data.updatedAt || new Date().toISOString(),
          updatedAt: data.updatedAt || new Date().toISOString(),
          lastRunDate: data.lastRunDate || '',
          lastRunAt: data.lastRunAt || null,
          lastResult: data.lastResult || null,
          config: data.config,
        }],
      };
    }
    return { jobs: [] };
  }
  catch { return { jobs: [] }; }
}

function writeAlgoSchedule(schedule) {
  fs.writeFileSync(ALGO_SCHEDULE_FILE, JSON.stringify(schedule, null, 2));
}

function normalizeOrderLogEntry(entry) {
  const now = new Date().toISOString();
  return {
    id: entry.id || 'ord-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8),
    recordedAt: entry.recordedAt || entry.at || now,
    time: entry.time || new Date(entry.recordedAt || entry.at || now).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
    symbol: String(entry.symbol || ''),
    action: entry.action || 'BUY',
    qty: entry.qty ?? entry.quantity ?? '',
    price: entry.price ?? entry.entryPrice ?? '',
    entryPrice: entry.entryPrice ?? entry.price ?? '',
    slPrice: entry.slPrice ?? entry.stopLossPrice ?? '',
    targetPrice: entry.targetPrice ?? entry.target ?? '',
    rr: entry.rr ?? entry.riskReward ?? '',
    orderId: entry.orderId || entry.order_id || 'N/A',
    status: entry.status || entry.error || '',
    exitType: entry.exitType || entry.result || '',
    exitPrice: entry.exitPrice ?? entry.averageExitPrice ?? '',
    realisedPnl: entry.realisedPnl ?? entry.realizedPnl ?? entry.pnl ?? '',
    lastStatusCheckAt: entry.lastStatusCheckAt || null,
    source: entry.source || 'manual',
    broker: entry.broker || 'dhan',
  };
}

function pruneOrderLog(entries) {
  const cutoff = Date.now() - ORDER_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  return (Array.isArray(entries) ? entries : [])
    .map(normalizeOrderLogEntry)
    .filter(entry => {
      const t = new Date(entry.recordedAt).getTime();
      return Number.isFinite(t) && t >= cutoff;
    })
    .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt));
}

function readOrderLog() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ORDER_LOG_FILE, 'utf8'));
    return pruneOrderLog(Array.isArray(parsed) ? parsed : parsed.orders);
  } catch {
    return [];
  }
}

function writeOrderLog(entries) {
  fs.writeFileSync(ORDER_LOG_FILE, JSON.stringify(pruneOrderLog(entries), null, 2));
}

function appendOrderLog(entries) {
  const rows = Array.isArray(entries) ? entries : [entries];
  const next = pruneOrderLog([...rows.map(normalizeOrderLogEntry), ...readOrderLog()]);
  writeOrderLog(next);
  return next;
}

function collectValues(obj, keyNeedles) {
  const out = [];
  const walk = (value) => {
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, child]) => {
      const nk = normalizeKey(key);
      if (keyNeedles.some(needle => nk.includes(needle)) && child !== null && child !== undefined && typeof child !== 'object') out.push(child);
      walk(child);
    });
  };
  walk(obj);
  return out;
}

function firstNumber(...values) {
  for (const value of values.flat()) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return NaN;
}

function findDhanSuperOrderPayload(data, orderId) {
  const target = String(orderId || '').trim();
  if (!target || target === 'N/A') return null;
  const rows = Array.isArray(data) ? data :
    Array.isArray(data?.data) ? data.data :
    Array.isArray(data?.orders) ? data.orders :
    Array.isArray(data?.superOrders) ? data.superOrders : [];
  const matchesId = row => collectValues(row, ['orderid', 'superorderid'])
    .some(value => String(value).trim() === target);
  return rows.find(matchesId) || null;
}

function inferDhanExitFromOrder(order, logEntry) {
  if (!order) return null;
  const statusText = collectValues(order, ['status', 'orderstatus']).map(v => String(v).toUpperCase()).join(' ');
  const legs = Array.isArray(order.legDetails) ? order.legDetails :
    Array.isArray(order.legs) ? order.legs :
    Array.isArray(order.data?.legDetails) ? order.data.legDetails : [];
  const legText = leg => JSON.stringify(leg || {}).toUpperCase();
  const targetLeg = legs.find(leg => legText(leg).includes('TARGET') && /(TRADED|EXECUTED|COMPLETE|CLOSED|TRIGGERED)/.test(legText(leg)));
  const slLeg = legs.find(leg => /(STOP|SL|LOSS)/.test(legText(leg)) && /(TRADED|EXECUTED|COMPLETE|CLOSED|TRIGGERED)/.test(legText(leg)));
  let exitType = '';
  let exitPrice = NaN;
  if (targetLeg) {
    exitType = 'TARGET HIT';
    exitPrice = firstNumber(collectValues(targetLeg, ['average', 'tradedprice', 'price']), logEntry.targetPrice);
  } else if (slLeg) {
    exitType = 'SL HIT';
    exitPrice = firstNumber(collectValues(slLeg, ['average', 'tradedprice', 'price']), logEntry.slPrice);
  } else if (/REJECT|CANCEL/.test(statusText)) {
    exitType = statusText.includes('REJECT') ? 'REJECTED' : 'CANCELLED';
  }
  const entryPrice = firstNumber(logEntry.entryPrice, logEntry.price, collectValues(order, ['average', 'tradedprice', 'price']));
  const qty = Number(logEntry.qty || 0);
  const realisedPnl = Number.isFinite(exitPrice) && Number.isFinite(entryPrice) && qty
    ? Number(((exitPrice - entryPrice) * qty).toFixed(2))
    : '';
  return {
    exitType,
    exitPrice: Number.isFinite(exitPrice) ? Number(exitPrice.toFixed(2)) : '',
    realisedPnl,
    rawStatus: statusText || logEntry.status,
  };
}

function refreshDhanOrderLogStatus(callback) {
  const store = readDhanTokenStore();
  if (!store?.token) return callback('No Dhan token saved');
  const req = https.request({
    hostname: 'api.dhan.co',
    port: 443,
    path: '/v2/super/orders',
    method: 'GET',
    headers: { 'access-token': store.token, 'Content-Type': 'application/json' },
  }, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      if (apiRes.statusCode >= 400) {
        const msg = parsed?.remarks || parsed?.message || parsed?.errorMessage || data || ('HTTP ' + apiRes.statusCode);
        return callback('Dhan order status failed: ' + msg);
      }
      let changed = 0;
      const checkedAt = new Date().toISOString();
      const next = readOrderLog().map(entry => {
        if ((entry.broker || 'dhan') !== 'dhan' || !entry.orderId || ['N/A', 'ERROR', 'SKIPPED'].includes(entry.orderId)) return entry;
        const order = findDhanSuperOrderPayload(parsed, entry.orderId);
        if (!order) return { ...entry, lastStatusCheckAt: checkedAt };
        const inferred = inferDhanExitFromOrder(order, entry);
        changed += inferred.exitType || inferred.rawStatus !== entry.status ? 1 : 0;
        return {
          ...entry,
          status: inferred.rawStatus || entry.status,
          exitType: inferred.exitType || entry.exitType,
          exitPrice: inferred.exitPrice || entry.exitPrice,
          realisedPnl: inferred.realisedPnl === '' ? entry.realisedPnl : inferred.realisedPnl,
          lastStatusCheckAt: checkedAt,
        };
      });
      writeOrderLog(next);
      callback(null, { changed, data: next });
    });
  });
  req.on('error', err => callback('Dhan order status failed: ' + err.message));
  req.end();
}

// ── Read access_token from Chrome ─────────────────────────────
function getStockkarToken(callback) {
  const tmpPath = path.join(os.tmpdir(), 'sk_cookies_tmp.db');
  try { fs.copyFileSync(CHROME_COOKIES_PATH, tmpPath); }
  catch (e) { return callback(null, 'Cannot copy Chrome cookies: ' + e.message); }
  try {
    const Database = require('better-sqlite3');
    const db = new Database(tmpPath, { readonly: true });
    const rows = db.prepare("SELECT name, value FROM cookies WHERE host_key LIKE '%stockkar%' AND value != '' ORDER BY name").all();
    db.close();
    const tokenRow = rows.find(r => r.name === 'access_token' || r.name === 'token' || r.name === 'auth');
    if (tokenRow) return callback(tokenRow.value, null);
    callback(null, 'MANUAL_TOKEN_NEEDED');
  } catch (e) { callback(null, 'MANUAL_TOKEN_NEEDED'); }
}

// ── Generic proxy ─────────────────────────────────────────────
function proxyRequest(reqBody, res) {
  try {
    const { url: targetUrl, method, headers, body } = JSON.parse(reqBody);
    const parsed = new URL(targetUrl);
    const lib = parsed.protocol === 'https:' ? https : http;
    const bodyData = body ? JSON.stringify(body) : null;
    const reqHeaders = { 'Content-Type': 'application/json', ...(headers || {}), ...(bodyData ? { 'Content-Length': Buffer.byteLength(bodyData) } : {}) };
    const req = lib.request({ hostname: parsed.hostname, port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80), path: parsed.pathname + parsed.search, method: method || 'GET', headers: reqHeaders }, (apiRes) => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        let p; try { p = JSON.parse(data); } catch { p = data; }
        res.end(JSON.stringify({ ok: true, status: apiRes.statusCode, data: p }));
      });
    });
    req.on('error', err => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ ok: false, error: err.message })); });
    if (bodyData) req.write(bodyData);
    req.end();
  } catch (err) { res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify({ ok: false, error: err.message })); }
}

// ── Stockkar API ──────────────────────────────────────────────
function stockkarGet(apiPath, token, callback) {
  // Use stored token from Electron auth if not provided
  const useToken = token || getStoredToken() || '';
  const useCookies = getStoredCookies() || '';
  const headers = {
    'Authorization': 'Bearer ' + useToken,
    'Origin': 'https://www.stockkar.in',
    'Referer': 'https://www.stockkar.in/',
    'User-Agent': 'Mozilla/5.0',
    'Content-Type': 'application/json',
  };
  if (useCookies) headers['Cookie'] = useCookies;
  const req = https.request({ hostname: STOCKKAR_HOST, port: 443, path: apiPath, method: 'GET', headers }, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => { let p; try { p = JSON.parse(data); } catch { p = data; } callback(null, { status: apiRes.statusCode, data: p }); });
  });
  req.on('error', err => callback(err.message, null));
  req.end();
}

// ── TradingView Scanner ───────────────────────────────────────
function fetchTVData(symbols, callback) {
  const tvSymbols = symbols.map(s => `NSE:${s.replace('.NS','').replace('-EQ','').replace(' ','').trim().toUpperCase()}`);
  const emaPeriods = [5, 9, 20, 21, 50, 100, 200];
  const body = JSON.stringify({
    symbols: { tickers: tvSymbols, query: { types: [] } },
    columns: ['name','close','open','high','low','volume', ...emaPeriods.map(p => 'EMA' + p), 'RSI','change','change_abs','average_volume_10d_calc','High.1M','Low.1M']
  });
  const req = https.request({
    hostname: 'scanner.tradingview.com', port: 443, path: '/india/scan', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Origin': 'https://www.tradingview.com', 'Referer': 'https://www.tradingview.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  }, (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        const results = (parsed.data || []).map(item => {
          const d = item.d;
          const ema = {};
          emaPeriods.forEach((p, idx) => { ema[p] = d[6 + idx]; });
          const base = 6 + emaPeriods.length;
          return { symbol: d[0], ltp: d[1], open: d[2], high: d[3], low: d[4], volume: d[5], ema, ema5: ema[5], ema9: ema[9], ema20: ema[20], ema21: ema[21], ema50: ema[50], ema100: ema[100], ema200: ema[200], rsi: d[base], change: d[base + 1], changeAbs: d[base + 2], avgVol10d: d[base + 3], high1M: d[base + 4], low1M: d[base + 5] };
        });
        callback(null, results);
      } catch(e) { callback('TV parse error: ' + e.message, null); }
    });
  });
  req.on('error', err => callback(err.message, null));
  req.write(body); req.end();
}

// ── Dhan Super Order ──────────────────────────────────────────
let dhanSecurityCache = null;
let dhanSecurityCacheAt = 0;
let equityInstrumentCache = null;
let equityInstrumentCacheAt = 0;

function parseCsvLine(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === ',' && !quoted) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function loadDhanSecurityMap(callback) {
  const maxAge = 12 * 60 * 60 * 1000;
  if (dhanSecurityCache && Date.now() - dhanSecurityCacheAt < maxAge) return callback(null, dhanSecurityCache);

  https.get('https://images.dhan.co/api-data/api-scrip-master-detailed.csv', (res) => {
    let csv = '';
    res.on('data', c => csv += c);
    res.on('end', () => {
      if (res.statusCode >= 400) return callback('Dhan scrip master HTTP ' + res.statusCode);
      const lines = csv.trim().split(/\r?\n/);
      const headers = parseCsvLine(lines.shift() || '').map(h => h.trim());
      const idx = (names) => names.map(n => headers.indexOf(n)).find(i => i >= 0);
      const iSec = idx(['SECURITY_ID', 'SEM_SMST_SECURITY_ID']);
      const symIndexes = ['UNDERLYING_SYMBOL', 'SM_SYMBOL', 'SYMBOL_NAME', 'TRADING_SYMBOL']
        .map(n => headers.indexOf(n))
        .filter(i => i >= 0);
      const iExch = idx(['EXCH_ID', 'EXCHANGE']);
      const iSeg = idx(['SEGMENT']);
      const iSeries = idx(['SERIES']);
      const map = {};

      lines.forEach(line => {
        const row = parseCsvLine(line);
        const symbol = String(symIndexes.map(i => row[i]).find(Boolean) || '').replace(/\s/g, '').toUpperCase();
        const sec = String(row[iSec] || '').trim();
        const exch = String(row[iExch] || '').toUpperCase();
        const seg = String(row[iSeg] || '').toUpperCase();
        const series = String(row[iSeries] || '').toUpperCase();
        if (!symbol || !sec) return;
        if (exch && !['NSE', 'NSE_EQ'].includes(exch)) return;
        if (seg && !['E', 'EQ', 'NSE_EQ'].includes(seg)) return;
        if (series && !['EQ', ''].includes(series)) return;
        map[symbol] = sec;
      });

      dhanSecurityCache = map;
      dhanSecurityCacheAt = Date.now();
      callback(null, map);
    });
  }).on('error', err => callback(err.message));
}

function loadEquityInstrumentMap(callback) {
  const maxAge = 12 * 60 * 60 * 1000;
  if (equityInstrumentCache && Date.now() - equityInstrumentCacheAt < maxAge) return callback(null, equityInstrumentCache);

  https.get('https://images.dhan.co/api-data/api-scrip-master-detailed.csv', (res) => {
    let csv = '';
    res.on('data', c => csv += c);
    res.on('end', () => {
      if (res.statusCode >= 400) return callback('Instrument master HTTP ' + res.statusCode);
      const lines = csv.trim().split(/\r?\n/);
      const headers = parseCsvLine(lines.shift() || '').map(h => h.trim());
      const idx = (names) => names.map(n => headers.indexOf(n)).find(i => i >= 0);
      const symIndexes = ['UNDERLYING_SYMBOL', 'SM_SYMBOL', 'SYMBOL_NAME', 'TRADING_SYMBOL']
        .map(n => headers.indexOf(n))
        .filter(i => i >= 0);
      const iIsin = idx(['ISIN', 'SEM_ISIN_CODE']);
      const iExch = idx(['EXCH_ID', 'EXCHANGE']);
      const iSeg = idx(['SEGMENT']);
      const iSeries = idx(['SERIES']);
      const map = {};

      lines.forEach(line => {
        const row = parseCsvLine(line);
        const symbol = String(symIndexes.map(i => row[i]).find(Boolean) || '').replace(/\s/g, '').toUpperCase();
        const isin = String(row[iIsin] || '').trim().toUpperCase();
        const exch = String(row[iExch] || '').toUpperCase();
        const seg = String(row[iSeg] || '').toUpperCase();
        const series = String(row[iSeries] || '').toUpperCase();
        if (!symbol || !isin) return;
        if (exch && !['NSE', 'NSE_EQ'].includes(exch)) return;
        if (seg && !['E', 'EQ', 'NSE_EQ'].includes(seg)) return;
        if (series && !['EQ', ''].includes(series)) return;
        map[symbol] = { isin, upstoxInstrumentKey: 'NSE_EQ|' + isin };
      });

      equityInstrumentCache = map;
      equityInstrumentCacheAt = Date.now();
      callback(null, map);
    });
  }).on('error', err => callback(err.message));
}

function roundPrice(value) {
  return Math.round(Number(value) * 100) / 100;
}

function updateScheduledDhanToken(clientId, newToken) {
  if (!newToken) return;
  const schedule = readAlgoSchedule();
  let changed = false;
  (schedule.jobs || []).forEach(job => {
    if (!job.config) return;
    if (!clientId || String(job.config.dhanClient) === String(clientId)) {
      job.config.dhanToken = newToken;
      job.config.dhanTokenRefreshedAt = new Date().toISOString();
      changed = true;
    }
  });
  if (changed) writeAlgoSchedule(schedule);
}

function readBrokerTokenStore() {
  try { return JSON.parse(fs.readFileSync(BROKER_TOKEN_FILE, 'utf8')); }
  catch { return { brokers: {} }; }
}

function writeBrokerTokenStore(data) {
  fs.writeFileSync(BROKER_TOKEN_FILE, JSON.stringify({ brokers: data.brokers || {} }, null, 2));
}

function saveBrokerToken(broker, payload) {
  const brokerId = String(broker || 'dhan').toLowerCase();
  const store = readBrokerTokenStore();
  const previous = store.brokers[brokerId] || {};
  const now = new Date().toISOString();
  const accessToken = payload.accessToken || payload.dhanToken || payload.token || previous.accessToken;
  const clientId = payload.clientId || payload.dhanClient || payload.apiKey || previous.clientId;
  if (!clientId || !accessToken) return null;
  const savedAt = previous.accessToken === accessToken && previous.savedAt ? previous.savedAt : now;
  store.brokers[brokerId] = {
    broker: brokerId,
    clientId: String(clientId),
    accessToken,
    refreshToken: payload.refreshToken || previous.refreshToken || '',
    clientSecret: payload.clientSecret || previous.clientSecret || '',
    savedAt,
    updatedAt: now,
    renewedAt: payload.renewedAt || previous.renewedAt || null,
    source: payload.source || 'settings',
    validityHours: BROKER_TOKEN_VALIDITY_HOURS[brokerId] || null,
    lastRenewalDate: previous.lastRenewalDate || null,
    lastRenewalAttemptAt: previous.lastRenewalAttemptAt || null,
    lastRenewalError: payload.lastRenewalError === undefined ? (previous.lastRenewalError || null) : payload.lastRenewalError,
  };
  writeBrokerTokenStore(store);
  return store.brokers[brokerId];
}

function nextKiteExpiryIso(store) {
  const base = new Date(store.updatedAt || store.savedAt || Date.now());
  const ist = new Date(base.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const expiryIst = new Date(ist);
  expiryIst.setDate(expiryIst.getDate() + 1);
  expiryIst.setHours(6, 0, 0, 0);
  return new Date(expiryIst.getTime() - (5.5 * 60 * 60 * 1000)).toISOString();
}

function getBrokerTokenStatus(broker) {
  const brokerId = String(broker || 'dhan').toLowerCase();
  if (brokerId === 'dhan') return getDhanTokenStatus();
  const store = readBrokerTokenStore().brokers[brokerId];
  if (!store?.clientId || !store?.accessToken) return { broker: brokerId, configured: false, status: 'missing', message: 'No token saved.' };
  const expiresAt = brokerId === 'zerodha'
    ? nextKiteExpiryIso(store)
    : new Date(new Date(store.renewedAt || store.updatedAt || store.savedAt).getTime() + (store.validityHours || 24) * 60 * 60 * 1000).toISOString();
  const minutesLeft = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 60000);
  let status = 'active';
  if (minutesLeft <= 0) status = 'expired';
  else if (minutesLeft <= 120) status = 'near-expiry';
  if (store.lastRenewalError && status !== 'expired') status = 'renew-failed';
  const canAutoRenew = brokerId === 'upstox' && !!store.refreshToken && !!store.clientSecret;
  return {
    broker: brokerId,
    configured: true,
    status,
    clientId: store.clientId,
    savedAt: store.savedAt,
    updatedAt: store.updatedAt,
    renewedAt: store.renewedAt,
    expiresAt,
    minutesLeft,
    canAutoRenew,
    renewalTimeIst: canAutoRenew ? String(DHAN_RENEW_HOUR_IST).padStart(2, '0') + ':' + String(DHAN_RENEW_MINUTE_IST).padStart(2, '0') : null,
    lastRenewalDate: store.lastRenewalDate,
    lastRenewalAttemptAt: store.lastRenewalAttemptAt,
    lastRenewalError: store.lastRenewalError || null,
    message: brokerId === 'zerodha'
      ? 'Zerodha Kite token normally needs a fresh daily login/access token.'
      : canAutoRenew
        ? 'Upstox token can auto-refresh if refresh token remains valid.'
        : 'Upstox auto-refresh needs refresh token and client secret.',
  };
}

function getAllBrokerTokenStatuses() {
  return {
    dhan: getDhanTokenStatus(),
    zerodha: getBrokerTokenStatus('zerodha'),
    upstox: getBrokerTokenStatus('upstox'),
  };
}

function readDhanTokenStore() {
  try { return JSON.parse(fs.readFileSync(DHAN_TOKEN_FILE, 'utf8')); }
  catch { return null; }
}

function writeDhanTokenStore(data) {
  fs.writeFileSync(DHAN_TOKEN_FILE, JSON.stringify(data, null, 2));
}

function saveDhanToken({ clientId, token, source, renewedAt }) {
  if (!clientId || !token) return null;
  const now = new Date().toISOString();
  const previous = readDhanTokenStore() || {};
  const savedAt = previous.token === token && previous.savedAt ? previous.savedAt : now;
  const next = {
    clientId: String(clientId),
    token,
    savedAt,
    updatedAt: now,
    renewedAt: renewedAt || previous.renewedAt || null,
    source: source || 'settings',
    validityHours: DHAN_TOKEN_VALIDITY_HOURS,
    lastRenewalDate: previous.lastRenewalDate || null,
    lastRenewalAttemptAt: previous.lastRenewalAttemptAt || null,
    lastRenewalError: null,
  };
  writeDhanTokenStore(next);
  saveBrokerToken('dhan', { clientId, accessToken: token, source: source || 'settings', renewedAt: renewedAt || previous.renewedAt || null, lastRenewalError: null });
  updateScheduledDhanToken(clientId, token);
  return next;
}

function getDhanTokenStatus() {
  const store = readDhanTokenStore();
  if (!store?.clientId || !store?.token) return { configured: false, status: 'missing', message: 'No Dhan token saved.' };
  const baseTime = new Date(store.renewedAt || store.updatedAt || store.savedAt).getTime();
  const expiresAtMs = baseTime + DHAN_TOKEN_VALIDITY_HOURS * 60 * 60 * 1000;
  const nowMs = Date.now();
  const minutesLeft = Math.floor((expiresAtMs - nowMs) / 60000);
  let status = 'active';
  if (minutesLeft <= 0) status = 'expired';
  else if (minutesLeft <= 120) status = 'near-expiry';
  if (store.lastRenewalError && status !== 'expired') status = 'renew-failed';
  return {
    configured: true,
    status,
    clientId: store.clientId,
    savedAt: store.savedAt,
    updatedAt: store.updatedAt,
    renewedAt: store.renewedAt,
    expiresAt: new Date(expiresAtMs).toISOString(),
    minutesLeft,
    renewalTimeIst: String(DHAN_RENEW_HOUR_IST).padStart(2, '0') + ':' + String(DHAN_RENEW_MINUTE_IST).padStart(2, '0'),
    lastRenewalDate: store.lastRenewalDate,
    lastRenewalAttemptAt: store.lastRenewalAttemptAt,
    lastRenewalError: store.lastRenewalError || null,
    message: status === 'expired'
      ? 'Dhan token is expired. Generate a fresh token and save Settings.'
      : status === 'near-expiry'
        ? 'Dhan token is near expiry. Auto-renewal will run at 4:00 PM IST if it is still active.'
        : status === 'renew-failed'
          ? 'Last Dhan renewal failed. Save a fresh token if this warning stays.'
          : 'Dhan token is active.',
  };
}

function renewStoredDhanToken(reason, callback) {
  const store = readDhanTokenStore();
  if (!store?.clientId || !store?.token) return callback && callback('No Dhan token saved');
  const attemptAt = new Date().toISOString();
  store.lastRenewalAttemptAt = attemptAt;
  store.lastRenewalError = null;
  writeDhanTokenStore(store);
  renewDhanToken(store.clientId, store.token, (err, token) => {
    if (err) {
      const failed = readDhanTokenStore() || store;
      failed.lastRenewalAttemptAt = attemptAt;
      failed.lastRenewalError = err;
      writeDhanTokenStore(failed);
      if (callback) callback(err);
      return;
    }
    const renewed = saveDhanToken({ clientId: store.clientId, token, source: reason || 'auto-renew', renewedAt: new Date().toISOString() });
    const ist = getIstNow();
    renewed.lastRenewalDate = ist.getFullYear() + '-' + String(ist.getMonth() + 1).padStart(2, '0') + '-' + String(ist.getDate()).padStart(2, '0');
    renewed.lastRenewalAttemptAt = attemptAt;
    renewed.lastRenewalError = null;
    writeDhanTokenStore(renewed);
    if (callback) callback(null, token);
  });
}

function checkDhanTokenRenewal() {
  const store = readDhanTokenStore();
  if (!store?.clientId || !store?.token) return;
  const now = getIstNow();
  const dateKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const afterRenewalTime = now.getHours() > DHAN_RENEW_HOUR_IST || (now.getHours() === DHAN_RENEW_HOUR_IST && now.getMinutes() >= DHAN_RENEW_MINUTE_IST);
  if (!afterRenewalTime || store.lastRenewalDate === dateKey) return;
  const status = getDhanTokenStatus();
  if (status.status === 'expired') return;
  renewStoredDhanToken('daily-4pm', (err) => {
    console.log('[DHAN TOKEN]', err ? 'renew failed: ' + err : 'renewed successfully');
  });
}

function renewDhanToken(dhanClient, dhanToken, callback) {
  if (!dhanToken) return callback('No Dhan token available');
  const req = https.request({
    hostname: 'api.dhan.co',
    port: 443,
    path: '/v2/RenewToken',
    method: 'GET',
    headers: { 'access-token': dhanToken, 'dhanClientId': dhanClient, 'Content-Type': 'application/json' },
  }, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      const token = parsed?.data?.token || parsed?.token || parsed?.accessToken || parsed?.access_token || parsed?.data?.accessToken;
      if (apiRes.statusCode >= 400 || !token) {
        const msg = parsed?.remarks || parsed?.message || parsed?.errorMessage || parsed?.errorCode || data || ('HTTP ' + apiRes.statusCode);
        return callback('Dhan token renewal failed: ' + msg, null);
      }
      updateScheduledDhanToken(dhanClient, token);
      callback(null, token);
    });
  });
  req.on('error', err => callback('Dhan token renewal failed: ' + err.message, null));
  req.end();
}

function renewUpstoxToken(store, callback) {
  if (!store?.refreshToken || !store?.clientId || !store?.clientSecret) return callback('Upstox refresh token, client ID, or client secret missing');
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: store.refreshToken,
    client_id: store.clientId,
    client_secret: store.clientSecret,
  }).toString();
  const req = https.request({
    hostname: 'api.upstox.com',
    port: 443,
    path: '/v2/login/authorization/token',
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      const accessToken = parsed?.access_token || parsed?.accessToken || parsed?.data?.access_token || parsed?.data?.accessToken;
      const refreshToken = parsed?.refresh_token || parsed?.refreshToken || parsed?.data?.refresh_token || parsed?.data?.refreshToken || store.refreshToken;
      if (apiRes.statusCode >= 400 || !accessToken) {
        const msg = parsed?.errors?.[0]?.message || parsed?.message || parsed?.error_description || parsed?.error || data || ('HTTP ' + apiRes.statusCode);
        return callback('Upstox token renewal failed: ' + msg, null);
      }
      callback(null, { accessToken, refreshToken });
    });
  });
  req.on('error', err => callback('Upstox token renewal failed: ' + err.message, null));
  req.write(body);
  req.end();
}

function checkBrokerTokenRenewal() {
  const store = readBrokerTokenStore();
  const upstox = store.brokers.upstox;
  if (!upstox?.accessToken || !upstox?.refreshToken || !upstox?.clientSecret) return;
  const now = getIstNow();
  const dateKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const afterRenewalTime = now.getHours() > DHAN_RENEW_HOUR_IST || (now.getHours() === DHAN_RENEW_HOUR_IST && now.getMinutes() >= DHAN_RENEW_MINUTE_IST);
  if (!afterRenewalTime || upstox.lastRenewalDate === dateKey) return;
  const status = getBrokerTokenStatus('upstox');
  if (status.status === 'expired') return;
  const attemptAt = new Date().toISOString();
  upstox.lastRenewalAttemptAt = attemptAt;
  upstox.lastRenewalError = null;
  writeBrokerTokenStore(store);
  renewUpstoxToken(upstox, (err, tokenData) => {
    const latest = readBrokerTokenStore();
    const current = latest.brokers.upstox || upstox;
    current.lastRenewalAttemptAt = attemptAt;
    if (err) {
      current.lastRenewalError = err;
      latest.brokers.upstox = current;
      writeBrokerTokenStore(latest);
      console.log('[UPSTOX TOKEN] renew failed: ' + err);
      return;
    }
    const renewed = saveBrokerToken('upstox', {
      clientId: current.clientId,
      clientSecret: current.clientSecret,
      accessToken: tokenData.accessToken,
      refreshToken: tokenData.refreshToken,
      source: 'daily-4pm',
      renewedAt: new Date().toISOString(),
      lastRenewalError: null,
    });
    const ist = getIstNow();
    renewed.lastRenewalDate = dateKey;
    renewed.lastRenewalAttemptAt = attemptAt;
    renewed.lastRenewalError = null;
    const finalStore = readBrokerTokenStore();
    finalStore.brokers.upstox = renewed;
    writeBrokerTokenStore(finalStore);
    console.log('[UPSTOX TOKEN] renewed successfully');
  });
}

function placeSuperOrder(orderParams, dhanClient, dhanToken, callback) {
  const entry = Number(orderParams.entryPrice);
  const sl = Number(orderParams.slPrice);
  const target = Number(orderParams.targetPrice);
  const qty = Number(orderParams.qty);
  const symbol = String(orderParams.symbol || '').replace(/\s/g, '').toUpperCase();

  if (!symbol || !entry || !sl || !target || !qty) return callback('Missing order fields', null);
  if (orderParams.action === 'BUY' && !(sl < entry && target > entry)) {
    return callback('Invalid BUY setup: SL must be below entry and target must be above entry', null);
  }

  loadDhanSecurityMap((lookupErr, securityMap) => {
    if (lookupErr) return callback('Security lookup failed: ' + lookupErr, null);
    const securityId = orderParams.securityId || (securityMap && securityMap[symbol]);
    if (!securityId) return callback('Security ID not found for ' + symbol, null);

    const trailPct = Number(orderParams.trailSL || 0);
    const body = JSON.stringify({
      dhanClientId:     dhanClient,
      transactionType:  orderParams.action,
      exchangeSegment:  orderParams.exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ',
      productType:      orderParams.segment || 'CNC',
      orderType:        'LIMIT',
      securityId:       String(securityId),
      quantity:         qty,
      price:            roundPrice(entry),
      targetPrice:      roundPrice(target),
      stopLossPrice:    roundPrice(sl),
      trailingJump:     trailPct > 0 ? roundPrice(entry * trailPct / 100) : 0,
    });

    const req = https.request({
      hostname: 'api.dhan.co', port: 443, path: '/v2/super/orders', method: 'POST',
      headers: { 'access-token': dhanToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        let p; try { p = JSON.parse(data); } catch { p = data; }
        callback(null, { status: apiRes.statusCode, data: p, request: JSON.parse(body) });
      });
    });
    req.on('error', err => callback(err.message, null));
    req.write(body); req.end();
  });
}

function kitePost(pathname, apiKey, accessToken, form, callback) {
  const body = new URLSearchParams(form).toString();
  const req = https.request({
    hostname: 'api.kite.trade',
    port: 443,
    path: pathname,
    method: 'POST',
    headers: {
      'X-Kite-Version': '3',
      Authorization: 'token ' + apiKey + ':' + accessToken,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      callback(null, { status: apiRes.statusCode, data: parsed, request: form });
    });
  });
  req.on('error', err => callback(err.message, null));
  req.write(body);
  req.end();
}

function placeZerodhaGttOrder(orderParams, credentials, callback) {
  const apiKey = credentials?.zerodhaApiKey || credentials?.apiKey || credentials?.clientId || credentials?.dhanClient;
  const accessToken = credentials?.zerodhaAccessToken || credentials?.accessToken || credentials?.dhanToken;
  const symbol = String(orderParams.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const qty = Number(orderParams.qty);
  const entry = Number(orderParams.entryPrice);
  const sl = Number(orderParams.slPrice);
  const target = Number(orderParams.targetPrice);
  if (!apiKey || !accessToken) return callback('Missing Zerodha API key or access token', null);
  if (!symbol || !qty || !entry || !sl || !target) return callback('Missing Zerodha order fields', null);
  if (!(sl < entry && target > entry)) return callback('Invalid Zerodha BUY setup: SL must be below entry and target above entry', null);

  const exchange = orderParams.exchange || 'NSE';
  const product = orderParams.segment === 'INTRADAY' ? 'MIS' : 'CNC';
  const entryForm = {
    exchange,
    tradingsymbol: symbol,
    transaction_type: 'BUY',
    quantity: String(qty),
    product,
    order_type: 'LIMIT',
    price: String(roundPrice(entry)),
    validity: 'DAY',
  };

  kitePost('/orders/regular', apiKey, accessToken, entryForm, (entryErr, entryRes) => {
    if (entryErr) return callback(entryErr, null);
    if (entryRes.status >= 400) return callback('Zerodha entry order failed: ' + JSON.stringify(entryRes.data), entryRes);

    const gttForm = {
      type: 'two-leg',
      condition: JSON.stringify({
        exchange,
        tradingsymbol: symbol,
        trigger_values: [roundPrice(sl), roundPrice(target)],
        last_price: roundPrice(entry),
      }),
      orders: JSON.stringify([
        {
          exchange,
          tradingsymbol: symbol,
          transaction_type: 'SELL',
          quantity: qty,
          order_type: 'LIMIT',
          product,
          price: roundPrice(sl * 0.995),
        },
        {
          exchange,
          tradingsymbol: symbol,
          transaction_type: 'SELL',
          quantity: qty,
          order_type: 'LIMIT',
          product,
          price: roundPrice(target),
        },
      ]),
    };

    kitePost('/gtt/triggers', apiKey, accessToken, gttForm, (gttErr, gttRes) => {
      if (gttErr) return callback(gttErr, null);
      const ok = gttRes.status < 400;
      callback(ok ? null : 'Zerodha GTT failed: ' + JSON.stringify(gttRes.data), {
        status: gttRes.status,
        data: { entry: entryRes.data, gtt: gttRes.data },
        request: { entry: entryForm, gtt: gttForm },
      });
    });
  });
}

function getDateRange(startDate, endDate) {
  const today = endDate ? new Date(endDate) : new Date();
  const start = startDate ? new Date(startDate) : new Date(today - 30 * 24 * 60 * 60 * 1000);
  const fmt = d => d.toISOString().split('T')[0];
  return { start: fmt(start), end: fmt(today) };
}

function formatDateOffset(daysBack) {
  const d = new Date();
  d.setDate(d.getDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

function extractStockRows(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.data)) return data.data;
  if (Array.isArray(data?.stocks)) return data.stocks;
  if (Array.isArray(data?.results)) return data.results;
  const key = Object.keys(data || {}).find(k => Array.isArray(data[k]));
  return key ? data[key] : [];
}

function looksLikeValidationError(rows) {
  return rows.length && rows.every(row =>
    row && typeof row === 'object' &&
    ('type' in row) && ('loc' in row) && ('msg' in row)
  );
}

function fetchLatestScreenerBacktest(slug, token, callback) {
  const maxLookbackDays = 14;
  const limit = STOCKKAR_MAX_LIMIT;

  const fetchPage = (date, offset, allRows, done) => {
    const apiPath = `/api/screeners/${slug}/backtest/range?start_date=${date}&end_date=${date}&limit=${limit}&offset=${offset}`;
    stockkarGet(apiPath, token, (err, r) => {
      if (err) return done(err);
      const rows = extractStockRows(r?.data);
      if (looksLikeValidationError(rows)) return done(null, { ...r, data: [] });
      const nextRows = allRows.concat(rows);
      if (rows.length === limit) return fetchPage(date, offset + limit, nextRows, done);
      done(null, { ...r, data: nextRows, latestDate: nextRows.length ? date : null });
    });
  };

  const tryDate = (daysBack) => {
    if (daysBack > maxLookbackDays) {
      return callback(null, { status: 200, data: [], latestDate: null });
    }

    const date = formatDateOffset(daysBack);
    fetchPage(date, 0, [], (err, r) => {
      if (err) return callback(err);
      const rows = extractStockRows(r?.data);
      if (rows.length) return callback(null, { ...r, latestDate: date });
      tryDate(daysBack + 1);
    });
  };

  tryDate(0);
}

// ── Server ────────────────────────────────────────────────────
function fetchPagedScreenerPath(pathname, token, callback) {
  const limit = STOCKKAR_MAX_LIMIT;

  const fetchPage = (offset, allRows, lastResponse) => {
    const sep = pathname.includes('?') ? '&' : '?';
    const apiPath = `${pathname}${sep}limit=${limit}&offset=${offset}`;
    stockkarGet(apiPath, token, (err, r) => {
      if (err) return callback(err);
      const rows = extractStockRows(r?.data);
      if (looksLikeValidationError(rows)) return callback(null, { ...r, data: [] });
      const nextRows = allRows.concat(rows);
      if (rows.length === limit) return fetchPage(offset + limit, nextRows, r);
      callback(null, { ...(r || lastResponse || {}), data: nextRows });
    });
  };

  fetchPage(0, [], null);
}

function fetchCurrentScreener(slug, token, callback) {
  const slugs = SCREENER_SLUG_ALIASES[slug] || [slug];
  const candidates = slugs.flatMap((s) => [
    `/api/screeners/${s}/stocks`,
    `/api/screeners/${s}/latest`,
    `/api/screeners/${s}/results`,
    `/api/screeners/${s}`,
  ]);

  const tryCandidate = (i) => {
    if (i >= candidates.length) return fetchLatestScreenerBacktest(slugs[0], token, callback);
    fetchPagedScreenerPath(candidates[i], token, (err, r) => {
      if (err) return callback(err);
      const rows = extractStockRows(r?.data);
      if (rows.length) return callback(null, { ...r, sourcePath: candidates[i] });
      tryCandidate(i + 1);
    });
  };

  tryCandidate(0);
}

function extractSymbolsFromStocks(stocks) {
  if (!Array.isArray(stocks) || !stocks.length) return [];
  const cols = Object.keys(stocks[0] || {});
  const symCol = ['symbol','Symbol','ticker','Ticker','tradingSymbol','company','Company','name','Name','stock','Stock'].find(k => cols.includes(k)) || cols[0];
  return stocks
    .map(s => String(s[symCol] || '').replace(/\s/g, '').toUpperCase())
    .filter(Boolean);
}

function normalizeKey(key) {
  return String(key || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function numberFromValue(value) {
  if (value === null || value === undefined) return NaN;
  if (typeof value === 'number') return value;
  const matches = String(value).match(/-?\d+(?:\.\d+)?/g);
  if (matches && matches.length >= 2) {
    const nums = matches.slice(0, 2).map(Number);
    return (nums[0] + nums[1]) / 2;
  }
  const cleaned = String(value).replace(/[^\d.-]/g, '');
  return Number(cleaned);
}

function findTechnicalValue(row, words) {
  if (!row) return NaN;
  const keys = Object.keys(row);
  const found = keys.find(key => {
    const nk = normalizeKey(key);
    return words.every(word => nk.includes(word));
  });
  return found ? numberFromValue(row[found]) : NaN;
}

function getIndicatorValue(indicator, stock, row) {
  const key = String(indicator || '').toLowerCase();
  const emaMatch = key.match(/^ema(\d+)$/);
  if (emaMatch) {
    const period = Number(emaMatch[1]);
    return stock.ema?.[period] || stock['ema' + period];
  }
  if (key === 'fearless_indicator') return findTechnicalValue(row, ['fearless', 'indicator']);
  if (key === 'fearless_zone') return findTechnicalValue(row, ['fearless', 'zone']);
  return NaN;
}

function indicatorLabel(indicator) {
  const key = String(indicator || '').toLowerCase();
  const emaMatch = key.match(/^ema(\d+)$/);
  if (emaMatch) return 'EMA' + emaMatch[1];
  if (key === 'fearless_indicator') return 'Fearless Indicator';
  if (key === 'fearless_zone') return 'Fearless Zone';
  return indicator || 'Indicator';
}

function stockKeyFromRow(row) {
  if (!row) return '';
  const cols = Object.keys(row || {});
  const symCol = ['symbol','Symbol','ticker','Ticker','tradingSymbol','company','Company','name','Name','stock','Stock'].find(k => cols.includes(k)) || cols[0];
  return String(row[symCol] || '').replace(/\s/g, '').toUpperCase();
}

const SECTOR_FIELD_KEYS = ['sector','Sector','sectorName','sector_name','sectorSlug','sector_slug'];
const INDUSTRY_FIELD_KEYS = ['industry','Industry','industryName','industry_name','industry_group','Industry Group','industrySlug','industry_slug'];

function normalizeFilterValue(value) {
  return String(value || '').trim().toLowerCase();
}

function getRowFieldValue(row, exactKeys, fuzzyWord) {
  if (!row) return '';
  const keys = Object.keys(row || {});
  const direct = exactKeys.find(k => Object.prototype.hasOwnProperty.call(row, k) && row[k]);
  if (direct) return String(row[direct]).trim();
  const fuzzy = keys.find(k => {
    const nk = String(k).toLowerCase().replace(/[^a-z]/g, '');
    return nk.includes(fuzzyWord) && row[k];
  });
  return fuzzy ? String(row[fuzzy]).trim() : '';
}

function getRowSector(row) {
  return getRowFieldValue(row, SECTOR_FIELD_KEYS, 'sector');
}

function getRowIndustry(row) {
  return getRowFieldValue(row, INDUSTRY_FIELD_KEYS, 'industry');
}

function filterStocksBySectorIndustry(stocks, sectorFilters, industryFilters) {
  const selectedSectors = (Array.isArray(sectorFilters) ? sectorFilters : [])
    .map(normalizeFilterValue)
    .filter(Boolean);
  const selectedIndustries = (Array.isArray(industryFilters) ? industryFilters : [])
    .map(normalizeFilterValue)
    .filter(Boolean);
  if (!selectedSectors.length && !selectedIndustries.length) return stocks;
  const allowedSectors = new Set(selectedSectors);
  const allowedIndustries = new Set(selectedIndustries);
  return (stocks || []).filter(row => {
    const sectorOk = !allowedSectors.size || allowedSectors.has(normalizeFilterValue(getRowSector(row)));
    const industryOk = !allowedIndustries.size || allowedIndustries.has(normalizeFilterValue(getRowIndustry(row)));
    return sectorOk && industryOk;
  });
}

function buildAlgoCandidates(tvData, cfg) {
  const entryFilters = Array.isArray(cfg.entryFilters) && cfg.entryFilters.length
    ? cfg.entryFilters
    : [{ indicator: 'ema20', withinPct: Number(cfg.emaDistance || 3) }];
  const slPct = Number(cfg.slPct || 2);
  const slIndicatorPct = Number(cfg.slIndicatorPct || 3);
  const rrRatio = Number(cfg.rrRatio || 2);
  const capitalPerTrade = Number(cfg.capital || cfg.capitalPerTrade || 10000);
  const slMethod = cfg.slMethod || 'pct';
  const stockRows = Array.isArray(cfg.screenerStocks) ? cfg.screenerStocks : [];
  const stockRowBySymbol = {};
  stockRows.forEach(row => { const key = stockKeyFromRow(row); if (key) stockRowBySymbol[key] = row; });

  return tvData.map(stock => {
    const ltp = stock.ltp;
    if (!ltp) return null;
    const symbolKey = String(stock.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
    const row = stockRowBySymbol[symbolKey];
    const criteria = entryFilters.map(filter => {
      const value = getIndicatorValue(filter.indicator, stock, row);
      const withinPct = Number(filter.withinPct || 0);
      const distancePct = value ? ((ltp - value) / value) * 100 : NaN;
      const pass = Number.isFinite(distancePct) && distancePct >= 0 && distancePct <= withinPct;
      const label = indicatorLabel(filter.indicator);
      return { indicator: filter.indicator, value, withinPct, distancePct, pass, text: label + ' +' + (Number.isFinite(distancePct) ? distancePct.toFixed(2) : 'missing') + '% <= ' + withinPct + '%' };
    });

    const primary = criteria.find(c => Number.isFinite(c.value)) || {};
    const ema = primary.value || ltp;
    const distancePct = primary.distancePct || 0;
    const withinEMA = criteria.every(c => c.pass);
    const slBase = slMethod === 'indicator' ? getIndicatorValue(cfg.slIndicator, stock, row) : ltp;
    const slPrice = slMethod === 'indicator' && slBase ? slBase * (1 - slIndicatorPct / 100) : ltp * (1 - slPct / 100);
    const slDistance = ltp - slPrice;
    const targetPrice = ltp + (slDistance * rrRatio);
    const qty = Math.floor(capitalPerTrade / ltp) || 1;
    return {
      ...stock,
      ema,
      criteria,
      criteriaSummary: criteria.map(c => c.text).join(' | '),
      distancePct: distancePct.toFixed(2),
      withinEMA,
      entryPrice: parseFloat(ltp.toFixed(2)),
      slPrice: parseFloat(slPrice.toFixed(2)),
      targetPrice: parseFloat(targetPrice.toFixed(2)),
      slPct: parseFloat(((ltp - slPrice) / ltp * 100).toFixed(2)),
      targetPct: parseFloat(((targetPrice - ltp) / ltp * 100).toFixed(2)),
      rr: rrRatio,
      qty,
      capitalRequired: parseFloat((qty * ltp).toFixed(2)),
    };
  }).filter(Boolean);
}

function runScheduledAlgo(job, callback) {
  const cfg = job.config || {};
  const tradedToday = new Set(Array.isArray(job.tradedSymbols) ? job.tradedSymbols.map(s => String(s).toUpperCase()) : []);
  const maxTrades = Number(cfg.maxTrades || 0);
  const remainingTrades = maxTrades > 0 ? Math.max(0, maxTrades - tradedToday.size) : Infinity;
  const token = cfg.stockkarToken || cfg.skToken;
  const storedDhan = readDhanTokenStore();
  if (storedDhan?.token && (!cfg.dhanClient || String(storedDhan.clientId) === String(cfg.dhanClient))) {
    cfg.dhanClient = storedDhan.clientId;
    cfg.dhanToken = storedDhan.token;
  }
  const dhanStatus = getDhanTokenStatus();
  if (!token) return callback('No Stockkar token saved in schedule');
  if (!cfg.dhanClient || !cfg.dhanToken) return callback('No Dhan credentials saved in schedule');
  if (dhanStatus.configured && dhanStatus.status === 'expired' && String(dhanStatus.clientId) === String(cfg.dhanClient)) {
    return callback('Dhan token expired. Generate a fresh token and save Settings.');
  }
  if ((cfg.broker || 'dhan') !== 'dhan') return callback('Scheduled auto-run for ' + cfg.broker + ' is not implemented yet. Use manual preview/execute first.');

  const activeDhanToken = cfg.dhanToken;

  const useStocks = (stocks) => {
    const filtered = filterStocksBySectorIndustry(stocks, cfg.sectorFilters, cfg.industryFilters);
    const symbols = extractSymbolsFromStocks(filtered);
    if (!symbols.length) return callback('No stocks from configured basket after sector/industry filters');
    fetchTVData(symbols, (tvErr, tvData) => {
      if (tvErr) return callback(tvErr);
      let qualified = buildAlgoCandidates(tvData, { ...cfg, screenerStocks: filtered }).filter(r => r.withinEMA);
      const freshQualified = qualified.filter(r => !tradedToday.has(String(r.symbol || '').replace('NSE:', '').toUpperCase()));
      const toTrade = Number.isFinite(remainingTrades) ? freshQualified.slice(0, remainingTrades) : freshQualified;
      const results = [];

      const placeNext = (i) => {
        if (i >= toTrade.length) {
          return callback(null, { scanned: symbols.length, qualified: qualified.length, freshQualified: freshQualified.length, selected: toTrade.length, alreadyTraded: tradedToday.size, orders: results });
        }
        const stock = toTrade[i];
        const sym = String(stock.symbol || '').replace('NSE:', '');
        placeSuperOrder({
          symbol: sym,
          action: 'BUY',
          exchange: cfg.exchange || 'NSE',
          segment: cfg.segment || 'CNC',
          qty: stock.qty,
          entryPrice: stock.entryPrice,
          slPrice: stock.slPrice,
          targetPrice: stock.targetPrice,
          trailSL: cfg.trailSL || 0,
        }, cfg.dhanClient, activeDhanToken, (orderErr, orderRes) => {
          results.push({
            symbol: sym,
            ok: !orderErr,
            error: orderErr || null,
            status: orderRes?.status,
            data: orderRes?.data,
          });
          const orderId = orderRes?.data?.orderId || orderRes?.data?.order_id || orderRes?.data?.data?.orderId || 'N/A';
          appendOrderLog({
            recordedAt: new Date().toISOString(),
            symbol: sym,
            action: 'BUY',
            qty: stock.qty,
            price: stock.entryPrice,
            entryPrice: stock.entryPrice,
            slPrice: stock.slPrice,
            targetPrice: stock.targetPrice,
            rr: stock.rr,
            orderId,
            status: orderErr || (orderRes?.status && orderRes.status < 400 ? 'SUPER ORDER' : JSON.stringify(orderRes?.data || {})),
            source: 'auto',
            broker: 'dhan',
          });
          placeNext(i + 1);
        });
      };
      placeNext(0);
    });
  };

  if (Array.isArray(cfg.screenerStocks) && cfg.screenerStocks.length) {
    return useStocks(cfg.screenerStocks);
  }

  fetchCurrentScreener(cfg.screenerSlug, token, (screenErr, screenRes) => {
    if (screenErr) return callback(screenErr);
    const stocks = filterStocksBySectorIndustry(extractStockRows(screenRes?.data), cfg.sectorFilters, cfg.industryFilters);
    const symbols = extractSymbolsFromStocks(stocks);
    if (!symbols.length) return callback('No stocks from screener after sector/industry filters');

    fetchTVData(symbols, (tvErr, tvData) => {
      if (tvErr) return callback(tvErr);
      let qualified = buildAlgoCandidates(tvData, { ...cfg, screenerStocks: stocks }).filter(r => r.withinEMA);
      const freshQualified = qualified.filter(r => !tradedToday.has(String(r.symbol || '').replace('NSE:', '').toUpperCase()));
      const toTrade = Number.isFinite(remainingTrades) ? freshQualified.slice(0, remainingTrades) : freshQualified;
      const results = [];

      const placeNext = (i) => {
        if (i >= toTrade.length) {
          return callback(null, { scanned: symbols.length, qualified: qualified.length, freshQualified: freshQualified.length, selected: toTrade.length, alreadyTraded: tradedToday.size, orders: results });
        }
        const stock = toTrade[i];
        const sym = String(stock.symbol || '').replace('NSE:', '');
        placeSuperOrder({
          symbol: sym,
          action: 'BUY',
          exchange: cfg.exchange || 'NSE',
          segment: cfg.segment || 'CNC',
          qty: stock.qty,
          entryPrice: stock.entryPrice,
          slPrice: stock.slPrice,
          targetPrice: stock.targetPrice,
          trailSL: cfg.trailSL || 0,
        }, cfg.dhanClient, activeDhanToken, (orderErr, orderRes) => {
          results.push({
            symbol: sym,
            ok: !orderErr,
            error: orderErr || null,
            status: orderRes?.status,
            data: orderRes?.data,
          });
          const orderId = orderRes?.data?.orderId || orderRes?.data?.order_id || orderRes?.data?.data?.orderId || 'N/A';
          appendOrderLog({
            recordedAt: new Date().toISOString(),
            symbol: sym,
            action: 'BUY',
            qty: stock.qty,
            price: stock.entryPrice,
            entryPrice: stock.entryPrice,
            slPrice: stock.slPrice,
            targetPrice: stock.targetPrice,
            rr: stock.rr,
            orderId,
            status: orderErr || (orderRes?.status && orderRes.status < 400 ? 'SUPER ORDER' : JSON.stringify(orderRes?.data || {})),
            source: 'auto',
            broker: 'dhan',
          });
          placeNext(i + 1);
        });
      };

      placeNext(0);
    });
  });
}

function placeUpstoxOrder(orderParams, accessToken, callback) {
  const symbol = String(orderParams.symbol || '').replace(/\s/g, '').toUpperCase();
  const qty = Number(orderParams.qty);
  const entry = Number(orderParams.entryPrice || orderParams.price || 0);
  if (!symbol || !qty) return callback('Missing Upstox order fields', null);
  if (!accessToken) return callback('Missing Upstox access token', null);

  loadEquityInstrumentMap((lookupErr, instrumentMap) => {
    if (lookupErr) return callback('Instrument lookup failed: ' + lookupErr, null);
    const instrumentKey = orderParams.instrumentKey || instrumentMap?.[symbol]?.upstoxInstrumentKey;
    if (!instrumentKey) return callback('Upstox instrument key not found for ' + symbol, null);

    const productMap = { CNC: 'D', INTRADAY: 'I', MTF: 'D' };
    const orderType = entry > 0 ? 'LIMIT' : 'MARKET';
    const body = JSON.stringify({
      quantity: qty,
      product: productMap[orderParams.segment] || 'D',
      validity: 'DAY',
      price: orderType === 'LIMIT' ? roundPrice(entry) : 0,
      tag: 'stockkar-algo',
      instrument_token: instrumentKey,
      order_type: orderType,
      transaction_type: orderParams.action || 'BUY',
      disclosed_quantity: 0,
      trigger_price: 0,
      is_amo: false,
    });

    const req = https.request({
      hostname: 'api.upstox.com',
      port: 443,
      path: '/v2/order/place',
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + accessToken,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
        callback(null, { status: apiRes.statusCode, data: parsed, request: JSON.parse(body) });
      });
    });
    req.on('error', err => callback(err.message, null));
    req.write(body);
    req.end();
  });
}

function placeBrokerSuperOrder({ broker, order, credentials }, callback) {
  const brokerId = String(broker || 'dhan').toLowerCase();
  const storedBroker = brokerId === 'dhan' ? readDhanTokenStore() : readBrokerTokenStore().brokers[brokerId];
  const mergedCredentials = {
    ...(credentials || {}),
    ...(brokerId === 'dhan' && storedBroker ? { dhanClient: storedBroker.clientId, dhanToken: storedBroker.token, accessToken: storedBroker.token } : {}),
    ...(brokerId !== 'dhan' && storedBroker ? { clientId: storedBroker.clientId, accessToken: storedBroker.accessToken, apiKey: storedBroker.clientId, zerodhaApiKey: storedBroker.clientId, zerodhaAccessToken: storedBroker.accessToken, upstoxToken: storedBroker.accessToken } : {}),
  };
  if (brokerId === 'dhan') {
    return placeSuperOrder(order, mergedCredentials?.dhanClient || mergedCredentials?.clientId, mergedCredentials?.dhanToken || mergedCredentials?.accessToken, callback);
  }
  if (brokerId === 'zerodha') {
    return placeZerodhaGttOrder(order, mergedCredentials, callback);
  }
  if (brokerId === 'upstox') {
    return placeUpstoxOrder(order, mergedCredentials?.upstoxToken || mergedCredentials?.accessToken || mergedCredentials?.dhanToken, callback);
  }
  const brokerInfo = BROKERS.find(b => b.id === brokerId);
  return callback((brokerInfo?.name || brokerId) + ' adapter is not implemented yet. Dhan is active; add this broker credentials and order adapter next.', null);
}

function getIstNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

function timeToMinutes(value, fallback) {
  const [h, m] = String(value || fallback || '09:15').split(':').map(Number);
  return (Number.isFinite(h) ? h : 9) * 60 + (Number.isFinite(m) ? m : 15);
}

function checkBackendSchedule() {
  const schedule = readAlgoSchedule();
  const jobs = Array.isArray(schedule.jobs) ? schedule.jobs : [];
  if (!jobs.some(job => job.enabled)) return;
  const now = getIstNow();
  const day = now.getDay();
  const dateKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  if (day === 0 || day === 6) return;

  jobs.forEach((job) => {
    if (!job.enabled) return;
    const daysMode = job.config?.days || 'all';
    if (daysMode === 'mon' && day !== 1) return;
    const startMinutes = timeToMinutes(job.config?.runTime, '09:15');
    const endMinutes = timeToMinutes(job.config?.endTime, '10:30');
    const intervalMinutes = Math.max(1, Number(job.config?.checkIntervalMinutes || 3));
    if (nowMinutes < startMinutes || nowMinutes > endMinutes) return;
    if (job.lastResult?.status === 'running') return;

    const latest = readAlgoSchedule();
    const latestJob = latest.jobs.find(j => j.id === job.id);
    if (!latestJob || !latestJob.enabled || latestJob.lastResult?.status === 'running') return;
    if (latestJob.monitorDate !== dateKey) {
      latestJob.monitorDate = dateKey;
      latestJob.tradedSymbols = [];
      latestJob.checkCount = 0;
      latestJob.lastCheckAt = null;
      latestJob.nextCheckAt = null;
      latestJob.lastResult = { status: 'monitoring', at: now.toISOString(), message: 'Monitoring window started' };
    }
    const maxTrades = Number(latestJob.config?.maxTrades || 0);
    const tradedCount = Array.isArray(latestJob.tradedSymbols) ? latestJob.tradedSymbols.length : 0;
    if (maxTrades > 0 && tradedCount >= maxTrades) {
      latestJob.lastResult = { status: 'complete', at: new Date().toISOString(), message: 'Max trades reached', traded: tradedCount };
      writeAlgoSchedule(latest);
      return;
    }
    if (latestJob.nextCheckAt && new Date(latestJob.nextCheckAt).getTime() > Date.now()) return;
    latestJob.lastRunDate = dateKey;
    latestJob.lastRunAt = now.toISOString();
    latestJob.lastCheckAt = latestJob.lastRunAt;
    latestJob.checkCount = Number(latestJob.checkCount || 0) + 1;
    latestJob.lastResult = { status: 'running', at: latestJob.lastRunAt, message: 'Checking criteria' };
    writeAlgoSchedule(latest);

    runScheduledAlgo(latestJob, (err, result) => {
      const done = readAlgoSchedule();
      const doneJob = done.jobs.find(j => j.id === job.id);
      if (!doneJob) return;
      const attempted = (result?.orders || []).map(o => String(o.symbol || '').toUpperCase()).filter(Boolean);
      const traded = new Set(Array.isArray(doneJob.tradedSymbols) ? doneJob.tradedSymbols.map(s => String(s).toUpperCase()) : []);
      attempted.forEach(sym => traded.add(sym));
      doneJob.tradedSymbols = Array.from(traded);
      const nowDone = new Date();
      const nextCheck = new Date(nowDone.getTime() + intervalMinutes * 60 * 1000);
      const maxTradesDone = Number(doneJob.config?.maxTrades || 0);
      const reachedMax = maxTradesDone > 0 && doneJob.tradedSymbols.length >= maxTradesDone;
      const nextCheckIst = new Date(nextCheck.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      const pastEnd = (nextCheckIst.getHours() * 60 + nextCheckIst.getMinutes()) > endMinutes;
      doneJob.nextCheckAt = reachedMax || pastEnd || err ? null : nextCheck.toISOString();
      doneJob.lastResult = err
        ? { status: 'failed', error: err, at: new Date().toISOString() }
        : {
            status: reachedMax ? 'complete' : (pastEnd ? 'window-complete' : 'monitoring'),
            result,
            at: new Date().toISOString(),
            nextCheckAt: doneJob.nextCheckAt,
            traded: doneJob.tradedSymbols.length,
            message: reachedMax ? 'Max trades reached' : (pastEnd ? 'Monitoring window complete' : 'Monitoring for criteria'),
          };
      writeAlgoSchedule(done);
      console.log('[ALGO SCHEDULE]', job.id, err || result);
    });
  });
}

function handleRequest(req, res) {
  const parsedUrl = url.parse(req.url, true);
  if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' }); return res.end(); }
  const sendJSON = (data) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(data)); };
  const getBody = (cb) => { let b = ''; req.on('data', c => b += c); req.on('end', () => cb(JSON.parse(b))); };

  if (parsedUrl.pathname === '/proxy' && req.method === 'POST') { let body = ''; req.on('data', c => body += c); req.on('end', () => proxyRequest(body, res)); return; }
  if (parsedUrl.pathname === '/get-token') { getStockkarToken((token, err) => sendJSON({ ok: !!token, token, error: err })); return; }
  if (parsedUrl.pathname === '/screeners-list') { sendJSON({ ok: true, data: BUILTIN_SCREENERS }); return; }
  if (parsedUrl.pathname === '/brokers') { sendJSON({ ok: true, data: BROKERS }); return; }

  if (parsedUrl.pathname === '/order-log' && req.method === 'GET') {
    sendJSON({ ok: true, data: readOrderLog(), retentionDays: ORDER_LOG_RETENTION_DAYS });
    return;
  }

  if (parsedUrl.pathname === '/order-log' && req.method === 'POST') {
    getBody((body) => {
      const rows = body.entries || body.orders || body;
      const data = appendOrderLog(rows);
      sendJSON({ ok: true, data, retentionDays: ORDER_LOG_RETENTION_DAYS });
    });
    return;
  }

  if (parsedUrl.pathname === '/order-log/clear' && req.method === 'POST') {
    writeOrderLog([]);
    sendJSON({ ok: true, data: [] });
    return;
  }

  if (parsedUrl.pathname === '/order-log/refresh-status' && req.method === 'POST') {
    refreshDhanOrderLogStatus((err, result) => {
      sendJSON(err ? { ok: false, error: err } : { ok: true, changed: result.changed, data: result.data });
    });
    return;
  }

  if (parsedUrl.pathname === '/dhan/token-status') {
    sendJSON({ ok: true, data: getDhanTokenStatus() });
    return;
  }

  if (parsedUrl.pathname === '/broker-token-status') {
    const broker = parsedUrl.query.broker;
    sendJSON({ ok: true, data: broker ? getBrokerTokenStatus(broker) : getAllBrokerTokenStatuses() });
    return;
  }

  if (parsedUrl.pathname === '/dhan/renew-token' && req.method === 'POST') {
    getBody(({ dhanClient, dhanToken }) => {
      const client = dhanClient || readDhanTokenStore()?.clientId;
      const currentToken = dhanToken || readDhanTokenStore()?.token;
      renewDhanToken(client, currentToken, (err, token) => {
        if (err) return sendJSON({ ok: false, error: err, data: getDhanTokenStatus() });
        saveDhanToken({ clientId: client, token, source: 'manual-renew', renewedAt: new Date().toISOString() });
        sendJSON({ ok: true, token, refreshedAt: new Date().toISOString(), data: getDhanTokenStatus() });
      });
    });
    return;
  }

  if (parsedUrl.pathname === '/broker/renew-token' && req.method === 'POST') {
    getBody(({ broker }) => {
      const brokerId = String(broker || 'dhan').toLowerCase();
      if (brokerId === 'dhan') {
        const store = readDhanTokenStore();
        return renewDhanToken(store?.clientId, store?.token, (err, token) => {
          if (err) return sendJSON({ ok: false, error: err, data: getDhanTokenStatus() });
          saveDhanToken({ clientId: store.clientId, token, source: 'manual-renew', renewedAt: new Date().toISOString() });
          sendJSON({ ok: true, data: getDhanTokenStatus() });
        });
      }
      if (brokerId === 'upstox') {
        const store = readBrokerTokenStore().brokers.upstox;
        return renewUpstoxToken(store, (err, tokenData) => {
          if (err) return sendJSON({ ok: false, error: err, data: getBrokerTokenStatus('upstox') });
          saveBrokerToken('upstox', {
            clientId: store.clientId,
            clientSecret: store.clientSecret,
            accessToken: tokenData.accessToken,
            refreshToken: tokenData.refreshToken,
            source: 'manual-renew',
            renewedAt: new Date().toISOString(),
            lastRenewalError: null,
          });
          sendJSON({ ok: true, data: getBrokerTokenStatus('upstox') });
        });
      }
      sendJSON({ ok: false, error: brokerId + ' does not support silent token renewal. Save a fresh access token.' });
    });
    return;
  }

  if (parsedUrl.pathname === '/algo-schedule/update-credentials' && req.method === 'POST') {
    getBody(({ dhanClient, dhanToken, broker, refreshToken, clientSecret }) => {
      const brokerId = String(broker || 'dhan').toLowerCase();
      if (!dhanClient || !dhanToken) return sendJSON({ ok: false, error: 'Missing broker client/API key or access token' });
      if (brokerId === 'dhan') {
        saveDhanToken({ clientId: dhanClient, token: dhanToken, source: 'settings' });
      } else {
        saveBrokerToken(brokerId, {
          clientId: dhanClient,
          accessToken: dhanToken,
          refreshToken,
          clientSecret,
          source: 'settings',
          lastRenewalError: null,
        });
      }
      const schedule = readAlgoSchedule();
      let updated = 0;
      (schedule.jobs || []).forEach(job => {
        if (!job.config) return;
        const jobBroker = job.config.broker || 'dhan';
        if (broker && jobBroker !== broker) return;
        if (String(job.config.dhanClient || '') && String(job.config.dhanClient) !== String(dhanClient)) return;
        job.config.dhanClient = dhanClient;
        job.config.dhanToken = dhanToken;
        job.config.dhanTokenUpdatedAt = new Date().toISOString();
        if (job.lastResult?.status === 'failed' && String(job.lastResult.error || '').toLowerCase().includes('dhan token')) {
          job.lastResult = { status: 'token-updated', at: new Date().toISOString() };
        }
        updated += 1;
      });
      if (updated) writeAlgoSchedule(schedule);
      sendJSON({ ok: true, updated, data: getBrokerTokenStatus(brokerId), tokenStatuses: getAllBrokerTokenStatuses() });
    });
    return;
  }

  if (parsedUrl.pathname === '/algo-schedule/status') {
    const schedule = readAlgoSchedule();
    const jobs = (schedule.jobs || []).map(job => ({
      id: job.id,
      enabled: !!job.enabled,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      lastRunAt: job.lastRunAt,
      lastRunDate: job.lastRunDate,
      monitorDate: job.monitorDate || '',
      lastCheckAt: job.lastCheckAt || null,
      nextCheckAt: job.nextCheckAt || null,
      checkCount: job.checkCount || 0,
      tradedSymbols: Array.isArray(job.tradedSymbols) ? job.tradedSymbols : [],
      lastResult: job.lastResult,
      config: job.config ? {
        algoTab: job.config.algoTab,
        screenerSlug: job.config.screenerSlug,
        screenerName: job.config.screenerName,
        screenerSourceName: job.config.screenerSourceName || job.config.screenerName,
        screenerStockCount: Array.isArray(job.config.screenerStocks) ? job.config.screenerStocks.length : null,
        days: job.config.days,
        runTime: job.config.runTime || '09:15',
        endTime: job.config.endTime || '10:30',
        checkIntervalMinutes: job.config.checkIntervalMinutes || 3,
        maxTrades: job.config.maxTrades,
        segment: job.config.segment,
        exchange: job.config.exchange,
        sectorFilters: job.config.sectorFilters || [],
        industryFilters: job.config.industryFilters || [],
        dhanTokenRefreshedAt: job.config.dhanTokenRefreshedAt || null,
      } : null,
    }));
    sendJSON({ ok: true, jobs, enabled: jobs.some(job => job.enabled), dhanTokenStatus: getDhanTokenStatus(), brokerTokenStatuses: getAllBrokerTokenStatuses() });
    return;
  }

  if (parsedUrl.pathname === '/algo-schedule' && req.method === 'POST') {
    getBody((body) => {
      const existing = readAlgoSchedule();
      existing.jobs = existing.jobs || [];
      if (body.enabled) {
        const cfg = body.config || {};
        if (!cfg.screenerSlug && !(Array.isArray(cfg.screenerStocks) && cfg.screenerStocks.length)) return sendJSON({ ok: false, error: 'Configure a screener basket before adding queue' });
        if (!cfg.runTime || !/^\d{2}:\d{2}$/.test(String(cfg.runTime))) return sendJSON({ ok: false, error: 'Select a valid run time' });
        cfg.endTime = cfg.endTime && /^\d{2}:\d{2}$/.test(String(cfg.endTime)) ? cfg.endTime : '10:30';
        cfg.checkIntervalMinutes = Math.max(1, Math.min(30, Number(cfg.checkIntervalMinutes || 3)));
        if (timeToMinutes(cfg.endTime) <= timeToMinutes(cfg.runTime)) return sendJSON({ ok: false, error: 'End time must be after start time' });
        const duplicate = existing.jobs.find(job =>
          job.enabled &&
          job.config?.screenerSlug === cfg.screenerSlug &&
          (job.config?.runTime || '09:15') === cfg.runTime
        );
        if (duplicate) return sendJSON({ ok: false, error: 'This screener is already queued at ' + cfg.runTime });
        const id = 'job-' + Date.now() + '-' + Math.random().toString(16).slice(2, 8);
        const now = new Date().toISOString();
        existing.jobs.push({
          id,
          enabled: true,
          createdAt: now,
          updatedAt: now,
          lastRunDate: '',
          lastRunAt: null,
          lastResult: null,
          config: cfg,
        });
        writeAlgoSchedule(existing);
        sendJSON({ ok: true, id, enabled: true, jobs: existing.jobs.length });
        return;
      }
      if (body.id) {
        const job = existing.jobs.find(j => j.id === body.id);
        if (!job) return sendJSON({ ok: false, error: 'Schedule job not found' });
        job.enabled = false;
        job.updatedAt = new Date().toISOString();
      } else {
        existing.jobs.forEach(job => {
          job.enabled = false;
          job.updatedAt = new Date().toISOString();
        });
      }
      writeAlgoSchedule(existing);
      sendJSON({ ok: true, enabled: existing.jobs.some(job => job.enabled), jobs: existing.jobs.length });
    });
    return;
  }

  // Fetch stocks using exact saved URL (user-provided from F12)
  if (parsedUrl.pathname === '/fetch-direct-url' && req.method === 'POST') {
    getBody(({ token, url, limit }) => {
      if (!token) return sendJSON({ ok: false, error: 'No token' });
      if (!url) return sendJSON({ ok: false, error: 'No URL' });
      try {
        // Parse the URL and update limit
        const u = new URL(url);
        u.searchParams.set('limit', String(Math.min(Number(limit) || STOCKKAR_MAX_LIMIT, STOCKKAR_MAX_LIMIT)));
        u.searchParams.set('offset', '0');
        const path = u.pathname + '?' + u.searchParams.toString();
        console.log('[DIRECT URL] Fetching:', path.slice(0, 150));
        stockkarGet(path, token, (err, r) => {
          if (err) return sendJSON({ ok: false, error: err });
          const d = r?.data;
          const stocks = Array.isArray(d) ? d :
                         Array.isArray(d?.data) ? d.data :
                         Array.isArray(d?.stocks) ? d.stocks :
                         Array.isArray(d?.results) ? d.results : [];
          console.log('[DIRECT URL] count:', stocks.length);
          sendJSON({ ok: true, data: stocks, total: r?.data?.count || stocks.length });
        });
      } catch(e) {
        sendJSON({ ok: false, error: 'Invalid URL: ' + e.message });
      }
    });
    return;
  }

  // Auth status
  if (parsedUrl.pathname === '/api/auth/status') {
    const auth = readStoredAuth();
    sendJSON({ ok: true, loggedIn: !!auth?.token, user: auth?.user, refreshedAt: auth?.refreshedAt });
    return;
  }

  // Load saved screeners list
  if (parsedUrl.pathname === '/saved-screeners' && req.method === 'POST') {
    getBody(({ token }) => {
      if (!token) return sendJSON({ ok: false, error: 'No token provided' });
      // Confirmed endpoint from network tab
      stockkarGet('/api/saved-filter/saved', token, (err, r) => {
        console.log('[SAVED] status:', r?.status);
        if (r?.data) {
          const items = Array.isArray(r.data) ? r.data : (r.data?.data || r.data?.filters || r.data?.results || []);
          if (items.length > 0) {
            console.log('[SAVED] FIRST ITEM ALL FIELDS:', JSON.stringify(Object.keys(items[0])));
            console.log('[SAVED] FIRST ITEM DATA:', JSON.stringify(items[0])?.slice(0, 500));
          }
        }
        if (err) return sendJSON({ ok: false, error: err });
        const d = r?.data;
        const list = Array.isArray(d) ? d :
                     Array.isArray(d?.data) ? d.data :
                     Array.isArray(d?.filters) ? d.filters :
                     Array.isArray(d?.results) ? d.results : [];
        if (!list.length) return sendJSON({ ok: false, error: 'No saved screeners found. Make sure you are logged in.' });
        sendJSON({ ok: true, data: list });
      });
    });
    return;
  }

  // Fetch stocks from a saved filter — verified mapper
  if (parsedUrl.pathname === '/saved-filter-stocks' && req.method === 'POST') {
    getBody(({ token, filterId, limit }) => {
      if (!token) return sendJSON({ ok: false, error: 'No token provided' });

      // Step 1: Get filter config using slug
      stockkarGet('/api/saved-filter/slug/' + filterId, token, (err1, r1) => {
        if (err1) return sendJSON({ ok: false, error: 'Filter config error: ' + err1 });

        const config = r1?.data || {};
        const f = config.filters || {};

        console.log('[FILTER CONFIG] name:', config.name, '| activeFilters:', JSON.stringify(f.activeFilters));

        // ── COMPLETE verified mapper — all filters researched via Chrome ──
        const p = new URLSearchParams();
        p.set('limit', String(Math.min(Number(limit) || STOCKKAR_MAX_LIMIT, STOCKKAR_MAX_LIMIT)));
        p.set('offset', '0');
        p.set('include_technicals', 'true');
        p.set('sort_order', f.sort_order || 'desc');

        const af   = f.activeFilters || [];
        const hasB = f.selectedBaskets && f.selectedBaskets.length > 0;

        // ── Baskets ───────────────────────────────────────────────────────
        if (hasB) p.set('baskets', f.selectedBaskets.join(','));

        // ── Industries ────────────────────────────────────────────────────
        if (f.selectedIndustries && f.selectedIndustries.length)
          f.selectedIndustries.forEach(function(ind) { p.append('industry', ind); });

        // ── Market Cap (always) ───────────────────────────────────────────
        p.set('market_cap_min', String(Math.round((f.marketCapRange && f.marketCapRange[0]) || 401)));
        p.set('market_cap_max', String(Math.round((f.marketCapRange && f.marketCapRange[1]) || 1787042)));

        // ── Close Price (skip when baskets present) ───────────────────────
        if (!hasB && f.closePriceRange && f.closePriceRange[1]) {
          p.set('close_price_min', String(f.closePriceRange[0] || 0));
          p.set('close_price_max', String(Math.round(f.closePriceRange[1])));
        }

        // ── PE Ratio ──────────────────────────────────────────────────────
        if (af.includes('PE Ratio') && f.peRatioRange) {
          p.set('pe_ratio_min', String(Math.round(f.peRatioRange[0])));
          p.set('pe_ratio_max', String(Math.round(f.peRatioRange[1])));
        }

        // ── ROE ───────────────────────────────────────────────────────────
        if (af.includes('ROE') && f.roeRange) {
          p.set('roe_min', String(Math.round(f.roeRange[0])));
          p.set('roe_max', String(Math.round(f.roeRange[1])));
        }

        // ── ROCE ──────────────────────────────────────────────────────────
        if (af.includes('ROCE') && f.roceRange) {
          p.set('roce_min', String(Math.round(f.roceRange[0])));
          p.set('roce_max', String(Math.round(f.roceRange[1])));
        }

        // ── Debt Ratio ────────────────────────────────────────────────────
        if (af.includes('Debt Ratio') && f.debtRatioRange) {
          p.set('de_ratio_min', String(Math.round(f.debtRatioRange[0])));
          p.set('de_ratio_max', String(Math.round(f.debtRatioRange[1])));
        }

        // ── Demand dates ──────────────────────────────────────────────────
        if (f.demandStartDate) p.set('demand_start_date', f.demandStartDate);
        if (f.demandEndDate)   p.set('demand_end_date',   f.demandEndDate);

        // ── Big Player Score (use Start/End NOT legacy bigPlayerScore) ────
        if (af.includes('Big Player Score')) {
          var bps = f.bigPlayerScoreStart || [0, 100];
          var bpe = f.bigPlayerScoreEnd   || [0, 100];
          p.set('big_player_score_start_min', String(bps[0]));
          p.set('big_player_score_start_max', String(bps[1]));
          p.set('big_player_score_end_min',   String(bpe[0]));
          p.set('big_player_score_end_max',   String(bpe[1]));
        }

        // ── Growth Score ──────────────────────────────────────────────────
        if (af.includes('Growth Score')) {
          var gss = f.growthScoreStart || [0, 100];
          var gse = f.growthScoreEnd   || [0, 100];
          p.set('growth_score_start_min', String(gss[0]));
          p.set('growth_score_start_max', String(gss[1]));
          p.set('growth_score_end_min',   String(gse[0]));
          p.set('growth_score_end_max',   String(gse[1]));
        }

        // ── Momentum Score (use Start/End NOT legacy momentumScore) ───────
        if (af.includes('Momentum Score')) {
          var mss = f.momentumScoreStart || [0, 100];
          var mse = f.momentumScoreEnd   || [0, 100];
          p.set('momentum_score_start_min', String(mss[0]));
          p.set('momentum_score_start_max', String(mss[1]));
          p.set('momentum_score_end_min',   String(mse[0]));
          p.set('momentum_score_end_max',   String(mse[1]));
        }

        // ── Near Term Growth ──────────────────────────────────────────────
        if (af.includes('Near Term Growth Meter')) {
          p.set('short_term_growth_score_min', String(f.shortTermGrowthMin || 0));
          p.set('short_term_growth_score_max', String(f.shortTermGrowthMax || 100));
        }

        // ── Growth Compounder ─────────────────────────────────────────────
        if (af.includes('Growth Compounder Meter')) {
          p.set('long_term_growth_score_min', String(f.longTermGrowthMin || 0));
          p.set('long_term_growth_score_max', String(f.longTermGrowthMax || 100));
        }

        // ── Performance Meter ─────────────────────────────────────────────
        if (af.includes('Performance Meter')) {
          p.set('returns_efficiency_score_min', String(f.returnsEffMin || 0));
          p.set('returns_efficiency_score_max', String(f.returnsEffMax || 100));
        }

        // ── Golden Valuation (PE TTM) ─────────────────────────────────────
        if (af.includes('Golden Valuation') && f.dailyTtmPeOp && f.dailyTtmPeOp !== 'within') {
          p.set('daily_ttm_pe_op',  f.dailyTtmPeOp);
          p.set('daily_ttm_pe_min', String((f.dailyTtmPeRange && f.dailyTtmPeRange[0]) || 0));
          p.set('daily_ttm_pe_max', String((f.dailyTtmPeRange && f.dailyTtmPeRange[1]) || 100));
          p.set('daily_ttm_pe_pct', String(f.dailyTtmPePct || 100));
        }

        // ── Quarterly EPS Growth ──────────────────────────────────────────
        if (af.includes('Quarterly EPS Growth') && f.quarterlyEpsRange && f.quarterlyEpsRange[0] > 0) {
          p.set('quarter',          f.quarterlyEpsQuarter || '');
          p.set('eps_growth_min',   String(f.quarterlyEpsRange[0]));
          p.set('eps_growth_max',   String(f.quarterlyEpsRange[1]));
        }

        // ── Delivery % ────────────────────────────────────────────────────
        if (af.includes('Delivery %') && f.deliveryRange) {
          p.set('delivery_min', String(f.deliveryRange[0] || 0));
          p.set('delivery_max', String(f.deliveryRange[1] || 100));
        }

        // ── Volume Traces ─────────────────────────────────────────────────
        if (af.includes('Volume Traces')) {
          p.set('volume_days',       String(f.volumeDays || 30));
          p.set('volume_multiplier', String(f.volumeMultiplier || 3));
        }

        // ── Your Date, Your Volume ────────────────────────────────────────
        if (af.includes('Your Date, Your Volume') && f.volumeSpike && f.volumeSpike.date) {
          p.set('volume_spike_date',       f.volumeSpike.date);
          p.set('volume_spike_multiplier', String(f.volumeSpike.multiplier || 3));
          p.set('volume_spike_days',       String(f.volumeSpike.days || 60));
        }

        // ── EMA above EMA (daily ema crossovers) ─────────────────────────
        if ((af.includes('EMA above EMA') || af.includes('EMA Crossover')) && f.emaCrossovers && f.emaCrossovers.length) {
          f.emaCrossovers.forEach(function(ec) {
            var lft = ec.left || '';
            var rgt = ec.right || '';
            if (lft.match(/^daily_ema/) && rgt.match(/^daily_ema/)) {
              // Daily EMA: use ema_cross_* params
              var sh = lft.replace('daily_ema','');
              var lo = rgt.replace('daily_ema','');
              p.append('ema_cross_short', sh);
              p.append('ema_cross_long',  lo);
              p.append('ema_cross_dir',   ec.dir);
            } else if (lft || rgt) {
              // Non-daily or SMA: use ma_crossovers param
              p.append('ma_crossovers', lft + '-' + rgt + '-' + ec.dir);
            } else if (ec.short && ec.long) {
              // Old format
              p.append('ema_cross_short', String(ec.short));
              p.append('ema_cross_long',  String(ec.long));
              p.append('ema_cross_dir',   ec.dir);
            }
          });
        }

        // ── SMA above SMA ─────────────────────────────────────────────────
        if ((af.includes('SMA above SMA') || af.includes('SMA Crossover')) && f.smaCrossovers && f.smaCrossovers.length) {
          f.smaCrossovers.forEach(function(sc) {
            p.append('ma_crossovers', sc.left + '-' + sc.right + '-' + sc.dir);
          });
        }

        // ── Historical EMA Crossovers ─────────────────────────────────────
        if (f.emaCrossFrom && f.historicalEmaCrossovers && f.historicalEmaCrossovers.length) {
          p.set('ema_cross_from', f.emaCrossFrom);
          p.set('ema_cross_to',   f.emaCrossTo || '');
          f.historicalEmaCrossovers.forEach(function(ec) {
            var lft = ec.left || '';
            var rgt = ec.right || '';
            if (lft.match(/^daily_ema/) && rgt.match(/^daily_ema/)) {
              var sh = lft.replace('daily_ema','');
              var lo = rgt.replace('daily_ema','');
              p.append('ema_crossovers', sh + '-' + lo + '-' + ec.dir);
            } else {
              p.set('ma_cross_from', f.emaCrossFrom);
              p.set('ma_cross_to',   f.emaCrossTo || '');
              p.append('ma_crossovers', lft + '-' + rgt + '-' + ec.dir);
            }
          });
        }

        // ── Historical SMA Crossovers ─────────────────────────────────────
        if (f.emaCrossFrom && f.historicalSmaCrossovers && f.historicalSmaCrossovers.length) {
          p.set('ma_cross_from', f.emaCrossFrom);
          p.set('ma_cross_to',   f.emaCrossTo || '');
          f.historicalSmaCrossovers.forEach(function(sc) {
            p.append('ma_crossovers', sc.left + '-' + sc.right + '-' + sc.dir);
          });
        }

        // ── % Within EMA ──────────────────────────────────────────────────
        if ((af.includes('% Within EMA') || af.includes('% Above Daily EMA')) && f.emaProximities && f.emaProximities.length) {
          f.emaProximities.forEach(function(ep) {
            if (!ep.field) return;
            var maxP = parseFloat((ep.maxPercent / 100).toFixed(4));
            var minP = parseFloat((ep.minPercent / 100).toFixed(4));
            if (ep.field.match(/^daily_ema/)) {
              var period = ep.field.replace('daily_ema','');
              p.set('ema_proximity_range', period + ':' + minP + ':' + maxP);
              p.set('ema_proximity',       period + ':' + maxP);
            } else {
              // weekly EMA or SMA → ma_proximity_range
              p.append('ma_proximity_range', ep.field + ':' + minP + ':' + maxP);
            }
          });
        }

        // ── % Within SMA ──────────────────────────────────────────────────
        if (af.includes('% Within SMA') && f.smaProximities && f.smaProximities.length) {
          f.smaProximities.forEach(function(sp) {
            if (!sp.field) return;
            var maxP = parseFloat((sp.maxPercent / 100).toFixed(4));
            var minP = parseFloat((sp.minPercent / 100).toFixed(4));
            p.append('ma_proximity_range', sp.field + ':' + minP + ':' + maxP);
          });
        }

        // ── EMA Price Crossover ───────────────────────────────────────────
        if ((af.includes('EMA Price Crossover') || af.includes('Price vs EMA')) && f.priceCrossovers && f.priceCrossovers.length) {
          if (f.priceCrossFrom) p.set('price_cross_from', f.priceCrossFrom);
          if (f.priceCrossTo)   p.set('price_cross_to',   f.priceCrossTo);
          f.priceCrossovers.forEach(function(pc) {
            if (!pc.field) return;
            if (pc.field.match(/^daily_ema/)) {
              var period = pc.field.replace('daily_ema','');
              p.append('price_crossovers', period + '-' + pc.dir);
            } else {
              p.append('ma_price_crossovers', pc.field + '-' + pc.dir);
              if (f.priceCrossFrom) p.set('ma_price_cross_from', f.priceCrossFrom);
              if (f.priceCrossTo)   p.set('ma_price_cross_to',   f.priceCrossTo);
            }
          });
        }

        // ── SMA Price Crossover ───────────────────────────────────────────
        if ((af.includes('SMA Price Crossover') || af.includes('SMA Crossover')) && f.smaPriceCrossovers && f.smaPriceCrossovers.length) {
          if (f.priceCrossFrom) p.set('ma_price_cross_from', f.priceCrossFrom);
          if (f.priceCrossTo)   p.set('ma_price_cross_to',   f.priceCrossTo);
          f.smaPriceCrossovers.forEach(function(sc) {
            if (sc.field) p.append('ma_price_crossovers', sc.field + '-' + sc.dir);
          });
        }

        // ── RSI 14 ────────────────────────────────────────────────────────
        if (af.includes('RSI 14') && f.rsiRange) {
          p.set('rsi_min', String(f.rsiRange[0]));
          p.set('rsi_max', String(f.rsiRange[1]));
        }

        // ── Supertrend ────────────────────────────────────────────────────
        if (af.includes('Supertrend') && f.supertrendSignal && f.supertrendSignal !== 'all') {
          p.set('supertrend_signal', f.supertrendSignal);
          p.set('supertrend_pct',    String(f.supertrendPct || 3));
        }

        // ── Fearless Indicator ────────────────────────────────────────────
        if (af.includes('Fearless Indicator') && f.fearlessZoneColor && f.fearlessZoneColor !== 'all') {
          p.set('fearless_zone_color',      f.fearlessZoneColor);
          p.set('fearless_zone_within_pct', String(f.fearlessZoneWithinPct || 3));
        }

        // ── Pivot / Price Near High (fall filter) ─────────────────────────
        if ((af.includes('Pivot') || af.includes('Price Near High')) && f.fallPct) {
          p.set('fall_days', String(f.fallDays || 30));
          p.set('fall_pct',  String(parseFloat((f.fallPct / 100).toFixed(4))));
        }

        // ── SH Filters (Public/FII/DII/Promoter) ─────────────────────────
        if (f.shFilters && f.shFilters.length) {
          var sh = f.shFilters.map(function(s) {
            return { bucket: s.bucket, mode: s.mode, window: s.window,
                     label: s.label, band: s.bandLo + '-' + s.bandHi };
          });
          p.set('sh_filters', JSON.stringify(sh));
        }

        // ── Form Your Own Candle (cb_groups) ─────────────────────────────
        var cbParts = [];
        var processFyoc = function(items, tf) {
          if (!items || !items.length) return;
          items.forEach(function(c) {
            var from = c.useRange ? (c.dateFrom || c.date || '') : (c.date || '');
            var to   = c.useRange ? (c.dateTo || '') : '';
            var dateStr = (from && to) ? (from + '..' + to) : (from || '');
            var body   = (c.bodyRange   || [0,100]).join('-');
            var upper  = (c.upperRange  || [0,100]).join('-');
            var lower  = (c.lowerRange  || [0,100]).join('-');
            var consol = (c.consol      || [0,100]).join('-');
            var label  = c.label || 'any';
            cbParts.push(tf + '|' + dateStr + '|' + label + '|' + body + '|' + upper + '|' + lower + '|' + consol);
          });
        };
        if (af.includes('Form Your Own Candle - Daily'))   processFyoc(f.fyocDaily,   'daily');
        if (af.includes('Form Your Own Candle - Weekly'))  processFyoc(f.fyocWeekly,  'weekly');
        if (af.includes('Form Your Own Candle - Monthly')) processFyoc(f.fyocMonthly, 'monthly');
        if (cbParts.length) cbParts.forEach(function(g) { p.append('cb_groups', g); });

        // ── Consolidation (cp_filters) ────────────────────────────────────
        var hasConsolDaily   = af.includes('Consolidation - Daily');
        var hasConsolWeekly  = af.includes('Consolidation - Weekly');
        var hasConsolMonthly = af.includes('Consolidation - Monthly');
        if (f.cp && (hasConsolDaily || hasConsolWeekly || hasConsolMonthly)) {
          p.set('cp_active', '1');
          var cpArr = [];
          var addCp = function(tf, enabled) {
            if (!enabled || !f.cp[tf]) return;
            var c = f.cp[tf];
            cpArr.push({
              timeframe:    tf,
              points_min:   (c.points && c.points[0]) || 1,
              points_max:   (c.points && c.points[1]) || 14,
              ref_from:     c.refFrom || null,
              ref_to:       c.refTo   || null,
              status:       c.status  || 'partial',
              ref_body_min: (c.body && c.body[0]) || 0,
              ref_body_max: (c.body && c.body[1]) || 100,
              ref_size_min: (c.size && c.size[0]) || 0,
              ref_size_max: (c.size && c.size[1]) || 100,
            });
          };
          addCp('daily',   hasConsolDaily);
          addCp('weekly',  hasConsolWeekly);
          addCp('monthly', hasConsolMonthly);
          if (cpArr.length) p.set('cp_filters', JSON.stringify(cpArr));
        }

        var query = '/api/global-filter/stocks?' + p.toString();
        console.log('[FILTER STOCKS] name:', config.name, '| query len:', query.length);

        console.log('[FILTER STOCKS] Query:', query.slice(0, 300));

        console.log('[FILTER STOCKS] Query:', query);

        stockkarGet(query, token, (err2, r2) => {
          if (err2) return sendJSON({ ok: false, error: 'Stocks fetch error: ' + err2 });

          const d = r2?.data;
          const stocks = Array.isArray(d) ? d :
                         Array.isArray(d?.data) ? d.data :
                         Array.isArray(d?.stocks) ? d.stocks :
                         Array.isArray(d?.results) ? d.results : [];

          console.log('[FILTER STOCKS] count:', stocks.length);
          sendJSON({ ok: true, data: stocks, total: stocks.length, filterName: config.name });
        });
      });
    });
    return;
  }

  if (parsedUrl.pathname === '/fetch-screener' && req.method === 'POST') {
    getBody(({ token, screenerUrl, slug }) => {
      let apiPath;
      if (slug) {
        fetchCurrentScreener(slug, token, (err, r) => {
          sendJSON(err ? { ok: false, error: err } : { ok: true, status: r.status, data: r.data, latestDate: r.latestDate });
        });
        return;
      } else {
        try {
          const u = new URL(screenerUrl);
          u.searchParams.set('limit', String(STOCKKAR_MAX_LIMIT));
          u.searchParams.set('offset', '0');
          if (u.hostname === 'apii.stockkar.in') { apiPath = u.pathname + '?' + u.searchParams.toString(); }
          else {
            const match = u.pathname.match(/\/screeners\/([^\/]+)/);
            if (match) {
              fetchCurrentScreener(match[1], token, (err, r) => {
                sendJSON(err ? { ok: false, error: err } : { ok: true, status: r.status, data: r.data, latestDate: r.latestDate });
              });
              return;
            }
            else { apiPath = u.pathname + '?' + u.searchParams.toString(); }
          }
        } catch { apiPath = screenerUrl; }
      }
      stockkarGet(apiPath, token, (err, r) => sendJSON(err ? { ok: false, error: err } : { ok: true, status: r.status, data: r.data }));
    });
    return;
  }

  // TradingView data for symbols
  if (parsedUrl.pathname === '/tv-data' && req.method === 'POST') {
    getBody(({ symbols }) => {
      fetchTVData(symbols, (err, data) => sendJSON(err ? { ok: false, error: err } : { ok: true, data }));
    });
    return;
  }

  // Algo scan — apply entry criteria and calculate prices
  if (parsedUrl.pathname === '/algo-scan' && req.method === 'POST') {
    getBody(({ symbols, screenerStocks, entryFilters, slMethod, slPct, slIndicator, slIndicatorPct, rrRatio, capitalPerTrade, sectorFilters, industryFilters }) => {
      const filteredStocks = filterStocksBySectorIndustry(screenerStocks || [], sectorFilters, industryFilters);
      const hasFilters = (Array.isArray(sectorFilters) && sectorFilters.length) || (Array.isArray(industryFilters) && industryFilters.length);
      const filteredSymbols = hasFilters ? extractSymbolsFromStocks(filteredStocks) : symbols;
      fetchTVData(filteredSymbols, (err, tvData) => {
        if (err) return sendJSON({ ok: false, error: err });
        const results = buildAlgoCandidates(tvData, { screenerStocks: filteredStocks.length ? filteredStocks : screenerStocks, entryFilters, slMethod, slPct, slIndicator, slIndicatorPct, rrRatio, capitalPerTrade });

        sendJSON({ ok: true, data: results, qualified: results.filter(r => r.withinEMA) });
      });
    });
    return;
  }

  // Place Super Order
  if (parsedUrl.pathname === '/place-super-order' && req.method === 'POST') {
    getBody(({ order, broker, credentials, dhanClient, dhanToken }) => {
      placeBrokerSuperOrder({
        broker: broker || 'dhan',
        order,
        credentials: credentials || { dhanClient, dhanToken },
      }, (err, result) => {
        sendJSON(err ? { ok: false, error: err } : { ok: true, data: result.data, status: result.status });
      });
    });
    return;
  }

  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, content) => {
      if (err) { res.writeHead(500); return res.end('Error'); }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(content);
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
}

if (require.main === module) {
  const server = http.createServer(handleRequest);
  server.listen(PORT, HOST, () => {
    console.log('\n  ================================');
    console.log('   STOCKKAR TRADER - Running!');
    console.log('  ================================');
    console.log('\n  URL: http://' + HOST + ':' + PORT);
    console.log('  Keep this window open. CTRL+C to stop.\n');
    if (process.platform === 'win32') exec('start http://localhost:' + PORT);
    checkBackendSchedule();
    checkDhanTokenRenewal();
    checkBrokerTokenRenewal();
    setInterval(checkBackendSchedule, 30000);
    setInterval(checkDhanTokenRenewal, 60000);
    setInterval(checkBrokerTokenRenewal, 60000);
  });
}

module.exports = handleRequest;
