const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const PACKAGE = require('./package.json');

const PORT = process.env.PORT || 7777;
const HOST = process.env.HOST || '127.0.0.1';
const CHROME_COOKIES_PATH = (process.env.LOCALAPPDATA || '') + '\\Google\\Chrome\\User Data\\Default\\Network\\Cookies';
const STOCKKAR_HOST = 'apii.stockkar.in';
const STOCKKAR_MAX_LIMIT = 2000;
const DATA_DIR = process.env.STOCKKAR_DATA_DIR || __dirname;
fs.mkdirSync(DATA_DIR, { recursive: true });
const ALGO_SCHEDULE_FILE = path.join(DATA_DIR, 'algo_schedule.json');
const ORDER_LOG_FILE = path.join(DATA_DIR, 'order_log.json');
const TEST_ORDER_LOG_FILE = path.join(DATA_DIR, 'test_order_log.json');
const DHAN_TOKEN_FILE = path.join(DATA_DIR, 'dhan_token.json');
const BROKER_TOKEN_FILE = path.join(DATA_DIR, 'broker_tokens.json');
const UPDATE_PIN_FILE = path.join(DATA_DIR, 'update_pin.json');
const UPDATE_STATUS_FILE = path.join(DATA_DIR, 'update_status.json');
const ORDER_LOG_RETENTION_DAYS = 30;
const DHAN_TOKEN_VALIDITY_HOURS = Number(process.env.DHAN_TOKEN_VALIDITY_HOURS || 24);
const DHAN_RENEW_HOUR_IST = Number(process.env.DHAN_RENEW_HOUR_IST || 16);
const DHAN_RENEW_MINUTE_IST = Number(process.env.DHAN_RENEW_MINUTE_IST || 0);
const EMA_TRAILING_CHECK_HOUR_IST = Number(process.env.EMA_TRAILING_CHECK_HOUR_IST || 15);
const EMA_TRAILING_CHECK_MINUTE_IST = Number(process.env.EMA_TRAILING_CHECK_MINUTE_IST || 45);
const BROKER_TOKEN_VALIDITY_HOURS = { dhan: DHAN_TOKEN_VALIDITY_HOURS, upstox: 24, angelone: 24 };
const UPDATE_REPO_PACKAGE_URL = process.env.STOCKKAR_UPDATE_PACKAGE_URL
  || 'https://raw.githubusercontent.com/mindvisualmedia-jpg/Stockkaralgo/main/package.json';
const UPDATE_SESSIONS = new Map();
const KITE_LOGIN_STATES = new Map();
const UPSTOX_LOGIN_STATES = new Map();
let latestVersionCache = { version: null, checkedAt: 0, error: null };

function readJsonFile(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}

function writePrivateJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

function hashUpdatePin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 64).toString('hex') };
}

if (!fs.existsSync(UPDATE_PIN_FILE) && /^\d{6,12}$/.test(String(process.env.STOCKKAR_INITIAL_UPDATE_PIN || ''))) {
  writePrivateJson(UPDATE_PIN_FILE, {
    ...hashUpdatePin(process.env.STOCKKAR_INITIAL_UPDATE_PIN),
    createdAt: new Date().toISOString(),
    source: 'aws-setup',
  });
}

function verifyUpdatePin(pin) {
  const stored = readJsonFile(UPDATE_PIN_FILE);
  if (!stored?.salt || !stored?.hash) return false;
  const candidate = hashUpdatePin(pin, stored.salt).hash;
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(stored.hash, 'hex'));
  } catch { return false; }
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(part => {
    const i = part.indexOf('=');
    return i < 0 ? ['', ''] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1))];
  }).filter(([key]) => key));
}

function hasUpdateSession(req) {
  const token = parseCookies(req).stockkar_update_session;
  const expiresAt = token && UPDATE_SESSIONS.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) UPDATE_SESSIONS.delete(token);
    return false;
  }
  return true;
}

function createUpdateSession() {
  const token = crypto.randomBytes(32).toString('hex');
  UPDATE_SESSIONS.set(token, Date.now() + 15 * 60 * 1000);
  return token;
}

function isIstMarketWindow() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  if (['Sat', 'Sun'].includes(values.weekday)) return false;
  const mins = Number(values.hour) * 60 + Number(values.minute);
  return mins >= 9 * 60 && mins <= 15 * 60 + 45;
}

function fetchLatestVersion(callback) {
  if (latestVersionCache.checkedAt > Date.now() - 60 * 1000) return callback(latestVersionCache);
  const versionUrl = UPDATE_REPO_PACKAGE_URL + (UPDATE_REPO_PACKAGE_URL.includes('?') ? '&' : '?') + 't=' + Date.now();
  https.get(versionUrl, { headers: { 'User-Agent': 'Stockkar-Updater', 'Cache-Control': 'no-cache' } }, response => {
    let body = '';
    response.on('data', chunk => body += chunk);
    response.on('end', () => {
      try {
        const cleanedBody = String(body || '').replace(/^\\uFEFF/, '').trim();
        latestVersionCache = { version: JSON.parse(cleanedBody).version || null, checkedAt: Date.now(), error: null };
      } catch (e) {
        latestVersionCache = { version: null, checkedAt: Date.now(), error: 'Could not read latest release.' };
      }
      callback(latestVersionCache);
    });
  }).on('error', () => {
    latestVersionCache = { version: null, checkedAt: Date.now(), error: 'Could not contact update server.' };
    callback(latestVersionCache);
  });
}

function serveStaticFile(res, file, contentType) {
  fs.readFile(path.join(__dirname, file), (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(content);
  });
}

// â”€â”€ Auth file (written by Electron main process) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  { id: 'upstox', name: 'Upstox', status: 'active', supports: ['gtt_three_leg', 'daily_oauth_login'] },
  { id: 'angelone', name: 'Angel One SmartAPI', status: 'active', supports: ['robo_order', 'token_refresh'] },
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
          status: data.enabled ? 'active' : (data.status || 'cancelled'),
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

function describeEntryCriteria(filters) {
  if (!Array.isArray(filters) || !filters.length) return 'No entry filter';
  return filters.map(filter => {
    const label = String(filter.label || filter.indicator || 'Indicator').replace(/_/g, ' ');
    const pct = Number(filter.withinPct ?? filter.pct ?? filter.value);
    return label + (Number.isFinite(pct) ? ' within ' + pct + '%' : '');
  }).join(' + ');
}

function describeExitCriteria(cfg = {}) {
  const rr = cfg.rrRatio || cfg.rr || cfg.riskReward || '';
  if (cfg.slMethod === 'indicator') {
    const indicator = String(cfg.slIndicator || 'indicator').replace(/_/g, ' ');
    return 'SL ' + (cfg.slIndicatorPct || 0) + '% below ' + indicator + (rr ? ' | R:R ' + rr : '');
  }
  return 'SL ' + (cfg.slPct || 0) + '% below entry' + (rr ? ' | R:R ' + rr : '');
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
    brokerSlPrice: entry.brokerSlPrice ?? entry.dhanStopLossPrice ?? '',
    targetPrice: entry.targetPrice ?? entry.target ?? '',
    rr: entry.rr ?? entry.riskReward ?? '',
    screenerName: entry.screenerName || entry.screener || '',
    entryCriteria: entry.entryCriteria || '',
    exitCriteria: entry.exitCriteria || '',
    emaTrailingEnabled: !!entry.emaTrailingEnabled,
    emaTrailingIndicator: entry.emaTrailingIndicator || '',
    emaTrailingPct: entry.emaTrailingPct ?? '',
    emaTrailingTimeframe: entry.emaTrailingTimeframe || '',
    emaTrailingTrigger: entry.emaTrailingTrigger || '',
    emaTrailingArmedAt: entry.emaTrailingArmedAt || null,
    emaTrailingStatus: entry.emaTrailingStatus || '',
    emaTrailingLastDate: entry.emaTrailingLastDate || '',
    lastTrailSlPrice: entry.lastTrailSlPrice ?? '',
    lastTrailCheckAt: entry.lastTrailCheckAt || null,
    lastTrailError: entry.lastTrailError || '',
    rejectionReason: entry.rejectionReason || entry.rejectReason || '',
    orderId: entry.orderId || entry.order_id || 'N/A',
    gttTriggerId: entry.gttTriggerId || entry.gttId || '',
    exitOrderId: entry.exitOrderId || '',
    status: entry.status || entry.error || '',
    exitType: entry.exitType || entry.result || '',
    exitPrice: entry.exitPrice ?? entry.averageExitPrice ?? '',
    realisedPnl: entry.realisedPnl ?? entry.realizedPnl ?? entry.pnl ?? '',
    lastStatusCheckAt: entry.lastStatusCheckAt || null,
    source: entry.source || 'manual',
    broker: entry.broker || 'dhan',
    exchange: entry.exchange || 'NSE',
    segment: entry.segment || 'CNC',
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

function readTestOrderLog() {
  try {
    const parsed = JSON.parse(fs.readFileSync(TEST_ORDER_LOG_FILE, 'utf8'));
    return pruneOrderLog(Array.isArray(parsed) ? parsed : parsed.orders);
  } catch {
    return [];
  }
}

function writeTestOrderLog(entries) {
  fs.writeFileSync(TEST_ORDER_LOG_FILE, JSON.stringify(pruneOrderLog(entries), null, 2));
}

function appendTestOrderLog(entries) {
  const rows = (Array.isArray(entries) ? entries : [entries]).map(entry => ({
    ...entry,
    source: 'test',
    orderId: entry.orderId || 'TEST-MODE',
    status: entry.status || 'TEST MODE - NO ORDER PLACED',
  }));
  const next = pruneOrderLog([...rows.map(normalizeOrderLogEntry), ...readTestOrderLog()]);
  writeTestOrderLog(next);
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

function dhanApiMessage(parsed, fallback) {
  return parsed?.remarks || parsed?.message || parsed?.errorMessage || parsed?.errorCode ||
    parsed?.data?.remarks || parsed?.data?.message || parsed?.data?.errorMessage ||
    (typeof parsed === 'string' ? parsed : '') || fallback || 'Dhan request failed';
}

function isSameIstDate(a, b = new Date()) {
  const fmt = date => new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  try { return fmt(a) === fmt(b); } catch { return false; }
}

function isOpenOrderLogEntry(entry) {
  const statusText = String(entry.status || '').toUpperCase();
  const resultText = String(entry.exitType || entry.result || '').toUpperCase();
  if (['ERROR', 'SKIPPED', 'N/A'].includes(String(entry.orderId || '').toUpperCase())) return false;
  if (/(TARGET HIT|SL HIT|REJECT|CANCEL|FAILED|FAIL|INVALID)/.test(statusText + ' ' + resultText)) return false;
  return true;
}

function hasOpenSameDayDhanOrder(symbol) {
  const cleanSymbol = String(symbol || '').replace(/\s/g, '').toUpperCase();
  return readOrderLog().some(entry =>
    String(entry.broker || 'dhan').toLowerCase() === 'dhan' &&
    String(entry.symbol || '').replace(/\s/g, '').toUpperCase() === cleanSymbol &&
    isSameIstDate(entry.recordedAt || entry.time || new Date()) &&
    isOpenOrderLogEntry(entry)
  );
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
  const isExecutedLeg = leg => /(TRADED|EXECUTED|COMPLETE|COMPLETED|FILLED)/.test(legText(leg));
  const targetLeg = legs.find(leg => legText(leg).includes('TARGET') && isExecutedLeg(leg));
  const slLeg = legs.find(leg => /(STOP|SL|LOSS)/.test(legText(leg)) && isExecutedLeg(leg));
  const triggeredExitLeg = legs.find(leg => /(TARGET|STOP|SL|LOSS)/.test(legText(leg)) && /TRIGGERED/.test(legText(leg)) && !isExecutedLeg(leg));
  let exitType = '';
  let exitPrice = NaN;
  if (targetLeg) {
    exitType = 'TARGET HIT';
    exitPrice = firstNumber(collectValues(targetLeg, ['average', 'avgprice', 'tradedprice', 'executedprice', 'filledprice']));
  } else if (slLeg) {
    exitType = 'SL HIT';
    exitPrice = firstNumber(collectValues(slLeg, ['average', 'avgprice', 'tradedprice', 'executedprice', 'filledprice']));
  } else if (/REJECT|CANCEL/.test(statusText)) {
    exitType = statusText.includes('REJECT') ? 'REJECTED' : 'CANCELLED';
  }
  const rejectionReason = exitType === 'REJECTED'
    ? dhanApiMessage(order, statusText || logEntry.status || 'Rejected by Dhan')
    : '';
  const entryPrice = firstNumber(logEntry.entryPrice, logEntry.price, collectValues(order, ['average', 'tradedprice', 'price']));
  const qty = Number(logEntry.qty || 0);
  const realisedPnl = Number.isFinite(exitPrice) && Number.isFinite(entryPrice) && qty
    ? Number(((exitPrice - entryPrice) * qty).toFixed(2))
    : '';
  return {
    exitType,
    exitPrice: Number.isFinite(exitPrice) ? Number(exitPrice.toFixed(2)) : '',
    realisedPnl,
    rejectionReason,
    rawStatus: triggeredExitLeg ? 'EXIT LEG TRIGGERED - WAITING FOR FILL' : (statusText || logEntry.status),
  };
}

function parseZerodhaOrderIds(orderId) {
  const text = String(orderId || '');
  const entry = (text.match(/ENTRY:([^|]+)/i) || [])[1];
  const gtt = (text.match(/GTT:([^|]+)/i) || [])[1];
  return { entryId: entry ? entry.trim() : '', gttId: gtt ? gtt.trim() : '' };
}

function kiteRows(payload) {
  return Array.isArray(payload) ? payload :
    Array.isArray(payload?.data) ? payload.data :
    Array.isArray(payload?.orders) ? payload.orders :
    Array.isArray(payload?.triggers) ? payload.triggers : [];
}

function zerodhaOrderResult(leg) {
  const result = leg?.result || {};
  const orderResult = result?.order_result || leg?.order_result || {};
  return {
    orderId: orderResult.order_id || orderResult.orderId || result.order_id || result.orderId || leg?.order_id || leg?.orderId || '',
    status: String(orderResult.status || result.status || leg?.status || '').toUpperCase(),
    rejectionReason: orderResult.rejection_reason || orderResult.rejectionReason || result.rejection_reason || result.rejectionReason || leg?.rejection_reason || '',
    price: firstNumber(orderResult.average_price, result.average_price, leg?.average_price, leg?.price),
  };
}

function inferZerodhaGttLeg(gtt) {
  if (!gtt) return null;
  const orders = Array.isArray(gtt.orders) ? gtt.orders : [];
  const triggered = orders
    .map((leg, index) => ({ index, ...zerodhaOrderResult(leg) }))
    .find(leg => leg.orderId || leg.status || leg.rejectionReason);
  if (!triggered) return null;

  const legName = triggered.index === 0 ? 'SL' : triggered.index === 1 ? 'TARGET' : 'EXIT';
  const complete = /(COMPLETE|TRADED|FILLED)/.test(triggered.status);
  const rejected = /(REJECT|CANCEL|FAIL)/.test(triggered.status);
  return {
    legName,
    exitOrderId: triggered.orderId,
    exitType: rejected ? 'REJECTED' : (complete ? (legName === 'TARGET' ? 'TARGET HIT' : legName === 'SL' ? 'SL HIT' : 'EXITED') : ''),
    exitPrice: Number.isFinite(triggered.price) ? triggered.price : NaN,
    rejectionReason: triggered.rejectionReason,
    rawStatus: rejected
      ? 'ZERODHA ' + legName + ' ORDER ' + (triggered.status || 'REJECTED')
      : (complete
        ? 'ZERODHA ' + (legName === 'TARGET' ? 'TARGET HIT' : legName === 'SL' ? 'SL HIT' : 'EXIT COMPLETE')
        : 'ZERODHA ' + legName + ' TRIGGERED - WAITING FOR FILL'),
  };
}

function inferZerodhaExitFromOrderBook(logEntry, ordersPayload, gttPayload) {
  const ids = parseZerodhaOrderIds(logEntry.orderId);
  const orders = kiteRows(ordersPayload);
  const gtts = kiteRows(gttPayload);
  const symbol = String(logEntry.symbol || '').replace(/\s/g, '').toUpperCase();
  const entryOrder = orders.find(o => String(o.order_id || o.orderId || '') === ids.entryId) || null;
  const entryStatus = String(entryOrder?.status || '').toUpperCase();
  const rejectionReason = entryOrder && /(REJECT|CANCEL)/.test(entryStatus)
    ? (entryOrder.status_message || entryOrder.status_message_raw || entryOrder.exchange_message || entryStatus)
    : '';
  if (entryOrder && /REJECT|CANCEL/.test(entryStatus)) {
    return {
      exitType: entryStatus.includes('REJECT') ? 'REJECTED' : 'CANCELLED',
      exitPrice: '',
      realisedPnl: '',
      rejectionReason,
      rawStatus: entryStatus,
    };
  }

  const entryTime = entryOrder?.order_timestamp || entryOrder?.exchange_timestamp || logEntry.recordedAt || logEntry.time || '';
  const sells = orders.filter(o => {
    const osym = String(o.tradingsymbol || o.symbol || '').replace(/\s/g, '').toUpperCase();
    const side = String(o.transaction_type || o.transactionType || '').toUpperCase();
    const status = String(o.status || '').toUpperCase();
    return osym === symbol && side === 'SELL' && /(COMPLETE|TRADED|FILLED)/.test(status);
  }).sort((a, b) => String(b.order_timestamp || b.exchange_timestamp || '').localeCompare(String(a.order_timestamp || a.exchange_timestamp || '')));

  const gtt = ids.gttId ? gtts.find(t => String(t.id || t.trigger_id || t.triggerId || '') === ids.gttId) : null;
  const gttStatus = String(gtt?.status || '').toUpperCase();
  const gttLeg = inferZerodhaGttLeg(gtt);
  const sell = (gttLeg?.exitOrderId
    ? orders.find(o => String(o.order_id || o.orderId || '') === String(gttLeg.exitOrderId))
    : null) || sells.find(o => !entryTime || String(o.order_timestamp || o.exchange_timestamp || '') >= String(entryTime)) || sells[0];
  const exitPrice = firstNumber(sell?.average_price, sell?.price, sell?.trigger_price, gttLeg?.exitPrice);
  const entryPrice = firstNumber(logEntry.entryPrice, logEntry.price, entryOrder?.average_price, entryOrder?.price);
  const qty = Number(logEntry.qty || 0);
  const target = Number(logEntry.targetPrice || 0);
  const sl = Number(logEntry.slPrice || 0);
  let exitType = gttLeg?.exitType || '';
  if (!exitType && Number.isFinite(exitPrice)) {
    if (target && exitPrice >= target * 0.999) exitType = 'TARGET HIT';
    else if (sl && exitPrice <= sl * 1.001) exitType = 'SL HIT';
    else exitType = 'EXITED';
  }
  const realisedPnl = Number.isFinite(exitPrice) && Number.isFinite(entryPrice) && qty && exitType && !/REJECT|CANCEL/.test(exitType)
    ? Number(((exitPrice - entryPrice) * qty).toFixed(2))
    : '';
  return {
    exitType,
    exitPrice: Number.isFinite(exitPrice) && exitType && !/REJECT|CANCEL/.test(exitType) ? Number(exitPrice.toFixed(2)) : '',
    realisedPnl,
    rejectionReason: gttLeg?.rejectionReason || rejectionReason,
    rawStatus: exitType ? (gttLeg?.rawStatus || 'ZERODHA EXIT COMPLETE') : (gttLeg?.rawStatus || (gttStatus ? 'ZERODHA GTT ' + gttStatus : (entryStatus || logEntry.status))),
    gttTriggerId: ids.gttId,
    exitOrderId: gttLeg?.exitOrderId || sell?.order_id || sell?.orderId || '',
  };
}

function refreshZerodhaOrderLogStatus(callback) {
  const store = readBrokerTokenStore().brokers.zerodha;
  const status = getBrokerTokenStatus('zerodha');
  if (!store?.clientId || !store?.accessToken) return callback('No Zerodha token saved');
  if (status.status === 'expired') return callback('Zerodha token expired. Complete today Kite login in Settings.');
  kiteGet('/orders', store.clientId, store.accessToken, (ordersErr, ordersRes) => {
    if (ordersErr) return callback('Zerodha order status failed: ' + ordersErr);
    if (!ordersRes || ordersRes.status >= 400) return callback('Zerodha order status failed: ' + JSON.stringify(ordersRes?.data || {}));
    kiteGet('/gtt/triggers', store.clientId, store.accessToken, (_gttErr, gttRes) => {
      let changed = 0;
      const checkedAt = new Date().toISOString();
      const next = readOrderLog().map(entry => {
        if (String(entry.broker || '').toLowerCase() !== 'zerodha' || !entry.orderId || ['N/A', 'ERROR', 'SKIPPED'].includes(entry.orderId)) return entry;
        const inferred = inferZerodhaExitFromOrderBook(entry, ordersRes.data, gttRes?.data || []);
        if ((inferred.exitType && inferred.exitType !== entry.exitType) || (inferred.rawStatus && inferred.rawStatus !== entry.status) || (inferred.exitOrderId && inferred.exitOrderId !== entry.exitOrderId)) changed += 1;
        const hasFinalExit = !!inferred.exitType;
        return {
          ...entry,
          status: inferred.rawStatus || entry.status,
          exitType: inferred.exitType || entry.exitType || '',
          exitPrice: hasFinalExit ? inferred.exitPrice : (entry.exitPrice || ''),
          realisedPnl: hasFinalExit ? inferred.realisedPnl : (entry.realisedPnl || ''),
          rejectionReason: inferred.rejectionReason || entry.rejectionReason || '',
          gttTriggerId: inferred.gttTriggerId || entry.gttTriggerId || '',
          exitOrderId: inferred.exitOrderId || entry.exitOrderId || '',
          lastStatusCheckAt: checkedAt,
        };
      });
      writeOrderLog(next);
      callback(null, { changed, data: next });
    });
  });
}

function parseUpstoxOrderIds(orderId) {
  const text = String(orderId || '');
  const gttIds = (text.match(/GTT-[A-Z0-9-]+/gi) || []).map(id => id.trim());
  const entry = (text.match(/ENTRY:([^|]+)/i) || [])[1];
  return { entryId: entry ? entry.trim() : '', gttIds };
}

function upstoxRows(payload) {
  return Array.isArray(payload) ? payload :
    Array.isArray(payload?.data) ? payload.data :
    Array.isArray(payload?.orders) ? payload.orders :
    Array.isArray(payload?.order_book) ? payload.order_book : [];
}

function upstoxGet(pathname, accessToken, callback) {
  const req = https.request({
    hostname: 'api.upstox.com',
    port: 443,
    path: pathname,
    method: 'GET',
    headers: {
      Authorization: 'Bearer ' + accessToken,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  }, apiRes => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      callback(null, { status: apiRes.statusCode, data: parsed });
    });
  });
  req.on('error', err => callback(err.message, null));
  req.end();
}

