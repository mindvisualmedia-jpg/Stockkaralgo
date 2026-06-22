const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const PACKAGE = require('./package.json');
const { computeMtmActions, computeMtmPlan, hasMtmRules } = require('./mtm');

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
const APP_LOCK_FILE = path.join(DATA_DIR, 'app_lock.json');
const SAVED_MONITORS_FILE = path.join(DATA_DIR, 'saved_screener_monitors.json');
const MTM_SETTINGS_FILE = path.join(DATA_DIR, 'mtm_settings.json');
const FREE_TIER_LIMITS = {
  maxAlgoJobs: Math.max(1, Number(process.env.STOCKKAR_MAX_ALGO_JOBS || 10)),
  maxSavedMonitors: Math.max(1, Number(process.env.STOCKKAR_MAX_SAVED_MONITORS || 20)),
  maxStocksPerAlgo: Math.max(1, Number(process.env.STOCKKAR_MAX_STOCKS_PER_ALGO || 200)),
  maxOrderLogRows: Math.max(100, Number(process.env.STOCKKAR_MAX_ORDER_LOG_ROWS || 1000)),
  orderLogRetentionDays: Math.max(1, Number(process.env.STOCKKAR_ORDER_LOG_RETENTION_DAYS || 30)),
  minCheckEveryMinutes: Math.max(1, Number(process.env.STOCKKAR_MIN_CHECK_EVERY_MINUTES || 3)),
};
const ORDER_LOG_RETENTION_DAYS = FREE_TIER_LIMITS.orderLogRetentionDays;
const DHAN_TOKEN_VALIDITY_HOURS = Number(process.env.DHAN_TOKEN_VALIDITY_HOURS || 24);
const DHAN_RENEW_HOUR_IST = Number(process.env.DHAN_RENEW_HOUR_IST || 16);
const DHAN_RENEW_MINUTE_IST = Number(process.env.DHAN_RENEW_MINUTE_IST || 0);
const EMA_TRAILING_CHECK_HOUR_IST = Number(process.env.EMA_TRAILING_CHECK_HOUR_IST || 15);
const EMA_TRAILING_CHECK_MINUTE_IST = Number(process.env.EMA_TRAILING_CHECK_MINUTE_IST || 45);
const BROKER_TOKEN_VALIDITY_HOURS = { dhan: DHAN_TOKEN_VALIDITY_HOURS, upstox: 24, angelone: 24 };
const SAVED_MONITOR_REFRESH_HOUR_IST = Number(process.env.SAVED_MONITOR_REFRESH_HOUR_IST || 8);
const SAVED_MONITOR_REFRESH_MINUTE_IST = Number(process.env.SAVED_MONITOR_REFRESH_MINUTE_IST || 0);
const UPDATE_REPO_PACKAGE_URL = process.env.STOCKKAR_UPDATE_PACKAGE_URL
  || 'https://raw.githubusercontent.com/mindvisualmedia-jpg/Stockkaralgo/main/package.json';
const UPDATE_SESSIONS = new Map();
const APP_LOCK_SESSIONS = new Map();
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

function hashAppLockPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(String(pin), salt, 64).toString('hex') };
}

function verifyAppLockPin(pin) {
  const stored = readJsonFile(APP_LOCK_FILE);
  if (!stored?.salt || !stored?.hash) return false;
  const candidate = hashAppLockPin(pin, stored.salt).hash;
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(stored.hash, 'hex'));
  } catch { return false; }
}

// Date of birth is the self-service PIN-reset secret. Stored salted+hashed,
// normalised to YYYY-MM-DD so formatting differences don't cause false misses.
function normaliseDob(dob) {
  const m = String(dob || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function verifyAppLockDob(dob) {
  const stored = readJsonFile(APP_LOCK_FILE);
  const norm = normaliseDob(dob);
  if (!norm || !stored?.dobSalt || !stored?.dobHash) return false;
  const candidate = hashAppLockPin(norm, stored.dobSalt).hash;
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(stored.dobHash, 'hex'));
  } catch { return false; }
}

function createAppLockSession() {
  const token = crypto.randomBytes(32).toString('hex');
  APP_LOCK_SESSIONS.set(token, Date.now() + 12 * 60 * 60 * 1000);
  return token;
}

function hasAppLockSession(req) {
  if (!fs.existsSync(APP_LOCK_FILE)) return false;
  const token = parseCookies(req).stockkar_app_session;
  const expiresAt = token && APP_LOCK_SESSIONS.get(token);
  if (!expiresAt || expiresAt < Date.now()) {
    if (token) APP_LOCK_SESSIONS.delete(token);
    return false;
  }
  return true;
}

function appCookieFlags(req) {
  const host = String(req.headers.host || '');
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  return 'HttpOnly; SameSite=Strict; Path=/; ' + (isLocal ? '' : 'Secure; ');
}

// Secret for in-process loopback calls (lets scheduled jobs reuse app-lock
// protected endpoints without a UI session). Regenerated each process start.
const INTERNAL_SECRET = crypto.randomBytes(24).toString('hex');
function isInternalLoopbackRequest(req) {
  const ip = req.socket?.remoteAddress || '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  return loopback && req.headers['x-stockkar-internal'] === INTERNAL_SECRET;
}
function internalPost(pathname, payload, callback) {
  const body = JSON.stringify(payload || {});
  const req = http.request({
    hostname: '127.0.0.1', port: PORT, path: pathname, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-stockkar-internal': INTERNAL_SECRET },
  }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      let p = null; try { p = JSON.parse(d); } catch {}
      callback(null, p);
    });
  });
  req.on('error', e => callback(e.message));
  req.setTimeout(45000, () => req.destroy(new Error('internal request timeout')));
  req.write(body); req.end();
}

function isAppLockSensitivePath(pathname) {
  if (pathname.startsWith('/app-lock/')) return false;
  if (['/', '/index.html', '/config.js', '/setup', '/setup.html', '/aws-backend-cloudformation.yml', '/oracle-stockkar-template.zip', '/google-cloud-stockkar-template.zip', '/screeners-list', '/brokers'].includes(pathname)) return false;
  if (pathname.startsWith('/broker/') && (pathname.includes('/callback') || pathname.includes('/postback'))) return false;
  const openReadOnly = ['/api/auth/status'];
  if (openReadOnly.includes(pathname)) return false;
  return true;
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Auth file (written by Electron main process) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
  { id: 'upstox', name: 'Upstox (Coming soon)', status: 'planned', supports: ['gtt_three_leg', 'daily_oauth_login'] },
  { id: 'angelone', name: 'Angel One SmartAPI', status: 'active', supports: ['normal_order', 'order_book', 'token_refresh'] },
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

function isActiveAlgoJob(job) {
  if (!job) return false;
  if (job.enabled) return true;
  const status = String(job.status || '').toLowerCase();
  return ['active', 'monitoring', 'needs_token', 'running'].includes(status);
}

function activeAlgoJobCount(schedule) {
  return (Array.isArray(schedule?.jobs) ? schedule.jobs : []).filter(isActiveAlgoJob).length;
}

function countAlgoConfigStocks(cfg) {
  if (Array.isArray(cfg?.screenerStocks)) return cfg.screenerStocks.length;
  if (Array.isArray(cfg?.stocks)) return cfg.stocks.length;
  return 0;
}

function freeTierLimitsClientView() {
  return {
    maxAlgoJobs: FREE_TIER_LIMITS.maxAlgoJobs,
    maxSavedMonitors: FREE_TIER_LIMITS.maxSavedMonitors,
    maxStocksPerAlgo: FREE_TIER_LIMITS.maxStocksPerAlgo,
    maxOrderLogRows: FREE_TIER_LIMITS.maxOrderLogRows,
    orderLogRetentionDays: FREE_TIER_LIMITS.orderLogRetentionDays,
    minCheckEveryMinutes: FREE_TIER_LIMITS.minCheckEveryMinutes,
  };
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
  const emaTrailingEnabled = !!entry.emaTrailingEnabled;
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
    emaTrailingEnabled,
    emaTrailingIndicator: entry.emaTrailingIndicator || '',
    emaTrailingPct: entry.emaTrailingPct ?? '',
    emaTrailingTimeframe: entry.emaTrailingTimeframe || '',
    emaTrailingTrigger: entry.emaTrailingTrigger || '',
    emaTrailingArmedAt: entry.emaTrailingArmedAt || null,
    emaTrailingStatus: entry.emaTrailingStatus || (emaTrailingEnabled ? 'waiting-target' : ''),
    emaTrailingLastDate: entry.emaTrailingLastDate || '',
    lastTrailSlPrice: entry.lastTrailSlPrice ?? '',
    lastTrailCheckAt: entry.lastTrailCheckAt || null,
    lastTrailError: entry.lastTrailError || '',
    rejectionReason: entry.rejectionReason || entry.rejectReason || '',
    orderId: entry.orderId || entry.order_id || 'N/A',
    gttTriggerId: entry.gttTriggerId || entry.gttId || '',
    exitOrderId: entry.exitOrderId || '',
    angelOneEntryOrderId: entry.angelOneEntryOrderId || '',
    angelOneSlRuleId: entry.angelOneSlRuleId || '',
    angelOneSlOrderId: entry.angelOneSlOrderId || '',
    angelOneTargetOrderId: entry.angelOneTargetOrderId || '',
    angelOneTargetRuleId: entry.angelOneTargetRuleId || '',
    targetExitOrderId: entry.targetExitOrderId || '',
    slOrderId: entry.slOrderId || '',
    targetOrderId: entry.targetOrderId || '',
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
    .sort((a, b) => new Date(b.recordedAt) - new Date(a.recordedAt))
    .slice(0, FREE_TIER_LIMITS.maxOrderLogRows);
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

// For a closed entry (SL/TARGET HIT) whose broker payload never carried a fill
// price, estimate the exit at the SL/target level so exit price + realised P&L
// are shown instead of blank. Marked exitEstimated so it's clearly an estimate.
function backfillClosedExit(entry) {
  const exitType = String(entry.exitType || '').toUpperCase();
  if (!/HIT/.test(exitType)) return entry;
  if (entry.exitPrice !== '' && entry.exitPrice != null) return entry;
  const px = exitType.includes('TARGET')
    ? Number(entry.targetPrice || 0)
    : Number(entry.brokerSlPrice || entry.slPrice || 0);
  if (!(px > 0)) return entry;
  const entryPrice = Number(entry.entryPrice || entry.price || 0);
  const qty = Number(entry.qty || 0);
  return {
    ...entry,
    exitPrice: Number(px.toFixed(2)),
    realisedPnl: (entryPrice && qty) ? Number(((px - entryPrice) * qty).toFixed(2)) : entry.realisedPnl,
    exitEstimated: true,
  };
}

function dhanApiMessage(parsed, fallback) {
  return parsed?.remarks || parsed?.message || parsed?.errorMessage || parsed?.omsErrorDescription ||
    parsed?.errorText || parsed?.reason || parsed?.description ||
    parsed?.data?.remarks || parsed?.data?.message || parsed?.data?.errorMessage || parsed?.data?.omsErrorDescription ||
    parsed?.errorCode || parsed?.data?.errorCode ||
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
    // Fallback when Dhan's leg payload omits the fill price: a target fills ~at
    // its trigger, so use the leg trigger / the order's target price.
    if (!Number.isFinite(exitPrice)) exitPrice = firstNumber(collectValues(targetLeg, ['trigger', 'target']), logEntry.targetPrice);
  } else if (slLeg) {
    exitType = 'SL HIT';
    exitPrice = firstNumber(collectValues(slLeg, ['average', 'avgprice', 'tradedprice', 'executedprice', 'filledprice']));
    // Fallback: a market SL fills ~at its trigger, so use the leg trigger / the
    // current broker SL / original SL price.
    if (!Number.isFinite(exitPrice)) exitPrice = firstNumber(collectValues(slLeg, ['trigger', 'stoploss']), logEntry.brokerSlPrice, logEntry.slPrice);
  } else if (/REJECT|CANCEL/.test(statusText)) {
    exitType = statusText.includes('REJECT') ? 'REJECTED' : 'CANCELLED';
  }
  // Use the broker's actual rejection message; never fall back to the leg-status
  // text ("REJECTED CANCELLED CANCELLED"). Keep the real reason captured at
  // placement (e.g. "insufficient funds"); treat status-only text as no-reason
  // so already-clobbered rows recover.
  const brokerMsg = order?.remarks || order?.message || order?.errorMessage || order?.omsErrorDescription ||
    order?.errorText || order?.reason || order?.data?.remarks || order?.data?.message || order?.data?.errorMessage || '';
  const statusOnly = s => /^(?:\s*(REJECT(?:ED)?|CANCELL?ED|PENDING|TRIGGERED|TRADED|COMPLETE[D]?|OPEN|N\/?A)\s*)+$/i.test(String(s || '').trim());
  const priorReason = statusOnly(logEntry.rejectionReason) ? '' : String(logEntry.rejectionReason || '').trim();
  const rejectionReason = exitType === 'REJECTED'
    ? (String(brokerMsg).trim() || priorReason || 'Rejected by broker')
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
  const ids = parseAngelOneOrderIds(logEntry);
  const symbol = String(logEntry.symbol || '').replace(/\s/g, '').toUpperCase();
  const normalizeSymbol = value => String(value || '').replace(/-EQ$/i, '').replace(/\s/g, '').toUpperCase();
  const rowOrderId = o => String(o?.orderid || o?.order_id || o?.orderId || '').trim();
  const rowTriggerId = o => String(o?.triggerid || o?.trigger_id || o?.gttTriggerId || o?.gtt_trigger_id || o?.id || o?.ruleid || o?.rule_id || o?.ruleId || '').trim();
  const matchesId = (o, id) => !!id && rowOrderId(o) === String(id).trim();
  const matchesRule = (o, ruleId) => !!ruleId && rowTriggerId(o) === String(ruleId).trim();
  const entryOrder = rows.find(o => matchesId(o, ids.entryId)) || null;
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

  const matchingSells = rows.filter(o => {
    const osym = normalizeSymbol(o.tradingsymbol || o.symbol || o.symbolname);
    const side = String(o.transactiontype || o.transaction_type || '').toUpperCase();
    const status = String(o.status || '').toUpperCase();
    return osym === symbol && side === 'SELL' && /(COMPLETE|TRADED|FILLED)/.test(status);
  }).sort((a, b) => String(b.updatetime || b.exchtime || b.ordertime || '').localeCompare(String(a.updatetime || a.exchtime || a.ordertime || '')));

  const explicitTarget = matchingSells.find(o => matchesId(o, ids.targetOrderId));
  const explicitSl = matchingSells.find(o => matchesId(o, ids.slOrderId) || matchesRule(o, ids.slRuleId));
  const sell = explicitTarget || explicitSl || matchingSells[0];
  const exitPrice = firstNumber(sell?.averageprice, sell?.average_price, sell?.price);
  const entryPrice = firstNumber(logEntry.entryPrice, logEntry.price, entryOrder?.averageprice, entryOrder?.average_price, entryOrder?.price);
  const qty = Number(logEntry.qty || 0);
  const target = Number(logEntry.targetPrice || 0);
  const sl = Number(logEntry.slPrice || 0);
  let exitType = '';
  if (explicitTarget) exitType = 'TARGET HIT';
  else if (explicitSl) exitType = 'SL HIT';
  else if (Number.isFinite(exitPrice)) {
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
  if (!store?.clientId || !store?.accountId || !store?.accessToken) return callback("No Angel One token generated. Open Settings and generate today's token.");
  if (status.status === 'expired') return callback("Angel One token expired. Generate today's token in Settings.");
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
        if (!order) return backfillClosedExit({ ...entry, lastStatusCheckAt: checkedAt });
        const inferred = inferDhanExitFromOrder(order, entry);
        changed += inferred.exitType || inferred.rawStatus !== entry.status ? 1 : 0;
        const hasFinalExit = !!inferred.exitType;
        return backfillClosedExit({
          ...entry,
          status: inferred.rawStatus || entry.status,
          exitType: inferred.exitType,
          exitPrice: hasFinalExit ? inferred.exitPrice : '',
          realisedPnl: hasFinalExit ? inferred.realisedPnl : '',
          rejectionReason: inferred.rejectionReason || entry.rejectionReason || '',
          lastStatusCheckAt: checkedAt,
        });
      });
      writeOrderLog(next);
      callback(null, { changed, data: next });
    });
  });
  req.on('error', err => callback('Dhan order status failed: ' + err.message));
  req.end();
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Read access_token from Chrome Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Generic proxy Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Stockkar API Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function stockkarHostGet(hostname, apiPath, token, callback) {
  const useToken = token || getStoredToken() || '';
  const useCookies = getStoredCookies() || '';
  const headers = {
    'Authorization': 'Bearer ' + useToken,
    'Origin': 'https://www.stockkar.in',
    'Referer': 'https://www.stockkar.in/profile/watchlist',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 StockkarAlgo/1.0',
    'Accept': 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
  };
  if (useCookies) headers['Cookie'] = useCookies;
  const req = https.request({ hostname, port: 443, path: apiPath, method: 'GET', headers }, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      let p;
      try { p = JSON.parse(data); } catch { p = data; }
      callback(null, { status: apiRes.statusCode, data: p, hostname, path: apiPath });
    });
  });
  req.on('error', err => callback(err.message, null));
  req.end();
}

function stockkarGet(apiPath, token, callback) {
  stockkarHostGet(STOCKKAR_HOST, apiPath, token, callback);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ TradingView Scanner Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
        recordTvHealth(symbols.length === 0 || results.length > 0, results.length === 0 ? 'empty market data response' : null);
        callback(null, results);
      } catch(e) { console.log('[SIGNAL] parse error:', e.message); recordTvHealth(false, 'market data parse error'); callback('Market data temporarily unavailable', null); }
    });
  });
  req.on('error', err => { console.log('[SIGNAL] fetch error:', err.message); recordTvHealth(false, 'market data connection error'); callback('Market data temporarily unavailable', null); });
  req.write(body); req.end();
}

// TradingView fetch health, so a data outage is visible instead of silent.
const tvHealth = { lastSuccessAt: null, lastFailureAt: null, lastError: null, consecutiveFailures: 0 };
function recordTvHealth(ok, err) {
  if (ok) {
    tvHealth.lastSuccessAt = new Date().toISOString();
    tvHealth.consecutiveFailures = 0;
    tvHealth.lastError = null;
  } else {
    tvHealth.lastFailureAt = new Date().toISOString();
    tvHealth.consecutiveFailures += 1;
    tvHealth.lastError = String(err || 'unknown');
    if (tvHealth.consecutiveFailures === 1 || tvHealth.consecutiveFailures % 5 === 0) {
      console.log('[SIGNAL HEALTH] market data fetch failing x' + tvHealth.consecutiveFailures + ': ' + tvHealth.lastError);
    }
  }
}
// Unhealthy = repeated failures, or no success for >5 min during market hours.
function tvHealthView() {
  const staleMs = tvHealth.lastSuccessAt ? Date.now() - new Date(tvHealth.lastSuccessAt).getTime() : Infinity;
  // Only "unhealthy" after ACTUAL failures - not merely "no fetch yet" (which is
  // normal pre-open or when no positions are open so monitors don't fetch).
  const unhealthy = tvHealth.consecutiveFailures >= 2 ||
    (!!tvHealth.lastFailureAt && withinMarketHours() && staleMs > 5 * 60 * 1000);
  return { ...tvHealth, unhealthy, marketOpen: withinMarketHours() };
}

// Shared short-TTL price cache so the per-minute monitors (EMA trailing, EMA
// target, Angel targets, MTM rules) collapse to ONE TradingView fetch when they
// co-fire, instead of one each. Per-symbol so partial overlaps still share.
// Order placement and manual endpoints keep using fetchTVData directly (fresh).
const TV_CACHE_TTL_MS = 45 * 1000;
const tvPriceCache = new Map(); // SYMBOL -> { row, at }
function tvCacheKey(s) {
  return String(s || '').replace('NSE:', '').replace('.NS', '').replace('-EQ', '').replace(/\s/g, '').trim().toUpperCase();
}
function fetchTVDataCached(symbols, callback) {
  const now = Date.now();
  if (tvPriceCache.size > 500) {
    for (const [k, v] of tvPriceCache) if (now - v.at > 5 * TV_CACHE_TTL_MS) tvPriceCache.delete(k);
  }
  const wanted = [...new Set(symbols.map(tvCacheKey).filter(Boolean))];
  const stale = wanted.filter(s => { const c = tvPriceCache.get(s); return !c || (now - c.at) > TV_CACHE_TTL_MS; });
  const build = () => wanted.map(s => tvPriceCache.get(s)?.row).filter(Boolean);
  if (!stale.length) return callback(null, build());
  fetchTVData(stale, (err, rows) => {
    if (err) { const cached = build(); return callback(cached.length ? null : err, cached); }
    (rows || []).forEach(r => { const k = tvCacheKey(r.symbol); if (k) tvPriceCache.set(k, { row: r, at: Date.now() }); });
    callback(null, build());
  });
}

// Ã¢â€â‚¬Ã¢â€â‚¬ Dhan Super Order Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

// Round order prices to a broker-valid tick: whole rupees at >= 1000, nearest
// 0.10 below 1000 (both are multiples of the 0.05 NSE tick). Finer granularity
// for lower-priced stocks where a full rupee would be too coarse.
function roundPrice(value) {
  const v = Number(value) || 0;
  // Whole rupee >= 1000, else nearest 0.10 (a valid 0.05-tick multiple). This
  // matches the user's preferred rounding and avoids broker tick rejections.
  return v >= 1000 ? Math.round(v) : Math.round(v * 10) / 10;
}