function inferUpstoxExitFromOrderBook(logEntry, orderBookPayload) {
  const ids = parseUpstoxOrderIds(logEntry.orderId);
  const rows = upstoxRows(orderBookPayload);
  const symbol = String(logEntry.symbol || '').replace(/\s/g, '').toUpperCase();
  const normalizeSymbol = value => String(value || '').replace(/-EQ$/i, '').replace(/\s/g, '').toUpperCase();
  const orderIdMatches = o => {
    const candidates = [o.order_id, o.orderId, o.parent_order_id, o.parentOrderId, o.guid, o.tag].map(v => String(v || '').trim());
    return candidates.includes(ids.entryId) || candidates.some(v => v && String(logEntry.orderId || '').includes(v));
  };
  const entryOrder = rows.find(orderIdMatches) || null;
  const entryStatus = String(entryOrder?.status || entryOrder?.order_status || '').toUpperCase();
  const rejectionReason = entryOrder && /(REJECT|CANCEL)/.test(entryStatus)
    ? (entryOrder.status_message || entryOrder.statusMessage || entryOrder.exchange_message || entryOrder.message || entryStatus)
    : '';
  if (entryOrder && /REJECT|CANCEL/.test(entryStatus)) {
    return {
      exitType: entryStatus.includes('REJECT') ? 'REJECTED' : 'CANCELLED',
      exitPrice: '',
      realisedPnl: '',
      rejectionReason,
      rawStatus: entryStatus,
    };
  }

  const entryTime = entryOrder?.order_timestamp || entryOrder?.exchange_timestamp || entryOrder?.created_at || logEntry.recordedAt || logEntry.time || '';
  const sells = rows.filter(o => {
    const osym = normalizeSymbol(o.tradingsymbol || o.trading_symbol || o.symbol || o.instrument_token || '');
    const side = String(o.transaction_type || o.transactionType || o.side || '').toUpperCase();
    const status = String(o.status || o.order_status || '').toUpperCase();
    return osym === symbol && side === 'SELL' && /(COMPLETE|TRADED|FILLED)/.test(status);
  }).sort((a, b) => String(b.order_timestamp || b.exchange_timestamp || b.created_at || '').localeCompare(String(a.order_timestamp || a.exchange_timestamp || a.created_at || '')));

  const sell = sells.find(o => !entryTime || String(o.order_timestamp || o.exchange_timestamp || o.created_at || '') >= String(entryTime)) || sells[0];
  const exitPrice = firstNumber(sell?.average_price, sell?.averagePrice, sell?.price, sell?.trigger_price, sell?.triggerPrice);
  const entryPrice = firstNumber(logEntry.entryPrice, logEntry.price, entryOrder?.average_price, entryOrder?.averagePrice, entryOrder?.price);
  const qty = Number(logEntry.qty || 0);
  const target = Number(logEntry.targetPrice || 0);
  const sl = Number(logEntry.slPrice || 0);
  let exitType = '';
  if (Number.isFinite(exitPrice)) {
    if (target && exitPrice >= target * 0.999) exitType = 'TARGET HIT';
    else if (sl && exitPrice <= sl * 1.001) exitType = 'SL HIT';
    else exitType = 'EXITED';
  }
  const realisedPnl = Number.isFinite(exitPrice) && Number.isFinite(entryPrice) && qty
    ? Number(((exitPrice - entryPrice) * qty).toFixed(2))
    : '';
  return {
    exitType,
    exitPrice: Number.isFinite(exitPrice) ? Number(exitPrice.toFixed(2)) : '',
    realisedPnl,
    rejectionReason,
    rawStatus: exitType ? 'UPSTOX EXIT COMPLETE' : (entryStatus || logEntry.status),
  };
}

function refreshUpstoxOrderLogStatus(callback) {
  const store = readBrokerTokenStore().brokers.upstox;
  const status = getBrokerTokenStatus('upstox');
  if (!store?.clientId || !store?.accessToken) return callback('No Upstox token saved');
  if (status.status === 'expired') return callback('Upstox token expired. Complete today secure Upstox login in Settings.');
  upstoxGet('/v2/order/retrieve-all', store.accessToken, (err, res) => {
    if (err) return callback('Upstox order status failed: ' + err);
    if (!res || res.status >= 400 || res.data?.status === 'error') return callback('Upstox order status failed: ' + JSON.stringify(res?.data || {}));
    let changed = 0;
    const checkedAt = new Date().toISOString();
    const next = readOrderLog().map(entry => {
      if (String(entry.broker || '').toLowerCase() !== 'upstox' || !entry.orderId || ['N/A', 'ERROR', 'SKIPPED'].includes(entry.orderId)) return entry;
      const inferred = inferUpstoxExitFromOrderBook(entry, res.data);
      if ((inferred.exitType && inferred.exitType !== entry.exitType) || (inferred.rawStatus && inferred.rawStatus !== entry.status)) changed += 1;
      const hasFinalExit = !!inferred.exitType;
      return {
        ...entry,
        status: inferred.rawStatus || entry.status,
        exitType: inferred.exitType || entry.exitType || '',
        exitPrice: hasFinalExit ? inferred.exitPrice : (entry.exitPrice || ''),
        realisedPnl: hasFinalExit ? inferred.realisedPnl : (entry.realisedPnl || ''),
        rejectionReason: inferred.rejectionReason || entry.rejectionReason || '',
        lastStatusCheckAt: checkedAt,
      };
    });
    writeOrderLog(next);
    callback(null, { changed, data: next });
  });
}

function angelRows(payload) {
  return Array.isArray(payload) ? payload :
    Array.isArray(payload?.data) ? payload.data :
    Array.isArray(payload?.orderBook) ? payload.orderBook :
    Array.isArray(payload?.orders) ? payload.orders : [];
}