// True only when we can positively confirm a live protective stop exists on the
// broker for this entry. Used to avoid arming/trailing a naked position.
function entryHasBrokerStop(entry) {
  const broker = String(entry.broker || 'dhan').toLowerCase();
  if (broker === 'zerodha') return !!parseZerodhaOrderIds(entry.orderId).gttId;
  if (broker === 'angelone') return !!(entry.angelOneSlRuleId || entry.mtmRemainderSlOrderId);
  const oid = String(entry.orderId || '').toUpperCase();
  return !!oid && !['N/A', 'ERROR', 'SKIPPED'].includes(oid);
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
  const hasAngelCredentialSetup = brokerId === 'angelone' && (payload.accountId || previous.accountId);
  if (!clientId || (!accessToken && !['zerodha', 'upstox'].includes(brokerId) && !hasAngelCredentialSetup)) return null;
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
    const hasAngelLoginSetup = brokerId === 'angelone' && !!store?.clientId && !!store?.accountId;
    const canAngelRenew = hasAngelLoginSetup && !!store?.refreshToken;
    return {
      broker: brokerId,
      configured: false,
      credentialsConfigured: canLoginRenew || hasAngelLoginSetup,
      status: hasAngelLoginSetup ? (canAngelRenew ? 'needs-renew' : 'needs-login') : 'missing',
      canLoginRenew,
      canAutoRenew: canAngelRenew,
      loginUrl: canLoginRenew ? '/broker/' + brokerId + '/login' : null,
      callbackPath: ['zerodha', 'upstox'].includes(brokerId) ? '/broker/' + brokerId + '/callback' : null,
      renewalTimeIst: canAngelRenew ? String(DHAN_RENEW_HOUR_IST).padStart(2, '0') + ':' + String(DHAN_RENEW_MINUTE_IST).padStart(2, '0') : null,
      message: canLoginRenew
        ? (brokerId === 'upstox' ? "Upstox credentials saved. Complete today's secure Upstox login." : "Kite credentials saved. Complete today's Zerodha login.")
        : hasAngelLoginSetup
          ? 'Angel One credentials saved. Enter PIN/password and current TOTP, then generate today token.'
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
        ? (canAutoRenew ? 'Angel One token can auto-refresh using the saved refresh token.' : 'Angel One token is active. Repeat Angel One login when it expires.')
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

function angelRequest(method, pathname, store, accessToken, payload, callback) {
  const body = payload ? JSON.stringify(payload) : '';
  const req = https.request({
    hostname: 'apiconnect.angelone.in',
    port: 443,
    path: pathname,
    method,
    headers: angelHeaders(store, accessToken, Buffer.byteLength(body)),
  }, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      callback(null, { status: apiRes.statusCode, data: parsed, request: payload || {} });
    });
  });
  req.on('error', err => callback(err.message, null));
  if (body) req.write(body);
  req.end();
}

function angelApiMessage(parsed, fallback) {
  return parsed?.message || parsed?.errorcode || parsed?.error || (typeof parsed === 'string' ? parsed : '') || fallback;
}

// Map Angel's generic errors to a specific, actionable cause so users can
// self-diagnose the most common "won't go active" reasons.
function angelLoginHint(rawMsg, parsed) {
  const m = String(rawMsg || '').toLowerCase();
  const code = String(parsed?.errorcode || '').toUpperCase();
  if (m.includes('totp') || code === 'AB1050') {
    return ' — Hint: the TOTP must be the CURRENT 6-digit code from the authenticator you linked in SmartAPI (not the Angel One app OTP), entered within its 30s window. If it keeps failing, your phone clock may be out of sync.';
  }
  if (m.includes('invalid api') || m.includes('private key') || code === 'AB1004') {
    return ' — Hint: the SmartAPI Key looks wrong. Use the API Key from smartapi.angelbroking.com → My Apps (an alphanumeric key), not your client code/number.';
  }
  if (m.includes('client') || m.includes('user') || m.includes('password') || m.includes('mpin') || code === 'AB1007') {
    return ' — Hint: check your client code and trading MPIN (use your MPIN, not the website login password).';
  }
  if (m.includes('block') || m.includes('frozen') || m.includes('suspend')) {
    return ' — Hint: Angel says the account is blocked/frozen. Resolve it in your Angel One account, then retry.';
  }
  return '';
}

function loginAngelOneToken(store, password, totp, callback) {
  if (!store?.clientId || !store?.accountId || !password || !totp) {
    return callback('Angel One SmartAPI key, client code, PIN/password, and current TOTP are required');
  }
  const body = JSON.stringify({
    clientcode: String(store.accountId),
    password: String(password),
    totp: String(totp),
  });
  const req = https.request({
    hostname: 'apiconnect.angelone.in',
    port: 443,
    path: '/rest/auth/angelbroking/user/v1/loginByPassword',
    method: 'POST',
    headers: angelHeaders(store, '', Buffer.byteLength(body)),
  }, apiRes => {
    let data = '';
    apiRes.on('data', chunk => data += chunk);
    apiRes.on('end', () => {
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = {}; }
      const result = parsed?.data || {};
      const accessToken = result.jwtToken || result.accessToken || '';
      const refreshToken = result.refreshToken || '';
      const feedToken = result.feedToken || '';
      if (apiRes.statusCode >= 400 || !accessToken || parsed?.status === false) {
        const rawMsg = parsed?.message || parsed?.errorcode || data || ('HTTP ' + apiRes.statusCode);
        return callback('Angel One login failed: ' + rawMsg + angelLoginHint(rawMsg, parsed), null);
      }
      callback(null, { accessToken, refreshToken, feedToken, raw: parsed });
    });
  });
  req.on('error', err => callback('Angel One login failed: ' + err.message, null));
  req.setTimeout(20000, () => req.destroy(new Error('Angel One did not respond in time (network/Angel server issue). Try again.')));
  req.write(body);
  req.end();
}