function inferAngelOneExitFromOrderBook(logEntry, orderBookPayload) {
  const rows = angelRows(orderBookPayload);
  const orderId = String(logEntry.orderId || '').trim();
  const symbol = String(logEntry.symbol || '').replace(/\s/g, '').toUpperCase();
  const normalizeSymbol = value => String(value || '').replace(/-EQ$/i, '').replace(/\s/g, '').toUpperCase();
  const entryOrder = rows.find(o => String(o.orderid || o.order_id || o.orderId || '') === orderId) || null;
  const entryStatus = String(entryOrder?.status || '').toUpperCase();
  const rejectionReason = entryOrder && /(REJECT|CANCEL)/.test(entryStatus)
    ? (entryOrder.text || entryOrder.status_message || entryOrder.rejectreason || entryStatus)
    : '';
  if (entryOrder && /REJECT|CANCEL/.test(entryStatus)) {
    return {
      exitType: entryStatus.includes('REJECT') ? 'REJECTED' : 'CANCELLED',
      exitPrice: '',
      realisedPnl: '',
      rejectionReason,
      rawStatus: entryStatus,
    };
  }

  const sells = rows.filter(o => {
    const osym = normalizeSymbol(o.tradingsymbol || o.symbol || o.symbolname);
    const side = String(o.transactiontype || o.transaction_type || '').toUpperCase();
    const status = String(o.status || '').toUpperCase();
    return osym === symbol && side === 'SELL' && /(COMPLETE|TRADED|FILLED)/.test(status);
  }).sort((a, b) => String(b.updatetime || b.exchtime || b.ordertime || '').localeCompare(String(a.updatetime || a.exchtime || a.ordertime || '')));

  const sell = sells[0];
  const exitPrice = firstNumber(sell?.averageprice, sell?.average_price, sell?.price);
  const entryPrice = firstNumber(logEntry.entryPrice, logEntry.price, entryOrder?.averageprice, entryOrder?.average_price, entryOrder?.price);
  const qty = Number(logEntry.qty || 0);
  const target = Number(logEntry.targetPrice || 0);
  const sl = Number(logEntry.slPrice || 0);
  let exitType = '';
  if (Number.isFinite(exitPrice)) {
    if (target && exitPrice >= target * 0.999) exitType = 'TARGET HIT';
    else if (sl && exitPrice <= sl * 1.001) exitType = 'SL HIT';
    else exitType = 'EXITED';
  }
  const realisedPnl = Number.isFinite(exitPrice) && Number.isFinite(entryPrice) && qty
    ? Number(((exitPrice - entryPrice) * qty).toFixed(2))
    : '';
  return {
    exitType,
    exitPrice: Number.isFinite(exitPrice) ? Number(exitPrice.toFixed(2)) : '',
    realisedPnl,
    rejectionReason,
    rawStatus: exitType ? 'ANGEL ONE EXIT COMPLETE' : (entryStatus || logEntry.status),
  };
}

function refreshAngelOneOrderLogStatus(callback) {
  const store = readBrokerTokenStore().brokers.angelone;
  const status = getBrokerTokenStatus('angelone');
  if (!store?.clientId || !store?.accountId || !store?.accessToken) return callback('No Angel One token saved');
  if (status.status === 'expired') return callback('Angel One token expired. Refresh token or paste fresh JWT in Settings.');
  const angelStore = { clientId: store.clientId, accountId: store.accountId };
  angelGet('/rest/secure/angelbroking/order/v1/getOrderBook', angelStore, store.accessToken, (err, res) => {
    if (err) return callback('Angel One order status failed: ' + err);
    if (!res || res.status >= 400 || res.data?.status === false) return callback('Angel One order status failed: ' + JSON.stringify(res?.data || {}));
    let changed = 0;
    const checkedAt = new Date().toISOString();
    const next = readOrderLog().map(entry => {
      if (String(entry.broker || '').toLowerCase() !== 'angelone' || !entry.orderId || ['N/A', 'ERROR', 'SKIPPED'].includes(entry.orderId)) return entry;
      const inferred = inferAngelOneExitFromOrderBook(entry, res.data);
      if ((inferred.exitType && inferred.exitType !== entry.exitType) || (inferred.rawStatus && inferred.rawStatus !== entry.status)) changed += 1;
      const hasFinalExit = !!inferred.exitType;
      return {
        ...entry,
        status: inferred.rawStatus || entry.status,
        exitType: inferred.exitType || entry.exitType || '',
        exitPrice: hasFinalExit ? inferred.exitPrice : (entry.exitPrice || ''),
        realisedPnl: hasFinalExit ? inferred.realisedPnl : (entry.realisedPnl || ''),
        rejectionReason: inferred.rejectionReason || entry.rejectionReason || '',
        lastStatusCheckAt: checkedAt,
      };
    });
    writeOrderLog(next);
    callback(null, { changed, data: next });
  });
}

function refreshBrokerOrderLogStatuses(callback) {
  const rows = readOrderLog();
  const brokers = [...new Set(rows.map(r => String(r.broker || 'dhan').toLowerCase()))];
  const tasks = [];
  if (brokers.includes('dhan')) tasks.push(refreshDhanOrderLogStatus);
  if (brokers.includes('zerodha')) tasks.push(refreshZerodhaOrderLogStatus);
  if (brokers.includes('upstox')) tasks.push(refreshUpstoxOrderLogStatus);
  if (brokers.includes('angelone')) tasks.push(refreshAngelOneOrderLogStatus);
  if (!tasks.length) return callback(null, { changed: 0, data: rows });
  let i = 0;
  let changed = 0;
  const errors = [];
  const next = () => {
    if (i >= tasks.length) {
      const data = readOrderLog();
      return callback(errors.length && !changed ? errors.join(' | ') : null, { changed, data, warnings: errors });
    }
    const task = tasks[i++];
    task((err, result) => {
      if (err) errors.push(err);
      if (result?.changed) changed += result.changed;
      next();
    });
  };
  next();
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
        const hasFinalExit = !!inferred.exitType;
        return {
          ...entry,
          status: inferred.rawStatus || entry.status,
          exitType: inferred.exitType,
          exitPrice: hasFinalExit ? inferred.exitPrice : '',
          realisedPnl: hasFinalExit ? inferred.realisedPnl : '',
          rejectionReason: inferred.rejectionReason || entry.rejectionReason || '',
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

// â”€â”€ Read access_token from Chrome â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Generic proxy â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Stockkar API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ TradingView Scanner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€ Dhan Super Order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let dhanSecurityCache = null;
let dhanSecurityCacheAt = 0;
let equityInstrumentCache = null;
let equityInstrumentCacheAt = 0;
let angelInstrumentCache = null;
let angelInstrumentCacheAt = 0;

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

function loadDhanSecurityMap(callback, forceRefresh) {
  const maxAge = 12 * 60 * 60 * 1000;
  if (!forceRefresh && dhanSecurityCache && Date.now() - dhanSecurityCacheAt < maxAge) return callback(null, dhanSecurityCache);

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
        if (exch && !['NSE', 'NSE_EQ', 'BSE', 'BSE_EQ'].includes(exch)) return;
        if (seg && !['E', 'EQ', 'NSE_EQ', 'BSE_EQ'].includes(seg)) return;
        const exchangeKey = exch.startsWith('BSE') ? 'BSE' : 'NSE';
        map[exchangeKey + ':' + symbol] = sec;
        if (!map[symbol] || exchangeKey === 'NSE' || series === 'EQ') map[symbol] = sec;
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
  if (!newToken) return 0;
  const schedule = readAlgoSchedule();
  let changed = 0;
  (schedule.jobs || []).forEach(job => {
    if (!job.config) return;
    if (!clientId || String(job.config.dhanClient) === String(clientId)) {
      job.config.dhanToken = newToken;
      job.config.dhanTokenRefreshedAt = new Date().toISOString();
      changed += 1;
    }
  });
  if (changed) writeAlgoSchedule(schedule);
  return changed;
}

function loadAngelInstrumentMap(callback) {
  const maxAge = 12 * 60 * 60 * 1000;
  if (angelInstrumentCache && Date.now() - angelInstrumentCacheAt < maxAge) return callback(null, angelInstrumentCache);
  https.get('https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json', res => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      if (res.statusCode >= 400) return callback('Angel One instrument master HTTP ' + res.statusCode);
      let rows;
      try { rows = JSON.parse(body); } catch (e) { return callback('Angel One instrument master parse failed: ' + e.message); }
      const map = {};
      (Array.isArray(rows) ? rows : []).forEach(row => {
        const exchange = String(row.exch_seg || '').toUpperCase();
        const symbol = String(row.symbol || '').toUpperCase();
        const name = String(row.name || '').replace(/\s/g, '').toUpperCase();
        const token = String(row.token || '').trim();
        if (!token || !symbol || !['NSE', 'BSE'].includes(exchange) || !symbol.endsWith('-EQ')) return;
        const cleanSymbol = symbol.replace(/-EQ$/, '').replace(/\s/g, '');
        map[exchange + ':' + cleanSymbol] = { token, tradingSymbol: symbol, exchange };
        if (!map[cleanSymbol] || exchange === 'NSE') map[cleanSymbol] = { token, tradingSymbol: symbol, exchange };
        if (name && !map[name]) map[name] = { token, tradingSymbol: symbol, exchange };
      });
      angelInstrumentCache = map;
      angelInstrumentCacheAt = Date.now();
      callback(null, map);
    });
  }).on('error', err => callback(err.message));
}

function updateScheduledBrokerToken(broker, clientId, newToken) {
  if (!newToken) return 0;
  const brokerId = String(broker || '').toLowerCase();
  const schedule = readAlgoSchedule();
  let changed = 0;
  (schedule.jobs || []).forEach(job => {
    if (!job.config || String(job.config.broker || 'dhan').toLowerCase() !== brokerId) return;
    if (clientId && job.config.dhanClient && String(job.config.dhanClient) !== String(clientId)) return;
    job.config.dhanClient = clientId || job.config.dhanClient;
    job.config.dhanToken = newToken;
    job.config.dhanTokenUpdatedAt = new Date().toISOString();
    if (job.lastResult?.status === 'failed' && String(job.lastResult.error || '').toLowerCase().includes('token')) {
      job.lastResult = { status: 'token-updated', at: new Date().toISOString() };
    }
    changed += 1;
  });
  if (changed) writeAlgoSchedule(schedule);
  return changed;
}

function readBrokerTokenStore() {
  try { return JSON.parse(fs.readFileSync(BROKER_TOKEN_FILE, 'utf8')); }
  catch { return { brokers: {} }; }
}

function writeBrokerTokenStore(data) {
  writePrivateJson(BROKER_TOKEN_FILE, { brokers: data.brokers || {} });
}

function saveBrokerToken(broker, payload) {
  const brokerId = String(broker || 'dhan').toLowerCase();
  const store = readBrokerTokenStore();
  const previous = store.brokers[brokerId] || {};
  const now = new Date().toISOString();
  const submittedAccessToken = payload.accessToken || payload.dhanToken || payload.token || '';
  const accessToken = submittedAccessToken || previous.accessToken;
  const clientId = payload.clientId || payload.dhanClient || payload.apiKey || previous.clientId;
  if (!clientId || (!accessToken && !['zerodha', 'upstox'].includes(brokerId))) return null;
  const saveSource = payload.source || 'settings';
  const effectiveRenewedAt = payload.renewedAt || (saveSource === 'settings' && submittedAccessToken ? now : previous.renewedAt || null);
  const savedAt = previous.accessToken === accessToken && previous.savedAt ? previous.savedAt : now;
  store.brokers[brokerId] = {
    broker: brokerId,
    clientId: String(clientId),
    accountId: payload.accountId || previous.accountId || '',
    accessToken: accessToken || '',
    refreshToken: payload.refreshToken || previous.refreshToken || '',
    feedToken: payload.feedToken || previous.feedToken || '',
    clientSecret: payload.clientSecret || previous.clientSecret || '',
    savedAt,
    updatedAt: now,
    renewedAt: effectiveRenewedAt,
    source: saveSource,
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

function nextUpstoxExpiryIso(store) {
  const base = new Date(store.renewedAt || store.savedAt || Date.now());
  const ist = new Date(base.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const expiryIst = new Date(ist);
  if (ist.getHours() >= 3 || (ist.getHours() === 3 && ist.getMinutes() >= 30)) expiryIst.setDate(expiryIst.getDate() + 1);
  expiryIst.setHours(3, 30, 0, 0);
  return new Date(expiryIst.getTime() - (5.5 * 60 * 60 * 1000)).toISOString();
}

function getBrokerTokenStatus(broker) {
  const brokerId = String(broker || 'dhan').toLowerCase();
  if (brokerId === 'dhan') return getDhanTokenStatus();
  const store = readBrokerTokenStore().brokers[brokerId];
  if (!store?.clientId || !store?.accessToken) {
    const canLoginRenew = ['zerodha', 'upstox'].includes(brokerId) && !!store?.clientId && !!store?.clientSecret;
    return {
      broker: brokerId,
      configured: false,
      credentialsConfigured: canLoginRenew,
      status: 'missing',
      canLoginRenew,
      loginUrl: canLoginRenew ? '/broker/' + brokerId + '/login' : null,
      callbackPath: ['zerodha', 'upstox'].includes(brokerId) ? '/broker/' + brokerId + '/callback' : null,
      message: canLoginRenew
        ? (brokerId === 'upstox' ? "Upstox credentials saved. Complete today's secure Upstox login." : "Kite credentials saved. Complete today's Zerodha login.")
        : 'No token saved.',
    };
  }
  const expiresAt = brokerId === 'zerodha'
    ? nextKiteExpiryIso(store)
    : brokerId === 'upstox'
      ? nextUpstoxExpiryIso(store)
    : new Date(new Date(store.renewedAt || store.updatedAt || store.savedAt).getTime() + (store.validityHours || 24) * 60 * 60 * 1000).toISOString();
  const minutesLeft = Math.floor((new Date(expiresAt).getTime() - Date.now()) / 60000);
  let status = 'active';
  if (minutesLeft <= 0) status = 'expired';
  else if (minutesLeft <= 120) status = 'near-expiry';
  if (store.lastRenewalError && status !== 'expired') status = 'renew-failed';
  const canAutoRenew = brokerId === 'angelone' && !!store.refreshToken && !!store.accountId;
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
    canLoginRenew: ['zerodha', 'upstox'].includes(brokerId) && !!store.clientSecret,
    loginUrl: ['zerodha', 'upstox'].includes(brokerId) ? '/broker/' + brokerId + '/login' : null,
    callbackPath: ['zerodha', 'upstox'].includes(brokerId) ? '/broker/' + brokerId + '/callback' : null,
    renewalTimeIst: canAutoRenew ? String(DHAN_RENEW_HOUR_IST).padStart(2, '0') + ':' + String(DHAN_RENEW_MINUTE_IST).padStart(2, '0') : null,
    lastRenewalDate: store.lastRenewalDate,
    lastRenewalAttemptAt: store.lastRenewalAttemptAt,
    lastRenewalError: store.lastRenewalError || null,
    message: brokerId === 'zerodha'
      ? 'Zerodha Kite requires a short daily login. Use Renew Zerodha Token after 6:00 AM IST.'
      : brokerId === 'angelone'
        ? (canAutoRenew ? 'Angel One token can auto-refresh using the saved refresh token.' : 'Angel One auto-refresh needs API key, client code, and refresh token.')
      : brokerId === 'upstox'
        ? 'Upstox requires secure daily authorization. Use Connect Upstox to renew the trading token.'
      : 'This broker token must be renewed manually.',
  };
}

function getAllBrokerTokenStatuses() {
  return {
    dhan: getDhanTokenStatus(),
    zerodha: getBrokerTokenStatus('zerodha'),
    upstox: getBrokerTokenStatus('upstox'),
    angelone: getBrokerTokenStatus('angelone'),
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
  const saveSource = source || 'settings';
  const effectiveRenewedAt = renewedAt || (saveSource === 'settings' ? now : previous.renewedAt || null);
  const savedAt = previous.token === token && previous.savedAt ? previous.savedAt : now;
  const next = {
    clientId: String(clientId),
    token,
    savedAt,
    updatedAt: now,
    renewedAt: effectiveRenewedAt,
    source: saveSource,
    validityHours: DHAN_TOKEN_VALIDITY_HOURS,
    lastRenewalDate: previous.lastRenewalDate || null,
    lastRenewalAttemptAt: previous.lastRenewalAttemptAt || null,
    lastRenewalError: null,
  };
  writeDhanTokenStore(next);
  saveBrokerToken('dhan', { clientId, accessToken: token, source: saveSource, renewedAt: effectiveRenewedAt, lastRenewalError: null });
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

function exchangeUpstoxAuthorizationCode(store, code, redirectUri, callback) {
  if (!store?.clientId || !store?.clientSecret || !code || !redirectUri) return callback('Upstox API key, client secret, authorization code, or redirect URL missing');
  const body = new URLSearchParams({
    code,
    client_id: store.clientId,
    client_secret: store.clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
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
      if (apiRes.statusCode >= 400 || !accessToken) {
        const msg = parsed?.errors?.[0]?.message || parsed?.message || parsed?.error_description || parsed?.error || data || ('HTTP ' + apiRes.statusCode);
        return callback('Upstox token exchange failed: ' + msg, null);
      }
      callback(null, { accessToken, profile: parsed });
    });
  });
  req.on('error', err => callback('Upstox token exchange failed: ' + err.message, null));
  req.write(body);
  req.end();
}

function angelHeaders(store, accessToken, contentLength) {
  return {
    ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}),
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': '00:00:00:00:00:00',
    'X-PrivateKey': store.clientId,
    ...(contentLength !== undefined ? { 'Content-Length': contentLength } : {}),
  };
}

function angelGet(pathname, store, accessToken, callback) {
  const req = https.request({
    hostname: 'apiconnect.angelone.in',
    port: 443,
    path: pathname,
    method: 'GET',
    headers: angelHeaders(store, accessToken, 0),
  }, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      callback(null, { status: apiRes.statusCode, data: parsed });
    });
  });
  req.on('error', err => callback(err.message, null));
  req.end();
}

function renewAngelOneToken(store, callback) {
  if (!store?.refreshToken || !store?.clientId || !store?.accountId) {
    return callback('Angel One API key, client code, or refresh token missing');
  }
  const body = JSON.stringify({ refreshToken: store.refreshToken });
  const req = https.request({
    hostname: 'apiconnect.angelone.in',
    port: 443,
    path: '/rest/auth/angelbroking/jwt/v1/generateTokens',
    method: 'POST',
    headers: angelHeaders(store, '', Buffer.byteLength(body)),
  }, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = {}; }
      const result = parsed?.data || {};
      const accessToken = result.jwtToken || result.accessToken;
      const refreshToken = result.refreshToken || store.refreshToken;
      const feedToken = result.feedToken || store.feedToken || '';
      if (apiRes.statusCode >= 400 || !accessToken || parsed?.status === false) {
        return callback('Angel One token renewal failed: ' + (parsed?.message || parsed?.errorcode || data || ('HTTP ' + apiRes.statusCode)), null);
      }
      callback(null, { accessToken, refreshToken, feedToken });
    });
  });
  req.on('error', err => callback('Angel One token renewal failed: ' + err.message, null));
  req.write(body);
  req.end();
}

function checkBrokerTokenRenewal() {
  const store = readBrokerTokenStore();
  const now = getIstNow();
  const dateKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const afterRenewalTime = now.getHours() > DHAN_RENEW_HOUR_IST || (now.getHours() === DHAN_RENEW_HOUR_IST && now.getMinutes() >= DHAN_RENEW_MINUTE_IST);
  if (!afterRenewalTime) return;
  ['angelone'].forEach(brokerId => {
    const brokerStore = store.brokers[brokerId];
    const renew = renewAngelOneToken;
    if (!brokerStore?.accessToken || !getBrokerTokenStatus(brokerId).canAutoRenew || brokerStore.lastRenewalDate === dateKey) return;
    const attemptAt = new Date().toISOString();
    renew(brokerStore, (err, tokenData) => {
      const latest = readBrokerTokenStore();
      const current = latest.brokers[brokerId] || brokerStore;
      current.lastRenewalAttemptAt = attemptAt;
      if (err) {
        current.lastRenewalError = err;
        latest.brokers[brokerId] = current;
        writeBrokerTokenStore(latest);
        console.log('[' + brokerId.toUpperCase() + ' TOKEN] renew failed: ' + err);
        return;
      }
      const renewed = saveBrokerToken(brokerId, {
        clientId: current.clientId,
        accountId: current.accountId,
        clientSecret: current.clientSecret,
        accessToken: tokenData.accessToken,
        refreshToken: tokenData.refreshToken,
        feedToken: tokenData.feedToken,
        source: 'daily-4pm',
        renewedAt: new Date().toISOString(),
        lastRenewalError: null,
      });
      renewed.lastRenewalDate = dateKey;
      renewed.lastRenewalAttemptAt = attemptAt;
      renewed.lastRenewalError = null;
      const finalStore = readBrokerTokenStore();
      finalStore.brokers[brokerId] = renewed;
      writeBrokerTokenStore(finalStore);
      updateScheduledBrokerToken(brokerId, current.clientId, tokenData.accessToken);
      console.log('[' + brokerId.toUpperCase() + ' TOKEN] renewed successfully');
    });
  });
}

function placeSuperOrder(orderParams, dhanClient, dhanToken, callback) {
  const entry = Number(orderParams.entryPrice);
  const sl = Number(orderParams.slPrice);
  const target = Number(orderParams.targetPrice);
  const qty = Number(orderParams.qty);
  const symbol = String(orderParams.symbol || '').replace(/\s/g, '').toUpperCase();
  const slTriggerBufferPct = Math.max(0, Number(orderParams.dhanSlTriggerBufferPct || orderParams.slTriggerBufferPct || 0));

  if (!dhanClient || !dhanToken) return callback('Dhan credentials missing. Save Client ID and access token in Settings first.', null);
  if (!symbol || !entry || !sl || !target || !qty) return callback('Missing order fields', null);
  if (!Number.isInteger(qty) || qty <= 0) return callback('Invalid quantity: Dhan order quantity must be a positive whole number', null);
  if (orderParams.action === 'BUY' && !(sl < entry && target > entry)) {
    return callback('Invalid BUY setup: SL must be below entry and target must be above entry', null);
  }
  if (target <= entry || (target - entry) < 0.05) return callback('Invalid target: target is too close to entry', null);
  if ((entry - sl) < 0.05) return callback('Invalid SL: stop-loss is too close to entry', null);
  const storedToken = readDhanTokenStore();
  const tokenStatus = getDhanTokenStatus();
  if (storedToken?.token === dhanToken && tokenStatus.status === 'expired') {
    return callback('Dhan token expired. Generate a fresh token and save Settings before placing orders.', null);
  }
  if (!orderParams.allowDuplicate && hasOpenSameDayDhanOrder(symbol)) {
    return callback('Safety block: open Dhan order already exists today for ' + symbol + '. Refresh Order Log or cancel/close broker order before placing again.', null);
  }

  const resolveSecurityId = (forceRefresh, done) => loadDhanSecurityMap((lookupErr, securityMap) => {
    if (lookupErr) return callback('Security lookup failed: ' + lookupErr, null);
    const exchange = orderParams.exchange === 'BSE' ? 'BSE' : 'NSE';
    const securityId = orderParams.securityId || (securityMap && (securityMap[exchange + ':' + symbol] || securityMap[symbol]));
    if (!securityId && !forceRefresh) return resolveSecurityId(true, done);
    if (!securityId) return callback('Security ID not found for ' + symbol + ' after refreshing Dhan instrument master', null);
    done(securityId);
  }, forceRefresh);

  resolveSecurityId(false, (securityId) => {
    const trailPct = Number(orderParams.trailSL || 0);
    const brokerStopLossPrice = orderParams.action === 'BUY' && slTriggerBufferPct > 0
      ? Math.min(entry - 0.05, sl * (1 + slTriggerBufferPct / 100))
      : sl;
    if (!(brokerStopLossPrice < entry)) return callback('Invalid Dhan SL trigger: protective SL must remain below entry price', null);
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
      stopLossPrice:    roundPrice(brokerStopLossPrice),
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
        if (apiRes.statusCode >= 400) return callback(dhanApiMessage(p, 'Dhan order failed with HTTP ' + apiRes.statusCode), { status: apiRes.statusCode, data: p, request: JSON.parse(body) });
        callback(null, { status: apiRes.statusCode, data: p, request: JSON.parse(body) });
      });
    });
    req.on('error', err => callback(err.message, null));
    req.write(body); req.end();
  });
}

function kiteRequest(method, pathname, apiKey, accessToken, form, callback) {
  const body = new URLSearchParams(form || {}).toString();
  const req = https.request({
    hostname: 'api.kite.trade',
    port: 443,
    path: pathname,
    method,
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
      callback(null, { status: apiRes.statusCode, data: parsed, request: form || {} });
    });
  });
  req.on('error', err => callback(err.message, null));
  if (body) req.write(body);
  req.end();
}

function kitePost(pathname, apiKey, accessToken, form, callback) {
  kiteRequest('POST', pathname, apiKey, accessToken, form, callback);
}

function kitePut(pathname, apiKey, accessToken, form, callback) {
  kiteRequest('PUT', pathname, apiKey, accessToken, form, callback);
}

function exchangeKiteRequestToken(apiKey, apiSecret, requestToken, callback) {
  const checksum = crypto.createHash('sha256').update(String(apiKey) + String(requestToken) + String(apiSecret)).digest('hex');
  const body = new URLSearchParams({
    api_key: apiKey,
    request_token: requestToken,
    checksum,
  }).toString();
  const req = https.request({
    hostname: 'api.kite.trade',
    port: 443,
    path: '/session/token',
    method: 'POST',
    headers: {
      'X-Kite-Version': '3',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(body),
    },
  }, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      let parsed;
      try { parsed = JSON.parse(data); } catch { parsed = {}; }
      const accessToken = parsed?.data?.access_token || parsed?.access_token;
      if (apiRes.statusCode >= 400 || !accessToken) {
        return callback(parsed?.message || parsed?.error_type || 'Kite token exchange failed', null);
      }
      callback(null, { accessToken, profile: parsed.data || parsed });
    });
  });
  req.on('error', err => callback('Kite token exchange failed: ' + err.message, null));
  req.write(body);
  req.end();
}

function requestPublicOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const localHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host);
  const protocol = forwardedProto || (localHost ? 'http' : 'https');
  return protocol + '://' + host;
}

function modifyDhanSuperOrderStopLoss(entry, nextSl, callback) {
  const store = readDhanTokenStore();
  const orderId = String(entry.orderId || '').trim();
  if (!store?.token) return callback('No Dhan token saved');
  if (!orderId || ['N/A', 'ERROR', 'SKIPPED'].includes(orderId.toUpperCase())) return callback('No Dhan order ID available');
  const body = JSON.stringify({
    orderId,
    stopLossPrice: roundPrice(nextSl),
    targetPrice: roundPrice(entry.targetPrice || 0),
    trailingJump: 0,
  });
  const req = https.request({
    hostname: 'api.dhan.co',
    port: 443,
    path: '/v2/super/orders/' + encodeURIComponent(orderId),
    method: 'PUT',
    headers: { 'access-token': store.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, apiRes => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      if (apiRes.statusCode >= 400) return callback(dhanApiMessage(parsed, 'Dhan SL modify failed with HTTP ' + apiRes.statusCode), { status: apiRes.statusCode, data: parsed, request: JSON.parse(body) });
      callback(null, { status: apiRes.statusCode, data: parsed, request: JSON.parse(body) });
    });
  });
  req.on('error', err => callback('Dhan SL modify failed: ' + err.message, null));
  req.write(body);
  req.end();
}