function renewAngelOneToken(store, callback) {
  if (!store?.refreshToken || !store?.clientId || !store?.accountId) {
    return callback('Angel One needs a fresh Settings login with PIN/password and current TOTP');
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
  req.setTimeout(20000, () => req.destroy(new Error('Angel One did not respond in time (network/Angel server issue). Try again.')));
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
    if (!getBrokerTokenStatus(brokerId).canAutoRenew || brokerStore.lastRenewalDate === dateKey) return;
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

function isPostTargetEmaTrailingOrder(orderParams = {}) {
  return !!orderParams.emaTrailingEnabled && String(orderParams.emaTrailingTrigger || 'afterTarget') === 'afterTarget';
}

function trailingActivationStatus(broker) {
  const name = String(broker || 'dhan').toLowerCase();
  if (name === 'zerodha') return 'ZERODHA ENTRY + SL GTT | TARGET ARMS EMA TRAIL';
  if (name === 'dhan') return 'DHAN ENTRY + SL | TARGET ARMS EMA TRAIL';
  return 'ENTRY + SL | TARGET ARMS EMA TRAIL';
}

function placeSuperOrder(orderParams, dhanClient, dhanToken, callback) {
  const entry = Number(orderParams.entryPrice);
  const sl = Number(orderParams.slPrice);
  const target = Number(orderParams.targetPrice);
  const qty = Number(orderParams.qty);
  const symbol = String(orderParams.symbol || '').replace(/\s/g, '').toUpperCase();
  const slTriggerBufferPct = Math.max(0, Number(orderParams.dhanSlTriggerBufferPct || orderParams.slTriggerBufferPct || 0));
  const emaTrailingMode = isPostTargetEmaTrailingOrder(orderParams);

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
    const trailPct = emaTrailingMode ? 0 : Number(orderParams.trailSL || 0);
    // Keep the buffered SL at least 1 (whole) rupee below entry so it stays a
    // valid below-entry stop after whole-rupee rounding.
    const brokerStopLossPrice = orderParams.action === 'BUY' && slTriggerBufferPct > 0
      ? roundPrice(Math.min(entry - 1, sl * (1 + slTriggerBufferPct / 100)))
      : roundPrice(sl);
    if (!(brokerStopLossPrice < roundPrice(entry))) return callback('Invalid Dhan SL trigger: protective SL must remain below entry price', null);
    const payload = {
      dhanClientId:     dhanClient,
      transactionType:  orderParams.action,
      exchangeSegment:  orderParams.exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ',
      productType:      orderParams.segment || 'CNC',
      orderType:        'LIMIT',
      securityId:       String(securityId),
      quantity:         qty,
      price:            roundPrice(entry),
      stopLossPrice:    roundPrice(brokerStopLossPrice),
      trailingJump:     trailPct > 0 ? Math.max(1, roundPrice(entry * trailPct / 100)) : 0,
    };
    if (!emaTrailingMode) payload.targetPrice = roundPrice(target);
    const body = JSON.stringify(payload);

    const req = https.request({
      hostname: 'api.dhan.co', port: 443, path: '/v2/super/orders', method: 'POST',
      headers: { 'access-token': dhanToken, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (apiRes) => {
      let data = '';
      apiRes.on('data', c => data += c);
      apiRes.on('end', () => {
        let p; try { p = JSON.parse(data); } catch { p = data; }
        if (apiRes.statusCode >= 400) return callback(dhanApiMessage(p, 'Dhan order failed with HTTP ' + apiRes.statusCode), { status: apiRes.statusCode, data: p, request: JSON.parse(body) });
        callback(null, { status: apiRes.statusCode, data: p, request: JSON.parse(body), softwareTargetTrailing: emaTrailingMode });
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

function kiteGet(pathname, apiKey, accessToken, callback) {
  kiteRequest('GET', pathname, apiKey, accessToken, null, callback);
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
  const payload = {
    orderId,
    stopLossPrice: roundPrice(nextSl),
    trailingJump: 0,
  };
  if (!entry.emaTrailingEnabled) payload.targetPrice = roundPrice(entry.targetPrice || 0);
  const body = JSON.stringify(payload);
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
  const gttForm = entry.emaTrailingEnabled ? {
    type: 'single',
    condition: JSON.stringify({
      exchange,
      tradingsymbol: symbol,
      trigger_values: [roundPrice(nextSl)],
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
    ]),
  } : {
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

function angelOneProductType(segment) {
  return String(segment || '').toUpperCase() === 'INTRADAY' ? 'INTRADAY' : 'DELIVERY';
}

function angelOneOrderId(payload) {
  return payload?.data?.orderid || payload?.data?.orderId || payload?.orderid || payload?.orderId || '';
}

function angelOneRuleId(payload) {
  return payload?.data?.id || payload?.data?.ruleId || payload?.data?.rule_id || payload?.id || payload?.ruleId || payload?.rule_id || '';
}

function parseAngelOneOrderIds(entryOrText) {
  const text = typeof entryOrText === 'string' ? entryOrText : String(entryOrText?.orderId || '');
  const read = (label) => {
    const match = text.match(new RegExp(label + ':([^|]+)', 'i'));
    return match ? match[1].trim() : '';
  };
  return {
    entryId: (typeof entryOrText === 'object' && entryOrText?.angelOneEntryOrderId) || read('ENTRY') || (/^\d+$/.test(text.trim()) ? text.trim() : ''),
    slRuleId: (typeof entryOrText === 'object' && entryOrText?.angelOneSlRuleId) || read('SLGTT') || read('SLRULE') || '',
    slOrderId: (typeof entryOrText === 'object' && entryOrText?.angelOneSlOrderId) || read('SL') || '',
    targetOrderId: (typeof entryOrText === 'object' && (entryOrText?.angelOneTargetOrderId || entryOrText?.targetExitOrderId)) || read('TARGET') || '',
  };
}

function angelOneSlLimitPrice(triggerPrice, bufferPct = 0.5) {
  const trigger = Number(triggerPrice || 0);
  const pct = Number.isFinite(Number(bufferPct)) && Number(bufferPct) > 0 ? Number(bufferPct) : 0.5;
  return roundPrice(trigger * (1 - pct / 100));
}

function buildAngelOneGttPayload({ instrument, transactionType, triggerPrice, price, qty, productType, exchange }) {
  return {
    tradingsymbol: instrument.tradingSymbol,
    symboltoken: instrument.token,
    exchange: instrument.exchange || exchange || 'NSE',
    producttype: productType,
    transactiontype: transactionType,
    price: String(roundPrice(price)),
    qty: String(qty),
    disclosedqty: '0',
    triggerprice: String(roundPrice(triggerPrice)),
    timeperiod: 365,
  };
}

function createAngelOneGttRule(store, accessToken, params, callback) {
  const payload = buildAngelOneGttPayload(params);
  angelRequest('POST', '/gtt-service/rest/secure/angelbroking/gtt/v1/createRule', store, accessToken, payload, (err, res) => {
    if (err) return callback('Angel One GTT create failed: ' + err, null);
    if (!res || res.status >= 400 || res.data?.status === false) {
      return callback('Angel One GTT create failed: ' + angelApiMessage(res?.data, 'HTTP ' + res?.status), res);
    }
    callback(null, res);
  });
}

function modifyAngelOneGttRule(store, accessToken, ruleId, params, callback) {
  const payload = { id: String(ruleId), ...buildAngelOneGttPayload(params) };
  angelRequest('POST', '/gtt-service/rest/secure/angelbroking/gtt/v1/modifyRule', store, accessToken, payload, (err, res) => {
    if (err) return callback('Angel One GTT modify failed: ' + err, null);
    if (!res || res.status >= 400 || res.data?.status === false) {
      return callback('Angel One GTT modify failed: ' + angelApiMessage(res?.data, 'HTTP ' + res?.status), res);
    }
    callback(null, res);
  });
}

function cancelAngelOneGttRule(store, accessToken, ruleId, callback) {
  if (!ruleId) return callback(null, { skipped: true });
  angelRequest('POST', '/gtt-service/rest/secure/angelbroking/gtt/v1/cancelRule', store, accessToken, { id: String(ruleId) }, (err, res) => {
    if (err) return callback('Angel One GTT cancel failed: ' + err, null);
    if (!res || res.status >= 400 || res.data?.status === false) {
      return callback('Angel One GTT cancel failed: ' + angelApiMessage(res?.data, 'HTTP ' + res?.status), res);
    }
    callback(null, res);
  });
}

function resolveAngelOneInstrument(symbol, exchange, callback) {
  const cleanSymbol = String(symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  loadAngelInstrumentMap((lookupErr, instrumentMap) => {
    if (lookupErr) return callback('Angel One instrument lookup failed: ' + lookupErr, null);
    const ex = exchange === 'BSE' ? 'BSE' : 'NSE';
    const instrument = instrumentMap?.[ex + ':' + cleanSymbol] || instrumentMap?.[cleanSymbol];
    if (!instrument?.token) return callback('Angel One symbol token not found for ' + cleanSymbol, null);
    callback(null, { cleanSymbol, exchange: ex, instrument });
  });
}

function modifyAngelOneGttStopLoss(entry, nextSl, callback) {
  const storeData = readBrokerTokenStore().brokers.angelone;
  const ids = parseAngelOneOrderIds(entry);
  if (!storeData?.clientId || !storeData?.accountId || !storeData?.accessToken) return callback("No Angel One token generated. Open Settings and generate today's token.");
  if (!ids.slRuleId) return callback('No Angel One SL GTT rule ID available');
  const qty = Number(entry.qty || 0);
  if (!qty) return callback('Missing Angel One trailing quantity');
  const store = { clientId: storeData.clientId, accountId: storeData.accountId };
  resolveAngelOneInstrument(entry.symbol, entry.exchange || 'NSE', (lookupErr, info) => {
    if (lookupErr) return callback(lookupErr);
    const slLimit = angelOneSlLimitPrice(nextSl);
    modifyAngelOneGttRule(store, storeData.accessToken, ids.slRuleId, {
      instrument: info.instrument,
      transactionType: 'SELL',
      triggerPrice: nextSl,
      price: slLimit,
      qty,
      productType: angelOneProductType(entry.segment),
      exchange: info.exchange,
    }, callback);
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
  const emaTrailingMode = isPostTargetEmaTrailingOrder(orderParams);
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

    const gttForm = emaTrailingMode ? {
      type: 'single',
      condition: JSON.stringify({
        exchange,
        tradingsymbol: symbol,
        trigger_values: [roundPrice(sl)],
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
      ]),
    } : {
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
        softwareTargetTrailing: emaTrailingMode,
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

// Ã¢â€â‚¬Ã¢â€â‚¬ Server Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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
    'symbol','nsecode','ticker','tradingsymbol','trading_symbol','company','company_name','companyname','compname','name','fincode','stock_fincode','live_price','ltp','close_price','market_cap','big_player_score','growth_score','momentum_score','returns_efficiency','returns_efficiency_score','long_term','long_term_score','short_term','short_term_score'
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

function stockkarPathWithPaging(basePath, limit, offset) {
  const raw = String(basePath || '').trim();
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  params.set('limit', String(Math.min(Number(limit) || STOCKKAR_MAX_LIMIT, STOCKKAR_MAX_LIMIT)));
  params.set('offset', String(offset || 0));
  if (!params.has('include_technicals')) params.set('include_technicals', 'true');
  return `${path}?${params.toString()}`;
}

function normalizeStockkarStocksPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let path = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      path = url.pathname + url.search;
    }
  } catch (_) {}
  const apiIndex = path.indexOf('/api/');
  if (apiIndex >= 0) path = path.slice(apiIndex);
  if (!path.startsWith('/')) path = '/' + path;
  if (/^\/stocks(\?|$)/.test(path)) path = '/api' + path;
  if (!/^\/api\/stocks(\?|$)/.test(path)) return '';
  return path;
}

function collectStockkarStocksPaths(value, paths = [], depth = 0, seen = new Set()) {
  if (depth > 8 || value == null) return paths;
  if (typeof value === 'string') {
    const direct = normalizeStockkarStocksPath(value);
    if (direct && !paths.includes(direct)) paths.push(direct);
    return paths;
  }
  if (typeof value !== 'object') return paths;
  if (seen.has(value)) return paths;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(item => collectStockkarStocksPaths(item, paths, depth + 1, seen));
    return paths;
  }
  Object.entries(value).forEach(([key, child]) => {
    if (/url|path|endpoint|api|stocks/i.test(key)) {
      const direct = normalizeStockkarStocksPath(child);
      if (direct && !paths.includes(direct)) paths.push(direct);
    }
    collectStockkarStocksPaths(child, paths, depth + 1, seen);
  });
  return paths;
}

function uniqueNonEmptyStrings(values) {
  return Array.from(new Set((values || []).map(v => String(v || '').trim()).filter(Boolean)));
}

function slugifyStockkarLookup(value) {
  return String(value || '').trim().toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function savedFilterNameFromItem(item) {
  if (!item || typeof item !== 'object') return String(item || '').trim();
  return item.stockkarDisplayName || item.name || item.title || item.label || item.filter_name ||
    item.filterName || item.displayName || item.screen_name || item.screener_name || '';
}

function savedFilterIdFromItem(item) {
  if (!item || typeof item !== 'object') return String(item || '').trim();
  return item.stockkarSavedFilterId || item.slug || item.id || item._id || item.uuid || item.filter_id ||
    item.filterId || item.saved_id || item.savedFilterId || item.key || savedFilterNameFromItem(item);
}

function savedFilterLookupValues(filterId, filterName) {
  const raw = uniqueNonEmptyStrings([filterId, filterName].flatMap(value => String(value || '').split('|||')));
  return uniqueNonEmptyStrings(raw.concat(raw.map(slugifyStockkarLookup)));
}

function fetchSavedFilterDirect(filterId, token, limit, callback, filterName) {
  const max = Math.min(Number(limit) || STOCKKAR_MAX_LIMIT, STOCKKAR_MAX_LIMIT);
  const lookupIds = savedFilterLookupValues(filterId, filterName).map(v => encodeURIComponent(v));
  if (!lookupIds.length) return callback(null, null);

  const candidates = Array.from(new Set(lookupIds.flatMap(id => [
    `/api/saved-filter/slug/${id}/stocks?include_technicals=true`,
    `/api/saved-filter/${id}/stocks?include_technicals=true`,
    `/api/saved-filter/stocks/${id}?include_technicals=true`,
    `/api/saved-filter/saved/${id}/stocks?include_technicals=true`,
    `/api/custom-filter/${id}/stocks?include_technicals=true`,
    `/api/custom-filter/slug/${id}/stocks?include_technicals=true`,
    `/api/custom-filter/stocks/${id}?include_technicals=true`,
  ])));

  const fetchPage = (basePath, offset, rows, done) => {
    const apiPath = stockkarPathWithPaging(basePath, max, offset);
    stockkarGet(apiPath, token, (err, r) => {
      if (err) return done(null, { err, rows, response: r });
      const pageRows = pickStockRowsFromPayload(r?.data);
      const nextRows = rows.concat(pageRows);
      if (pageRows.length === max) return fetchPage(basePath, offset + max, nextRows, done);
      done(null, { rows: nextRows, response: r, sourcePath: basePath });
    });
  };

  const trySavedFilterConfigPaths = (lastError) => {
    const configCandidates = Array.from(new Set(lookupIds.flatMap(id => [
      `/api/saved-filter/slug/${id}`,
      `/api/saved-filter/${id}`,
      `/api/custom-filter/slug/${id}`,
      `/api/custom-filter/${id}`,
    ])));
    const tryConfig = (cfgIndex, lastCfgError) => {
      if (cfgIndex >= configCandidates.length) return callback(null, null, lastCfgError || lastError);
      stockkarGet(configCandidates[cfgIndex], token, (cfgErr, cfgRes) => {
        if (cfgErr) return tryConfig(cfgIndex + 1, cfgErr);
        const paths = collectStockkarStocksPaths(cfgRes?.data);
        const tryPath = (pathIndex, lastPathError) => {
          if (pathIndex >= paths.length) return tryConfig(cfgIndex + 1, lastPathError || lastCfgError);
          fetchPage(paths[pathIndex], 0, [], (err, result) => {
            if (err) return callback(err);
            if (result?.rows?.length) {
              return callback(null, {
                status: result.response?.status || 200,
                data: result.rows,
                sourcePath: paths[pathIndex],
              });
            }
            tryPath(pathIndex + 1, result?.err || lastPathError);
          });
        };
        tryPath(0, null);
      });
    };
    tryConfig(0, lastError);
  };

  const tryCandidate = (index, lastError) => {
    if (index >= candidates.length) return trySavedFilterConfigPaths(lastError);
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

function htmlEntityDecode(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

function walkJson(value, visitor, depth = 0, seen = new Set()) {
  if (depth > 8 || value == null) return;
  if (typeof value === 'object') {
    if (seen.has(value)) return;
    seen.add(value);
    visitor(value);
    if (Array.isArray(value)) value.forEach(item => walkJson(item, visitor, depth + 1, seen));
    else Object.values(value).forEach(item => walkJson(item, visitor, depth + 1, seen));
  }
}

function normalizeWatchlistStockRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  const symbol = row.symbol || row.nsecode || row.nse_code || row.trading_symbol || row.tradingsymbol || row.stock_symbol || '';
  const fincode = row.fincode || row.stock_fincode || row.fin_code || row.stockFincode || '';
  const companyName = row.company_name || row.companyName || row.stock_name || row.stockName || row.compname || row.name || '';
  const price = row.close_price || row.live_price || row.ltp || row.price || row.last_price || row.entry_close || '';
  return {
    ...row,
    fincode,
    stock_fincode: row.stock_fincode || fincode,
    symbol,
    stock_name: row.stock_name || companyName,
    company_name: companyName,
    name: row.name || companyName,
    close_price: row.close_price || price,
    live_price: row.live_price || price,
    price,
    sector: row.sector || row.sector_name || '',
    industry: row.industry || row.industry_name || '',
    market_cap: row.market_cap || row.marketCap || row.mcap || row.marketcap || '',
    big_player_score: row.big_player_score ?? row.bigPlayerScore ?? row.big_player,
    growth_score: row.growth_score ?? row.growthScore ?? row.growth,
    momentum_score: row.momentum_score ?? row.momentumScore ?? row.momentum,
    returns_efficiency: row.returns_efficiency ?? row.returnsEfficiency ?? row.returns_efficiency_score ?? row.returnsEfficiencyScore,
    long_term: row.long_term ?? row.longTerm ?? row.long_term_score ?? row.longTermScore,
    short_term: row.short_term ?? row.shortTerm ?? row.short_term_score ?? row.shortTermScore,
  };
}

function normalizeWatchlistItems(payload) {
  const rawLists = Array.isArray(payload?.watchlists) ? payload.watchlists :
                   Array.isArray(payload?.data?.watchlists) ? payload.data.watchlists :
                   Array.isArray(payload?.data) ? payload.data :
                   Array.isArray(payload) ? payload : [];
  const candidates = [];
  rawLists.forEach(item => candidates.push(item));

  if (!candidates.length) {
    walkJson(payload, value => {
      if (!Array.isArray(value)) return;
      const objects = value.filter(item => item && typeof item === 'object' && !Array.isArray(item));
      const watchlike = objects.filter(item => {
        const keys = Object.keys(item).map(k => k.toLowerCase());
        return keys.includes('stocks') && keys.some(k => ['id','_id','uuid','slug','name','title'].includes(k));
      });
      if (watchlike.length) candidates.push(...watchlike);
    });
  }

  const seen = new Set();
  return candidates.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const id = String(item.id || item._id || item.uuid || item.slug || item.name || item.title || '').trim();
    const name = String(item.name || item.title || item.label || item.slug || id || 'Watchlist').trim();
    if (!id || !name || seen.has(id)) return null;
    seen.add(id);
    const stocks = Array.isArray(item.stocks) ? item.stocks.map(normalizeWatchlistStockRow) : [];
    return {
      id,
      slug: item.slug || id,
      name,
      stockCount: Number(item.stockCount ?? item.stocks_count ?? item.count ?? stocks.length) || stocks.length,
      stocks,
      raw: item,
    };
  }).filter(Boolean);
}

function parseJsonSnippetsFromHtml(html) {
  const text = String(html || '');
  const snippets = [];
  const nextMatch = text.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextMatch) snippets.push(htmlEntityDecode(nextMatch[1]).trim());
  const appJsonMatches = text.matchAll(/<script[^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const m of appJsonMatches) snippets.push(htmlEntityDecode(m[1]).trim());
  const pushMatches = text.matchAll(/self\.__next_f\.push\((\[[\s\S]*?\])\)/g);
  for (const m of pushMatches) snippets.push(htmlEntityDecode(m[1]).trim());
  return snippets.map(raw => {
    try { return JSON.parse(raw); } catch { return null; }
  }).filter(Boolean);
}

function extractWatchlistsFromHtml(html) {
  const parsed = parseJsonSnippetsFromHtml(html);
  let lists = [];
  parsed.forEach(obj => { lists = lists.concat(normalizeWatchlistItems(obj)); });
  if (lists.length) return lists;

  const stripped = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const text = htmlEntityDecode(stripped.replace(/<[^>]+>/g, '\n'));
  const lines = text.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const blacklist = new Set(['Stockkar', 'My Watchlists', 'Lists', 'Stocks', 'Library', 'New', 'Edit', 'Home', 'Screeners', 'Dashboard']);
  const names = [];
  for (const line of lines) {
    if (blacklist.has(line)) continue;
    if (line.length < 2 || line.length > 60) continue;
    if (/^\d+$/.test(line)) continue;
    if (/results|tracked|price|change|added|note|search|company|quick links|date|market/i.test(line)) continue;
    if (/^[A-Z0-9 .&-]+$/.test(line) || /^[A-Z][A-Za-z0-9 .&-]+$/.test(line)) names.push(line);
  }
  return Array.from(new Set(names)).slice(0, 30).map(name => ({ id: name, slug: name, name, raw: { source: 'profile-page-text' } }));
}
function normalizeWatchlistRowsFromHtml(html) {
  const parsed = parseJsonSnippetsFromHtml(html);
  for (const obj of parsed) {
    const rows = pickStockRowsFromPayload(obj);
    if (rows.length) return rows;
  }
  return [];
}

function stockkarTryGet(paths, token, callback, hosts = [STOCKKAR_HOST, 'stockkar.in', 'www.stockkar.in']) {
  const attempts = [];
  hosts.forEach(host => paths.forEach(path => attempts.push({ host, path })));
  const run = (index, lastError) => {
    if (index >= attempts.length) return callback(null, null, lastError);
    const attempt = attempts[index];
    stockkarHostGet(attempt.host, attempt.path, token, (err, r) => {
      if (err) return run(index + 1, err);
      if (r && r.status >= 200 && r.status < 300) return callback(null, r, null);
      run(index + 1, 'HTTP ' + (r?.status || 'error') + ' from ' + attempt.host + attempt.path);
    });
  };
  run(0, null);
}

function fetchWatchlists(token, callback) {
  const candidates = [
    '/api/watchlist/my-with-stocks',
    '/api/watchlists/my-with-stocks',
    '/watchlist/my-with-stocks',
    '/watchlists/my-with-stocks',
  ];
  stockkarTryGet(candidates, token, (err, r, miss) => {
    if (err) return callback(null, [], err);
    if (!r) return callback(null, [], miss || 'No response from Stockkar watchlist API');
    const sourcePath = r.hostname + (r.path || '');
    const list = typeof r.data === 'string' ? extractWatchlistsFromHtml(r.data) : normalizeWatchlistItems(r.data);
    callback(null, list, list.length ? null : 'No watchlists from ' + sourcePath, sourcePath);
  }, [STOCKKAR_HOST, 'stockkar.in', 'www.stockkar.in']);
}

function fetchWatchlistRows(watchlistId, token, limit, callback) {
  const max = Math.min(Number(limit) || STOCKKAR_MAX_LIMIT, STOCKKAR_MAX_LIMIT);
  const rawId = String(watchlistId || '').trim();
  if (!rawId) return callback(new Error('Watchlist id missing'));

  fetchWatchlists(token, (err, list, miss, sourcePath) => {
    if (err) return callback(err);
    const key = rawId.toLowerCase();
    const selected = (list || []).find(w =>
      String(w.id || '').toLowerCase() === key ||
      String(w.slug || '').toLowerCase() === key ||
      String(w.name || '').toLowerCase() === key
    );
    if (!selected) return callback(null, null, miss || 'Selected watchlist was not found in Stockkar response');
    const rows = Array.isArray(selected.stocks) ? selected.stocks.slice(0, max).map(normalizeWatchlistStockRow) : [];
    callback(null, {
      status: 200,
      data: rows,
      sourcePath: sourcePath || 'watchlist/my-with-stocks',
      watchlistName: selected.name,
    }, rows.length ? null : 'Watchlist "' + selected.name + '" has no stocks');
  });
}

function readSavedScreenerMonitors() {
  const data = readJsonFile(SAVED_MONITORS_FILE, { monitors: [] }) || { monitors: [] };
  data.monitors = Array.isArray(data.monitors) ? data.monitors : [];
  return data;
}

function writeSavedScreenerMonitors(data) {
  writePrivateJson(SAVED_MONITORS_FILE, {
    updatedAt: new Date().toISOString(),
    monitors: Array.isArray(data?.monitors) ? data.monitors : [],
  });
}

function monitorClientView(monitor, includeStocks = false) {
  const latestSnapshot = Array.isArray(monitor.latestSnapshot) ? monitor.latestSnapshot : [];
  const previousSnapshot = Array.isArray(monitor.previousSnapshot) ? monitor.previousSnapshot : [];
  const view = {
    id: monitor.id,
    enabled: monitor.enabled !== false,
    source: monitor.source || 'builtin',
    name: monitor.name || 'Saved monitor',
    slug: monitor.slug || '',
    filterId: monitor.filterId || '',
    createdAt: monitor.createdAt || null,
    updatedAt: monitor.updatedAt || null,
    refreshTime: monitor.refreshTime || '08:00 IST',
    lastRefreshAt: monitor.lastRefreshAt || null,
    lastRefreshDate: monitor.lastRefreshDate || '',
    lastRefreshStatus: monitor.lastRefreshStatus || 'saved',
    lastRefreshError: monitor.lastRefreshError || '',
    latestCount: latestSnapshot.length,
    previousCount: previousSnapshot.length,
  };
  if (includeStocks) view.latestSnapshot = latestSnapshot;
  return view;
}

function monitorStockKey(row) {
  return String(row?.symbol || row?.nsecode || row?.ticker || row?.tradingsymbol || row?.fincode || row?.company_name || row?.name || '').trim().toUpperCase();
}

function normalizeMonitorStocks(stocks) {
  const seen = new Set();
  return (Array.isArray(stocks) ? stocks : [])
    .filter(row => row && typeof row === 'object' && !Array.isArray(row))
    .filter(row => {
      const key = monitorStockKey(row);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, STOCKKAR_MAX_LIMIT);
}

function fetchSavedMonitorRows(monitor, token, callback) {
  if ((monitor.source || 'builtin') === 'manual') {
    const rows = normalizeMonitorStocks(monitor.latestSnapshot || []);
    if (rows.length) return callback(null, rows, 'manual-watchlist');
    return callback(new Error('Manual watchlist is empty'));
  }
  if ((monitor.source || 'builtin') === 'saved') {
    const monitorLookup = uniqueNonEmptyStrings([
      monitor.filterId || monitor.slug,
      monitor.name || monitor.screenerName || monitor.filterName,
    ]).join('|||');
    return fetchSavedFilterDirect(monitorLookup, token, STOCKKAR_MAX_LIMIT, (err, directRes, directMiss) => {
      if (err) return callback(err);
      const rows = directRes ? pickStockRowsFromPayload(directRes.data) : [];
      if (rows.length) return callback(null, rows, directRes.sourcePath || 'saved-filter-direct');
      callback(new Error('No stocks found for saved screener refresh' + (directMiss ? ': ' + directMiss : '')));
    });
  }
  if ((monitor.source || 'builtin') === 'watchlist') {
    return fetchWatchlistRows(monitor.filterId || monitor.slug, token, STOCKKAR_MAX_LIMIT, (err, watchlistRes, watchlistMiss) => {
      if (err) return callback(err);
      const rows = watchlistRes ? pickStockRowsFromPayload(watchlistRes.data) : [];
      if (rows.length) return callback(null, rows, watchlistRes.sourcePath || 'watchlist-direct');
      callback(new Error('No stocks found for watchlist refresh' + (watchlistMiss ? ': ' + watchlistMiss : '')));
    });
  }
  fetchCurrentScreener(monitor.slug, token, (err, response) => {
    if (err) return callback(err);
    const rows = extractStockRows(response?.data);
    if (!rows.length) return callback(new Error('No stocks found for built-in screener refresh'));
    callback(null, rows, response?.sourcePath || 'builtin-screener');
  });
}

function refreshSavedScreenerMonitor(monitor, callback) {
  const token = monitor.stockkarToken || getStoredToken();
  const now = new Date().toISOString();
  if (!token) {
    monitor.lastRefreshAt = now;
    monitor.lastRefreshStatus = 'failed';
    monitor.lastRefreshError = 'Stockkar token missing';
    return callback(new Error(monitor.lastRefreshError), monitor);
  }
  fetchSavedMonitorRows(monitor, token, (err, rows, sourcePath) => {
    monitor.lastRefreshAt = new Date().toISOString();
    monitor.lastRefreshDate = istDateKey();
    if (err) {
      monitor.lastRefreshStatus = 'failed';
      monitor.lastRefreshError = err.message || String(err);
      return callback(err, monitor);
    }
    const normalized = normalizeMonitorStocks(rows);
    monitor.previousSnapshot = Array.isArray(monitor.latestSnapshot) ? monitor.latestSnapshot : [];
    monitor.latestSnapshot = normalized;
    monitor.sourcePath = sourcePath || monitor.sourcePath || '';
    monitor.lastRefreshStatus = 'ok';
    monitor.lastRefreshError = '';
    monitor.updatedAt = monitor.lastRefreshAt;
    callback(null, monitor);
  });
}

function checkSavedScreenerMonitors() {
  const now = getIstNow();
  const afterRefreshTime = now.getHours() > SAVED_MONITOR_REFRESH_HOUR_IST || (now.getHours() === SAVED_MONITOR_REFRESH_HOUR_IST && now.getMinutes() >= SAVED_MONITOR_REFRESH_MINUTE_IST);
  if (!afterRefreshTime) return;
  const dateKey = istDateKey(now);
  const data = readSavedScreenerMonitors();
  const due = data.monitors.filter(m => m.enabled !== false && m.lastRefreshDate !== dateKey && m.lastRefreshStatus !== 'running');
  if (!due.length) return;

  const runNext = (index) => {
    if (index >= due.length) return;
    const current = readSavedScreenerMonitors();
    const monitor = current.monitors.find(m => m.id === due[index].id);
    if (!monitor || monitor.enabled === false || monitor.lastRefreshDate === dateKey) return runNext(index + 1);
    monitor.lastRefreshStatus = 'running';
    monitor.lastRefreshError = '';
    writeSavedScreenerMonitors(current);
    refreshSavedScreenerMonitor(monitor, () => {
      const latest = readSavedScreenerMonitors();
      const idx = latest.monitors.findIndex(m => m.id === monitor.id);
      if (idx >= 0) latest.monitors[idx] = monitor;
      writeSavedScreenerMonitors(latest);
      runNext(index + 1);
    });
  };

  runNext(0);
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

function getStockkarScoreValue(indicator, row) {
  const key = String(indicator || '').toLowerCase();
  if (key === 'big_player_score') {
    return numberFromValue(findTechnicalField(row, [
      'big_player_score', 'bigplayer_score', 'big_player', 'bigplayer', 'big player score', 'Big Player Score', 'big player'
    ]));
  }
  if (key === 'growth_score') {
    return numberFromValue(findTechnicalField(row, ['growth_score', 'growth', 'Growth Score', 'growth score']));
  }
  if (key === 'momentum_score') {
    return numberFromValue(findTechnicalField(row, ['momentum_score', 'momentum', 'Momentum Score', 'momentum score']));
  }
  if (key === 'returns_efficiency') {
    return numberFromValue(findTechnicalField(row, [
      'returns_efficiency', 'returns_efficiency_score', 'returns efficiency', 'returns efficiency score',
      'Returns Efficiency', 'Returns Efficiency Score', 'return_efficiency', 'return_efficiency_score'
    ]));
  }
  if (key === 'long_term') {
    return numberFromValue(findTechnicalField(row, [
      'long_term', 'long_term_score', 'long term', 'long term score',
      'Long Term', 'Long Term Score'
    ]));
  }
  if (key === 'short_term') {
    return numberFromValue(findTechnicalField(row, [
      'short_term', 'short_term_score', 'short term', 'short term score',
      'Short Term', 'Short Term Score'
    ]));
  }
  return NaN;
}

function isScoreEntryFilter(filter) {
  const key = String(filter?.indicator || '').toLowerCase();
  return filter?.type === 'score' || ['big_player_score', 'growth_score', 'momentum_score', 'returns_efficiency', 'long_term', 'short_term'].includes(key);
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
  if (['big_player_score', 'growth_score', 'momentum_score', 'returns_efficiency', 'long_term', 'short_term'].includes(key)) return getStockkarScoreValue(key, row);
  return NaN;
}

function indicatorLabel(indicator) {
  const key = String(indicator || '').toLowerCase();
  const emaMatch = key.match(/^ema(\d+)$/);
  if (emaMatch) return 'EMA' + emaMatch[1];
  if (key === 'fearless_indicator') return 'Fearless Indicator';
  if (key === 'fearless_zone') return 'Fearless Zone';
  if (key === 'big_player_score') return 'Big Player Score';
  if (key === 'growth_score') return 'Growth Score';
  if (key === 'momentum_score') return 'Momentum Score';
  if (key === 'returns_efficiency') return 'Returns Efficiency';
  if (key === 'long_term') return 'Long Term Score';
  if (key === 'short_term') return 'Short Term Score';
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
  const priceMin = Number(cfg.priceMin || 0);
  const priceMax = Number(cfg.priceMax || 0);
  const stockRows = Array.isArray(cfg.screenerStocks) ? cfg.screenerStocks : [];
  const stockRowBySymbol = {};
  stockRows.forEach(row => { const key = stockKeyFromRow(row); if (key) stockRowBySymbol[key] = row; });

  return tvData.map(stock => {
    const ltp = stock.ltp;
    if (!ltp) return null;
    const symbolKey = String(stock.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
    const row = stockRowBySymbol[symbolKey];
    const criteria = entryFilters.map(filter => {
      const label = indicatorLabel(filter.indicator);
      if (isScoreEntryFilter(filter)) {
        const value = getStockkarScoreValue(filter.indicator, row);
        const minScore = Math.max(0, Math.min(100, Number(filter.minScore ?? 0)));
        const maxScore = Math.max(0, Math.min(100, Number(filter.maxScore ?? 100)));
        const low = Math.min(minScore, maxScore);
        const high = Math.max(minScore, maxScore);
        const pass = Number.isFinite(value) && value >= low && value <= high;
        return {
          indicator: filter.indicator,
          type: 'score',
          value,
          minScore: low,
          maxScore: high,
          distancePct: NaN,
          signal: null,
          pass,
          text: label + ' ' + (Number.isFinite(value) ? value : 'missing') + ' in ' + low + '-' + high,
        };
      }
      const value = getIndicatorValue(filter.indicator, stock, row);
      const withinPct = Number(filter.withinPct || 0);
      const fearless = String(filter.indicator || '').toLowerCase() === 'fearless_indicator'
        ? getFearlessIndicatorData(row)
        : null;
      const distancePct = fearless ? fearless.pct : (value ? ((ltp - value) / value) * 100 : NaN);
      const bullish = !fearless || fearless.signal === 'bullish';
      const pass = bullish && Number.isFinite(distancePct) && distancePct >= 0 && distancePct <= withinPct;
      const signalText = fearless ? ' ' + (fearless.signal || 'signal missing') + ' |' : '';
      const distanceText = Number.isFinite(distancePct)
        ? (distancePct >= 0 ? '+' : '') + distancePct.toFixed(2)
        : 'missing';
      return {
        indicator: filter.indicator,
        type: 'price',
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
    // LTP range filter (e.g. only trade stocks priced 300-1500).
    const priceInRange = (!priceMin || ltp >= priceMin) && (!priceMax || ltp <= priceMax);
    // Position size from per-trade capital. 0 means one share already exceeds the
    // budget, so the stock is NOT tradeable (never force a 1-share over-budget buy).
    const qty = Math.floor(capitalPerTrade / ltp);
    const affordable = qty >= 1;
    const withinEMA = criteria.every(c => c.pass) && priceInRange && affordable;
    const slBase = slMethod === 'indicator' ? getIndicatorValue(cfg.slIndicator, stock, row) : ltp;
    const slPrice = slMethod === 'indicator' && slBase ? slBase * (1 - slIndicatorPct / 100) : ltp * (1 - slPct / 100);
    const slDistance = ltp - slPrice;
    const targetPrice = ltp + (slDistance * rrRatio);
    return {
      ...stock,
      ema,
      criteria,
      criteriaSummary: criteria.map(c => c.text).join(' | '),
      distancePct: distancePct.toFixed(2),
      withinEMA,
      affordable,
      affordabilityNote: affordable ? '' : ('1 share Rs.' + roundPrice(ltp) + ' exceeds per-trade capital Rs.' + capitalPerTrade),
      entryPrice: roundPrice(ltp),
      slPrice: roundPrice(slPrice),
      targetPrice: roundPrice(targetPrice),
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
    if (!stored?.clientId || !stored?.accountId || !stored?.accessToken) return { broker, error: "No Angel One token generated. Open Settings and generate today's token." };
    if (status.status === 'expired') return { broker, error: "Angel One token expired. Generate today's token in Settings." };
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
  if (broker === 'angelone') {
    const entryId = orderRes?.angelOneEntryOrderId || angelOneOrderId(data.entry) || angelOneOrderId(data);
    const slRuleId = orderRes?.angelOneSlRuleId || angelOneRuleId(data.slGtt);
    const targetOrderId = orderRes?.angelOneTargetOrderId || angelOneOrderId(data.target);
    return [
      entryId && ('ENTRY:' + entryId),
      slRuleId && ('SLGTT:' + slRuleId),
      targetOrderId && ('TARGET:' + targetOrderId),
    ].filter(Boolean).join(' | ') || 'N/A';
  }
  if (broker === 'upstox') {
    const ids = data?.data?.gtt_order_ids || data?.gtt_order_ids;
    return (Array.isArray(ids) && ids.length ? ids.join(' | ') : data?.data?.gtt_order_id || data?.data?.order_id || data?.gtt_order_id || data?.order_id) || 'N/A';
  }
  return data.orderId || data.order_id || data.data?.orderId || 'N/A';
}

function extractPlacedOrderLogFields(broker, orderRes) {
  if (String(broker || '').toLowerCase() !== 'angelone') return {};
  const data = orderRes?.data || {};
  return {
    angelOneEntryOrderId: orderRes?.angelOneEntryOrderId || angelOneOrderId(data.entry) || angelOneOrderId(data) || '',
    angelOneSlRuleId: orderRes?.angelOneSlRuleId || angelOneRuleId(data.slGtt) || '',
    angelOneTargetOrderId: orderRes?.angelOneTargetOrderId || angelOneOrderId(data.target) || '',
  };
}

function scheduledOrderStatusText(broker, orderErr, orderRes) {
  if (orderErr) return orderErr;
  if (orderRes?.status && orderRes.status >= 400) return JSON.stringify(orderRes?.data || {});
  if (broker === 'zerodha') return 'ZERODHA ENTRY + GTT';
  if (broker === 'upstox') return 'UPSTOX COMING SOON';
  if (broker === 'angelone') return 'ANGEL ENTRY + SL GTT';
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
  if (!['dhan', 'zerodha', 'angelone'].includes(broker)) return false;
  if (!entry.emaTrailingEnabled) return false;
  if (String(entry.emaTrailingTrigger || 'afterTarget') !== 'afterTarget') return false;
  if (String(entry.action || 'BUY').toUpperCase() !== 'BUY') return false;
  if (entry.emaTrailingLastDate === dateKey) return false;
  if (!isOpenOrderLogEntry(entry)) return false;
  return !!String(entry.orderId || '').trim();
}

// The slowest (largest-period) EMA used in the entry criteria - the trend EMA we
// floor the trail against. e.g. entry "price within X% above EMA 200" -> ema200.
function entryEmaIndicatorFromFilters(entryFilters) {
  let best = '';
  let bestPeriod = -1;
  (Array.isArray(entryFilters) ? entryFilters : []).forEach(f => {
    if (f && f.type === 'score') return;
    const m = String(f?.indicator || '').toLowerCase().match(/^ema(\d+)$/);
    if (m && Number(m[1]) > bestPeriod) { bestPeriod = Number(m[1]); best = 'ema' + m[1]; }
  });
  return best;
}

function emaValueFromRow(indicator, tvRow) {
  const m = String(indicator || '').toLowerCase().match(/^ema(\d+)$/);
  if (!m) return NaN;
  return Number(tvRow?.ema?.[m[1]] ?? tvRow?.[String(indicator).toLowerCase()]);
}

function trailingEmaValue(entry, tvRow) {
  let val = emaValueFromRow(entry.emaTrailingIndicator || 'ema20', tvRow);
  // Floor against the entry EMA: while the trailing EMA is below the entry EMA,
  // trail the entry EMA instead, until the trailing EMA crosses back above it.
  const entryEma = emaValueFromRow(entry.entryEmaIndicator, tvRow);
  if (Number.isFinite(entryEma) && Number.isFinite(val) && entryEma > val) val = entryEma;
  return Number.isFinite(val) ? val : NaN;
}

function modifyBrokerTrailingStop(entry, nextSl, callback) {
  const broker = String(entry.broker || 'dhan').toLowerCase();
  if (broker === 'dhan') return modifyDhanSuperOrderStopLoss(entry, nextSl, callback);
  if (broker === 'zerodha') return modifyZerodhaGttStopLoss(entry, nextSl, callback);
  if (broker === 'angelone') return modifyAngelOneGttStopLoss(entry, nextSl, callback);
  callback('EMA trailing not implemented for ' + broker);
}

let emaTrailingTargetCheckInFlight = false;
let emaTrailingTargetLastCheckAt = 0;
function checkEmaTrailingTargetTriggers() {
  if (emaTrailingTargetCheckInFlight || Date.now() - emaTrailingTargetLastCheckAt < 60 * 1000) return;
  const rows = readOrderLog();
  const candidates = rows.filter(entry => {
    const broker = String(entry.broker || 'dhan').toLowerCase();
    return ['dhan', 'zerodha', 'angelone'].includes(broker) &&
      entry.emaTrailingEnabled &&
      String(entry.emaTrailingTrigger || 'afterTarget') === 'afterTarget' &&
      !entry.emaTrailingArmedAt &&
      Number(entry.targetPrice || 0) > 0 &&
      isOpenOrderLogEntry(entry);
  });
  if (!candidates.length) return;
  const symbols = [...new Set(candidates.map(entry => String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase()).filter(Boolean))];
  if (!symbols.length) return;
  emaTrailingTargetCheckInFlight = true;
  emaTrailingTargetLastCheckAt = Date.now();
  fetchTVDataCached(symbols, (err, tvData) => {
    emaTrailingTargetCheckInFlight = false;
    const checkedAt = new Date().toISOString();
    if (err) return;
    const tvBySymbol = {};
    (tvData || []).forEach(row => {
      const key = String(row.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
      if (key) tvBySymbol[key] = row;
    });
    let changed = false;
    const nextRows = readOrderLog().map(entry => {
      if (!candidates.some(candidate => candidate.id === entry.id)) return entry;
      const symbol = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
      const ltp = Number(tvBySymbol[symbol]?.ltp || 0);
      const target = Number(entry.targetPrice || 0);
      if (!(target > 0 && ltp >= target)) return entry;
      changed = true;
      // Safety: never arm EMA trailing on a position with no live broker stop
      // (e.g. the SL GTT was rejected). Flag it loudly for manual action so it
      // doesn't masquerade as "armed/trailed" while sitting naked.
      if (!entryHasBrokerStop(entry)) {
        return {
          ...entry,
          emaTrailingStatus: 'unprotected',
          lastTrailCheckAt: checkedAt,
          lastTrailError: 'No stop-loss on broker (SL order missing/rejected). Place an SL manually or exit; EMA trailing not armed.',
          status: ((entry.status || '').replace(/ \| TARGET ARMED EMA TRAIL/g, '') + ' | UNPROTECTED - NO SL ON BROKER').trim(),
        };
      }
      return {
        ...entry,
        emaTrailingArmedAt: checkedAt,
        emaTrailingStatus: 'target-armed',
        lastTrailCheckAt: checkedAt,
        lastTrailError: '',
        status: ((entry.status || '') + ' | TARGET ARMED EMA TRAIL').trim(),
      };
    });
    if (changed) writeOrderLog(nextRows);
  });
}

// ---- Auto-recover a missing broker stop-loss --------------------------------
// If a position's SL order never made it onto the broker (e.g. the GTT was
// rejected on a tick), the monitor re-places a fresh SL GTT so the position is
// not left naked. Bias is to place (a duplicate SL is harmless; a missing SL is
// not). Capped per position to avoid hammering the broker on a persistent error.
const SL_RESTORE_MAX_ATTEMPTS = 3;
// Auto-PLACEMENT of a replacement stop. Root cause of duplicate GTTs (reading
// the wrong field of the GTT list) is fixed, so this is ON by default; set
// STOCKKAR_SL_AUTORESTORE=0 to make the monitor flag-only (no placement).
const SL_AUTORESTORE_ENABLED = process.env.STOCKKAR_SL_AUTORESTORE !== '0';
// Per-symbol cooldown: once we re-place a stop for a symbol, do not place
// another for it within this window even if a list read is briefly stale.
const SL_RESTORE_COOLDOWN_MS = 5 * 60 * 1000;
const slRestoreRecent = new Map(); // symbol -> last placed ts

// Read-modify-write a single order-log row against the latest on-disk state, so
// a background pass never clobbers concurrent changes from other monitors.
function patchOrderLogEntry(id, patch) {
  const rows = readOrderLog();
  let found = false;
  const next = rows.map(r => (r.id === id ? (found = true, { ...r, ...patch }) : r));
  if (found) writeOrderLog(next);
  return found;
}

function restoreZerodhaStop(entry, callback) {
  const store = readBrokerTokenStore().brokers.zerodha;
  const apiKey = store?.clientId;
  const accessToken = store?.accessToken;
  if (!apiKey || !accessToken) return callback('No Zerodha token saved');
  const ids = parseZerodhaOrderIds(entry.orderId);
  const symbol = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const qty = Number(entry.qty || 0);
  const entryPrice = Number(entry.entryPrice || entry.price || 0);
  // Re-place at the HIGHEST stop reached so cancelling/restoring never drops a
  // trailed stop back down. For a long, the trailed SL sits above the original.
  const sl = Math.max(Number(entry.slPrice || 0), Number(entry.lastTrailSlPrice || 0), Number(entry.brokerSlPrice || 0));
  const target = Number(entry.targetPrice || 0);
  if (!symbol || !qty || !entryPrice || !sl) return callback('Missing Zerodha SL restore fields');
  const exchange = entry.exchange || 'NSE';
  const product = entry.segment === 'INTRADAY' ? 'MIS' : 'CNC';
  const emaMode = isPostTargetEmaTrailingOrder(entry);
  const orders = [{ exchange, tradingsymbol: symbol, transaction_type: 'SELL', quantity: qty, order_type: 'LIMIT', product, price: roundPrice(sl * 0.995) }];
  let triggers = [roundPrice(sl)];
  let type = 'single';
  if (!emaMode && target > 0) {
    type = 'two-leg';
    triggers = [roundPrice(sl), roundPrice(target)];
    orders.push({ exchange, tradingsymbol: symbol, transaction_type: 'SELL', quantity: qty, order_type: 'LIMIT', product, price: roundPrice(target) });
  }
  const gttForm = {
    type,
    condition: JSON.stringify({ exchange, tradingsymbol: symbol, trigger_values: triggers, last_price: roundPrice(entryPrice) }),
    orders: JSON.stringify(orders),
  };
  kitePost('/gtt/triggers', apiKey, accessToken, gttForm, (err, res) => {
    if (err) return callback(err);
    if (res.status >= 400) return callback('Zerodha SL re-place failed: ' + JSON.stringify(res.data));
    const gttId = res.data?.data?.trigger_id || res.data?.trigger_id || '';
    if (!gttId) return callback('Zerodha SL re-place returned no GTT id');
    const newOrderId = [ids.entryId && ('ENTRY:' + ids.entryId), 'GTT:' + gttId].filter(Boolean).join(' | ');
    callback(null, { orderId: newOrderId, brokerSlPrice: roundPrice(sl) });
  });
}

function restoreAngelStop(entry, callback) {
  const sStore = readBrokerTokenStore().brokers.angelone;
  const store = { clientId: sStore?.clientId, accountId: sStore?.accountId };
  const accessToken = sStore?.accessToken;
  if (!store.clientId || !store.accountId || !accessToken) return callback('No Angel One token saved');
  const symbol = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const qty = Number(entry.qty || 0);
  // Highest stop reached, so a restore never drops a trailed stop back down.
  const sl = Math.max(Number(entry.slPrice || 0), Number(entry.lastTrailSlPrice || 0), Number(entry.brokerSlPrice || 0));
  if (!symbol || !qty || !sl) return callback('Missing Angel One SL restore fields');
  resolveAngelOneInstrument(symbol, entry.exchange || 'NSE', (lookupErr, info) => {
    if (lookupErr) return callback(lookupErr);
    const productType = angelOneProductType(entry.segment);
    const slLimit = angelOneSlLimitPrice(sl, entry.dhanSlTriggerBufferPct || 0.5);
    createAngelOneGttRule(store, accessToken, {
      instrument: info.instrument, transactionType: 'SELL', triggerPrice: sl, price: slLimit, qty, productType, exchange: info.exchange,
    }, (slErr, slRes) => {
      if (slErr) return callback(slErr);
      const ruleId = angelOneRuleId(slRes.data);
      if (!ruleId) return callback('Angel One SL re-place returned no rule id');
      callback(null, { angelOneSlRuleId: ruleId, brokerSlPrice: roundPrice(sl) });
    });
  });
}

function restoreBrokerStop(entry, callback) {
  const broker = String(entry.broker || 'dhan').toLowerCase();
  if (broker === 'zerodha') return restoreZerodhaStop(entry, callback);
  if (broker === 'angelone') return restoreAngelStop(entry, callback);
  callback('Auto SL restore not supported for ' + broker);
}

let restoreStopsInFlight = false;
let restoreStopsLastAt = 0;
function checkAndRestoreBrokerStops() {
  if (restoreStopsInFlight || Date.now() - restoreStopsLastAt < 60 * 1000) return;
  const openRows = readOrderLog().filter(entry => {
    const broker = String(entry.broker || 'dhan').toLowerCase();
    return ['zerodha', 'angelone'].includes(broker) &&
      !entry.testMode && entry.source !== 'test' &&
      Number(entry.slPrice || 0) > 0 &&
      isOpenOrderLogEntry(entry) &&
      Number(entry.slRestoreAttempts || 0) < SL_RESTORE_MAX_ATTEMPTS;
  });
  if (!openRows.length) return;
  restoreStopsInFlight = true;
  restoreStopsLastAt = Date.now();

  const runRestores = (activeZerodhaSymbols) => {
    // Duplicate-proof rule for Zerodha: only ever place a GTT when we have the
    // LIVE GTT list (activeZerodhaSymbols != null) AND it shows no active GTT for
    // this symbol. Matching by symbol (not by a stored id that can be lost on a
    // concurrent order-log write) makes a second GTT impossible. If we could not
    // fetch the list, we skip Zerodha this cycle rather than risk a duplicate.
    const claimedThisRun = new Set();
    const onCooldown = (sym) => {
      const ts = slRestoreRecent.get(sym);
      return ts && (Date.now() - ts) < SL_RESTORE_COOLDOWN_MS;
    };
    const candidates = openRows.filter(entry => {
      const broker = String(entry.broker || 'dhan').toLowerCase();
      const sym = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
      if (onCooldown(sym) || claimedThisRun.has(sym)) return false; // cross-cycle + per-cycle dedup
      if (broker === 'zerodha') {
        if (!activeZerodhaSymbols) return false;
        if (activeZerodhaSymbols.has(sym)) return false;
        claimedThisRun.add(sym);
        return true;
      }
      if (!entryHasBrokerStop(entry)) { claimedThisRun.add(sym); return true; }
      return false;
    });
    if (!candidates.length) { restoreStopsInFlight = false; return; }
    let i = 0;
    const next = () => {
      if (i >= candidates.length) { restoreStopsInFlight = false; return; }
      const entry = candidates[i++];
      if (!SL_AUTORESTORE_ENABLED) {
        // Safety: do NOT place any order. Flag the position so the user acts.
        patchOrderLogEntry(entry.id, {
          lastTrailError: 'No active stop on broker. Auto-replace is OFF — place an SL manually in your broker.',
          ...(entry.emaTrailingEnabled ? { emaTrailingStatus: 'unprotected' } : {}),
          status: ((entry.status || '').replace(/ \| TARGET ARMED EMA TRAIL/g, '').replace(/ \| UNPROTECTED[^|]*/g, '').replace(/ \| EMA TRAIL SL [0-9.]+/g, '') + ' | UNPROTECTED - PLACE SL MANUALLY').trim(),
        });
        console.log('[SL RESTORE] ' + entry.symbol + ' naked, auto-replace disabled (flag only)');
        return next();
      }
      restoreBrokerStop(entry, (err, patch) => {
        const attempts = Number(entry.slRestoreAttempts || 0) + 1;
        if (err) {
          patchOrderLogEntry(entry.id, {
            slRestoreAttempts: attempts,
            lastTrailError: 'Auto SL restore failed: ' + err,
            ...(entry.emaTrailingEnabled ? { emaTrailingStatus: 'unprotected' } : {}),
            status: attempts >= SL_RESTORE_MAX_ATTEMPTS
              ? ((entry.status || '').replace(/ \| TARGET ARMED EMA TRAIL/g, '').replace(/ \| UNPROTECTED[^|]*/g, '').replace(/ \| EMA TRAIL SL [0-9.]+/g, '') + ' | UNPROTECTED - SL RESTORE FAILED, PLACE MANUALLY').trim()
              : entry.status,
          });
          console.log('[SL RESTORE] ' + entry.symbol + ' failed (attempt ' + attempts + '): ' + err);
        } else {
          patchOrderLogEntry(entry.id, {
            ...patch,
            slRestoreAttempts: attempts,
            slRestoredAt: new Date().toISOString(),
            lastTrailError: '',
            ...(entry.emaTrailingEnabled ? { emaTrailingStatus: entry.emaTrailingArmedAt ? 'trailed' : 'waiting-target' } : {}),
            status: ((entry.status || '').replace(/ \| UNPROTECTED[^|]*/g, '').trim() + ' | SL RESTORED @' + patch.brokerSlPrice).trim(),
          });
          slRestoreRecent.set(String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase(), Date.now());
          console.log('[SL RESTORE] ' + entry.symbol + ' re-placed SL @' + patch.brokerSlPrice);
        }
        next();
      });
    };
    next();
  };

  // For Zerodha, fetch the live GTT list once and collect the SYMBOLS that
  // already have an active/triggered GTT. Pass null on any fetch failure so we
  // skip Zerodha this cycle (never place blind -> never duplicate).
  const zStore = readBrokerTokenStore().brokers.zerodha;
  const hasZerodha = openRows.some(e => String(e.broker || '').toLowerCase() === 'zerodha');
  if (hasZerodha && zStore?.clientId && zStore?.accessToken) {
    kiteGet('/gtt/triggers', zStore.clientId, zStore.accessToken, (err, res) => {
      // Could not verify the live GTT list -> skip Zerodha this cycle (never
      // place blind). Note: kiteRows needs the API body (res.data), not res.
      if (err || !res || res.status >= 400) return runRestores(null);
      const rows = kiteRows(res.data);
      if (!rows.length && !Array.isArray(res.data?.data)) return runRestores(null); // unexpected shape -> skip
      const activeSymbols = new Set();
      rows.forEach(t => {
        const st = String(t.status || '').toLowerCase();
        if (st !== 'active' && st !== 'triggered') return;
        let cond = t.condition;
        if (typeof cond === 'string') { try { cond = JSON.parse(cond); } catch { cond = {}; } }
        const sym = String(cond?.tradingsymbol || cond?.tradingSymbol || '').replace(/\s/g, '').toUpperCase();
        if (sym) activeSymbols.add(sym);
      });
      runRestores(activeSymbols);
    });
  } else {
    runRestores(null);
  }
}

function placeAngelOneMarketExit(entry, reason, callback, exitQty) {
  const storeData = readBrokerTokenStore().brokers.angelone;
  const status = getBrokerTokenStatus('angelone');
  if (!storeData?.clientId || !storeData?.accountId || !storeData?.accessToken) return callback("No Angel One token generated. Open Settings and generate today's token.");
  if (status.status === 'expired') return callback("Angel One token expired. Generate today's token before software target exit.");
  const qty = Number(exitQty != null ? exitQty : entry.qty || 0);
  if (!qty) return callback('Missing Angel One exit quantity');
  const ids = parseAngelOneOrderIds(entry);
  const store = { clientId: storeData.clientId, accountId: storeData.accountId };
  resolveAngelOneInstrument(entry.symbol, entry.exchange || 'NSE', (lookupErr, info) => {
    if (lookupErr) return callback(lookupErr);
    const payload = {
      variety: 'NORMAL',
      tradingsymbol: info.instrument.tradingSymbol,
      symboltoken: info.instrument.token,
      transactiontype: 'SELL',
      exchange: info.exchange,
      ordertype: 'MARKET',
      producttype: angelOneProductType(entry.segment),
      duration: 'DAY',
      price: '0',
      squareoff: '0',
      stoploss: '0',
      quantity: String(qty),
    };
    angelRequest('POST', '/rest/secure/angelbroking/order/v1/placeOrder', store, storeData.accessToken, payload, (exitErr, exitRes) => {
      if (exitErr) return callback('Angel One target exit failed: ' + exitErr, exitRes);
      if (!exitRes || exitRes.status >= 400 || exitRes.data?.status === false) {
        return callback('Angel One target exit failed: ' + angelApiMessage(exitRes?.data, 'HTTP ' + exitRes?.status), exitRes);
      }
      cancelAngelOneGttRule(store, storeData.accessToken, ids.slRuleId, (cancelErr, cancelRes) => {
        callback(null, {
          status: exitRes.status,
          data: { exit: exitRes.data, cancelSlGtt: cancelRes?.data || cancelRes || null },
          request: { exit: payload, reason },
          angelOneTargetOrderId: angelOneOrderId(exitRes.data),
          cancelSlError: cancelErr || '',
        });
      });
    });
  });
}

let angelOneTargetCheckInFlight = false;
let angelOneTargetLastCheckAt = 0;
function checkAngelOneSoftwareTargets() {
  if (angelOneTargetCheckInFlight || Date.now() - angelOneTargetLastCheckAt < 60 * 1000) return;
  const rows = readOrderLog();
  const candidates = rows.filter(entry =>
    String(entry.broker || '').toLowerCase() === 'angelone' &&
    !entry.emaTrailingEnabled &&
    !hasMtmRules(entry) &&                  // MTM-managed orders are handled by checkMtmRules
    Number(entry.targetPrice || 0) > 0 &&
    !entry.targetExitOrderId &&
    !entry.angelOneTargetOrderId &&
    isOpenOrderLogEntry(entry)
  );
  if (!candidates.length) return;
  const symbols = [...new Set(candidates.map(entry => String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase()).filter(Boolean))];
  if (!symbols.length) return;
  angelOneTargetCheckInFlight = true;
  angelOneTargetLastCheckAt = Date.now();
  fetchTVDataCached(symbols, (err, tvData) => {
    const checkedAt = new Date().toISOString();
    if (err) {
      const failedIds = new Set(candidates.map(entry => entry.id));
      const nextRows = readOrderLog().map(entry => failedIds.has(entry.id)
        ? { ...entry, lastStatusCheckAt: checkedAt, rejectionReason: entry.rejectionReason || ('Weak signal: ' + err) }
        : entry);
      writeOrderLog(nextRows);
      angelOneTargetCheckInFlight = false;
      return;
    }
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
    const processNext = (i) => {
      if (i >= candidates.length) {
        angelOneTargetCheckInFlight = false;
        return;
      }
      const entry = candidates[i];
      const symbol = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
      const ltp = Number(tvBySymbol[symbol]?.ltp || 0);
      const target = Number(entry.targetPrice || 0);
      if (!(target > 0 && ltp >= target)) {
        updateEntry(entry.id, { lastStatusCheckAt: checkedAt });
        return processNext(i + 1);
      }
      placeAngelOneMarketExit(entry, 'software-target', (exitErr, exitRes) => {
        const exitPrice = roundPrice(ltp || target);
        const entryPrice = Number(entry.entryPrice || entry.price || 0);
        const qty = Number(entry.qty || 0);
        const realisedPnl = entryPrice && qty ? Number(((exitPrice - entryPrice) * qty).toFixed(2)) : '';
        if (exitErr) {
          updateEntry(entry.id, {
            status: 'ANGEL TARGET EXIT FAILED',
            rejectionReason: exitErr,
            lastStatusCheckAt: checkedAt,
          });
        } else {
          updateEntry(entry.id, {
            status: exitRes?.cancelSlError ? 'ANGEL TARGET EXIT SENT | SL GTT CANCEL WARNING' : 'ANGEL TARGET EXIT SENT',
            exitType: 'TARGET HIT',
            exitPrice,
            realisedPnl,
            targetExitOrderId: exitRes?.angelOneTargetOrderId || '',
            angelOneTargetOrderId: exitRes?.angelOneTargetOrderId || '',
            rejectionReason: exitRes?.cancelSlError || entry.rejectionReason || '',
            lastStatusCheckAt: checkedAt,
          });
        }
        processNext(i + 1);
      });
    };
    processNext(0);
  });
}

// ---- MTM rules engine (software-managed, broker-agnostic) -------------------
// Config fields to persist on each order so the monitor can manage it later.
function mtmConfigFields(cfg) {
  return {
    costPct: Number(cfg.costPct || 0) || 0,
    t1RR: Number(cfg.t1RR || 0) || 0,
    t1Qty: Number(cfg.t1Qty || 0) || 0,
    t2RR: Number(cfg.t2RR || 0) || 0,
    mtmCostDone: false,
    mtmT1Done: false,
    mtmT2Done: false,
    mtmRemainingQty: Number(cfg.qty || 0) || '',
  };
}

// Broker-agnostic SL modify (move-to-cost). Reuses the proven trailing-stop
// dispatch which already covers Dhan, Zerodha and Angel One.
function mtmModifyStopLoss(entry, newSl, callback) {
  return modifyBrokerTrailingStop(entry, newSl, callback);
}

// When live MTM exits are enabled for this broker, set the broker target leg to
// T2 so a gap straight to T2 (before T1) is handled broker-side. Otherwise keep
// the algo's own target (placement behaviour unchanged while exits are gated).
function mtmEntryTargetPrice(cfg, stock, broker) {
  const t2RR = Number(cfg.t2RR || 0);
  if (mtmLiveExitEnabled(broker) && t2RR > 0 && stock.entryPrice > stock.slPrice) {
    return roundPrice(stock.entryPrice + t2RR * (stock.entryPrice - stock.slPrice));
  }
  return stock.targetPrice;
}

// ---- Broker exit primitives used by the MTM executor -----------------------
function dhanCancelOrder(orderId, isSuper, callback) {
  const store = readDhanTokenStore();
  if (!store?.token) return callback('No Dhan token saved');
  const id = String(orderId || '').trim();
  if (!id) return callback('Missing Dhan order id to cancel');
  const path = (isSuper ? '/v2/super/orders/' : '/v2/orders/') + encodeURIComponent(id);
  const req = https.request({ hostname: 'api.dhan.co', port: 443, path, method: 'DELETE',
    headers: { 'access-token': store.token, 'Content-Type': 'application/json' } }, apiRes => {
    let data = ''; apiRes.on('data', c => data += c); apiRes.on('end', () => {
      let p; try { p = JSON.parse(data); } catch { p = data; }
      if (apiRes.statusCode >= 400) return callback(dhanApiMessage(p, 'Dhan cancel failed HTTP ' + apiRes.statusCode), { status: apiRes.statusCode, data: p });
      callback(null, { status: apiRes.statusCode, data: p });
    });
  });
  req.on('error', e => callback('Dhan cancel failed: ' + e.message));
  req.end();
}

function dhanPlaceSell(entry, qty, opts, callback) {
  opts = opts || {};
  const store = readDhanTokenStore();
  if (!store?.clientId || !store?.token) return callback('Dhan credentials missing');
  const symbol = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const q = Math.floor(Number(qty || 0));
  if (!symbol || q <= 0) return callback('Invalid Dhan sell qty');
  loadDhanSecurityMap((lookupErr, securityMap) => {
    if (lookupErr) return callback('Security lookup failed: ' + lookupErr);
    const exchange = entry.exchange === 'BSE' ? 'BSE' : 'NSE';
    const securityId = entry.securityId || (securityMap && (securityMap[exchange + ':' + symbol] || securityMap[symbol]));
    if (!securityId) return callback('Security ID not found for ' + symbol);
    const payload = {
      dhanClientId: store.clientId,
      transactionType: 'SELL',
      exchangeSegment: entry.exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ',
      productType: entry.segment || 'CNC',
      orderType: opts.slm ? 'STOP_LOSS_MARKET' : 'MARKET',
      securityId: String(securityId),
      quantity: q,
      price: '',
    };
    if (opts.slm) payload.triggerPrice = roundPrice(opts.trigger);
    const body = JSON.stringify(payload);
    const req = https.request({ hostname: 'api.dhan.co', port: 443, path: '/v2/orders', method: 'POST',
      headers: { 'access-token': store.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, apiRes => {
      let data = ''; apiRes.on('data', c => data += c); apiRes.on('end', () => {
        let p; try { p = JSON.parse(data); } catch { p = data; }
        if (apiRes.statusCode >= 400) return callback(dhanApiMessage(p, 'Dhan sell failed HTTP ' + apiRes.statusCode), { status: apiRes.statusCode, data: p });
        callback(null, { status: apiRes.statusCode, data: p, orderId: p?.orderId || p?.data?.orderId || '' });
      });
    });
    req.on('error', e => callback('Dhan sell failed: ' + e.message));
    req.write(body); req.end();
  });
}

// Dhan Forever Order (GTT) protective stop - persists across trading days, so
// it protects swing/positional CNC holds overnight (unlike a DAY SL-M).
function dhanPlaceForeverSl(entry, qty, trigger, callback) {
  const store = readDhanTokenStore();
  if (!store?.clientId || !store?.token) return callback('Dhan credentials missing');
  const symbol = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const q = Math.floor(Number(qty || 0));
  if (!symbol || q <= 0) return callback('Invalid Dhan forever-SL qty');
  loadDhanSecurityMap((lookupErr, securityMap) => {
    if (lookupErr) return callback('Security lookup failed: ' + lookupErr);
    const exchange = entry.exchange === 'BSE' ? 'BSE' : 'NSE';
    const securityId = entry.securityId || (securityMap && (securityMap[exchange + ':' + symbol] || securityMap[symbol]));
    if (!securityId) return callback('Security ID not found for ' + symbol);
    const payload = {
      dhanClientId: store.clientId,
      orderFlag: 'SINGLE',
      transactionType: 'SELL',
      exchangeSegment: entry.exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ',
      productType: entry.segment || 'CNC',
      orderType: 'STOP_LOSS_MARKET',
      securityId: String(securityId),
      quantity: q,
      price: 0,
      triggerPrice: roundPrice(trigger),
    };
    const body = JSON.stringify(payload);
    const req = https.request({ hostname: 'api.dhan.co', port: 443, path: '/v2/forever/orders', method: 'POST',
      headers: { 'access-token': store.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, apiRes => {
      let data = ''; apiRes.on('data', c => data += c); apiRes.on('end', () => {
        let p; try { p = JSON.parse(data); } catch { p = data; }
        if (apiRes.statusCode >= 400) return callback(dhanApiMessage(p, 'Dhan forever-SL failed HTTP ' + apiRes.statusCode), { status: apiRes.statusCode, data: p });
        callback(null, { status: apiRes.statusCode, data: p, orderId: p?.orderId || p?.data?.orderId || '' });
      });
    });
    req.on('error', e => callback('Dhan forever-SL failed: ' + e.message));
    req.write(body); req.end();
  });
}

function dhanCancelForever(orderId, callback) {
  const store = readDhanTokenStore();
  if (!store?.token) return callback('No Dhan token saved');
  const id = String(orderId || '').trim();
  if (!id) return callback('Missing Dhan forever order id to cancel');
  const req = https.request({ hostname: 'api.dhan.co', port: 443, path: '/v2/forever/orders/' + encodeURIComponent(id), method: 'DELETE',
    headers: { 'access-token': store.token, 'Content-Type': 'application/json' } }, apiRes => {
    let data = ''; apiRes.on('data', c => data += c); apiRes.on('end', () => {
      let p; try { p = JSON.parse(data); } catch { p = data; }
      if (apiRes.statusCode >= 400) return callback(dhanApiMessage(p, 'Dhan forever cancel failed HTTP ' + apiRes.statusCode), { status: apiRes.statusCode, data: p });
      callback(null, { status: apiRes.statusCode, data: p });
    });
  });
  req.on('error', e => callback('Dhan forever cancel failed: ' + e.message));
  req.end();
}

function zerodhaPlaceSell(entry, qty, callback) {
  const store = readBrokerTokenStore().brokers.zerodha;
  const apiKey = store?.clientId, accessToken = store?.accessToken;
  if (!apiKey || !accessToken) return callback('No Zerodha token saved');
  const symbol = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const q = Math.floor(Number(qty || 0));
  if (!symbol || q <= 0) return callback('Invalid Zerodha sell qty');
  const form = {
    exchange: entry.exchange || 'NSE',
    tradingsymbol: symbol,
    transaction_type: 'SELL',
    quantity: String(q),
    product: entry.segment === 'INTRADAY' ? 'MIS' : 'CNC',
    order_type: 'MARKET',
    validity: 'DAY',
  };
  kitePost('/orders/regular', apiKey, accessToken, form, (err, res) => {
    if (err) return callback(err);
    if (res.status >= 400) return callback('Zerodha sell failed: ' + JSON.stringify(res.data), res);
    callback(null, { status: res.status, data: res.data, orderId: res.data?.data?.order_id || '' });
  });
}

function zerodhaModifyGttRemainder(entry, qty, sl, target, callback) {
  const store = readBrokerTokenStore().brokers.zerodha;
  const ids = parseZerodhaOrderIds(entry.orderId);
  const apiKey = store?.clientId, accessToken = store?.accessToken;
  if (!apiKey || !accessToken) return callback('No Zerodha token saved');
  if (!ids.gttId) return callback('No Zerodha GTT id');
  const symbol = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const exchange = entry.exchange || 'NSE';
  const product = entry.segment === 'INTRADAY' ? 'MIS' : 'CNC';
  const q = Math.floor(Number(qty || 0));
  const form = {
    type: 'two-leg',
    condition: JSON.stringify({ exchange, tradingsymbol: symbol, trigger_values: [roundPrice(sl), roundPrice(target)], last_price: roundPrice(entry.entryPrice || entry.price || sl) }),
    orders: JSON.stringify([
      { exchange, tradingsymbol: symbol, transaction_type: 'SELL', quantity: q, order_type: 'LIMIT', product, price: roundPrice(sl * 0.995) },
      { exchange, tradingsymbol: symbol, transaction_type: 'SELL', quantity: q, order_type: 'LIMIT', product, price: roundPrice(target) },
    ]),
  };
  kitePut('/gtt/triggers/' + encodeURIComponent(ids.gttId), apiKey, accessToken, form, (err, res) => {
    if (err) return callback(err);
    if (res.status >= 400) return callback('Zerodha GTT remainder modify failed: ' + JSON.stringify(res.data), res);
    callback(null, { status: res.status, data: res.data });
  });
}

// Angel One: partial market SELL that leaves the SL GTT in place (T1 booking).
function angelPlaceSell(entry, qty, callback) {
  const storeData = readBrokerTokenStore().brokers.angelone;
  if (!storeData?.clientId || !storeData?.accountId || !storeData?.accessToken) return callback("No Angel One token generated.");
  const q = Math.floor(Number(qty || 0));
  if (!q) return callback('Invalid Angel One sell qty');
  const store = { clientId: storeData.clientId, accountId: storeData.accountId };
  resolveAngelOneInstrument(entry.symbol, entry.exchange || 'NSE', (lookupErr, info) => {
    if (lookupErr) return callback(lookupErr);
    const payload = {
      variety: 'NORMAL', tradingsymbol: info.instrument.tradingSymbol, symboltoken: info.instrument.token,
      transactiontype: 'SELL', exchange: info.exchange, ordertype: 'MARKET',
      producttype: angelOneProductType(entry.segment), duration: 'DAY',
      price: '0', squareoff: '0', stoploss: '0', quantity: String(q),
    };
    angelRequest('POST', '/rest/secure/angelbroking/order/v1/placeOrder', store, storeData.accessToken, payload, (err, res) => {
      if (err) return callback('Angel One sell failed: ' + err, res);
      if (!res || res.status >= 400 || res.data?.status === false) return callback('Angel One sell failed: ' + angelApiMessage(res?.data, 'HTTP ' + res?.status), res);
      callback(null, { status: res.status, data: res.data, orderId: angelOneOrderId(res.data) });
    });
  });
}

// Angel One: shrink the SL GTT rule to the remainder qty at cost (after T1).
function angelModifyGttRemainder(entry, qty, sl, callback) {
  const storeData = readBrokerTokenStore().brokers.angelone;
  const ids = parseAngelOneOrderIds(entry);
  if (!storeData?.clientId || !storeData?.accountId || !storeData?.accessToken) return callback("No Angel One token generated.");
  if (!ids.slRuleId) return callback('No Angel One SL GTT rule ID');
  const q = Math.floor(Number(qty || 0));
  if (!q) return callback('Invalid Angel One remainder qty');
  const store = { clientId: storeData.clientId, accountId: storeData.accountId };
  resolveAngelOneInstrument(entry.symbol, entry.exchange || 'NSE', (lookupErr, info) => {
    if (lookupErr) return callback(lookupErr);
    modifyAngelOneGttRule(store, storeData.accessToken, ids.slRuleId, {
      instrument: info.instrument, transactionType: 'SELL', triggerPrice: sl,
      price: angelOneSlLimitPrice(sl), qty: q,
      productType: angelOneProductType(entry.segment), exchange: info.exchange,
    }, callback);
  });
}

// Execute a BOOK_T1/BOOK_T2 action as an ordered sequence of broker calls
// (see planExitOps). Stops on the first failure and reports it; the monitor
// then leaves the rule "not done" so it retries / stays visible.
function executeMtmExit(entry, act, plan, callback) {
  const ops = planExitOps(entry.broker, act, entry, plan);
  if (!ops.length) return callback('No exit sequence for broker ' + (entry.broker || ''));
  const acc = { delegated: false, slOrderId: '', exitOrderIds: [] };
  const runOp = (i) => {
    if (i >= ops.length) return callback(null, acc);
    const op = ops[i];
    const next = (err, res) => {
      if (err) return callback(err, acc);
      if (op.op === 'dhanSlm' || op.op === 'dhanForeverSl') acc.slOrderId = res?.orderId || acc.slOrderId;
      if (['dhanSell', 'zerodhaSell', 'angelSell', 'angelExit'].includes(op.op)) acc.exitOrderIds.push(res?.orderId || '');
      if (op.op === 'delegateBrokerTarget') acc.delegated = true;
      runOp(i + 1);
    };
    switch (op.op) {
      case 'cancelDhanSuper': return dhanCancelOrder(op.orderId, true, next);
      case 'cancelDhanOrder': return dhanCancelOrder(op.orderId, false, next);
      case 'dhanSell': return dhanPlaceSell(entry, op.qty, {}, next);
      case 'dhanSlm': return dhanPlaceSell(entry, op.qty, { slm: true, trigger: op.trigger }, next);
      case 'dhanForeverSl': return dhanPlaceForeverSl(entry, op.qty, op.trigger, next);
      case 'cancelDhanForever': return dhanCancelForever(op.orderId, next);
      case 'zerodhaSell': return zerodhaPlaceSell(entry, op.qty, next);
      case 'zerodhaGttRemainder': return zerodhaModifyGttRemainder(entry, op.qty, op.sl, op.target, next);
      case 'angelSell': return angelPlaceSell(entry, op.qty, next);
      case 'angelGttRemainder': return angelModifyGttRemainder(entry, op.qty, op.sl, next);
      case 'angelExit': return placeAngelOneMarketExit(entry, 'mtm-t2', (e, r) => next(e, { orderId: r?.angelOneTargetOrderId }), op.qty);
      case 'delegateBrokerTarget': return next(null, {});
      default: return next('Unknown MTM op: ' + op.op);
    }
  };
  runOp(0);
}

// Live MTM exits (T1/T2 auto-booking, EMA-trail breach exit) are on by default
// for the supported brokers - they only ever fire when the user has actually
// configured T1/T2, so no separate toggle is needed. Set
// STOCKKAR_MTM_LIVE_EXIT_DISABLE=1 to force-disable (e.g. for a dry run).
const MTM_EXIT_ALLOWED_BROKERS = ['dhan', 'zerodha', 'angelone'];
function mtmLiveExitEnabled(broker) {
  if (process.env.STOCKKAR_MTM_LIVE_EXIT_DISABLE === '1') return false;
  return MTM_EXIT_ALLOWED_BROKERS.includes(String(broker || 'dhan').toLowerCase());
}

let mtmCheckInFlight = false;
let mtmLastCheckAt = 0;

// Run one MTM pass over a given order store. `forceSimulate` makes every action
// a dry-run (used for the Test-Mode store so the full cost/T1/T2 lifecycle is
// visible on real prices with zero broker calls). Calls done() when finished.
function runMtmPass(readFn, writeFn, forceSimulate, done) {
  const rows = readFn();
  const candidates = rows.filter(entry =>
    hasMtmRules(entry) &&
    !entry.emaTrailingEnabled &&            // EMA trailing is a separate exit mode
    !entry.mtmT2Done &&
    Number(entry.entryPrice || entry.price || 0) > 0 &&
    isOpenOrderLogEntry(entry)
  );
  if (!candidates.length) return done();
  const symbols = [...new Set(candidates
    .map(entry => String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase())
    .filter(Boolean))];
  if (!symbols.length) return done();

  fetchTVDataCached(symbols, (err, tvData) => {
    const checkedAt = new Date().toISOString();
    if (err) return done();
    const tvBySymbol = {};
    (tvData || []).forEach(row => {
      const key = String(row.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
      if (key) tvBySymbol[key] = row;
    });

    let nextRows = readFn();
    const updateEntry = (id, patch) => {
      nextRows = nextRows.map(row => row.id === id ? { ...row, ...patch } : row);
      writeFn(nextRows);
    };

    const processNext = (i) => {
      if (i >= candidates.length) return done();
      const entry = candidates[i];
      const symbol = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
      const ltp = Number(tvBySymbol[symbol]?.ltp || 0);
      if (!ltp) { updateEntry(entry.id, { lastMtmCheckAt: checkedAt }); return processNext(i + 1); }

      const { actions, patch, plan } = computeMtmActions(entry, ltp);
      if (!actions.length) {
        updateEntry(entry.id, { lastMtmCheckAt: checkedAt, ...patch });
        return processNext(i + 1);
      }

      const isTest = forceSimulate || !!entry.testMode || entry.source === 'test';
      const notes = [];
      // When a live T1 booking runs this tick, its exit sequence already sets the
      // remainder SL to cost. A separate MOVE_SL_TO_COST would then hit a
      // cancelled (Dhan) or reshaped (Zerodha/Angel) order, so skip it.
      const liveBookT1 = !isTest && mtmLiveExitEnabled(entry.broker) && actions.some(a => a.type === 'BOOK_T1');

      // Execute the ordered actions. SL-to-cost runs live (safe, proven);
      // partial/full exits run live only for brokers with a validated path,
      // and are always simulated in Test Mode.
      const runAction = (k, afterAll) => {
        if (k >= actions.length) return afterAll();
        const act = actions[k];

        if (act.type === 'MOVE_SL_TO_COST') {
          if (isTest) { notes.push('MTM(TEST): SL->cost ' + act.newSl); return runAction(k + 1, afterAll); }
          if (liveBookT1) { notes.push('MTM SL->cost via T1 exit'); return runAction(k + 1, afterAll); }
          return mtmModifyStopLoss(entry, act.newSl, (mErr) => {
            notes.push(mErr ? ('MTM SL->cost FAILED: ' + mErr) : ('MTM SL->cost ' + act.newSl));
            if (!mErr) { patch.brokerSlPrice = act.newSl; patch.lastTrailSlPrice = act.newSl; }
            else { delete patch.mtmCostDone; }   // retry next tick
            runAction(k + 1, afterAll);
          });
        }

        if (act.type === 'BOOK_T1' || act.type === 'BOOK_T2') {
          const label = act.type === 'BOOK_T1' ? 'T1 book ' + act.qty : 'T2 exit ' + act.qty;
          if (isTest) { notes.push('MTM(TEST): ' + label + ' @' + act.price); return runAction(k + 1, afterAll); }

          // Live exits are gated per broker until validated with a small live
          // trade (partial exits must keep the remainder's SL consistent, which
          // is broker-specific). Until enabled: alert once, do NOT mark booked.
          if (mtmLiveExitEnabled(entry.broker)) {
            return executeMtmExit(entry, act, plan, (xErr, info) => {
              if (xErr) {
                if (act.type === 'BOOK_T1') { delete patch.mtmT1Done; delete patch.mtmRemainingQty; }
                if (act.type === 'BOOK_T2') { delete patch.mtmT2Done; patch.mtmRemainingQty = act.qty; }
                notes.push('MTM ' + label + ' FAILED: ' + xErr);
              } else {
                if (act.type === 'BOOK_T1' && info.slOrderId) patch.mtmRemainderSlOrderId = info.slOrderId;
                if (act.type === 'BOOK_T2') { patch.exitType = 'TARGET HIT'; patch.exitPrice = act.price; }
                notes.push('MTM ' + label + (info.delegated ? ' (broker target owns exit)' : ' SENT'));
              }
              runAction(k + 1, afterAll);
            });
          }

          // Not yet live-enabled: don't mark booked; alert once to avoid spam.
          const alertKey = act.type === 'BOOK_T1' ? 'mtmT1Alerted' : 'mtmT2Alerted';
          if (act.type === 'BOOK_T1') { delete patch.mtmT1Done; delete patch.mtmRemainingQty; }
          if (act.type === 'BOOK_T2') { delete patch.mtmT2Done; delete patch.mtmRemainingQty; }
          if (!entry[alertKey]) {
            patch[alertKey] = true;
            notes.push('MTM ' + (act.type === 'BOOK_T1' ? 'T1' : 'T2') + ' @' + act.price + ' reached (' + act.qty + ') - auto-exit pending broker validation; act manually');
          }
          return runAction(k + 1, afterAll);
        }

        runAction(k + 1, afterAll);
      };

      runAction(0, () => {
        updateEntry(entry.id, {
          ...patch,
          lastMtmCheckAt: checkedAt,
          mtmStatus: notes.join(' | '),
          status: ((entry.status || '') + ' | ' + notes.join(' | ')).trim(),
        });
        processNext(i + 1);
      });
    };
    processNext(0);
  });
}

// NSE cash session in IST, Mon-Fri 09:15-15:30. Keeps the free server idle
// outside trading hours (no TradingView calls, no file reads).
function withinMarketHours(now = getIstNow()) {
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= (9 * 60 + 15) && mins <= (15 * 60 + 30);
}

// Reconciliation: periodically sync the order log with broker truth (orders,
// positions, GTTs) so the app's view can't silently drift. This also protects
// the MTM monitor - once a broker reports an order rejected/cancelled/exited,
// isOpenOrderLogEntry excludes it, so the monitor stops acting on dead state.
// Entries that flip from open -> closed are stamped for visibility/alerting.
let reconcileInFlight = false;
let reconcileLastAt = 0;
function reconcileBrokerOrders() {
  if (reconcileInFlight || Date.now() - reconcileLastAt < 60 * 1000) return;
  if (!withinMarketHours()) return;
  const openBefore = new Map(
    readOrderLog().filter(isOpenOrderLogEntry).map(e => [e.id, String(e.status || '')])
  );
  if (!openBefore.size) return;          // nothing to reconcile -> no broker calls
  reconcileInFlight = true;
  reconcileLastAt = Date.now();
  refreshBrokerOrderLogStatuses((err, result) => {
    reconcileInFlight = false;
    if (err && !result?.changed) {
      console.log('[RECONCILE] skipped:', err);
      return;
    }
    const at = new Date().toISOString();
    let flagged = 0;
    const next = readOrderLog().map(e => {
      if (!openBefore.has(e.id)) return e;
      const stamped = { ...e, reconciledAt: at };
      // Was open last we knew, broker now reports it closed/rejected/cancelled.
      if (!isOpenOrderLogEntry(e) && openBefore.get(e.id) !== String(e.status || '')) {
        flagged++;
        stamped.reconcileNote = 'Broker closed this position: ' + (e.exitType || e.status || 'closed');
      }
      return stamped;
    });
    writeOrderLog(next);
    if (flagged) console.log('[RECONCILE] drift flagged on', flagged, 'order(s) at', at);
  });
}

function checkMtmRules() {
  if (mtmCheckInFlight || Date.now() - mtmLastCheckAt < 50 * 1000) return;
  if (!withinMarketHours()) return;
  mtmCheckInFlight = true;
  mtmLastCheckAt = Date.now();
  // Live store: execute (move-to-cost live; exits live only for validated brokers).
  runMtmPass(readOrderLog, writeOrderLog, false, () => {
    // Test store: always simulate so the full lifecycle is visible risk-free.
    runMtmPass(readTestOrderLog, writeTestOrderLog, true, () => {
      mtmCheckInFlight = false;
    });
  });
}

function zerodhaCancelGtt(gttId, callback) {
  const store = readBrokerTokenStore().brokers.zerodha;
  const apiKey = store?.clientId, accessToken = store?.accessToken;
  if (!apiKey || !accessToken) return callback('No Zerodha token saved');
  if (!gttId) return callback(null, { skipped: true });
  kiteRequest('DELETE', '/gtt/triggers/' + encodeURIComponent(gttId), apiKey, accessToken, null, (err, res) => {
    if (err) return callback(err);
    if (res.status >= 400) return callback('Zerodha GTT cancel failed: ' + JSON.stringify(res.data), res);
    callback(null, res);
  });
}

// Exit the full remaining position at market, cancelling the protective SL
// first so the broker can't double-sell. Used when an armed EMA trail is
// already breached (computed stop at/above price). Behind the live-exit gate.
function emaTrailingExitAtMarket(entry, callback) {
  const broker = String(entry.broker || 'dhan').toLowerCase();
  const qty = Number(entry.qty || 0);
  if (!qty) return callback('Missing exit quantity');
  if (broker === 'angelone') return placeAngelOneMarketExit(entry, 'ema-trail-breach', callback);
  if (broker === 'dhan') {
    return dhanCancelOrder(entry.orderId, true, (cErr) => {
      if (cErr) return callback('Could not cancel Dhan super order before exit: ' + cErr);
      dhanPlaceSell(entry, qty, {}, callback);
    });
  }
  if (broker === 'zerodha') {
    const ids = parseZerodhaOrderIds(entry.orderId);
    return zerodhaCancelGtt(ids.gttId, (cErr) => {
      if (cErr) return callback('Could not cancel Zerodha GTT before exit: ' + cErr);
      zerodhaPlaceSell(entry, qty, callback);
    });
  }
  return callback('EMA trail market-exit not implemented for ' + broker);
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

  fetchTVDataCached(symbols, (tvErr, tvData) => {
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
        lastTrailError: 'Weak signal: ' + tvErr,
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
      // Trail already breached: the computed stop is at/above current price
      // (e.g. target hit but price already below the trailing EMA). Setting an
      // SL above market is invalid/instant-fill, so book the position at market.
      if (ltp > 0 && nextSl >= ltp) {
        const armStamp = {
          emaTrailingArmedAt: entry.emaTrailingArmedAt || checkedAt,
          emaTrailingLastDate: dateKey,
          lastTrailCheckAt: checkedAt,
        };
        if (!mtmLiveExitEnabled(entry.broker)) {
          updateEntry(entry.id, {
            ...armStamp,
            emaTrailingStatus: 'breach-pending',
            lastTrailError: 'Trail below price (' + nextSl + ' >= LTP ' + ltp + '); market exit pending - enable live exits for ' + entry.broker + ' or exit manually.',
          });
          return processNext(i + 1);
        }
        return emaTrailingExitAtMarket(entry, (xErr) => {
          const entryPrice = Number(entry.entryPrice || entry.price || 0);
          const qty = Number(entry.qty || 0);
          updateEntry(entry.id, {
            ...armStamp,
            emaTrailingStatus: xErr ? 'failed' : 'trail-exit',
            exitType: xErr ? entry.exitType : 'TARGET HIT',
            exitPrice: xErr ? entry.exitPrice : ltp,
            realisedPnl: xErr ? entry.realisedPnl : (entryPrice && qty ? Number(((ltp - entryPrice) * qty).toFixed(2)) : ''),
            lastTrailError: xErr || '',
            status: xErr ? entry.status : ((entry.status || '') + ' | EMA TRAIL BREACH EXIT @' + ltp).trim(),
          });
          processNext(i + 1);
        });
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
        // A "no GTT/order id" error means the protective stop never existed on
        // the broker (e.g. SL GTT was rejected). Surface that as UNPROTECTED so
        // it can't keep looking like a healthy "trailed" position.
        const noStop = err && /no .*(gtt|order) id/i.test(String(err));
        updateEntry(entry.id, {
          emaTrailingArmedAt: entry.emaTrailingArmedAt || checkedAt,
          emaTrailingLastDate: dateKey,
          lastTrailCheckAt: checkedAt,
          emaTrailingStatus: err ? (noStop ? 'unprotected' : 'failed') : 'trailed',
          lastTrailSlPrice: err ? (entry.lastTrailSlPrice || '') : nextSl,
          brokerSlPrice: err ? entry.brokerSlPrice : nextSl,
          status: err
            ? (noStop ? ((entry.status || '').replace(/ \| TARGET ARMED EMA TRAIL/g, '') + ' | UNPROTECTED - NO SL ON BROKER').trim() : entry.status)
            : ((entry.status || '') + ' | EMA TRAIL SL ' + nextSl).trim(),
          lastTrailError: err ? (noStop ? 'No stop-loss on broker (SL order missing/rejected). Place an SL manually or exit.' : err) : '',
          trailingModifyResponse: err ? entry.trailingModifyResponse : res?.data || '',
        });
        processNext(i + 1);
      });
    };
    processNext(0);
  });
}

// Symbols this broker already holds an OPEN position in (any date). For
// positional/swing the algo must not re-buy a stock it still holds even if the
// screener keeps showing it; it becomes eligible again only once the position
// closes (exit detected via order-status refresh / reconciliation).
function openHeldSymbols(broker, useTestLog) {
  const b = String(broker || '').toLowerCase();
  const rows = useTestLog ? readTestOrderLog() : readOrderLog();
  const set = new Set();
  rows.forEach(entry => {
    if (b && String(entry.broker || 'dhan').toLowerCase() !== b) return;
    if (!isOpenOrderLogEntry(entry)) return;
    const sym = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
    if (sym) set.add(sym);
  });
  return set;
}

// How many positions this algo currently has open (across all dates). Used to
// cap concurrent open positions: the algo stops adding once the cap is hit and
// auto-resumes as positions close (exit detected via status refresh/reconcile).
function openPositionsForJob(jobId, useTestLog) {
  if (!jobId) return 0;
  const rows = useTestLog ? readTestOrderLog() : readOrderLog();
  return rows.filter(e => e.jobId === jobId && isOpenOrderLogEntry(e)).length;
}

function runScheduledAlgo(job, callback) {
  const cfg = job.config || {};
  const tradedToday = new Set(Array.isArray(job.tradedSymbols) ? job.tradedSymbols.map(s => String(s).toUpperCase()) : []);
  const heldOpen = openHeldSymbols(cfg.broker, !!cfg.testMode);
  const skipHeld = sym => tradedToday.has(sym) || heldOpen.has(sym);
  const maxTrades = Number(cfg.maxTrades || 0);
  const remainingTrades = maxTrades > 0 ? Math.max(0, maxTrades - tradedToday.size) : Infinity;
  // Concurrent open-position cap (auto-throttles new entries until some close).
  const maxOpenPositions = Number(cfg.maxOpenPositions || 0);
  const openNow = maxOpenPositions > 0 ? openPositionsForJob(job.id, !!cfg.testMode) : 0;
  const remainingOpenSlots = maxOpenPositions > 0 ? Math.max(0, maxOpenPositions - openNow) : Infinity;
  const entryLimit = Math.min(remainingTrades, remainingOpenSlots);
  const token = cfg.stockkarToken || cfg.skToken;
  if (!token) return callback('No Stockkar token saved in schedule');
  const testMode = !!cfg.testMode;
  const brokerContext = testMode ? { broker: cfg.broker || 'dhan', credentials: {} } : resolveScheduledBrokerCredentials(cfg);
  if (brokerContext.error) return callback(brokerContext.error);
  const broker = brokerContext.broker;
  const credentials = brokerContext.credentials;
  const logScreenerName = cfg.screenerSourceName || cfg.screenerName || cfg.screenerSlug || '';
  const priceRangeText = (Number(cfg.priceMin) || Number(cfg.priceMax))
    ? ' + Price ' + (Number(cfg.priceMin) || 0) + '-' + (Number(cfg.priceMax) || '∞')
    : '';
  const logEntryCriteria = (cfg.entryCriteria || describeEntryCriteria(cfg.entryFilters)) + priceRangeText;
  const logExitCriteria = cfg.exitCriteria || describeExitCriteria(cfg);

  const useStocks = (stocks) => {
    const filtered = filterStocksBySectorIndustry(stocks, cfg.sectorFilters, cfg.industryFilters);
    const symbols = extractSymbolsFromStocks(filtered);
    if (!symbols.length) return callback('No stocks from configured basket after sector/industry filters');
    fetchTVData(symbols, (tvErr, tvData) => {
      if (tvErr) return callback(tvErr);
      let qualified = buildAlgoCandidates(tvData, { ...cfg, screenerStocks: filtered }).filter(r => r.withinEMA);
      const freshQualified = qualified.filter(r => !skipHeld(String(r.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase()));
      const toTrade = Number.isFinite(entryLimit) ? freshQualified.slice(0, entryLimit) : freshQualified;
      const results = [];

      const placeNext = (i) => {
        if (i >= toTrade.length) {
          return callback(null, { scanned: symbols.length, qualified: qualified.length, freshQualified: freshQualified.length, selected: toTrade.length, alreadyTraded: tradedToday.size, alreadyHeld: heldOpen.size, openPositions: openNow, maxOpenPositions, orders: results });
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
            targetPrice: mtmEntryTargetPrice(cfg, stock, broker),
            rr: stock.rr,
            screenerName: logScreenerName,
            entryCriteria: logEntryCriteria,
            exitCriteria: logExitCriteria,
            emaTrailingEnabled: !!cfg.emaTrailingEnabled,
            emaTrailingIndicator: cfg.emaTrailingIndicator || '',
            entryEmaIndicator: entryEmaIndicatorFromFilters(cfg.entryFilters),
            jobId: job.id,
            emaTrailingPct: cfg.emaTrailingPct ?? '',
            emaTrailingTimeframe: cfg.emaTrailingTimeframe || '',
            emaTrailingTrigger: cfg.emaTrailingTrigger || '',
            emaTrailingStatus: cfg.emaTrailingEnabled ? 'waiting-target' : '',
            ...mtmConfigFields({ ...cfg, qty: stock.qty }),
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
          targetPrice: mtmEntryTargetPrice(cfg, stock, broker),
          trailSL: cfg.trailSL || 0,
          dhanSlTriggerBufferPct: cfg.dhanSlTriggerBufferPct || 0,
          emaTrailingEnabled: !!cfg.emaTrailingEnabled,
          emaTrailingTrigger: cfg.emaTrailingTrigger || 'afterTarget',
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
          const orderFields = extractPlacedOrderLogFields(broker, orderRes);
          const brokerSlPrice = broker === 'dhan'
            ? orderRes?.request?.stopLossPrice
            : broker === 'angelone'
              ? orderRes?.request?.stopLossPrice
              : '';
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
            targetPrice: mtmEntryTargetPrice(cfg, stock, broker),
            rr: stock.rr,
            screenerName: logScreenerName,
            entryCriteria: logEntryCriteria,
            exitCriteria: logExitCriteria,
            emaTrailingEnabled: !!cfg.emaTrailingEnabled,
            emaTrailingIndicator: cfg.emaTrailingIndicator || '',
            entryEmaIndicator: entryEmaIndicatorFromFilters(cfg.entryFilters),
            jobId: job.id,
            emaTrailingPct: cfg.emaTrailingPct ?? '',
            emaTrailingTimeframe: cfg.emaTrailingTimeframe || '',
            emaTrailingTrigger: cfg.emaTrailingTrigger || '',
            emaTrailingStatus: cfg.emaTrailingEnabled ? 'waiting-target' : '',
            ...mtmConfigFields({ ...cfg, qty: stock.qty }),
            orderId,
            ...orderFields,
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
      const freshQualified = qualified.filter(r => !skipHeld(String(r.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase()));
      const toTrade = Number.isFinite(entryLimit) ? freshQualified.slice(0, entryLimit) : freshQualified;
      const results = [];

      const placeNext = (i) => {
        if (i >= toTrade.length) {
          return callback(null, { scanned: symbols.length, qualified: qualified.length, freshQualified: freshQualified.length, selected: toTrade.length, alreadyTraded: tradedToday.size, alreadyHeld: heldOpen.size, openPositions: openNow, maxOpenPositions, orders: results });
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
            targetPrice: mtmEntryTargetPrice(cfg, stock, broker),
            rr: stock.rr,
            screenerName: logScreenerName,
            entryCriteria: logEntryCriteria,
            exitCriteria: logExitCriteria,
            emaTrailingEnabled: !!cfg.emaTrailingEnabled,
            emaTrailingIndicator: cfg.emaTrailingIndicator || '',
            entryEmaIndicator: entryEmaIndicatorFromFilters(cfg.entryFilters),
            jobId: job.id,
            emaTrailingPct: cfg.emaTrailingPct ?? '',
            emaTrailingTimeframe: cfg.emaTrailingTimeframe || '',
            emaTrailingTrigger: cfg.emaTrailingTrigger || '',
            emaTrailingStatus: cfg.emaTrailingEnabled ? 'waiting-target' : '',
            ...mtmConfigFields({ ...cfg, qty: stock.qty }),
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
          targetPrice: mtmEntryTargetPrice(cfg, stock, broker),
          trailSL: cfg.trailSL || 0,
          dhanSlTriggerBufferPct: cfg.dhanSlTriggerBufferPct || 0,
          emaTrailingEnabled: !!cfg.emaTrailingEnabled,
          emaTrailingTrigger: cfg.emaTrailingTrigger || 'afterTarget',
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
          const orderFields = extractPlacedOrderLogFields(broker, orderRes);
          const brokerSlPrice = broker === 'dhan'
            ? orderRes?.request?.stopLossPrice
            : broker === 'angelone'
              ? orderRes?.request?.stopLossPrice
              : '';
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
            targetPrice: mtmEntryTargetPrice(cfg, stock, broker),
            rr: stock.rr,
            screenerName: logScreenerName,
            entryCriteria: logEntryCriteria,
            exitCriteria: logExitCriteria,
            emaTrailingEnabled: !!cfg.emaTrailingEnabled,
            emaTrailingIndicator: cfg.emaTrailingIndicator || '',
            entryEmaIndicator: entryEmaIndicatorFromFilters(cfg.entryFilters),
            jobId: job.id,
            emaTrailingPct: cfg.emaTrailingPct ?? '',
            emaTrailingTimeframe: cfg.emaTrailingTimeframe || '',
            emaTrailingTrigger: cfg.emaTrailingTrigger || '',
            emaTrailingStatus: cfg.emaTrailingEnabled ? 'waiting-target' : '',
            ...mtmConfigFields({ ...cfg, qty: stock.qty }),
            orderId,
            ...orderFields,
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
      ? Math.max(1, roundPrice(entry * Number(orderParams.trailSL) / 100))
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
  const sl = Number(orderParams.slPrice || 0);
  const target = Number(orderParams.targetPrice || 0);
  const emaTrailingMode = isPostTargetEmaTrailingOrder(orderParams);
  if (!store.clientId || !store.accountId || !accessToken) return callback('Missing Angel One API key, client code, or generated token. Open Settings and generate today token.', null);
  if (!symbol || !qty || !entry || !sl || !target) return callback('Missing Angel One protected order fields', null);
  if (!(sl < entry && target > entry)) return callback('Invalid Angel One BUY setup: SL must be below entry and target above entry', null);

  resolveAngelOneInstrument(symbol, orderParams.exchange || 'NSE', (lookupErr, info) => {
    if (lookupErr) return callback(lookupErr, null);
    const exchange = info.exchange;
    const instrument = info.instrument;
    const productType = angelOneProductType(orderParams.segment);
    const orderType = entry > 0 ? 'LIMIT' : 'MARKET';
    const entryPayload = {
      variety: 'NORMAL',
      tradingsymbol: instrument.tradingSymbol,
      symboltoken: instrument.token,
      transactiontype: orderParams.action || 'BUY',
      exchange: instrument.exchange || exchange,
      ordertype: orderType,
      producttype: productType,
      duration: 'DAY',
      price: orderType === 'LIMIT' ? String(roundPrice(entry)) : '0',
      squareoff: '0',
      stoploss: '0',
      quantity: String(qty),
    };
    angelRequest('POST', '/rest/secure/angelbroking/order/v1/placeOrder', store, accessToken, entryPayload, (entryErr, entryRes) => {
      if (entryErr) return callback('Angel One entry order failed: ' + entryErr, null);
      if (!entryRes || entryRes.status >= 400 || entryRes.data?.status === false) {
        return callback('Angel One entry order failed: ' + angelApiMessage(entryRes?.data, 'HTTP ' + entryRes?.status), entryRes);
      }
      const entryOrderId = angelOneOrderId(entryRes.data);
      const slLimit = angelOneSlLimitPrice(sl, orderParams.dhanSlTriggerBufferPct || 0.5);
      createAngelOneGttRule(store, accessToken, {
        instrument,
        transactionType: 'SELL',
        triggerPrice: sl,
        price: slLimit,
        qty,
        productType,
        exchange,
      }, (slErr, slRes) => {
        if (slErr) {
          return callback(slErr, {
            status: slRes?.status || 500,
            data: { entry: entryRes.data, slGtt: slRes?.data || null },
            request: { entry: entryPayload, slGtt: slRes?.request || null },
            angelOneEntryOrderId: entryOrderId,
            softwareTargetTrailing: emaTrailingMode,
          });
        }
        const slRuleId = angelOneRuleId(slRes.data);
        callback(null, {
          status: slRes.status,
          data: { entry: entryRes.data, slGtt: slRes.data },
          request: { entry: entryPayload, slGtt: slRes.request, stopLossPrice: roundPrice(sl), stopLossLimitPrice: slLimit },
          angelOneEntryOrderId: entryOrderId,
          angelOneSlRuleId: slRuleId,
          softwareTargetOrder: true,
          softwareTargetTrailing: emaTrailingMode,
        });
      });
    });
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
    return callback('Upstox broker execution is coming soon. Please use Dhan, Zerodha, or Test Mode for now.', null);
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

// Re-fetch a job's screener live and replace its stored stock list, so the
// algo trades today's constituents instead of a snapshot frozen at config time.
// Built-in screeners use fetchCurrentScreener; saved screeners reuse the tested
// /saved-filter-stocks resolver via an in-process loopback call.
function refreshAlgoScreener(job, done) {
  const cfg = job.config || {};
  const token = cfg.stockkarToken || getStoredToken();
  const slug = cfg.screenerSlug;
  if (!token || !slug) return done && done('No token or screener slug');
  const apply = (stocks) => {
    if (!Array.isArray(stocks) || !stocks.length) return done && done('Refresh returned no stocks');
    const latest = readAlgoSchedule();
    const j = (latest.jobs || []).find(x => x.id === job.id);
    if (j) {
      j.config.screenerStocks = stocks;
      j.config.screenerStockCount = stocks.length;
      j.screenerRefreshedDate = istDateKey();
      j.lastScreenerRefreshAt = new Date().toISOString();
      writeAlgoSchedule(latest);
    }
    done && done(null, stocks.length);
  };
  const tab = String(cfg.algoTab || 'builtin').toLowerCase();
  if (tab === 'watchlist') {
    // A watchlist algo MUST refresh from the watchlist source (the user's saved
    // stocks). Using /saved-filter-stocks here returned the full screener
    // universe (e.g. 2000) instead of the watchlist's handful of stocks.
    fetchWatchlistRows(slug, token, 5000, (err, directRes, directMiss) => {
      if (err) return done && done('Watchlist refresh error: ' + err + (directMiss ? ' (' + directMiss + ')' : ''));
      apply(directRes ? pickStockRowsFromPayload(directRes.data) : null);
    });
  } else if (tab === 'saved') {
    internalPost('/saved-filter-stocks', { token, filterId: slug, filterName: cfg.screenerName }, (err, body) => {
      if (err) return done && done(err);
      apply(body && body.ok ? (body.data || []) : null);
    });
  } else {
    fetchCurrentScreener(slug, token, (err, r) => {
      if (err) return done && done(err);
      apply(extractStockRows(r && r.data));
    });
  }
}

// Daily pre-open refresh: after ~8 AM IST (when the source screeners refresh),
// re-pull every enabled algo's screener once, before the 9:15 open. Also runs at
// startup so a backend that booted late still refreshes before the first run.
const ALGO_SCREENER_REFRESH_HOUR_IST = Number(process.env.ALGO_SCREENER_REFRESH_HOUR_IST || 8);
const ALGO_SCREENER_REFRESH_MINUTE_IST = Number(process.env.ALGO_SCREENER_REFRESH_MINUTE_IST || 0);
let screenerRefreshInFlight = false;
function checkAlgoScreenerRefresh() {
  if (screenerRefreshInFlight) return;
  const now = getIstNow();
  if (now.getDay() === 0 || now.getDay() === 6) return;
  if (now.getHours() * 60 + now.getMinutes() < ALGO_SCREENER_REFRESH_HOUR_IST * 60 + ALGO_SCREENER_REFRESH_MINUTE_IST) return;
  const dateKey = istDateKey(now);
  const due = (readAlgoSchedule().jobs || []).filter(j => j.enabled && j.config?.screenerSlug && j.screenerRefreshedDate !== dateKey);
  if (!due.length) return;
  screenerRefreshInFlight = true;
  let i = 0;
  const next = () => {
    if (i >= due.length) { screenerRefreshInFlight = false; return; }
    const job = due[i++];
    refreshAlgoScreener(job, (err, count) => {
      console.log('[SCREENER REFRESH]', job.id, err ? ('failed: ' + err) : ('updated ' + count + ' stocks'));
      next();
    });
  };
  next();
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
  const getBody = (cb) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { cb(b ? JSON.parse(b) : {}); } catch { sendJSON({ ok: false, error: 'Invalid JSON body' }, 400); } }); };

  if (parsedUrl.pathname === '/app-lock/status' && req.method === 'GET') {
    const configured = fs.existsSync(APP_LOCK_FILE);
    sendJSON({ ok: true, configured, unlocked: configured && hasAppLockSession(req) });
    return;
  }

  if (parsedUrl.pathname === '/app-lock/setup' && req.method === 'POST') {
    getBody(({ pin, dob }) => {
      if (fs.existsSync(APP_LOCK_FILE)) return sendJSON({ ok: false, error: 'App Lock PIN is already configured.' }, 409);
      if (!/^\d{6,12}$/.test(String(pin || ''))) return sendJSON({ ok: false, error: 'Choose a 6 to 12 digit PIN.' }, 400);
      const normDob = normaliseDob(dob);
      if (!normDob) return sendJSON({ ok: false, error: 'Enter your date of birth (used to reset a forgotten PIN).' }, 400);
      const pinH = hashAppLockPin(pin);
      const dobH = hashAppLockPin(normDob);
      writePrivateJson(APP_LOCK_FILE, {
        salt: pinH.salt, hash: pinH.hash,
        dobSalt: dobH.salt, dobHash: dobH.hash,
        createdAt: new Date().toISOString(),
      });
      const token = createAppLockSession();
      sendJSON({ ok: true, message: 'App Lock enabled.' }, 200, {
        'Set-Cookie': `stockkar_app_session=${token}; ${appCookieFlags(req)}Max-Age=43200`,
      });
    });
    return;
  }

  // Change PIN / set recovery DOB from inside the app. Requires an active
  // unlocked session (the /app-lock/* paths bypass the normal lock gate, so
  // we check explicitly here). Lets existing users add a DOB to an old PIN.
  if (parsedUrl.pathname === '/app-lock/reconfigure' && req.method === 'POST') {
    getBody(({ pin, dob }) => {
      if (!fs.existsSync(APP_LOCK_FILE)) return sendJSON({ ok: false, setupRequired: true, error: 'Create your App Lock PIN first.' }, 409);
      if (!hasAppLockSession(req)) return sendJSON({ ok: false, locked: true, error: 'Unlock the app first.' }, 401);
      if (!/^\d{6,12}$/.test(String(pin || ''))) return sendJSON({ ok: false, error: 'Choose a 6 to 12 digit PIN.' }, 400);
      const normDob = normaliseDob(dob);
      if (!normDob) return sendJSON({ ok: false, error: 'Enter your date of birth (used to reset a forgotten PIN).' }, 400);
      const pinH = hashAppLockPin(pin);
      const dobH = hashAppLockPin(normDob);
      writePrivateJson(APP_LOCK_FILE, {
        salt: pinH.salt, hash: pinH.hash,
        dobSalt: dobH.salt, dobHash: dobH.hash,
        createdAt: readJsonFile(APP_LOCK_FILE)?.createdAt || new Date().toISOString(),
        pinResetAt: new Date().toISOString(),
      });
      sendJSON({ ok: true, message: 'PIN and recovery date of birth updated.' });
    });
    return;
  }

  if (parsedUrl.pathname === '/app-lock/recover' && req.method === 'POST') {
    getBody(({ dob, pin }) => {
      const stored = readJsonFile(APP_LOCK_FILE);
      if (!fs.existsSync(APP_LOCK_FILE)) return sendJSON({ ok: false, setupRequired: true, error: 'Create your App Lock PIN first.' }, 409);
      if (!stored?.dobHash) return sendJSON({ ok: false, error: 'This PIN has no date-of-birth reset set. Use SSH recovery.' }, 409);

      // Lockout: 5 wrong DOB attempts -> 1 hour cooldown (persisted across restarts).
      const RECOVER_MAX_FAILS = 5, RECOVER_LOCK_MS = 60 * 60 * 1000;
      const now = Date.now();
      if (stored.recoverLockUntil && now < stored.recoverLockUntil) {
        const mins = Math.ceil((stored.recoverLockUntil - now) / 60000);
        return sendJSON({ ok: false, error: `Too many wrong attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` }, 429);
      }

      if (!verifyAppLockDob(dob)) {
        const fails = (stored.recoverFails || 0) + 1;
        const next = { ...stored, recoverFails: fails };
        if (fails >= RECOVER_MAX_FAILS) { next.recoverLockUntil = now + RECOVER_LOCK_MS; next.recoverFails = 0; }
        writePrivateJson(APP_LOCK_FILE, next);
        const left = RECOVER_MAX_FAILS - fails;
        if (next.recoverLockUntil) return sendJSON({ ok: false, error: 'Too many wrong attempts. Locked for 1 hour.' }, 429);
        return sendJSON({ ok: false, error: `Date of birth does not match. ${left} attempt${left === 1 ? '' : 's'} left.` }, 401);
      }
      if (!/^\d{6,12}$/.test(String(pin || ''))) return sendJSON({ ok: false, error: 'Choose a new 6 to 12 digit PIN.' }, 400);
      const pinH = hashAppLockPin(pin);
      writePrivateJson(APP_LOCK_FILE, {
        salt: pinH.salt, hash: pinH.hash,
        dobSalt: stored.dobSalt, dobHash: stored.dobHash,
        createdAt: stored.createdAt, pinResetAt: new Date().toISOString(),
      });
      const token = createAppLockSession();
      sendJSON({ ok: true, message: 'PIN reset.' }, 200, {
        'Set-Cookie': `stockkar_app_session=${token}; ${appCookieFlags(req)}Max-Age=43200`,
      });
    });
    return;
  }

  if (parsedUrl.pathname === '/app-lock/login' && req.method === 'POST') {
    getBody(({ pin }) => {
      if (!fs.existsSync(APP_LOCK_FILE)) return sendJSON({ ok: false, setupRequired: true, error: 'Create your App Lock PIN first.' }, 409);
      if (!verifyAppLockPin(pin)) return sendJSON({ ok: false, error: 'Incorrect App Lock PIN.' }, 401);
      const token = createAppLockSession();
      sendJSON({ ok: true, message: 'Unlocked.' }, 200, {
        'Set-Cookie': `stockkar_app_session=${token}; ${appCookieFlags(req)}Max-Age=43200`,
      });
    });
    return;
  }

  if (parsedUrl.pathname === '/app-lock/logout' && req.method === 'POST') {
    const token = parseCookies(req).stockkar_app_session;
    if (token) APP_LOCK_SESSIONS.delete(token);
    sendJSON({ ok: true, message: 'Locked.' }, 200, {
      'Set-Cookie': `stockkar_app_session=; ${appCookieFlags(req)}Max-Age=0`,
    });
    return;
  }

  if (isAppLockSensitivePath(parsedUrl.pathname) && fs.existsSync(APP_LOCK_FILE) && !hasAppLockSession(req) && !isInternalLoopbackRequest(req)) {
    return sendJSON({ ok: false, locked: true, error: 'App is locked. Enter your App Lock PIN.' }, 401);
  }

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

  if (parsedUrl.pathname === '/signal-health' && req.method === 'GET') {
    sendJSON({ ok: true, signalHealth: tvHealthView() });
    return;
  }

  if (parsedUrl.pathname === '/algo-schedule/job' && req.method === 'GET') {
    const job = (readAlgoSchedule().jobs || []).find(j => j.id === parsedUrl.query.id);
    if (!job) return sendJSON({ ok: false, error: 'Algo not found' });
    const { stockkarToken, dhanToken, dhanClient, ...safeConfig } = job.config || {};
    sendJSON({ ok: true, config: safeConfig });
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

  const brokerPostbackMatch = parsedUrl.pathname.match(/^\/broker\/(zerodha|upstox|angelone)\/postback$/);
  if (brokerPostbackMatch && (req.method === 'POST' || req.method === 'GET')) {
    if (req.method === 'POST') {
      let ignored = '';
      req.on('data', chunk => { ignored += chunk; if (ignored.length > 65536) req.destroy(); });
      req.on('end', () => sendJSON({ ok: true, broker: brokerPostbackMatch[1], received: true }));
    } else {
      sendJSON({ ok: true, broker: brokerPostbackMatch[1], received: true });
    }
    return;
  }

  if (parsedUrl.pathname === '/broker/angelone/callback' && req.method === 'GET') {
    res.writeHead(302, { Location: '/?broker=angelone&callback=received' });
    res.end();
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
        if (!store?.refreshToken) {
          return sendJSON({
            ok: false,
            error: 'Angel One needs fresh PIN/TOTP login. Enter current TOTP in Settings and click Login / Generate Angel One Token.',
            data: getBrokerTokenStatus('angelone'),
          }, 409);
        }
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

  if (parsedUrl.pathname === '/broker/angelone/login' && req.method === 'POST') {
    getBody(({ apiKey, dhanClient, clientId, accountId, brokerAccountId, password, pin, totp }) => {
      const previous = readBrokerTokenStore().brokers.angelone || {};
      const store = {
        clientId: apiKey || dhanClient || clientId || previous.clientId,
        accountId: accountId || brokerAccountId || previous.accountId,
      };
      const loginSecret = password || pin;
      if (!store.clientId || !store.accountId || !loginSecret || !totp) {
        return sendJSON({ ok: false, error: 'Fill Angel One SmartAPI key, client code, PIN/password, and current TOTP.' }, 400);
      }
      loginAngelOneToken(store, loginSecret, totp, (err, tokenData) => {
        if (err) return sendJSON({ ok: false, error: err, data: getBrokerTokenStatus('angelone') }, 400);
        saveBrokerToken('angelone', {
          clientId: store.clientId,
          accountId: store.accountId,
          accessToken: tokenData.accessToken,
          refreshToken: tokenData.refreshToken,
          feedToken: tokenData.feedToken,
          source: 'angel-login',
          renewedAt: new Date().toISOString(),
          lastRenewalError: null,
        });
        updateScheduledBrokerToken('angelone', store.clientId, tokenData.accessToken);
        sendJSON({ ok: true, data: getBrokerTokenStatus('angelone'), tokenStatuses: getAllBrokerTokenStatuses() });
      });
    });
    return;
  }

  if (parsedUrl.pathname === '/algo-schedule/update-credentials' && req.method === 'POST') {
    getBody(({ dhanClient, dhanToken, broker, refreshToken, clientSecret, accountId, feedToken }) => {
      const brokerId = String(broker || 'dhan').toLowerCase();
      const oauthLoginSetup = ['zerodha', 'upstox'].includes(brokerId) && dhanClient && clientSecret;
      const angelCredentialSetup = brokerId === 'angelone' && dhanClient && accountId;
      if (!dhanClient || (!dhanToken && !oauthLoginSetup && !angelCredentialSetup)) return sendJSON({ ok: false, error: 'Missing broker client/API key or access token' });
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
      screenerRefreshedDate: job.screenerRefreshedDate || '',
      screenerRefreshedToday: !!job.screenerRefreshedDate && job.screenerRefreshedDate === istDateKey(),
      lastScreenerRefreshAt: job.lastScreenerRefreshAt || null,
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
        emaTrailingEnabled: !!job.config.emaTrailingEnabled,
        emaTrailingIndicator: job.config.emaTrailingIndicator || '',
        emaTrailingPct: job.config.emaTrailingPct || '',
        emaTrailingTimeframe: job.config.emaTrailingTimeframe || '1D',
        emaTrailingTrigger: job.config.emaTrailingTrigger || 'afterTarget',
      } : null,
    }));
    sendJSON({ ok: true, jobs, enabled: jobs.some(job => job.enabled), dhanTokenStatus: getDhanTokenStatus(), brokerTokenStatuses: getAllBrokerTokenStatuses(), signalHealth: tvHealthView() });
    return;
  }

  if (parsedUrl.pathname === '/algo-schedule' && req.method === 'POST') {
    getBody((body) => {
      const existing = readAlgoSchedule();
      existing.jobs = existing.jobs || [];
      if (body.enabled) {
        const cfg = body.config || {};
        if (!cfg.screenerSlug && !(Array.isArray(cfg.screenerStocks) && cfg.screenerStocks.length)) return sendJSON({ ok: false, error: 'Configure a screener basket before adding queue' });
        const stockCount = countAlgoConfigStocks(cfg);
        if (stockCount > FREE_TIER_LIMITS.maxStocksPerAlgo) return sendJSON({ ok: false, error: 'Too many stocks selected. Select max ' + FREE_TIER_LIMITS.maxStocksPerAlgo + ' stocks per algo for free-tier safety.' });
        if (activeAlgoJobCount(existing) >= FREE_TIER_LIMITS.maxAlgoJobs) return sendJSON({ ok: false, error: 'Free-tier safety limit reached: max ' + FREE_TIER_LIMITS.maxAlgoJobs + ' active algos. Pause or cancel an algo before starting another.' });
        if (!cfg.runTime || !/^\d{2}:\d{2}$/.test(String(cfg.runTime))) return sendJSON({ ok: false, error: 'Select a valid run time' });
        cfg.endTime = cfg.endTime && /^\d{2}:\d{2}$/.test(String(cfg.endTime)) ? cfg.endTime : '10:30';
        cfg.checkIntervalMinutes = Math.max(FREE_TIER_LIMITS.minCheckEveryMinutes, Math.min(30, Number(cfg.checkIntervalMinutes || FREE_TIER_LIMITS.minCheckEveryMinutes)));
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
        sendJSON({ ok: true, id, enabled: true, jobs: existing.jobs.length, limits: freeTierLimitsClientView() });
        return;
      }
      if (body.id) {
        const job = existing.jobs.find(j => j.id === body.id);
        if (!job) return sendJSON({ ok: false, error: 'Schedule job not found' });
        if (body.action === 'delete') {
          existing.jobs = existing.jobs.filter(j => j.id !== job.id);
          writeAlgoSchedule(existing);
          // Note: removes the schedule entry only. Any open broker positions stay
          // protected by their broker-side SL and are still managed from the order log.
          return sendJSON({ ok: true, id: job.id, deleted: true, jobs: existing.jobs.length });
        }
        if (body.action === 'edit') {
          // Full edit: replace the strategy config (entry, exit, trailing, MTM,
          // screener basket, filters, broker, schedule). Credentials and job
          // identity/run-state are preserved (creds aren't in the form payload).
          const newCfg = body.config || {};
          if (!newCfg.screenerSlug && !(Array.isArray(newCfg.screenerStocks) && newCfg.screenerStocks.length)) return sendJSON({ ok: false, error: 'Configure a screener basket before saving' });
          if (!newCfg.runTime || !/^\d{2}:\d{2}$/.test(String(newCfg.runTime))) return sendJSON({ ok: false, error: 'Select a valid run time' });
          const endTime = newCfg.endTime && /^\d{2}:\d{2}$/.test(String(newCfg.endTime)) ? newCfg.endTime : '10:30';
          if (timeToMinutes(endTime) <= timeToMinutes(newCfg.runTime)) return sendJSON({ ok: false, error: 'End time must be after start time' });
          const interval = Math.max(FREE_TIER_LIMITS.minCheckEveryMinutes, Math.min(30, Number(newCfg.checkIntervalMinutes || FREE_TIER_LIMITS.minCheckEveryMinutes)));
          if (countAlgoConfigStocks(newCfg) > FREE_TIER_LIMITS.maxStocksPerAlgo) return sendJSON({ ok: false, error: 'Too many stocks selected. Max ' + FREE_TIER_LIMITS.maxStocksPerAlgo + ' per algo.' });
          const dup = existing.jobs.find(o => o.id !== job.id && o.enabled &&
            o.config?.screenerSlug === newCfg.screenerSlug && (o.config?.runTime || '09:15') === newCfg.runTime);
          if (dup) return sendJSON({ ok: false, error: 'Another active job already uses this screener at ' + newCfg.runTime });
          // Preserve credentials from the existing config (not sent by the form).
          const preserved = {
            stockkarToken: job.config?.stockkarToken,
            dhanClient: job.config?.dhanClient,
            dhanToken: job.config?.dhanToken,
          };
          job.config = { ...job.config, ...newCfg, ...preserved, endTime, checkIntervalMinutes: interval };
          job.screenerRefreshedDate = '';   // force a fresh screener pull on next refresh
          job.updatedAt = new Date().toISOString();
          writeAlgoSchedule(existing);
          return sendJSON({ ok: true, id: job.id, edited: true });
        }
        if (body.action === 'resume') {
          const duplicate = existing.jobs.find(other =>
            other.id !== job.id &&
            other.enabled &&
            other.config?.screenerSlug === job.config?.screenerSlug &&
            (other.config?.runTime || '09:15') === (job.config?.runTime || '09:15')
          );
          if (duplicate) return sendJSON({ ok: false, error: 'Another active job already uses this screener at ' + (job.config?.runTime || '09:15') });
          if (activeAlgoJobCount(existing) >= FREE_TIER_LIMITS.maxAlgoJobs && !isActiveAlgoJob(job)) return sendJSON({ ok: false, error: 'Free-tier safety limit reached: max ' + FREE_TIER_LIMITS.maxAlgoJobs + ' active algos. Pause or cancel an algo before resuming another.' });
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
  if (parsedUrl.pathname === '/saved-screener-monitors' && req.method === 'GET') {
    const includeStocks = parsedUrl.query.includeStocks === '1';
    const data = readSavedScreenerMonitors();
    sendJSON({ ok: true, refreshTime: '08:00 IST', limits: freeTierLimitsClientView(), monitors: data.monitors.map(m => monitorClientView(m, includeStocks)) });
    return;
  }

  if (parsedUrl.pathname === '/saved-screener-monitors' && req.method === 'POST') {
    getBody((body) => {
      const token = body.token || getStoredToken();
      const stocks = normalizeMonitorStocks(body.stocks || []);
      if (!token) return sendJSON({ ok: false, error: 'Stockkar token missing' });
      if (!stocks.length) return sendJSON({ ok: false, error: 'Fetch a screener before saving monitor' });
      const source = ['saved', 'watchlist', 'manual'].includes(body.source) ? body.source : 'builtin';
      const slug = String(body.slug || '').trim();
      const filterId = String(body.filterId || slug).trim();
      if (source === 'saved' && !filterId) return sendJSON({ ok: false, error: 'Saved screener id missing' });
      if (source === 'watchlist' && !filterId) return sendJSON({ ok: false, error: 'Watchlist id missing' });
      if (source === 'builtin' && !slug) return sendJSON({ ok: false, error: 'Built-in screener slug missing' });
      if (source === 'manual' && !slug) return sendJSON({ ok: false, error: 'Manual watchlist id missing' });
      const name = String(body.name || (source === 'saved' ? 'Saved screener' : (source === 'watchlist' ? 'Watchlist' : slug))).trim();
      const idSeed = source + ':' + ((source === 'saved' || source === 'watchlist') ? filterId : slug);
      const id = crypto.createHash('sha1').update(idSeed).digest('hex').slice(0, 12);
      const now = new Date().toISOString();
      const data = readSavedScreenerMonitors();
      const existingIndex = data.monitors.findIndex(m => m.id === id);
      if (existingIndex < 0 && data.monitors.length >= FREE_TIER_LIMITS.maxSavedMonitors) return sendJSON({ ok: false, error: 'Free-tier safety limit reached: max ' + FREE_TIER_LIMITS.maxSavedMonitors + ' saved monitors. Delete an old monitor before saving another.' });
      const existing = existingIndex >= 0 ? data.monitors[existingIndex] : {};
      const monitor = {
        ...existing,
        id,
        enabled: true,
        source,
        name,
        slug,
        filterId,
        stockkarToken: token,
        refreshTime: '08:00 IST',
        previousSnapshot: Array.isArray(existing.latestSnapshot) ? existing.latestSnapshot : [],
        latestSnapshot: stocks,
        latestSavedAt: now,
        lastRefreshAt: now,
        lastRefreshDate: istDateKey(),
        lastRefreshStatus: 'saved',
        lastRefreshError: '',
        createdAt: existing.createdAt || now,
        updatedAt: now,
      };
      if (existingIndex >= 0) data.monitors[existingIndex] = monitor;
      else data.monitors.push(monitor);
      writeSavedScreenerMonitors(data);
      sendJSON({ ok: true, monitor: monitorClientView(monitor) });
    });
    return;
  }

  if (parsedUrl.pathname === '/saved-screener-monitors/refresh' && req.method === 'POST') {
    getBody((body) => {
      const data = readSavedScreenerMonitors();
      const targets = body.id ? data.monitors.filter(m => m.id === body.id) : data.monitors.filter(m => m.enabled !== false);
      if (!targets.length) return sendJSON({ ok: false, error: 'No monitor found' });
      let completed = 0;
      const finish = () => {
        completed += 1;
        if (completed < targets.length) return;
        writeSavedScreenerMonitors(data);
        sendJSON({ ok: true, monitors: data.monitors.map(m => monitorClientView(m)) });
      };
      targets.forEach(target => refreshSavedScreenerMonitor(target, finish));
    });
    return;
  }

  if (parsedUrl.pathname === '/saved-screener-monitors/delete' && req.method === 'POST') {
    getBody((body) => {
      const id = String(body.id || '').trim();
      if (!id) return sendJSON({ ok: false, error: 'Saved watchlist id missing' });
      const data = readSavedScreenerMonitors();
      const before = data.monitors.length;
      data.monitors = data.monitors.filter(m => m.id !== id);
      if (data.monitors.length === before) return sendJSON({ ok: false, error: 'Saved watchlist not found' });
      writeSavedScreenerMonitors(data);
      sendJSON({ ok: true, monitors: data.monitors.map(m => monitorClientView(m)) });
    });
    return;
  }

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

  // Load Stockkar watchlists list
  if (parsedUrl.pathname === '/watchlists' && req.method === 'POST') {
    getBody(({ token }) => {
      if (!token) return sendJSON({ ok: false, error: 'No token provided' });
      fetchWatchlists(token, (err, list, miss, sourcePath) => {
        if (err) return sendJSON({ ok: false, error: String(err) });
        if (!list.length) return sendJSON({ ok: false, error: 'No watchlists found. Make sure you are logged in to Stockkar.' + (miss ? ' Last check: ' + miss : '') });
        sendJSON({ ok: true, data: list, sourcePath });
      });
    });
    return;
  }

  // Fetch stocks from a Stockkar watchlist
  if (parsedUrl.pathname === '/watchlist-stocks' && req.method === 'POST') {
    getBody(({ token, watchlistId, limit }) => {
      if (!token) return sendJSON({ ok: false, error: 'No token provided' });
      if (!watchlistId) return sendJSON({ ok: false, error: 'Watchlist id missing' });
      fetchWatchlistRows(watchlistId, token, limit, (err, directRes, directMiss) => {
        if (err) return sendJSON({ ok: false, error: 'Watchlist fetch error: ' + err });
        const rows = directRes ? pickStockRowsFromPayload(directRes.data) : [];
        if (!rows.length) return sendJSON({ ok: false, error: 'No stocks found for this watchlist' + (directMiss ? ': ' + directMiss : '') });
        console.log('[WATCHLIST DIRECT] count:', rows.length, '| source:', directRes.sourcePath);
        sendJSON({ ok: true, data: rows, total: rows.length, watchlistId, sourcePath: directRes.sourcePath });
      });
    });
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
        const normalized = list.map((item) => {
          const base = item && typeof item === 'object' ? item : {};
          const name = savedFilterNameFromItem(item);
          const id = savedFilterIdFromItem(item);
          return {
            ...base,
            stockkarDisplayName: name,
            stockkarSavedFilterId: id,
          };
        });
        sendJSON({ ok: true, data: normalized });
      });
    });
    return;
  }

  // Fetch stocks from a saved filter Ã¢â‚¬â€ verified mapper
  if (parsedUrl.pathname === '/saved-filter-stocks' && req.method === 'POST') {
    getBody(({ token, filterId, filterName, limit }) => {
      if (!token) return sendJSON({ ok: false, error: 'No token provided' });
      if (!filterId && !filterName) return sendJSON({ ok: false, error: 'No saved screener selected' });
      const lookupFilterId = uniqueNonEmptyStrings([filterId, filterName]).join('|||');

      fetchSavedFilterDirect(lookupFilterId, token, limit, (directErr, directRes, directMiss) => {
        if (directErr) return sendJSON({ ok: false, error: 'Saved filter direct fetch error: ' + directErr });
        const directStocks = directRes ? pickStockRowsFromPayload(directRes.data) : [];
        if (directStocks.length) {
          console.log('[SAVED FILTER DIRECT] count:', directStocks.length, '| source:', directRes.sourcePath);
          return sendJSON({ ok: true, data: directStocks, total: directStocks.length, filterName: filterName || filterId, sourcePath: directRes.sourcePath });
        }
        if (directMiss) console.log('[SAVED FILTER DIRECT] no rows, fallback mapper:', directMiss);

      // Step 1: Get filter config using slug
      stockkarGet('/api/saved-filter/slug/' + encodeURIComponent(filterId || filterName || ''), token, (err1, r1) => {
        if (err1) return sendJSON({ ok: false, error: 'Filter config error: ' + err1 });

        const config = r1?.data || {};
        const f = config.filters || {};

        console.log('[FILTER CONFIG] name:', config.name, '| activeFilters:', JSON.stringify(f.activeFilters));

        // Ã¢â€â‚¬Ã¢â€â‚¬ COMPLETE verified mapper Ã¢â‚¬â€ all filters researched via Chrome Ã¢â€â‚¬Ã¢â€â‚¬
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

        // Ã¢â€â‚¬Ã¢â€â‚¬ Baskets Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasB) p.set('baskets', f.selectedBaskets.join(','));

        // Ã¢â€â‚¬Ã¢â€â‚¬ Industries Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (f.selectedIndustries && f.selectedIndustries.length)
          f.selectedIndustries.forEach(function(ind) { p.append('industry', ind); });

        // Ã¢â€â‚¬Ã¢â€â‚¬ Market Cap (always) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        p.set('market_cap_min', String(Math.round((f.marketCapRange && f.marketCapRange[0]) || 401)));
        p.set('market_cap_max', String(Math.round((f.marketCapRange && f.marketCapRange[1]) || 1787042)));

        // Exchange (NSE/BSE) filter
        if (hasFilter('Exchange') && f.stockExchange && String(f.stockExchange).toLowerCase() !== 'all') {
          p.set('stock_exchange', String(f.stockExchange).toLowerCase());
        }

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

        // Ã¢â€â‚¬Ã¢â€â‚¬ PE Ratio Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('PE Ratio') && f.peRatioRange) {
          p.set('pe_ratio_min', String(Math.round(f.peRatioRange[0])));
          p.set('pe_ratio_max', String(Math.round(f.peRatioRange[1])));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ ROE Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('ROE') && f.roeRange) {
          p.set('roe_min', String(Math.round(f.roeRange[0])));
          p.set('roe_max', String(Math.round(f.roeRange[1])));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ ROCE Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('ROCE') && f.roceRange) {
          p.set('roce_min', String(Math.round(f.roceRange[0])));
          p.set('roce_max', String(Math.round(f.roceRange[1])));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Debt Ratio Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('Debt Ratio') && f.debtRatioRange) {
          p.set('de_ratio_min', String(Math.round(f.debtRatioRange[0])));
          p.set('de_ratio_max', String(Math.round(f.debtRatioRange[1])));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Demand dates Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (f.demandStartDate) p.set('demand_start_date', f.demandStartDate);
        if (f.demandEndDate)   p.set('demand_end_date',   f.demandEndDate);

        // Ã¢â€â‚¬Ã¢â€â‚¬ Big Player Score (use Start/End NOT legacy bigPlayerScore) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('Big Player Score')) {
          var bps = f.bigPlayerScoreStart || [0, 100];
          var bpe = f.bigPlayerScoreEnd   || [0, 100];
          p.set('big_player_score_start_min', String(bps[0]));
          p.set('big_player_score_start_max', String(bps[1]));
          p.set('big_player_score_end_min',   String(bpe[0]));
          p.set('big_player_score_end_max',   String(bpe[1]));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Growth Score Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('Growth Score')) {
          var gss = f.growthScoreStart || [0, 100];
          var gse = f.growthScoreEnd   || [0, 100];
          p.set('growth_score_start_min', String(gss[0]));
          p.set('growth_score_start_max', String(gss[1]));
          p.set('growth_score_end_min',   String(gse[0]));
          p.set('growth_score_end_max',   String(gse[1]));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Momentum Score (use Start/End NOT legacy momentumScore) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('Momentum Score')) {
          var mss = f.momentumScoreStart || [0, 100];
          var mse = f.momentumScoreEnd   || [0, 100];
          p.set('momentum_score_start_min', String(mss[0]));
          p.set('momentum_score_start_max', String(mss[1]));
          p.set('momentum_score_end_min',   String(mse[0]));
          p.set('momentum_score_end_max',   String(mse[1]));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Near Term Growth Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('Near Term Growth Meter')) {
          p.set('short_term_growth_score_min', String(f.shortTermGrowthMin || 0));
          p.set('short_term_growth_score_max', String(f.shortTermGrowthMax || 100));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Growth Compounder Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('Growth Compounder Meter')) {
          p.set('long_term_growth_score_min', String(f.longTermGrowthMin || 0));
          p.set('long_term_growth_score_max', String(f.longTermGrowthMax || 100));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Performance Meter Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('Performance Meter')) {
          p.set('returns_efficiency_score_min', String(f.returnsEffMin || 0));
          p.set('returns_efficiency_score_max', String(f.returnsEffMax || 100));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Golden Valuation (PE TTM) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('Golden Valuation') && f.dailyTtmPeOp && f.dailyTtmPeOp !== 'within') {
          p.set('daily_ttm_pe_op',  f.dailyTtmPeOp);
          p.set('daily_ttm_pe_min', String((f.dailyTtmPeRange && f.dailyTtmPeRange[0]) || 0));
          p.set('daily_ttm_pe_max', String((f.dailyTtmPeRange && f.dailyTtmPeRange[1]) || 100));
          p.set('daily_ttm_pe_pct', String(f.dailyTtmPePct || 100));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Quarterly EPS Growth Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('Quarterly EPS Growth') && f.quarterlyEpsRange && f.quarterlyEpsRange[0] > 0) {
          p.set('quarter',          f.quarterlyEpsQuarter || '');
          p.set('eps_growth_min',   String(f.quarterlyEpsRange[0]));
          p.set('eps_growth_max',   String(f.quarterlyEpsRange[1]));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Delivery % Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (af.includes('Delivery %') && f.deliveryRange) {
          p.set('delivery_min', String(f.deliveryRange[0] || 0));
          p.set('delivery_max', String(f.deliveryRange[1] || 100));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Volume Traces Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (af.includes('Volume Traces')) {
          p.set('volume_days',       String(f.volumeDays || 30));
          p.set('volume_multiplier', String(f.volumeMultiplier || 3));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Your Date, Your Volume Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (af.includes('Your Date, Your Volume') && f.volumeSpike && f.volumeSpike.date) {
          p.set('volume_spike_date',       f.volumeSpike.date);
          p.set('volume_spike_multiplier', String(f.volumeSpike.multiplier || 3));
          p.set('volume_spike_days',       String(f.volumeSpike.days || 60));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ EMA above EMA (daily ema crossovers) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        // When a dated crossover is set, the website emits only the dated ema_crossovers
        // params below Ã¢â‚¬â€ skip the current/undated ema_cross_* to keep the query identical.
        var emaDated = f.emaCrossFrom && f.historicalEmaCrossovers && f.historicalEmaCrossovers.length;
        if ((af.includes('EMA above EMA') || af.includes('EMA Crossover')) && f.emaCrossovers && f.emaCrossovers.length && !emaDated) {
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

        // Ã¢â€â‚¬Ã¢â€â‚¬ SMA above SMA Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        var smaDated = f.emaCrossFrom && f.historicalSmaCrossovers && f.historicalSmaCrossovers.length;
        if ((hasFilter('SMA above SMA') || hasFilter('SMA Crossover')) && f.smaCrossovers && f.smaCrossovers.length && !smaDated) {
          f.smaCrossovers.forEach(function(sc) {
            p.append('ma_crossovers', sc.left + '-' + sc.right + '-' + sc.dir);
          });
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Historical EMA Crossovers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if ((hasFilter('EMA above EMA') || hasFilter('EMA Crossover')) && f.emaCrossFrom && f.historicalEmaCrossovers && f.historicalEmaCrossovers.length) {
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

        // Ã¢â€â‚¬Ã¢â€â‚¬ Historical SMA Crossovers Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if ((hasFilter('SMA above SMA') || hasFilter('SMA Crossover')) && f.emaCrossFrom && f.historicalSmaCrossovers && f.historicalSmaCrossovers.length) {
          p.set('ma_cross_from', f.emaCrossFrom);
          p.set('ma_cross_to',   f.emaCrossTo || '');
          f.historicalSmaCrossovers.forEach(function(sc) {
            p.append('ma_crossovers', sc.left + '-' + sc.right + '-' + sc.dir);
          });
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ % Within EMA Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if ((hasFilter('% Within EMA') || hasFilter('% Above Daily EMA')) && f.emaProximities && f.emaProximities.length) {
          f.emaProximities.forEach(function(ep) {
            if (!ep.field) return;
            var maxP = parseFloat((ep.maxPercent / 100).toFixed(4));
            var minP = parseFloat((ep.minPercent / 100).toFixed(4));
            if (ep.field.match(/^daily_ema/)) {
              var period = ep.field.replace('daily_ema','');
              p.append('ema_proximity_range', period + ':' + minP + ':' + maxP);
              p.append('ema_proximity',       period + ':' + maxP);
            } else {
              // weekly EMA or SMA Ã¢â€ â€™ ma_proximity_range
              p.append('ma_proximity_range', ep.field + ':' + minP + ':' + maxP);
            }
          });
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ % Within SMA Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('% Within SMA') && f.smaProximities && f.smaProximities.length) {
          f.smaProximities.forEach(function(sp) {
            if (!sp.field) return;
            var maxP = parseFloat((sp.maxPercent / 100).toFixed(4));
            var minP = parseFloat((sp.minPercent / 100).toFixed(4));
            p.append('ma_proximity_range', sp.field + ':' + minP + ':' + maxP);
          });
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ EMA Price Crossover Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

        // Ã¢â€â‚¬Ã¢â€â‚¬ SMA Price Crossover Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if ((hasFilter('SMA Price Crossover') || hasFilter('SMA Crossover')) && f.smaPriceCrossovers && f.smaPriceCrossovers.length) {
          if (f.priceCrossFrom) p.set('ma_price_cross_from', f.priceCrossFrom);
          if (f.priceCrossTo)   p.set('ma_price_cross_to',   f.priceCrossTo);
          f.smaPriceCrossovers.forEach(function(sc) {
            if (sc.field) p.append('ma_price_crossovers', sc.field + '-' + sc.dir);
          });
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ RSI 14 Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (hasFilter('RSI 14') && f.rsiRange) {
          p.set('rsi_min', String(f.rsiRange[0]));
          p.set('rsi_max', String(f.rsiRange[1]));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Supertrend Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

        // Ã¢â€â‚¬Ã¢â€â‚¬ Pivot / Price Near High (fall filter) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if ((hasFilter('Pivot') || hasFilter('Price Near High')) && f.fallPct) {
          p.set('fall_days', String(f.fallDays || 30));
          p.set('fall_pct',  String(parseFloat((f.fallPct / 100).toFixed(4))));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ SH Filters (Public/FII/DII/Promoter) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
        if (f.shFilters && f.shFilters.length) {
          var sh = f.shFilters.map(function(s) {
            return { bucket: s.bucket, mode: s.mode, window: s.window,
                     label: s.label, band: s.bandLo + '-' + s.bandHi };
          });
          p.set('sh_filters', JSON.stringify(sh));
        }

        // Ã¢â€â‚¬Ã¢â€â‚¬ Form Your Own Candle (cb_groups) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

        // Ã¢â€â‚¬Ã¢â€â‚¬ Consolidation (cp_filters) Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
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

  // Algo scan Ã¢â‚¬â€ apply entry criteria and calculate prices
  if (parsedUrl.pathname === '/algo-scan' && req.method === 'POST') {
    getBody(({ symbols, screenerStocks, entryFilters, slMethod, slPct, slIndicator, slIndicatorPct, emaTrailingEnabled, emaTrailingIndicator, emaTrailingPct, emaTrailingTimeframe, emaTrailingTrigger, rrRatio, capitalPerTrade, sectorFilters, industryFilters, priceMin, priceMax }) => {
      const filteredStocks = filterStocksBySectorIndustry(screenerStocks || [], sectorFilters, industryFilters);
      const hasFilters = (Array.isArray(sectorFilters) && sectorFilters.length) || (Array.isArray(industryFilters) && industryFilters.length);
      const filteredSymbols = hasFilters ? extractSymbolsFromStocks(filteredStocks) : symbols;
      fetchTVData(filteredSymbols, (err, tvData) => {
        if (err) return sendJSON({ ok: false, error: err });
        const results = buildAlgoCandidates(tvData, { screenerStocks: filteredStocks.length ? filteredStocks : screenerStocks, entryFilters, slMethod, slPct, slIndicator, slIndicatorPct, emaTrailingEnabled, emaTrailingIndicator, emaTrailingPct, emaTrailingTimeframe, emaTrailingTrigger, rrRatio, capitalPerTrade, priceMin, priceMax });

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
        const brokerFields = {
          angelOneEntryOrderId: result?.angelOneEntryOrderId || '',
          angelOneSlRuleId: result?.angelOneSlRuleId || '',
          angelOneTargetOrderId: result?.angelOneTargetOrderId || '',
          softwareTargetOrder: !!result?.softwareTargetOrder,
          softwareTargetTrailing: !!result?.softwareTargetTrailing,
        };
        sendJSON(err
          ? { ok: false, error: err, data: result?.data || null, status: result?.status || 400, request: result?.request || null, ...brokerFields }
          : { ok: true, data: result.data, status: result.status, request: result.request || null, ...brokerFields });
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
  if (parsedUrl.pathname === '/oracle-stockkar-template.zip') return serveStaticFile(res, 'oracle-stockkar-template.zip', 'application/zip');
  if (parsedUrl.pathname === '/google-cloud-stockkar-template.zip') return serveStaticFile(res, 'google-cloud-stockkar-template.zip', 'application/zip');

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
    checkAngelOneSoftwareTargets();
    checkMtmRules();
    checkAlgoScreenerRefresh();
    setInterval(checkMtmRules, 60 * 1000);
    setInterval(checkAlgoScreenerRefresh, 3 * 60 * 1000);
    setInterval(reconcileBrokerOrders, 5 * 60 * 1000);
    setInterval(checkBackendSchedule, 30000);
    setInterval(checkDhanTokenRenewal, 60000);
    setInterval(checkBrokerTokenRenewal, 60000);
    setInterval(checkDailyEmaTrailing, 10 * 60 * 1000);
    setInterval(checkEmaTrailingTargetTriggers, 3 * 60 * 1000);
    setInterval(checkAndRestoreBrokerStops, 2 * 60 * 1000);
    setInterval(checkAngelOneSoftwareTargets, 3 * 60 * 1000);
    setInterval(checkSavedScreenerMonitors, 5 * 60 * 1000);
  });
}

module.exports = handleRequest;