function modifyZerodhaGttStopLoss(entry, nextSl, callback) {
  const store = readBrokerTokenStore().brokers.zerodha;
  const ids = parseZerodhaOrderIds(entry.orderId);
  const apiKey = store?.clientId;
  const accessToken = store?.accessToken;
  const symbol = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const qty = Number(entry.qty || 0);
  const target = Number(entry.targetPrice || 0);
  const entryPrice = Number(entry.entryPrice || entry.price || 0);
  if (!apiKey || !accessToken) return callback('No Zerodha token saved');
  if (!ids.gttId) return callback('No Zerodha GTT ID available');
  if (!symbol || !qty || !target || !entryPrice) return callback('Missing Zerodha trailing order fields');
  const exchange = entry.exchange || 'NSE';
  const product = entry.segment === 'INTRADAY' ? 'MIS' : 'CNC';
  const gttForm = {
    type: 'two-leg',
    condition: JSON.stringify({
      exchange,
      tradingsymbol: symbol,
      trigger_values: [roundPrice(nextSl), roundPrice(target)],
      last_price: roundPrice(entryPrice),
    }),
    orders: JSON.stringify([
      {
        exchange,
        tradingsymbol: symbol,
        transaction_type: 'SELL',
        quantity: qty,
        order_type: 'LIMIT',
        product,
        price: roundPrice(nextSl * 0.995),
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
  kitePut('/gtt/triggers/' + encodeURIComponent(ids.gttId), apiKey, accessToken, gttForm, (err, res) => {
    if (err) return callback(err, null);
    if (res.status >= 400) return callback('Zerodha GTT SL modify failed: ' + JSON.stringify(res.data), res);
    callback(null, res);
  });
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

// â”€â”€ Server â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

function isStockRowCandidate(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const keys = Object.keys(row).map(k => k.toLowerCase());
  return keys.some(k => [
    'symbol','nsecode','ticker','tradingsymbol','trading_symbol','company','company_name','companyname','compname','name','fincode','live_price','ltp','close_price','market_cap'
  ].includes(k));
}

function pickStockRowsFromPayload(payload, depth = 0) {
  if (depth > 5 || payload == null) return [];
  if (Array.isArray(payload)) {
    const objects = payload.filter(item => item && typeof item === 'object' && !Array.isArray(item));
    if (objects.length && objects.some(isStockRowCandidate)) return objects;
    for (const item of payload) {
      const nested = pickStockRowsFromPayload(item, depth + 1);
      if (nested.length) return nested;
    }
    return [];
  }
  if (typeof payload !== 'object') return [];
  const preferred = ['data', 'stocks', 'results', 'rows', 'items', 'list'];
  for (const key of preferred) {
    const nested = pickStockRowsFromPayload(payload[key], depth + 1);
    if (nested.length) return nested;
  }
  for (const value of Object.values(payload)) {
    const nested = pickStockRowsFromPayload(value, depth + 1);
    if (nested.length) return nested;
  }
  return [];
}

function fetchSavedFilterDirect(filterId, token, limit, callback) {
  const max = Math.min(Number(limit) || STOCKKAR_MAX_LIMIT, STOCKKAR_MAX_LIMIT);
  const id = encodeURIComponent(String(filterId || '').trim());
  if (!id) return callback(null, null);

  const candidates = [
    `/api/saved-filter/slug/${id}/stocks?include_technicals=true`,
    `/api/saved-filter/${id}/stocks?include_technicals=true`,
  ];

  const fetchPage = (basePath, offset, rows, done) => {
    const sep = basePath.includes('?') ? '&' : '?';
    const apiPath = `${basePath}${sep}limit=${max}&offset=${offset}`;
    stockkarGet(apiPath, token, (err, r) => {
      if (err) return done(null, { err, rows, response: r });
      const pageRows = pickStockRowsFromPayload(r?.data);
      const nextRows = rows.concat(pageRows);
      if (pageRows.length === max) return fetchPage(basePath, offset + max, nextRows, done);
      done(null, { rows: nextRows, response: r, sourcePath: basePath });
    });
  };

  const tryCandidate = (index, lastError) => {
    if (index >= candidates.length) return callback(null, null, lastError);
    fetchPage(candidates[index], 0, [], (err, result) => {
      if (err) return callback(err);
      if (result?.rows?.length) {
        return callback(null, {
          status: result.response?.status || 200,
          data: result.rows,
          sourcePath: result.sourcePath,
        });
      }
      tryCandidate(index + 1, result?.err || lastError);
    });
  };

  tryCandidate(0, null);
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

function findTechnicalField(row, normalizedKeys) {
  if (!row) return undefined;
  const wanted = new Set(normalizedKeys.map(normalizeKey));
  const found = Object.keys(row).find(key => wanted.has(normalizeKey(key)));
  return found ? row[found] : undefined;
}

function getFearlessIndicatorData(row) {
  const value = numberFromValue(findTechnicalField(row, ['supertrend', 'super_trend']));
  const signal = String(findTechnicalField(row, ['supertrend_signal', 'super_trend_signal']) || '').trim().toLowerCase();
  const pct = numberFromValue(findTechnicalField(row, ['supertrend_pct', 'super_trend_pct']));
  return { value, signal, pct };
}

function getIndicatorValue(indicator, stock, row) {
  const key = String(indicator || '').toLowerCase();
  const emaMatch = key.match(/^ema(\d+)$/);
  if (emaMatch) {
    const period = Number(emaMatch[1]);
    return stock.ema?.[period] || stock['ema' + period];
  }
  if (key === 'fearless_indicator') return getFearlessIndicatorData(row).value;
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
      const fearless = String(filter.indicator || '').toLowerCase() === 'fearless_indicator'
        ? getFearlessIndicatorData(row)
        : null;
      const distancePct = fearless ? fearless.pct : (value ? ((ltp - value) / value) * 100 : NaN);
      const bullish = !fearless || fearless.signal === 'bullish';
      const pass = bullish && Number.isFinite(distancePct) && distancePct >= 0 && distancePct <= withinPct;
      const label = indicatorLabel(filter.indicator);
      const signalText = fearless ? ' ' + (fearless.signal || 'signal missing') + ' |' : '';
      const distanceText = Number.isFinite(distancePct)
        ? (distancePct >= 0 ? '+' : '') + distancePct.toFixed(2)
        : 'missing';
      return {
        indicator: filter.indicator,
        value,
        withinPct,
        distancePct,
        signal: fearless?.signal || null,
        pass,
        text: label + signalText + ' ' + distanceText + '% <= ' + withinPct + '%',
      };
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

function resolveScheduledBrokerCredentials(cfg) {
  const broker = String(cfg.broker || 'dhan').toLowerCase();
  if (broker === 'dhan') {
    const stored = readDhanTokenStore();
    if (stored?.token && (!cfg.dhanClient || String(stored.clientId) === String(cfg.dhanClient))) {
      cfg.dhanClient = stored.clientId;
      cfg.dhanToken = stored.token;
    }
    const status = getDhanTokenStatus();
    if (!cfg.dhanClient || !cfg.dhanToken) return { broker, error: 'No Dhan credentials saved in schedule' };
    if (status.configured && status.status === 'expired' && String(status.clientId) === String(cfg.dhanClient)) {
      return { broker, error: 'Dhan token expired. Generate a fresh token and save Settings.' };
    }
    return { broker, credentials: { dhanClient: cfg.dhanClient, dhanToken: cfg.dhanToken, accessToken: cfg.dhanToken } };
  }
  if (broker === 'zerodha') {
    const stored = readBrokerTokenStore().brokers.zerodha;
    if (stored?.accessToken && (!cfg.dhanClient || String(stored.clientId) === String(cfg.dhanClient))) {
      cfg.dhanClient = stored.clientId;
      cfg.dhanToken = stored.accessToken;
    }
    const status = getBrokerTokenStatus('zerodha');
    if (!cfg.dhanClient || !cfg.dhanToken) return { broker, error: 'No Zerodha Kite API key/access token saved in schedule' };
    if (status.configured && status.status === 'expired' && String(status.clientId) === String(cfg.dhanClient)) {
      return { broker, error: 'Zerodha token expired. Generate today access token and save Settings.' };
    }
    return {
      broker,
      credentials: {
        apiKey: cfg.dhanClient,
        accessToken: cfg.dhanToken,
        zerodhaApiKey: cfg.dhanClient,
        zerodhaAccessToken: cfg.dhanToken,
      },
    };
  }
  if (broker === 'upstox') {
    const stored = readBrokerTokenStore().brokers.upstox;
    const status = getBrokerTokenStatus('upstox');
    if (!stored?.clientId || !stored?.accessToken) return { broker, error: 'No Upstox API key/access token saved. Complete today Upstox login in Settings.' };
    if (status.status === 'expired') return { broker, error: 'Upstox token expired. Complete today secure Upstox login in Settings.' };
    return {
      broker,
      credentials: {
        apiKey: stored.clientId,
        clientId: stored.clientId,
        accessToken: stored.accessToken,
        upstoxToken: stored.accessToken,
      },
    };
  }
  if (broker === 'angelone') {
    const stored = readBrokerTokenStore().brokers.angelone;
    const status = getBrokerTokenStatus('angelone');
    if (!stored?.clientId || !stored?.accountId || !stored?.accessToken) return { broker, error: 'No Angel One API key/client code/JWT token saved' };
    if (status.status === 'expired') return { broker, error: 'Angel One token expired. Save a fresh JWT token or refresh token.' };
    return {
      broker,
      credentials: {
        apiKey: stored.clientId,
        clientId: stored.clientId,
        accountId: stored.accountId,
        accessToken: stored.accessToken,
      },
    };
  }
  return { broker, error: 'Scheduled auto-run for ' + broker + ' is not implemented yet.' };
}

function extractPlacedOrderId(broker, orderRes) {
  const data = orderRes?.data || {};
  if (broker === 'zerodha') {
    const entryId = data.entry?.data?.order_id || data.entry?.order_id || data.entry?.data?.orderId || '';
    const gttId = data.gtt?.data?.trigger_id || data.gtt?.trigger_id || data.gtt?.data?.triggerId || '';
    return [entryId && ('ENTRY:' + entryId), gttId && ('GTT:' + gttId)].filter(Boolean).join(' | ') || 'N/A';
  }
  if (broker === 'angelone') return data?.data?.orderid || data?.orderid || data?.data?.orderId || 'N/A';
  if (broker === 'upstox') {
    const ids = data?.data?.gtt_order_ids || data?.gtt_order_ids;
    return (Array.isArray(ids) && ids.length ? ids.join(' | ') : data?.data?.gtt_order_id || data?.data?.order_id || data?.gtt_order_id || data?.order_id) || 'N/A';
  }
  return data.orderId || data.order_id || data.data?.orderId || 'N/A';
}

function scheduledOrderStatusText(broker, orderErr, orderRes) {
  if (orderErr) return orderErr;
  if (orderRes?.status && orderRes.status >= 400) return JSON.stringify(orderRes?.data || {});
  if (broker === 'zerodha') return 'ZERODHA ENTRY + GTT';
  if (broker === 'upstox') return 'UPSTOX GTT ENTRY + TARGET + SL';
  if (broker === 'angelone') return 'ANGEL ONE ROBO ORDER';
  return 'SUPER ORDER';
}

function istDateKey(date = getIstNow()) {
  return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}

function afterEmaTrailingTime(now = getIstNow()) {
  return now.getHours() > EMA_TRAILING_CHECK_HOUR_IST ||
    (now.getHours() === EMA_TRAILING_CHECK_HOUR_IST && now.getMinutes() >= EMA_TRAILING_CHECK_MINUTE_IST);
}

function isEmaTrailingCandidate(entry, dateKey) {
  const broker = String(entry.broker || 'dhan').toLowerCase();
  if (!['dhan', 'zerodha'].includes(broker)) return false;
  if (!entry.emaTrailingEnabled) return false;
  if (String(entry.emaTrailingTrigger || 'afterTarget') !== 'afterTarget') return false;
  if (String(entry.action || 'BUY').toUpperCase() !== 'BUY') return false;
  if (entry.emaTrailingLastDate === dateKey) return false;
  if (!isOpenOrderLogEntry(entry)) return false;
  return !!String(entry.orderId || '').trim();
}

function trailingEmaValue(entry, tvRow) {
  const indicator = String(entry.emaTrailingIndicator || 'ema20').toLowerCase();
  const match = indicator.match(/^ema(\d+)$/);
  if (!match) return NaN;
  return Number(tvRow?.ema?.[match[1]] ?? tvRow?.[indicator]);
}

function modifyBrokerTrailingStop(entry, nextSl, callback) {
  const broker = String(entry.broker || 'dhan').toLowerCase();
  if (broker === 'dhan') return modifyDhanSuperOrderStopLoss(entry, nextSl, callback);
  if (broker === 'zerodha') return modifyZerodhaGttStopLoss(entry, nextSl, callback);
  callback('EMA trailing not implemented for ' + broker);
}

function checkDailyEmaTrailing() {
  const now = getIstNow();
  if (!afterEmaTrailingTime(now)) return;
  const dateKey = istDateKey(now);
  const rows = readOrderLog();
  const candidates = rows.filter(entry => isEmaTrailingCandidate(entry, dateKey));
  if (!candidates.length) return;
  const symbols = [...new Set(candidates.map(entry => String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase()).filter(Boolean))];
  if (!symbols.length) return;

  fetchTVData(symbols, (tvErr, tvData) => {
    const checkedAt = new Date().toISOString();
    const tvBySymbol = {};
    (tvData || []).forEach(row => {
      const key = String(row.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
      if (key) tvBySymbol[key] = row;
    });
    let nextRows = readOrderLog();
    const updateEntry = (id, patch) => {
      nextRows = nextRows.map(row => row.id === id ? { ...row, ...patch } : row);
      writeOrderLog(nextRows);
    };

    if (tvErr) {
      candidates.forEach(entry => updateEntry(entry.id, {
        emaTrailingLastDate: dateKey,
        lastTrailCheckAt: checkedAt,
        emaTrailingStatus: 'failed',
        lastTrailError: 'TV data failed: ' + tvErr,
      }));
      return;
    }

    const processNext = (i) => {
      if (i >= candidates.length) return;
      const entry = candidates[i];
      const symbol = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
      const tvRow = tvBySymbol[symbol];
      const ltp = Number(tvRow?.ltp || 0);
      const target = Number(entry.targetPrice || 0);
      const currentSl = Math.max(
        Number(entry.lastTrailSlPrice || 0),
        Number(entry.brokerSlPrice || 0),
        Number(entry.slPrice || 0)
      );
      const armed = !!entry.emaTrailingArmedAt || (target > 0 && ltp >= target);
      if (!armed) {
        updateEntry(entry.id, {
          emaTrailingLastDate: dateKey,
          lastTrailCheckAt: checkedAt,
          emaTrailingStatus: 'waiting-target',
          lastTrailError: '',
        });
        return processNext(i + 1);
      }

      const ema = trailingEmaValue(entry, tvRow);
      const pct = Number(entry.emaTrailingPct || 0);
      const nextSl = Number.isFinite(ema) && pct >= 0 ? roundPrice(ema * (1 - pct / 100)) : NaN;
      if (!Number.isFinite(nextSl) || nextSl <= 0) {
        updateEntry(entry.id, {
          emaTrailingArmedAt: entry.emaTrailingArmedAt || checkedAt,
          emaTrailingLastDate: dateKey,
          lastTrailCheckAt: checkedAt,
          emaTrailingStatus: 'failed',
          lastTrailError: 'EMA value unavailable for ' + (entry.emaTrailingIndicator || 'EMA'),
        });
        return processNext(i + 1);
      }
      if (currentSl && nextSl <= currentSl) {
        updateEntry(entry.id, {
          emaTrailingArmedAt: entry.emaTrailingArmedAt || checkedAt,
          emaTrailingLastDate: dateKey,
          lastTrailCheckAt: checkedAt,
          emaTrailingStatus: 'no-raise',
          lastTrailError: '',
        });
        return processNext(i + 1);
      }

      modifyBrokerTrailingStop(entry, nextSl, (err, res) => {
        updateEntry(entry.id, {
          emaTrailingArmedAt: entry.emaTrailingArmedAt || checkedAt,
          emaTrailingLastDate: dateKey,
          lastTrailCheckAt: checkedAt,
          emaTrailingStatus: err ? 'failed' : 'trailed',
          lastTrailSlPrice: err ? (entry.lastTrailSlPrice || '') : nextSl,
          brokerSlPrice: err ? entry.brokerSlPrice : nextSl,
          status: err ? entry.status : ((entry.status || '') + ' | EMA TRAIL SL ' + nextSl).trim(),
          lastTrailError: err || '',
          trailingModifyResponse: err ? entry.trailingModifyResponse : res?.data || '',
        });
        processNext(i + 1);
      });
    };
    processNext(0);
  });
}

function runScheduledAlgo(job, callback) {
  const cfg = job.config || {};
  const tradedToday = new Set(Array.isArray(job.tradedSymbols) ? job.tradedSymbols.map(s => String(s).toUpperCase()) : []);
  const maxTrades = Number(cfg.maxTrades || 0);
  const remainingTrades = maxTrades > 0 ? Math.max(0, maxTrades - tradedToday.size) : Infinity;
  const token = cfg.stockkarToken || cfg.skToken;
  if (!token) return callback('No Stockkar token saved in schedule');
  const testMode = !!cfg.testMode;
  const brokerContext = testMode ? { broker: cfg.broker || 'dhan', credentials: {} } : resolveScheduledBrokerCredentials(cfg);
  if (brokerContext.error) return callback(brokerContext.error);
  const broker = brokerContext.broker;
  const credentials = brokerContext.credentials;
  const logScreenerName = cfg.screenerSourceName || cfg.screenerName || cfg.screenerSlug || '';
  const logEntryCriteria = cfg.entryCriteria || describeEntryCriteria(cfg.entryFilters);
  const logExitCriteria = cfg.exitCriteria || describeExitCriteria(cfg);

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
        if (testMode) {
          results.push({ symbol: sym, ok: true, testMode: true, status: 'TEST MODE - NO ORDER PLACED' });
          appendTestOrderLog({
            recordedAt: new Date().toISOString(),
            symbol: sym,
            action: 'BUY',
            qty: stock.qty,
            price: stock.entryPrice,
            entryPrice: stock.entryPrice,
            slPrice: stock.slPrice,
            brokerSlPrice: '',
            targetPrice: stock.targetPrice,
            rr: stock.rr,
            screenerName: logScreenerName,
            entryCriteria: logEntryCriteria,
            exitCriteria: logExitCriteria,
            emaTrailingEnabled: !!cfg.emaTrailingEnabled,
            emaTrailingIndicator: cfg.emaTrailingIndicator || '',
            emaTrailingPct: cfg.emaTrailingPct ?? '',
            emaTrailingTimeframe: cfg.emaTrailingTimeframe || '',
            emaTrailingTrigger: cfg.emaTrailingTrigger || '',
            orderId: 'TEST-' + Date.now() + '-' + String(i + 1).padStart(2, '0'),
            rejectionReason: '',
            status: 'TEST MODE - NO ORDER PLACED',
            result: 'TEST MODE',
            source: 'test',
            broker,
            exchange: cfg.exchange || 'NSE',
            segment: cfg.segment || 'CNC',
          });
          return placeNext(i + 1);
        }

        placeBrokerSuperOrder({
          broker,
          credentials,
          order: {
          symbol: sym,
          action: 'BUY',
          exchange: cfg.exchange || 'NSE',
          segment: cfg.segment || 'CNC',
          qty: stock.qty,
          entryPrice: stock.entryPrice,
          slPrice: stock.slPrice,
          targetPrice: stock.targetPrice,
          trailSL: cfg.trailSL || 0,
          dhanSlTriggerBufferPct: cfg.dhanSlTriggerBufferPct || 0,
          },
        }, (orderErr, orderRes) => {
          results.push({
            symbol: sym,
            ok: !orderErr,
            error: orderErr || null,
            status: orderRes?.status,
            data: orderRes?.data,
          });
          const orderId = extractPlacedOrderId(broker, orderRes);
          const brokerSlPrice = broker === 'dhan' ? orderRes?.request?.stopLossPrice : '';
          const rejectionReason = orderErr || (orderRes?.status >= 400 ? dhanApiMessage(orderRes?.data, '') : '');
          appendOrderLog({
            recordedAt: new Date().toISOString(),
            symbol: sym,
            action: 'BUY',
            qty: stock.qty,
            price: stock.entryPrice,
            entryPrice: stock.entryPrice,
            slPrice: stock.slPrice,
            brokerSlPrice,
            targetPrice: stock.targetPrice,
            rr: stock.rr,
            screenerName: logScreenerName,
            entryCriteria: logEntryCriteria,
            exitCriteria: logExitCriteria,
            emaTrailingEnabled: !!cfg.emaTrailingEnabled,
            emaTrailingIndicator: cfg.emaTrailingIndicator || '',
            emaTrailingPct: cfg.emaTrailingPct ?? '',
            emaTrailingTimeframe: cfg.emaTrailingTimeframe || '',
            emaTrailingTrigger: cfg.emaTrailingTrigger || '',
            orderId,
            rejectionReason,
            status: scheduledOrderStatusText(broker, orderErr, orderRes),
            source: 'auto',
            broker,
            exchange: cfg.exchange || 'NSE',
            segment: cfg.segment || 'CNC',
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
        if (testMode) {
          results.push({ symbol: sym, ok: true, testMode: true, status: 'TEST MODE - NO ORDER PLACED' });
          appendTestOrderLog({
            recordedAt: new Date().toISOString(),
            symbol: sym,
            action: 'BUY',
            qty: stock.qty,
            price: stock.entryPrice,
            entryPrice: stock.entryPrice,
            slPrice: stock.slPrice,
            brokerSlPrice: '',
            targetPrice: stock.targetPrice,
            rr: stock.rr,
            screenerName: logScreenerName,
            entryCriteria: logEntryCriteria,
            exitCriteria: logExitCriteria,
            emaTrailingEnabled: !!cfg.emaTrailingEnabled,
            emaTrailingIndicator: cfg.emaTrailingIndicator || '',
            emaTrailingPct: cfg.emaTrailingPct ?? '',
            emaTrailingTimeframe: cfg.emaTrailingTimeframe || '',
            emaTrailingTrigger: cfg.emaTrailingTrigger || '',
            orderId: 'TEST-' + Date.now() + '-' + String(i + 1).padStart(2, '0'),
            rejectionReason: '',
            status: 'TEST MODE - NO ORDER PLACED',
            result: 'TEST MODE',
            source: 'test',
            broker,
          });
          return placeNext(i + 1);
        }

        placeBrokerSuperOrder({
          broker,
          credentials,
          order: {
          symbol: sym,
          action: 'BUY',
          exchange: cfg.exchange || 'NSE',
          segment: cfg.segment || 'CNC',
          qty: stock.qty,
          entryPrice: stock.entryPrice,
          slPrice: stock.slPrice,
          targetPrice: stock.targetPrice,
          trailSL: cfg.trailSL || 0,
          dhanSlTriggerBufferPct: cfg.dhanSlTriggerBufferPct || 0,
          },
        }, (orderErr, orderRes) => {
          results.push({
            symbol: sym,
            ok: !orderErr,
            error: orderErr || null,
            status: orderRes?.status,
            data: orderRes?.data,
          });
          const orderId = extractPlacedOrderId(broker, orderRes);
          const brokerSlPrice = broker === 'dhan' ? orderRes?.request?.stopLossPrice : '';
          const rejectionReason = orderErr || (orderRes?.status >= 400 ? dhanApiMessage(orderRes?.data, '') : '');
          appendOrderLog({
            recordedAt: new Date().toISOString(),
            symbol: sym,
            action: 'BUY',
            qty: stock.qty,
            price: stock.entryPrice,
            entryPrice: stock.entryPrice,
            slPrice: stock.slPrice,
            brokerSlPrice,
            targetPrice: stock.targetPrice,
            rr: stock.rr,
            screenerName: logScreenerName,
            entryCriteria: logEntryCriteria,
            exitCriteria: logExitCriteria,
            emaTrailingEnabled: !!cfg.emaTrailingEnabled,
            emaTrailingIndicator: cfg.emaTrailingIndicator || '',
            emaTrailingPct: cfg.emaTrailingPct ?? '',
            emaTrailingTimeframe: cfg.emaTrailingTimeframe || '',
            emaTrailingTrigger: cfg.emaTrailingTrigger || '',
            orderId,
            rejectionReason,
            status: scheduledOrderStatusText(broker, orderErr, orderRes),
            source: 'auto',
            broker,
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
  const sl = Number(orderParams.slPrice || 0);
  const target = Number(orderParams.targetPrice || 0);
  if (!symbol || !qty || !entry || !sl || !target) return callback('Missing Upstox GTT order fields', null);
  if (!accessToken) return callback('Missing Upstox access token', null);
  if (!(sl < entry && target > entry)) return callback('Invalid Upstox BUY setup: SL must be below entry and target above entry', null);

  loadEquityInstrumentMap((lookupErr, instrumentMap) => {
    if (lookupErr) return callback('Instrument lookup failed: ' + lookupErr, null);
    const instrumentKey = orderParams.instrumentKey || instrumentMap?.[symbol]?.upstoxInstrumentKey;
    if (!instrumentKey) return callback('Upstox instrument key not found for ' + symbol, null);

    const productMap = { CNC: 'D', INTRADAY: 'I', MTF: 'MTF' };
    const trailingGap = Number(orderParams.trailSL || 0) > 0
      ? roundPrice(entry * Number(orderParams.trailSL) / 100)
      : 0;
    const stopRule = { strategy: 'STOPLOSS', trigger_type: 'IMMEDIATE', trigger_price: roundPrice(sl) };
    if (trailingGap > 0) stopRule.trailing_gap = trailingGap;
    const body = JSON.stringify({
      type: 'MULTIPLE',
      quantity: qty,
      product: productMap[orderParams.segment] || 'D',
      rules: [
        { strategy: 'ENTRY', trigger_type: 'ABOVE', trigger_price: roundPrice(entry) },
        { strategy: 'TARGET', trigger_type: 'IMMEDIATE', trigger_price: roundPrice(target) },
        stopRule,
      ],
      instrument_token: instrumentKey,
      transaction_type: orderParams.action || 'BUY',
    });

    const req = https.request({
      hostname: 'api.upstox.com',
      port: 443,
      path: '/v3/order/gtt/place',
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
        if (apiRes.statusCode >= 400 || parsed?.status === 'error') {
          const message = parsed?.errors?.[0]?.message || parsed?.message || data || ('HTTP ' + apiRes.statusCode);
          return callback('Upstox GTT order failed: ' + message, { status: apiRes.statusCode, data: parsed, request: JSON.parse(body) });
        }
        callback(null, { status: apiRes.statusCode, data: parsed, request: JSON.parse(body) });
      });
    });
    req.on('error', err => callback(err.message, null));
    req.write(body);
    req.end();
  });
}

function placeAngelOneOrder(orderParams, credentials, callback) {
  const store = {
    clientId: credentials?.apiKey || credentials?.clientId,
    accountId: credentials?.accountId,
  };
  const accessToken = credentials?.accessToken;
  const symbol = String(orderParams.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const qty = Number(orderParams.qty);
  const entry = Number(orderParams.entryPrice || orderParams.price || 0);
  if (!store.clientId || !store.accountId || !accessToken) return callback('Missing Angel One API key, client code, or JWT token', null);
  if (!symbol || !qty) return callback('Missing Angel One order fields', null);

  loadAngelInstrumentMap((lookupErr, instrumentMap) => {
    if (lookupErr) return callback('Angel One instrument lookup failed: ' + lookupErr, null);
    const exchange = orderParams.exchange === 'BSE' ? 'BSE' : 'NSE';
    const instrument = instrumentMap?.[exchange + ':' + symbol] || instrumentMap?.[symbol];
    if (!instrument?.token) return callback('Angel One symbol token not found for ' + symbol, null);
    const orderType = entry > 0 ? 'LIMIT' : 'MARKET';
    const body = JSON.stringify({
      variety: 'NORMAL',
      tradingsymbol: instrument.tradingSymbol,
      symboltoken: instrument.token,
      transactiontype: orderParams.action || 'BUY',
      exchange: instrument.exchange || exchange,
      ordertype: orderType,
      producttype: orderParams.segment === 'INTRADAY' ? 'INTRADAY' : 'DELIVERY',
      duration: 'DAY',
      price: orderType === 'LIMIT' ? String(roundPrice(entry)) : '0',
      squareoff: '0',
      stoploss: '0',
      quantity: String(qty),
    });
    const req = https.request({
      hostname: 'apiconnect.angelone.in',
      port: 443,
      path: '/rest/secure/angelbroking/order/v1/placeOrder',
      method: 'POST',
      headers: angelHeaders(store, accessToken, Buffer.byteLength(body)),
    }, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
        if (apiRes.statusCode >= 400 || parsed?.status === false) {
          return callback('Angel One order failed: ' + (parsed?.message || parsed?.errorcode || data || ('HTTP ' + apiRes.statusCode)), { status: apiRes.statusCode, data: parsed, request: JSON.parse(body) });
        }
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
    ...(brokerId !== 'dhan' && storedBroker ? { clientId: storedBroker.clientId, accountId: storedBroker.accountId, accessToken: storedBroker.accessToken, apiKey: storedBroker.clientId, zerodhaApiKey: storedBroker.clientId, zerodhaAccessToken: storedBroker.accessToken, upstoxToken: storedBroker.accessToken } : {}),
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
  if (brokerId === 'angelone') {
    return placeAngelOneOrder(order, mergedCredentials, callback);
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

function allowedScheduleDays(config) {
  const daysMode = config?.days || 'all';
  if (daysMode === 'custom') {
    const selected = Array.isArray(config?.customDays)
      ? config.customDays.map(Number).filter(day => day >= 1 && day <= 5)
      : [];
    return selected.length ? selected : [1];
  }
  if (daysMode === 'mon') return [1];
  return [1, 2, 3, 4, 5];
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
    if (!allowedScheduleDays(job.config).includes(day)) return;
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
      if (!doneJob.enabled) {
        doneJob.nextCheckAt = null;
        doneJob.lastResult = {
          status: doneJob.status === 'cancelled' ? 'cancelled' : 'paused',
          at: new Date().toISOString(),
          message: doneJob.status === 'cancelled' ? 'Cancelled after current check finished' : 'Paused after current check finished',
          result: err ? null : result,
          error: err || null,
        };
        writeAlgoSchedule(done);
        console.log('[ALGO SCHEDULE]', job.id, doneJob.lastResult.status, err || result);
        return;
      }
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
  const sendJSON = (data, status = 200, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', ...headers }); res.end(JSON.stringify(data)); };
  const getBody = (cb) => { let b = ''; req.on('data', c => b += c); req.on('end', () => cb(JSON.parse(b))); };

  if (parsedUrl.pathname === '/update/status' && req.method === 'GET') {
    fetchLatestVersion(latest => {
      const status = readJsonFile(UPDATE_STATUS_FILE, { status: 'idle', message: 'No update has run yet.' });
      sendJSON({
        ok: true,
        currentVersion: PACKAGE.version,
        latestVersion: latest.version,
        updateAvailable: !!latest.version && latest.version !== PACKAGE.version,
        latestCheckError: latest.error,
        pinConfigured: fs.existsSync(UPDATE_PIN_FILE),
        unlocked: hasUpdateSession(req),
        marketWindow: isIstMarketWindow(),
        updaterInstalled: fs.existsSync('/usr/local/sbin/stockkar-update'),
        status,
      });
    });
    return;
  }

  if (parsedUrl.pathname === '/update/setup-pin' && req.method === 'POST') {
    getBody(({ pin }) => {
      if (fs.existsSync(UPDATE_PIN_FILE)) return sendJSON({ ok: false, error: 'Update PIN is already configured.' }, 409);
      if (!/^\d{6,12}$/.test(String(pin || ''))) return sendJSON({ ok: false, error: 'Choose a 6 to 12 digit PIN.' }, 400);
      writePrivateJson(UPDATE_PIN_FILE, { ...hashUpdatePin(pin), createdAt: new Date().toISOString() });
      sendJSON({ ok: true, message: 'Update PIN configured.' });
    });
    return;
  }

  if (parsedUrl.pathname === '/update/unlock' && req.method === 'POST') {
    getBody(({ pin }) => {
      if (!verifyUpdatePin(pin)) return sendJSON({ ok: false, error: 'Incorrect update PIN.' }, 401);
      const token = createUpdateSession();
      sendJSON({ ok: true, message: 'Updates unlocked for 15 minutes.' }, 200, {
        'Set-Cookie': `stockkar_update_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`,
      });
    });
    return;
  }

  if (parsedUrl.pathname === '/update/apply' && req.method === 'POST') {
    if (!hasUpdateSession(req)) return sendJSON({ ok: false, error: 'Unlock updates with your PIN first.' }, 401);
    getBody(({ force }) => {
      if (isIstMarketWindow() && !force) {
        return sendJSON({ ok: false, requiresConfirmation: true, error: 'Market hours are active. Update after 3:45 PM IST, or confirm a forced update.' }, 409);
      }
      writePrivateJson(UPDATE_STATUS_FILE, { status: 'queued', message: 'Update queued.', updatedAt: new Date().toISOString() });
      exec('sudo /usr/bin/systemctl start --no-block stockkar-update.service', { timeout: 10000 }, err => {
        if (err) writePrivateJson(UPDATE_STATUS_FILE, { status: 'failed', message: 'Updater service could not start: ' + err.message, updatedAt: new Date().toISOString() });
      });
      sendJSON({ ok: true, message: 'Update started. The app may reconnect once while it restarts.' }, 202);
    });
    return;
  }

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

  if (parsedUrl.pathname === '/order-log/refresh-status' && (req.method === 'POST' || req.method === 'GET')) {
    refreshBrokerOrderLogStatuses((err, result) => {
      sendJSON(err ? { ok: false, error: err, data: result?.data || readOrderLog(), warnings: result?.warnings || [] } : { ok: true, changed: result.changed, data: result.data, warnings: result.warnings || [] });
    });
    return;
  }

  if (parsedUrl.pathname === '/test-order-log' && req.method === 'GET') {
    sendJSON({ ok: true, data: readTestOrderLog(), retentionDays: ORDER_LOG_RETENTION_DAYS });
    return;
  }

  if (parsedUrl.pathname === '/test-order-log' && req.method === 'POST') {
    getBody((body) => {
      const rows = body.entries || body.orders || body;
      const data = appendTestOrderLog(rows);
      sendJSON({ ok: true, data, retentionDays: ORDER_LOG_RETENTION_DAYS });
    });
    return;
  }

  if (parsedUrl.pathname === '/test-order-log/clear' && req.method === 'POST') {
    writeTestOrderLog([]);
    sendJSON({ ok: true, data: [] });
    return;
  }

  if (parsedUrl.pathname === '/dhan/token-status') {
    sendJSON({ ok: true, data: getDhanTokenStatus() });
    return;
  }

  if (parsedUrl.pathname === '/broker/zerodha/login' && req.method === 'GET') {
    const store = readBrokerTokenStore().brokers.zerodha;
    if (!store?.clientId || !store?.clientSecret) {
      return sendJSON({ ok: false, error: 'Save the Zerodha Kite API key and API secret in Settings first.' }, 400);
    }
    const state = crypto.randomBytes(24).toString('hex');
    KITE_LOGIN_STATES.set(state, Date.now() + 10 * 60 * 1000);
    res.writeHead(302, {
      Location: 'https://kite.zerodha.com/connect/login?v=3&api_key=' + encodeURIComponent(store.clientId)
        + '&redirect_params=' + encodeURIComponent('stockkar_state=' + state),
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  if (parsedUrl.pathname === '/broker/zerodha/callback' && req.method === 'GET') {
    const store = readBrokerTokenStore().brokers.zerodha;
    const requestToken = parsedUrl.query.request_token;
    const kiteStatus = parsedUrl.query.status;
    const state = parsedUrl.query.stockkar_state;
    const stateExpiresAt = state && KITE_LOGIN_STATES.get(state);
    if (state) KITE_LOGIN_STATES.delete(state);
    if (!stateExpiresAt || stateExpiresAt < Date.now() || kiteStatus !== 'success' || !requestToken || !store?.clientId || !store?.clientSecret) {
      const reason = parsedUrl.query.message || 'Kite login was not completed or Zerodha credentials are missing.';
      res.writeHead(302, { Location: '/?zerodha_login=failed&message=' + encodeURIComponent(reason), 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    exchangeKiteRequestToken(store.clientId, store.clientSecret, requestToken, (err, tokenData) => {
      if (err) {
        res.writeHead(302, { Location: '/?zerodha_login=failed&message=' + encodeURIComponent(err), 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      saveBrokerToken('zerodha', {
        clientId: store.clientId,
        clientSecret: store.clientSecret,
        accessToken: tokenData.accessToken,
        source: 'kite-login',
        renewedAt: new Date().toISOString(),
        lastRenewalError: null,
      });
      const updated = updateScheduledBrokerToken('zerodha', store.clientId, tokenData.accessToken);
      res.writeHead(302, { Location: '/?zerodha_login=success&updated=' + updated, 'Cache-Control': 'no-store' });
      res.end();
    });
    return;
  }

  if (parsedUrl.pathname === '/broker/upstox/login' && req.method === 'GET') {
    const store = readBrokerTokenStore().brokers.upstox;
    if (!store?.clientId || !store?.clientSecret) {
      return sendJSON({ ok: false, error: 'Save the Upstox API key and API secret in Settings first.' }, 400);
    }
    const state = crypto.randomBytes(24).toString('hex');
    const redirectUri = requestPublicOrigin(req) + '/broker/upstox/callback';
    UPSTOX_LOGIN_STATES.set(state, { expiresAt: Date.now() + 10 * 60 * 1000, redirectUri });
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: store.clientId,
      redirect_uri: redirectUri,
      state,
    });
    res.writeHead(302, {
      Location: 'https://api.upstox.com/v2/login/authorization/dialog?' + params.toString(),
      'Cache-Control': 'no-store',
    });
    res.end();
    return;
  }

  if (parsedUrl.pathname === '/broker/upstox/callback' && req.method === 'GET') {
    const store = readBrokerTokenStore().brokers.upstox;
    const code = parsedUrl.query.code;
    const state = parsedUrl.query.state;
    const loginState = state && UPSTOX_LOGIN_STATES.get(state);
    if (state) UPSTOX_LOGIN_STATES.delete(state);
    if (!loginState || loginState.expiresAt < Date.now() || !code || !store?.clientId || !store?.clientSecret) {
      const reason = parsedUrl.query.error_description || parsedUrl.query.error || 'Upstox login was not completed or credentials are missing.';
      res.writeHead(302, { Location: '/?upstox_login=failed&message=' + encodeURIComponent(reason), 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    exchangeUpstoxAuthorizationCode(store, code, loginState.redirectUri, (err, tokenData) => {
      if (err) {
        res.writeHead(302, { Location: '/?upstox_login=failed&message=' + encodeURIComponent(err), 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      saveBrokerToken('upstox', {
        clientId: store.clientId,
        clientSecret: store.clientSecret,
        accessToken: tokenData.accessToken,
        source: 'upstox-login',
        renewedAt: new Date().toISOString(),
        lastRenewalError: null,
      });
      const updated = updateScheduledBrokerToken('upstox', store.clientId, tokenData.accessToken);
      res.writeHead(302, { Location: '/?upstox_login=success&updated=' + updated, 'Cache-Control': 'no-store' });
      res.end();
    });
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
        return sendJSON({
          ok: false,
          loginRequired: true,
          loginUrl: '/broker/upstox/login',
          error: 'Upstox requires secure daily authorization. Use Connect / Renew Upstox Token.',
          data: getBrokerTokenStatus('upstox'),
        }, 409);
      }
      if (brokerId === 'angelone') {
        const store = readBrokerTokenStore().brokers.angelone;
        return renewAngelOneToken(store, (err, tokenData) => {
          if (err) return sendJSON({ ok: false, error: err, data: getBrokerTokenStatus('angelone') });
          saveBrokerToken('angelone', {
            clientId: store.clientId,
            accountId: store.accountId,
            accessToken: tokenData.accessToken,
            refreshToken: tokenData.refreshToken,
            feedToken: tokenData.feedToken,
            source: 'manual-renew',
            renewedAt: new Date().toISOString(),
            lastRenewalError: null,
          });
          updateScheduledBrokerToken('angelone', store.clientId, tokenData.accessToken);
          sendJSON({ ok: true, data: getBrokerTokenStatus('angelone') });
        });
      }
      sendJSON({ ok: false, error: brokerId + ' does not support silent token renewal. Save a fresh access token.' });
    });
    return;
  }

  if (parsedUrl.pathname === '/algo-schedule/update-credentials' && req.method === 'POST') {
    getBody(({ dhanClient, dhanToken, broker, refreshToken, clientSecret, accountId, feedToken }) => {
      const brokerId = String(broker || 'dhan').toLowerCase();
      const oauthLoginSetup = ['zerodha', 'upstox'].includes(brokerId) && dhanClient && clientSecret;
      if (!dhanClient || (!dhanToken && !oauthLoginSetup)) return sendJSON({ ok: false, error: 'Missing broker client/API key or access token' });
      if (brokerId === 'dhan') {
        saveDhanToken({ clientId: dhanClient, token: dhanToken, source: 'settings' });
      } else {
        saveBrokerToken(brokerId, {
          clientId: dhanClient,
          accountId,
          accessToken: dhanToken,
          refreshToken,
          feedToken,
          clientSecret,
          source: 'settings',
          lastRenewalError: null,
        });
      }
      const updated = brokerId === 'dhan'
        ? updateScheduledDhanToken(dhanClient, dhanToken)
        : (dhanToken ? updateScheduledBrokerToken(brokerId, dhanClient, dhanToken) : 0);
      sendJSON({ ok: true, updated, data: getBrokerTokenStatus(brokerId), tokenStatuses: getAllBrokerTokenStatuses() });
    });
    return;
  }

  if (parsedUrl.pathname === '/algo-schedule/status') {
    const schedule = readAlgoSchedule();
    const jobs = (schedule.jobs || []).map(job => ({
      id: job.id,
      enabled: !!job.enabled,
      status: job.status || (job.enabled ? 'active' : 'cancelled'),
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
        broker: job.config.broker || 'dhan',
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
        testMode: !!job.config.testMode,
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
          status: 'active',
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
        if (body.action === 'resume') {
          const duplicate = existing.jobs.find(other =>
            other.id !== job.id &&
            other.enabled &&
            other.config?.screenerSlug === job.config?.screenerSlug &&
            (other.config?.runTime || '09:15') === (job.config?.runTime || '09:15')
          );
          if (duplicate) return sendJSON({ ok: false, error: 'Another active job already uses this screener at ' + (job.config?.runTime || '09:15') });
          job.enabled = true;
          job.status = 'active';
        } else if (body.action === 'cancel') {
          job.enabled = false;
          job.status = 'cancelled';
        } else {
          job.enabled = false;
          job.status = 'paused';
        }
        job.updatedAt = new Date().toISOString();
      } else {
        existing.jobs.forEach(job => {
          job.enabled = false;
          job.status = body.action === 'cancel' ? 'cancelled' : 'paused';
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

  // Fetch stocks from a saved filter â€” verified mapper
  if (parsedUrl.pathname === '/saved-filter-stocks' && req.method === 'POST') {
    getBody(({ token, filterId, limit }) => {
      if (!token) return sendJSON({ ok: false, error: 'No token provided' });

      fetchSavedFilterDirect(filterId, token, limit, (directErr, directRes, directMiss) => {
        if (directErr) return sendJSON({ ok: false, error: 'Saved filter direct fetch error: ' + directErr });
        const directStocks = directRes ? pickStockRowsFromPayload(directRes.data) : [];
        if (directStocks.length) {
          console.log('[SAVED FILTER DIRECT] count:', directStocks.length, '| source:', directRes.sourcePath);
          return sendJSON({ ok: true, data: directStocks, total: directStocks.length, filterName: filterId, sourcePath: directRes.sourcePath });
        }
        if (directMiss) console.log('[SAVED FILTER DIRECT] no rows, fallback mapper:', directMiss);

      // Step 1: Get filter config using slug
      stockkarGet('/api/saved-filter/slug/' + filterId, token, (err1, r1) => {
        if (err1) return sendJSON({ ok: false, error: 'Filter config error: ' + err1 });

        const config = r1?.data || {};
        const f = config.filters || {};

        console.log('[FILTER CONFIG] name:', config.name, '| activeFilters:', JSON.stringify(f.activeFilters));

        // â”€â”€ COMPLETE verified mapper â€” all filters researched via Chrome â”€â”€
        const p = new URLSearchParams();
        p.set('limit', String(Math.min(Number(limit) || STOCKKAR_MAX_LIMIT, STOCKKAR_MAX_LIMIT)));
        p.set('offset', '0');
        p.set('include_technicals', 'true');
        p.set('sort_order', f.sort_order || 'desc');

        const af   = f.activeFilters || [];
        const afNorm = af.map(function(x) { return String(x || '').trim().toLowerCase(); });
        const hasFilter = function() {
          return Array.prototype.slice.call(arguments).some(function(name) {
            var target = String(name || '').trim().toLowerCase();
            return afNorm.includes(target) || afNorm.some(function(x) { return x.includes(target) || target.includes(x); });
          });
        };
        const hasB = f.selectedBaskets && f.selectedBaskets.length > 0;

        // â”€â”€ Baskets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (hasB) p.set('baskets', f.selectedBaskets.join(','));

        // â”€â”€ Industries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (f.selectedIndustries && f.selectedIndustries.length)
          f.selectedIndustries.forEach(function(ind) { p.append('industry', ind); });

        // â”€â”€ Market Cap (always) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        p.set('market_cap_min', String(Math.round((f.marketCapRange && f.marketCapRange[0]) || 401)));
        p.set('market_cap_max', String(Math.round((f.marketCapRange && f.marketCapRange[1]) || 1787042)));

        // Close/Prev price filters. Stockkar has used multiple saved-filter field names here.
        const closeRange = f.closePriceRange || f.livePriceRange || f.priceRange || null;
        if (!hasB && closeRange && closeRange[1]) {
          p.set('close_price_min', String(closeRange[0] || 0));
          p.set('close_price_max', String(Math.round(closeRange[1])));
        }
        const prevRange = f.prevPriceRange || f.previousPriceRange || f.prevClosePriceRange || f.previousClosePriceRange || f.prevCloseRange || null;
        if (prevRange && prevRange[1]) {
          const prevMin = String(prevRange[0] || 0);
          const prevMax = String(Math.round(prevRange[1]));
          p.set('prev_price_min', prevMin);
          p.set('prev_price_max', prevMax);
          p.set('prev_close_price_min', prevMin);
          p.set('prev_close_price_max', prevMax);
          p.set('previous_close_price_min', prevMin);
          p.set('previous_close_price_max', prevMax);
        }

        // â”€â”€ PE Ratio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (hasFilter('PE Ratio') && f.peRatioRange) {
          p.set('pe_ratio_min', String(Math.round(f.peRatioRange[0])));
          p.set('pe_ratio_max', String(Math.round(f.peRatioRange[1])));
        }

        // â”€â”€ ROE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (hasFilter('ROE') && f.roeRange) {
          p.set('roe_min', String(Math.round(f.roeRange[0])));
          p.set('roe_max', String(Math.round(f.roeRange[1])));
        }

        // â”€â”€ ROCE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (hasFilter('ROCE') && f.roceRange) {
          p.set('roce_min', String(Math.round(f.roceRange[0])));
          p.set('roce_max', String(Math.round(f.roceRange[1])));
        }

        // â”€â”€ Debt Ratio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (hasFilter('Debt Ratio') && f.debtRatioRange) {
          p.set('de_ratio_min', String(Math.round(f.debtRatioRange[0])));
          p.set('de_ratio_max', String(Math.round(f.debtRatioRange[1])));
        }

        // â”€â”€ Demand dates â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (f.demandStartDate) p.set('demand_start_date', f.demandStartDate);
        if (f.demandEndDate)   p.set('demand_end_date',   f.demandEndDate);

        // â”€â”€ Big Player Score (use Start/End NOT legacy bigPlayerScore) â”€â”€â”€â”€
        if (hasFilter('Big Player Score')) {
          var bps = f.bigPlayerScoreStart || [0, 100];
          var bpe = f.bigPlayerScoreEnd   || [0, 100];
          p.set('big_player_score_start_min', String(bps[0]));
          p.set('big_player_score_start_max', String(bps[1]));
          p.set('big_player_score_end_min',   String(bpe[0]));
          p.set('big_player_score_end_max',   String(bpe[1]));
        }

        // â”€â”€ Growth Score â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (hasFilter('Growth Score')) {
          var gss = f.growthScoreStart || [0, 100];
          var gse = f.growthScoreEnd   || [0, 100];
          p.set('growth_score_start_min', String(gss[0]));
          p.set('growth_score_start_max', String(gss[1]));
          p.set('growth_score_end_min',   String(gse[0]));
          p.set('growth_score_end_max',   String(gse[1]));
        }

        // â”€â”€ Momentum Score (use Start/End NOT legacy momentumScore) â”€â”€â”€â”€â”€â”€â”€
        if (hasFilter('Momentum Score')) {
          var mss = f.momentumScoreStart || [0, 100];
          var mse = f.momentumScoreEnd   || [0, 100];
          p.set('momentum_score_start_min', String(mss[0]));
          p.set('momentum_score_start_max', String(mss[1]));
          p.set('momentum_score_end_min',   String(mse[0]));
          p.set('momentum_score_end_max',   String(mse[1]));
        }

        // â”€â”€ Near Term Growth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (hasFilter('Near Term Growth Meter')) {
          p.set('short_term_growth_score_min', String(f.shortTermGrowthMin || 0));
          p.set('short_term_growth_score_max', String(f.shortTermGrowthMax || 100));
        }

        // â”€â”€ Growth Compounder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (hasFilter('Growth Compounder Meter')) {
          p.set('long_term_growth_score_min', String(f.longTermGrowthMin || 0));
          p.set('long_term_growth_score_max', String(f.longTermGrowthMax || 100));
        }

        // â”€â”€ Performance Meter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (hasFilter('Performance Meter')) {
          p.set('returns_efficiency_score_min', String(f.returnsEffMin || 0));
          p.set('returns_efficiency_score_max', String(f.returnsEffMax || 100));
        }

        // â”€â”€ Golden Valuation (PE TTM) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (hasFilter('Golden Valuation') && f.dailyTtmPeOp && f.dailyTtmPeOp !== 'within') {
          p.set('daily_ttm_pe_op',  f.dailyTtmPeOp);
          p.set('daily_ttm_pe_min', String((f.dailyTtmPeRange && f.dailyTtmPeRange[0]) || 0));
          p.set('daily_ttm_pe_max', String((f.dailyTtmPeRange && f.dailyTtmPeRange[1]) || 100));
          p.set('daily_ttm_pe_pct', String(f.dailyTtmPePct || 100));
        }

        // â”€â”€ Quarterly EPS Growth â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (hasFilter('Quarterly EPS Growth') && f.quarterlyEpsRange && f.quarterlyEpsRange[0] > 0) {
          p.set('quarter',          f.quarterlyEpsQuarter || '');
          p.set('eps_growth_min',   String(f.quarterlyEpsRange[0]));
          p.set('eps_growth_max',   String(f.quarterlyEpsRange[1]));
        }

        // â”€â”€ Delivery % â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (af.includes('Delivery %') && f.deliveryRange) {
          p.set('delivery_min', String(f.deliveryRange[0] || 0));
          p.set('delivery_max', String(f.deliveryRange[1] || 100));
        }

        // â”€â”€ Volume Traces â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (af.includes('Volume Traces')) {
          p.set('volume_days',       String(f.volumeDays || 30));
          p.set('volume_multiplier', String(f.volumeMultiplier || 3));
        }

        // â”€â”€ Your Date, Your Volume â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (af.includes('Your Date, Your Volume') && f.volumeSpike && f.volumeSpike.date) {
          p.set('volume_spike_date',       f.volumeSpike.date);
          p.set('volume_spike_multiplier', String(f.volumeSpike.multiplier || 3));
          p.set('volume_spike_days',       String(f.volumeSpike.days || 60));
        }

        // â”€â”€ EMA above EMA (daily ema crossovers) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        // â”€â”€ SMA above SMA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if ((hasFilter('SMA above SMA') || hasFilter('SMA Crossover')) && f.smaCrossovers && f.smaCrossovers.length) {
          f.smaCrossovers.forEach(function(sc) {
            p.append('ma_crossovers', sc.left + '-' + sc.right + '-' + sc.dir);
          });
        }

        // â”€â”€ Historical EMA Crossovers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        // â”€â”€ Historical SMA Crossovers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (f.emaCrossFrom && f.historicalSmaCrossovers && f.historicalSmaCrossovers.length) {
          p.set('ma_cross_from', f.emaCrossFrom);
          p.set('ma_cross_to',   f.emaCrossTo || '');
          f.historicalSmaCrossovers.forEach(function(sc) {
            p.append('ma_crossovers', sc.left + '-' + sc.right + '-' + sc.dir);
          });
        }

        // â”€â”€ % Within EMA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if ((hasFilter('% Within EMA') || hasFilter('% Above Daily EMA')) && f.emaProximities && f.emaProximities.length) {
          f.emaProximities.forEach(function(ep) {
            if (!ep.field) return;
            var maxP = parseFloat((ep.maxPercent / 100).toFixed(4));
            var minP = parseFloat((ep.minPercent / 100).toFixed(4));
            if (ep.field.match(/^daily_ema/)) {
              var period = ep.field.replace('daily_ema','');
              p.set('ema_proximity_range', period + ':' + minP + ':' + maxP);
              p.set('ema_proximity',       period + ':' + maxP);
            } else {
              // weekly EMA or SMA â†’ ma_proximity_range
              p.append('ma_proximity_range', ep.field + ':' + minP + ':' + maxP);
            }
          });
        }

        // â”€â”€ % Within SMA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (hasFilter('% Within SMA') && f.smaProximities && f.smaProximities.length) {
          f.smaProximities.forEach(function(sp) {
            if (!sp.field) return;
            var maxP = parseFloat((sp.maxPercent / 100).toFixed(4));
            var minP = parseFloat((sp.minPercent / 100).toFixed(4));
            p.append('ma_proximity_range', sp.field + ':' + minP + ':' + maxP);
          });
        }

        // â”€â”€ EMA Price Crossover â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if ((hasFilter('EMA Price Crossover') || hasFilter('Price vs EMA')) && f.priceCrossovers && f.priceCrossovers.length) {
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

        // â”€â”€ SMA Price Crossover â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if ((hasFilter('SMA Price Crossover') || hasFilter('SMA Crossover')) && f.smaPriceCrossovers && f.smaPriceCrossovers.length) {
          if (f.priceCrossFrom) p.set('ma_price_cross_from', f.priceCrossFrom);
          if (f.priceCrossTo)   p.set('ma_price_cross_to',   f.priceCrossTo);
          f.smaPriceCrossovers.forEach(function(sc) {
            if (sc.field) p.append('ma_price_crossovers', sc.field + '-' + sc.dir);
          });
        }

        // â”€â”€ RSI 14 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (hasFilter('RSI 14') && f.rsiRange) {
          p.set('rsi_min', String(f.rsiRange[0]));
          p.set('rsi_max', String(f.rsiRange[1]));
        }

        // â”€â”€ Supertrend â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if ((hasFilter('Supertrend') || hasFilter('Fearless Indicator')) && (f.supertrendSignal || f.fearlessSignal || f.fearlessIndicatorSignal)) {
          const stSignal = f.supertrendSignal || f.fearlessSignal || f.fearlessIndicatorSignal;
          if (stSignal && stSignal !== 'all') p.set('supertrend_signal', stSignal);
          const stPct = f.supertrendPct || f.fearlessPct || f.fearlessIndicatorPct || f.pricePctAwayFromFearless || f.fearlessWithinPct;
          if (stPct !== undefined && stPct !== null && stPct !== '') p.set('supertrend_pct', String(stPct));
        }

        // Fearless zone is separate from Fearless Indicator/Supertrend.
        if (hasFilter('Fearless Zone') && f.fearlessZoneColor && f.fearlessZoneColor !== 'all') {
          p.set('fearless_zone_color',      f.fearlessZoneColor);
          p.set('fearless_zone_within_pct', String(f.fearlessZoneWithinPct || 3));
        }

        // â”€â”€ Pivot / Price Near High (fall filter) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if ((hasFilter('Pivot') || hasFilter('Price Near High')) && f.fallPct) {
          p.set('fall_days', String(f.fallDays || 30));
          p.set('fall_pct',  String(parseFloat((f.fallPct / 100).toFixed(4))));
        }

        // â”€â”€ SH Filters (Public/FII/DII/Promoter) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (f.shFilters && f.shFilters.length) {
          var sh = f.shFilters.map(function(s) {
            return { bucket: s.bucket, mode: s.mode, window: s.window,
                     label: s.label, band: s.bandLo + '-' + s.bandHi };
          });
          p.set('sh_filters', JSON.stringify(sh));
        }

        // â”€â”€ Form Your Own Candle (cb_groups) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        if (hasFilter('Form Your Own Candle - Daily'))   processFyoc(f.fyocDaily,   'daily');
        if (hasFilter('Form Your Own Candle - Weekly'))  processFyoc(f.fyocWeekly,  'weekly');
        if (hasFilter('Form Your Own Candle - Monthly')) processFyoc(f.fyocMonthly, 'monthly');
        if (cbParts.length) cbParts.forEach(function(g) { p.append('cb_groups', g); });

        // â”€â”€ Consolidation (cp_filters) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        var hasConsolDaily   = hasFilter('Consolidation - Daily');
        var hasConsolWeekly  = hasFilter('Consolidation - Weekly');
        var hasConsolMonthly = hasFilter('Consolidation - Monthly');
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

  // Algo scan â€” apply entry criteria and calculate prices
  if (parsedUrl.pathname === '/algo-scan' && req.method === 'POST') {
    getBody(({ symbols, screenerStocks, entryFilters, slMethod, slPct, slIndicator, slIndicatorPct, emaTrailingEnabled, emaTrailingIndicator, emaTrailingPct, emaTrailingTimeframe, emaTrailingTrigger, rrRatio, capitalPerTrade, sectorFilters, industryFilters }) => {
      const filteredStocks = filterStocksBySectorIndustry(screenerStocks || [], sectorFilters, industryFilters);
      const hasFilters = (Array.isArray(sectorFilters) && sectorFilters.length) || (Array.isArray(industryFilters) && industryFilters.length);
      const filteredSymbols = hasFilters ? extractSymbolsFromStocks(filteredStocks) : symbols;
      fetchTVData(filteredSymbols, (err, tvData) => {
        if (err) return sendJSON({ ok: false, error: err });
        const results = buildAlgoCandidates(tvData, { screenerStocks: filteredStocks.length ? filteredStocks : screenerStocks, entryFilters, slMethod, slPct, slIndicator, slIndicatorPct, emaTrailingEnabled, emaTrailingIndicator, emaTrailingPct, emaTrailingTimeframe, emaTrailingTrigger, rrRatio, capitalPerTrade });

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
        sendJSON(err
          ? { ok: false, error: err, data: result?.data || null, status: result?.status || 400, request: result?.request || null }
          : { ok: true, data: result.data, status: result.status, request: result.request || null });
      });
    });
    return;
  }

  if (parsedUrl.pathname === '/' || parsedUrl.pathname === '/index.html') return serveStaticFile(res, 'index.html', 'text/html; charset=utf-8');
  if (parsedUrl.pathname === '/setup' || parsedUrl.pathname === '/setup.html') return serveStaticFile(res, 'setup.html', 'text/html; charset=utf-8');
  if (parsedUrl.pathname === '/config.js') {
    res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end("window.STOCKKAR_API_BASE = window.location.origin;\n");
    return;
  }
  if (parsedUrl.pathname === '/aws-backend-cloudformation.yml') return serveStaticFile(res, 'aws-backend-cloudformation.yml', 'text/yaml; charset=utf-8');

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
    checkDailyEmaTrailing();
    setInterval(checkBackendSchedule, 30000);
    setInterval(checkDhanTokenRenewal, 60000);
    setInterval(checkBrokerTokenRenewal, 60000);
    setInterval(checkDailyEmaTrailing, 10 * 60 * 1000);
  });
}

module.exports = handleRequest;


