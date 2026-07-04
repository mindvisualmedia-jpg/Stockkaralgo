const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const PACKAGE = require('./package.json');
const { computeMtmActions, computeMtmPlan, hasMtmRules, planExitOps, computeSplitBracket, resolveSplitExit, resolveSplitFromFills } = require('./mtm');

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
// Daily EMA snapshots per symbol, so "EMA crossover in last N days" needs NO
// extra fetch - we reuse the EMAs the scan already pulls and compare days.
const EMA_HISTORY_FILE = path.join(DATA_DIR, 'ema_history.json');
const EMA_HISTORY_KEEP_DAYS = 8;
const EMA_CROSS_PERIODS = [5, 9, 20, 21, 33, 50, 100, 200];
// No-secret "timed reset" wait; logging in cancels it. Per-box overrides:
// STOCKKAR_PIN_RESET_DELAY_MINUTES (takes precedence), else
// STOCKKAR_PIN_RESET_DELAY_HOURS.
// *** TEMPORARY ***: global default lowered from 24h to 5 minutes per request.
// SECURITY: a 5-minute window lets anyone with page access reset the PIN and
// take over the app. Revert the default below to 24 * 60 * 60 * 1000 (24h)
// when the temporary period ends.
const APP_LOCK_RESET_DELAY_MS = (() => {
  const mins = Number(process.env.STOCKKAR_PIN_RESET_DELAY_MINUTES);
  if (Number.isFinite(mins) && mins > 0) return mins * 60 * 1000;
  const hrs = Number(process.env.STOCKKAR_PIN_RESET_DELAY_HOURS);
  if (Number.isFinite(hrs) && hrs > 0) return hrs * 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000; // 24h default (env vars above can override per-box)
})();
// Human label for the configured wait (used in UI copy so it isn't hardcoded 24h).
function appLockResetDelayLabel() {
  const mins = Math.round(APP_LOCK_RESET_DELAY_MS / 60000);
  if (mins < 60) return mins + ' minute' + (mins === 1 ? '' : 's');
  const hrs = Math.round(mins / 60);
  return hrs + ' hour' + (hrs === 1 ? '' : 's');
}
const SAVED_MONITORS_FILE = path.join(DATA_DIR, 'saved_screener_monitors.json');
const MTM_SETTINGS_FILE = path.join(DATA_DIR, 'mtm_settings.json');
const TELEGRAM_FILE = path.join(DATA_DIR, 'telegram.json');
const FREE_TIER_LIMITS = {
  maxAlgoJobs: Math.max(1, Number(process.env.STOCKKAR_MAX_ALGO_JOBS || 10)),
  maxSavedMonitors: Math.max(1, Number(process.env.STOCKKAR_MAX_SAVED_MONITORS || 20)),
  maxStocksPerAlgo: Math.max(1, Number(process.env.STOCKKAR_MAX_STOCKS_PER_ALGO || 250)),
  maxOrderLogRows: Math.max(100, Number(process.env.STOCKKAR_MAX_ORDER_LOG_ROWS || 1000)),
  orderLogRetentionDays: Math.max(1, Number(process.env.STOCKKAR_ORDER_LOG_RETENTION_DAYS || 30)),
  minCheckEveryMinutes: Math.max(1, Number(process.env.STOCKKAR_MIN_CHECK_EVERY_MINUTES || 3)),
};
const ORDER_LOG_RETENTION_DAYS = FREE_TIER_LIMITS.orderLogRetentionDays;
const DHAN_TOKEN_VALIDITY_HOURS = Number(process.env.DHAN_TOKEN_VALIDITY_HOURS || 24);
const DHAN_RENEW_HOUR_IST = Number(process.env.DHAN_RENEW_HOUR_IST || 16);
const DHAN_RENEW_MINUTE_IST = Number(process.env.DHAN_RENEW_MINUTE_IST || 0);
// Daily Dhan auto-renew slots (IST, HH:MM). Defaults to a 7 AM pre-open refresh
// and a 5 PM post-close refresh. Each slot renews at most once per day.
const DHAN_RENEW_TIMES_IST = String(process.env.DHAN_RENEW_TIMES_IST || '07:00,17:00')
  .split(',').map(s => s.trim()).filter(t => /^\d{1,2}:\d{2}$/.test(t))
  .sort((a, b) => {
    const [ah, am] = a.split(':').map(Number); const [bh, bm] = b.split(':').map(Number);
    return (ah * 60 + am) - (bh * 60 + bm);
  });
const EMA_TRAILING_CHECK_HOUR_IST = Number(process.env.EMA_TRAILING_CHECK_HOUR_IST || 15);
const EMA_TRAILING_CHECK_MINUTE_IST = Number(process.env.EMA_TRAILING_CHECK_MINUTE_IST || 45);
const BROKER_TOKEN_VALIDITY_HOURS = { dhan: DHAN_TOKEN_VALIDITY_HOURS, upstox: 24, angelone: 24, fyers: 24 };
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

// A Secure cookie is dropped by the browser over plain HTTP, so the session
// never sticks. We omit Secure when the connection can't be HTTPS:
//  - localhost / 127.0.0.1
//  - a BARE IP host (e.g. 13.207.12.97:7777) — a public IP can't have a TLS cert,
//    so it's plain HTTP. (A real domain like *.nip.io served over HTTPS keeps
//    Secure.) This auto-handles staging boxes without depending on an env flag
//    surviving restarts.
//  - explicit override STOCKKAR_INSECURE_COOKIE=1
const ALLOW_INSECURE_COOKIE = process.env.STOCKKAR_INSECURE_COOKIE === '1';
function appCookieFlags(req) {
  const host = String(req.headers.host || '');
  const isLocal = host.startsWith('localhost') || host.startsWith('127.0.0.1');
  const isBareIp = /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?$/.test(host);
  const omitSecure = isLocal || isBareIp || ALLOW_INSECURE_COOKIE;
  return 'HttpOnly; SameSite=Strict; Path=/; ' + (omitSecure ? '' : 'Secure; ');
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
  // Private repo: read main's package.json via the GitHub API with a read-only
  // token (STOCKKAR_GITHUB_TOKEN), so the "update available" banner works without
  // making the repo public. Falls back to the public raw URL when no token is set.
  const token = process.env.STOCKKAR_GITHUB_TOKEN || '';
  const base = token
    ? (process.env.STOCKKAR_UPDATE_API_URL || 'https://api.github.com/repos/mindvisualmedia-jpg/Stockkaralgo/contents/package.json?ref=main')
    : UPDATE_REPO_PACKAGE_URL;
  const versionUrl = base + (base.includes('?') ? '&' : '?') + 't=' + Date.now();
  const headers = { 'User-Agent': 'Stockkar-Updater', 'Cache-Control': 'no-cache' };
  if (token) { headers['Authorization'] = 'token ' + token; headers['Accept'] = 'application/vnd.github.raw'; }
  https.get(versionUrl, { headers }, response => {
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
    // Private single-tenant app: keep every page out of search engines.
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex, nofollow, noarchive' });
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
    if (filter.type === 'cross' || filter.indicator === 'cross') {
      return 'EMA ' + (filter.fast || 9) + ' x EMA ' + (filter.slow || 21) + ' cross-up (' + (filter.lookbackDays || 3) + 'd)';
    }
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
    // Preserve EVERY field on the row (jobId, dhanProtection, dhanForeverId,
    // splitT1/leg ids, mtm* flags, costPct/t1Pct/t2Pct, etc.). This used to be a
    // strict whitelist that silently dropped those on every read/write - which
    // broke the open-position count/cap, the Forever reconcile, split tracking
    // and MTM state. The explicit fields below still normalise/default the
    // standard ones on top of the spread.
    ...entry,
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
    // Corrupt/missing main file: fall back to the last-good backup instead of
    // returning [] — an empty read followed by any write would make the loss
    // PERMANENT (the log is the app's memory; every safety layer reads it).
    try {
      const bak = JSON.parse(fs.readFileSync(ORDER_LOG_FILE + '.bak', 'utf8'));
      console.log('[ORDER-LOG] main file unreadable — recovered from .bak (' + (Array.isArray(bak) ? bak.length : 0) + ' rows)');
      return pruneOrderLog(Array.isArray(bak) ? bak : bak.orders);
    } catch { return []; }
  }
}

function writeOrderLog(entries) {
  // ATOMIC write: temp file + rename, so a crash mid-write can never leave a
  // half-written log. The previous good file survives as .bak (read fallback).
  const data = JSON.stringify(pruneOrderLog(entries), null, 2);
  const tmp = ORDER_LOG_FILE + '.tmp';
  fs.writeFileSync(tmp, data);
  try { fs.renameSync(ORDER_LOG_FILE, ORDER_LOG_FILE + '.bak'); } catch {} // first-ever write has no main yet
  fs.renameSync(tmp, ORDER_LOG_FILE);
}

function appendOrderLog(entries) {
  const rows = Array.isArray(entries) ? entries : [entries];
  const next = pruneOrderLog([...rows.map(normalizeOrderLogEntry), ...readOrderLog()]);
  writeOrderLog(next);
  return next;
}

// Read-modify-write a single order-log row by id. Used by the protect-after-fill
// reconcile so each placement updates only its own row (others may be changing
// concurrently across reconcile tasks). `fn(row)` returns the replacement row.
function updateOrderLogRow(id, fn) {
  let found = false;
  const next = readOrderLog().map(e => { if (e.id === id) { found = true; return fn(e); } return e; });
  if (found) writeOrderLog(next);
  return found;
}

// SINGLE-WRITER RULE for the order log: every mutation must be an ATOMIC
// read-modify-write with no async gap — either updateOrderLogRow (one row) or
// mutateOrderLog (whole log). Node is single-threaded, so a synchronous
// read→transform→write cannot interleave with another writer. What is NOT safe
// is reading the log, awaiting a broker call, then writing rows derived from
// the stale read — that clobbers concurrent updates. Compute your DECISIONS
// during the async work; apply them through one of these two helpers.
function mutateOrderLog(fn) {
  const next = fn(readOrderLog());
  if (Array.isArray(next)) { writeOrderLog(next); return next; }
  return null;
}

// PROTECT AFTER FILL (kill-switch STOCKKAR_PROTECT_AFTER_FILL=1): place ONLY the
// entry order at scan time; the protective Forever (Dhan) / GTT (Zerodha) is
// placed once the entry actually FILLS, via the reconcile poller. This prevents
// (a) a naked position when a pending LIMIT entry fills later with no stop, and
// (b) an orphaned protective SELL when the entry is rejected (e.g. no funds).
// OFF by default so production behaviour (protect on acceptance) is unchanged.
const PROTECT_AFTER_FILL = process.env.STOCKKAR_PROTECT_AFTER_FILL === '1';

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

// A "hard" rejection is one that will keep failing for the rest of the day, so
// the symbol should be parked (not retried this session): trade ban / ASM-GSM
// freeze, circuit limit hit, or insufficient funds/margin. Anything else (a
// transient rate-limit, a fat-finger price reject, a momentary broker 5xx) is
// "soft" and stays eligible for the next scan to retry.
function isHardRejectReason(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  return /(ban|banned|freeze|frozen|asm|gsm|circuit|upper\s*limit|lower\s*limit|price\s*band|insufficient|margin\s*shortfall|funds|not\s*allowed|blocked|surveillance|t2t|trade\s*to\s*trade|invalid\s*quantity|lot\s*size|quantity\s*freeze)/.test(t);
}

function isOpenOrderLogEntry(entry) {
  const statusText = String(entry.status || '').toUpperCase();
  const resultText = String(entry.exitType || entry.result || '').toUpperCase();
  if (['ERROR', 'SKIPPED', 'N/A'].includes(String(entry.orderId || '').toUpperCase())) return false;
  if (entry.manualClose) return false;
  // "Entry placed but ... protection FAILED" = the BUY filled (position is OPEN),
  // only the stop didn't place. It MUST count as open (for the position cap +
  // display + recovery); the "FAILED" is about the stop, not the position.
  if (/^ENTRY PLACED BUT/.test(statusText)) return true;
  if (/(TARGET HIT|SL HIT|REJECT|CANCEL|FAILED|FAIL|INVALID|EXITED|CLOSED)/.test(statusText + ' ' + resultText)) return false;
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
      const orphans = []; // newly-rejected entries: cancel the orphaned GTT (+ halt on funds)
      const next = readOrderLog().map(entry => {
        if (String(entry.broker || '').toLowerCase() !== 'zerodha' || !entry.orderId || ['N/A', 'ERROR', 'SKIPPED'].includes(entry.orderId)) return entry;
        if (entry.awaitingFill) return entry; // protect-after-fill handles the entry-fill -> GTT step itself
        if (entry.splitT1) return entry; // split rows handled by the split-aware reconcile
        const inferred = inferZerodhaExitFromOrderBook(entry, ordersRes.data, gttRes?.data || []);
        // Entry rejected (e.g. async insufficient funds) -> the GTT is orphaned
        // (resting SELL with no position = naked-short risk). Cancel it + halt.
        if (inferred.exitType === 'REJECTED' && entry.exitType !== 'REJECTED') {
          orphans.push({ gttId: parseZerodhaOrderIds(entry.orderId).gttId, jobId: entry.jobId || '', reason: inferred.rejectionReason || '' });
        }
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
      // Cancel orphaned GTTs (best-effort) + halt the algo on a funds/margin reject.
      orphans.forEach(o => {
        if (o.gttId) zerodhaCancelGtt(o.gttId, () => {});
        if (/insufficient|funds|margin|low\s*balance/i.test(o.reason)) haltAlgoJobForError(o.jobId, o.reason || 'Insufficient funds');
      });
      callback(null, { changed, data: next });
    });
  });
}

// Reconcile "split T1 at broker" Zerodha holds (two two-leg GTTs). Mirrors the
// Dhan split reconcile: legA target (T1) -> move legB SL to cost; legB resolved
// -> close with combined P&L. Per-leg state comes from each GTT's fired leg
// (inferZerodhaGttLeg). Conservative: unknown/pending -> leave OPEN.
function refreshZerodhaSplitOrderLogStatus(callback) {
  const isSplitOpen = e => String(e.broker || '').toLowerCase() === 'zerodha' && e.splitT1 && e.zerodhaSplit && isOpenOrderLogEntry(e);
  if (!readOrderLog().some(isSplitOpen)) return callback(null, { changed: 0 });
  const store = readBrokerTokenStore().brokers.zerodha;
  if (!store?.clientId || !store?.accessToken) return callback('No Zerodha token saved');
  kiteGet('/gtt/triggers', store.clientId, store.accessToken, (gErr, gttRes) => {
    if (gErr) return callback('Zerodha split status failed: ' + gErr);
    const gtts = kiteRows(gttRes?.data || []);
    const findGtt = id => gtts.find(t => String(t.id || t.trigger_id || t.triggerId || '') === String(id || '').trim());
    const resolve = (gttId) => {
      const id = String(gttId || '').trim();
      if (!id) return { state: 'absent', px: 0 };
      const g = findGtt(id);
      if (!g) return { state: 'absent', px: 0 };          // vanished -> unknown, stay open
      const leg = inferZerodhaGttLeg(g);
      if (leg && leg.exitType === 'TARGET HIT') return { state: 'target', px: Number.isFinite(leg.exitPrice) ? leg.exitPrice : 0 };
      if (leg && leg.exitType === 'SL HIT') return { state: 'sl', px: Number.isFinite(leg.exitPrice) ? leg.exitPrice : 0 };
      if (/(cancel|delete|reject|expire)/.test(String(g.status || '').toLowerCase())) return { state: 'gone', px: 0 };
      return { state: 'pending', px: 0 };                  // active / triggered-not-filled
    };
    const checkedAt = new Date().toISOString();
    let changed = 0;
    const costMoves = [];
    const next = readOrderLog().map(entry => {
      if (!isSplitOpen(entry)) return entry;
      const entryPx = Number(entry.entryPrice || entry.price || 0);
      const aQty = Number(entry.splitLegAQty || 0), bQty = Number(entry.splitLegBQty || 0);
      const t1Pct = Number(entry.t1Pct || 0);
      const t1Px = t1Pct > 0 ? Number((entryPx * (1 + t1Pct / 100)).toFixed(2)) : Number(entry.targetPrice || 0);
      const slPx = Number(entry.slPrice || 0), t2Px = Number(entry.targetPrice || 0);
      let A = resolve(entry.zerodhaGttT1Id); const B = resolve(entry.zerodhaGttId);
      // Broker-truth T1 book (parity with Dhan): if T1's GTT has vanished while the
      // runner's GTT is STILL live/pending, T1 can only have hit TARGET — a shared-SL
      // hit would have closed the runner too. Ticks T1 + moves SL->cost DURING the
      // trade, even if the fired GTT was deleted before we polled it.
      if (A.state === 'absent' && B.state === 'pending') A = { state: 'target', px: t1Px };
      let patch = { lastStatusCheckAt: checkedAt };
      if (A.state === 'target') {
        if (!entry.mtmT1Done) { patch.mtmT1Done = true; patch.t1BookedAt = checkedAt; patch.splitT1Pnl = (entryPx && aQty) ? Number((((A.px || t1Px) - entryPx) * aQty).toFixed(2)) : ''; changed++; }
        if (!entry.splitCostDone) costMoves.push(entry.id);
      }
      const decision = resolveSplitExit({ aState: A.state, aPx: A.px, bState: B.state, bPx: B.px, entryPrice: entryPx, slPrice: slPx, t2Price: t2Px, t1Price: t1Px, aQty, bQty });
      if (decision.closed) { changed++; return { ...entry, ...patch, status: 'ZERODHA ' + decision.exitType + ' (split)', exitType: decision.exitType, exitPrice: decision.exitPrice > 0 ? decision.exitPrice : '', realisedPnl: decision.realisedPnl }; }
      if (B.state === 'gone') { patch.reconcileNote = 'Runner GTT gone - re-arm a stop in Zerodha'; patch.lastTrailError = 'GTT gone'; changed++; }
      return { ...entry, ...patch };
    });
    writeOrderLog(next);
    if (!costMoves.length) return callback(null, { changed });
    let i = 0;
    const doNext = () => {
      if (i >= costMoves.length) return callback(null, { changed });
      const id = costMoves[i++];
      const row = readOrderLog().find(r => r.id === id);
      if (!row || row.splitCostDone || !isOpenOrderLogEntry(row)) return doNext();
      const entryPx = Number(row.entryPrice || row.price || 0);
      // Rebuild legB GTT as (runner qty, SL=cost, target=T2).
      zerodhaModifyGttRemainder(row, Number(row.splitLegBQty || 0), entryPx, Number(row.targetPrice || 0), (mErr) => {
        if (!mErr) { const rows2 = readOrderLog().map(r => r.id === id ? { ...r, splitCostDone: true, mtmCostDone: true, slPrice: entryPx, brokerSlPrice: entryPx } : r); writeOrderLog(rows2); }
        doNext();
      });
    };
    doNext();
  });
}

let _zerodhaHeldCache = { at: 0, set: null };
function fetchZerodhaHeldSymbols(callback) {
  if (_zerodhaHeldCache.set && Date.now() - _zerodhaHeldCache.at < 30000) return callback(null, _zerodhaHeldCache.set);
  const store = readBrokerTokenStore().brokers.zerodha;
  if (!store?.clientId || !store?.accessToken) return callback('No Zerodha token', null);
  const norm = s => String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const add = (set, sym, qty) => { const s = norm(sym); if (s && Number(qty) > 0) set.add(s); };
  kiteGet('/portfolio/holdings', store.clientId, store.accessToken, (hErr, hRes) => {
    if (hErr) return callback(hErr, null);
    kiteGet('/portfolio/positions', store.clientId, store.accessToken, (pErr, pRes) => {
      if (pErr) return callback(pErr, null);
      const set = new Set();
      // quantity + t1_quantity: unsettled CNC (bought yesterday) sits in t1_quantity —
      // "not held" is closure evidence, so unsettled must still count as held.
      kiteRows(hRes?.data).forEach(h => add(set, h.tradingsymbol || h.trading_symbol,
        (Number(h.quantity) || 0) + (Number(h.t1_quantity) || 0) || (Number(h.opening_quantity) || 0)));
      const net = Array.isArray(pRes?.data?.net) ? pRes.data.net : kiteRows(pRes?.data);
      net.forEach(p => add(set, p.tradingsymbol || p.trading_symbol, p.quantity ?? p.net_quantity ?? 0));
      _zerodhaHeldCache = { at: Date.now(), set };
      callback(null, set);
    });
  });
}

// Broker-truth close for Zerodha splits — the mirror of closeCompletedDhanForevers.
// When a GTT fires and is later deleted, resolveSplitExit can't see it, so a fully
// exited split can sit stuck OPEN. Here: if BOTH of a split's GTT ids are GONE from
// /gtt/triggers AND the symbol is NO LONGER held (holdings+positions) -> it closed at
// the broker; reconstruct T1/T2 + realised P&L from the SELL fills. FAIL-SAFE: aborts
// on a GTT-list or holdings fetch error, and only closes when confirmed not-held.
function closeCompletedZerodhaGtts(callback) {
  const norm = s => String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const isOpenSplit = e => String(e.broker || '').toLowerCase() === 'zerodha'
    && e.splitT1 && e.zerodhaSplit && !e.awaitingFill && !e.testMode && e.source !== 'test' && isOpenOrderLogEntry(e);
  if (!readOrderLog().some(isOpenSplit)) return callback(null, { changed: 0 });
  const store = readBrokerTokenStore().brokers.zerodha;
  if (!store?.clientId || !store?.accessToken) return callback('No Zerodha token saved');
  kiteGet('/gtt/triggers', store.clientId, store.accessToken, (gErr, gRes) => {
    if (gErr) return callback('Zerodha GTT list failed: ' + gErr);          // can't confirm gone -> abort (safe)
    const activeIds = new Set(kiteRows(gRes?.data).map(t => String(t.id || t.trigger_id || t.triggerId || '').trim()).filter(Boolean));
    kiteGet('/orders', store.clientId, store.accessToken, (oErr, oRes) => {
      const orders = oErr ? [] : kiteRows(oRes?.data);                       // no order book -> exit price estimated
      fetchZerodhaHeldSymbols((hErr, heldSet) => {
        if (hErr || !heldSet) return callback('Zerodha holdings failed: ' + (hErr || 'none'));  // never false-close
        const sellsBySym = {};
        orders.forEach(o => {
          const side = String(o.transaction_type || o.transactionType || '').toUpperCase();
          const status = String(o.status || '').toUpperCase();
          if (side !== 'SELL' || !/COMPLETE|TRADED|FILLED/.test(status)) return;
          const sym = norm(o.tradingsymbol || o.trading_symbol || o.symbol);
          const q = Number(o.filled_quantity || o.filledQuantity || o.quantity || 0);
          const px = Number(o.average_price || o.averagePrice || o.price || 0);
          if (!sym || !q || !px) return;
          (sellsBySym[sym] = sellsBySym[sym] || []).push({ q, px });
        });
        let changed = 0;
        const at = new Date().toISOString();
        const next = readOrderLog().map(e => {
          if (!isOpenSplit(e)) return e;
          const gids = [];
          [e.zerodhaGttId, e.zerodhaGttT1Id].forEach(v => { if (v) gids.push(String(v).trim()); });
          const pid = parseZerodhaOrderIds(e.orderId); if (pid.gttId) gids.push(String(pid.gttId).trim());
          const sym = norm(e.symbol);
          if (gids.some(id => activeIds.has(id)) || heldSet.has(sym)) return e;   // GTT still active OR still held -> not closed
          // Both GTTs gone AND not held -> closed at the broker. Reconstruct the exit.
          const entry = Number(e.entryPrice || e.price || 0);
          const qty = Number(e.qty || 0);
          const target = Number(e.targetPrice || 0);
          const slBase = Number(e.brokerSlPrice || e.slPrice || 0);
          const sells = sellsBySym[sym] || [];
          let pnl = 0, soldQty = 0;
          sells.forEach(s => { soldQty += s.q; pnl += (s.px - entry) * s.q; });
          // CROSS-DAY SPLIT: the order book is TODAY-only, so a T1 leg booked on an
          // earlier day is missing from today's sells — add its recorded P&L back.
          if (e.splitT1 && e.mtmT1Done && soldQty > 0 && soldQty < qty && Number(e.splitT1Pnl)) pnl += Number(e.splitT1Pnl);
          const estimated = soldQty <= 0;
          const maxSell = sells.length ? Math.max(...sells.map(s => s.px)) : 0;
          const minSell = sells.length ? Math.min(...sells.map(s => s.px)) : 0;
          const exitPx = maxSell || (target > 0 ? target : slBase);
          const realisedPnl = estimated ? (entry && qty ? Number(((exitPx - entry) * qty).toFixed(2)) : '') : Number(pnl.toFixed(2));
          const flags = {};   // split-aware T1/T2 flags so the log reads like Test Mode
          const t1Pct = Number(e.t1Pct || 0);
          const t1Px = t1Pct > 0 ? entry * (1 + t1Pct / 100) : target;
          const t2Hit = target > 0 && maxSell >= target * 0.999;
          const t1Hit = (t1Px > 0 && sells.some(s => s.px >= t1Px * 0.995)) || (t2Hit && sells.length >= 2);
          if (t1Hit && !e.mtmT1Done) { flags.mtmT1Done = true; flags.t1BookedAt = at; }
          if (t2Hit) flags.mtmT2Done = true;
          const exitType = t2Hit ? 'TARGET HIT'
            : (slBase > 0 && minSell > 0 && minSell <= slBase * 1.001) ? 'SL HIT' : 'EXITED';
          changed++;
          return { ...e, ...flags, exitType, exitPrice: roundPrice(exitPx), realisedPnl, exitEstimated: estimated,
            status: 'ZERODHA ' + exitType + ' (split)', lastStatusCheckAt: at, reconciledAt: at, unrealisedPnl: undefined };
        });
        if (changed) writeOrderLog(next);
        callback(null, { changed });
      });
    });
  });
}

// RECHECK Zerodha GTT protection is actually LIVE — the mirror of
// verifyDhanForeverProtection. Kite accepts a GTT POST and validates via RMS, so a
// GTT can be rejected after we recorded its id (T2T stocks reject the same-day
// SELL). If the entry is still HELD but no active GTT guards the symbol and it
// hasn't been sold -> flag UNPROTECTED, clear any false SL->cost tick, and alert.
// Two-strike grace; FAIL-SAFE aborts on any fetch error; only flags when confirmed
// still held AND not sold.
function verifyZerodhaGttProtection(callback) {
  const norm = s => String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const isCand = e => String(e.broker || '').toLowerCase() === 'zerodha'
    && !e.awaitingFill && !e.testMode && e.source !== 'test' && !e.protectionUnverified
    && (e.zerodhaSplit || e.zerodhaGttId || e.zerodhaGttT1Id || parseZerodhaOrderIds(e.orderId).gttId)
    && isOpenOrderLogEntry(e);
  if (!readOrderLog().some(isCand)) return callback(null, { flagged: 0 });
  const store = readBrokerTokenStore().brokers.zerodha;
  if (!store?.clientId || !store?.accessToken) return callback('No Zerodha token saved');
  kiteGet('/gtt/triggers', store.clientId, store.accessToken, (gErr, gRes) => {
    if (gErr) return callback('Zerodha GTT list failed: ' + gErr);           // can't verify -> abort (safe)
    // Protected iff one of the row's OWN GTT ids is still present and non-terminal.
    const activeIds = new Set();
    kiteRows(gRes?.data).forEach(g => {
      const st = String(g.status || '').toUpperCase();
      if (/REJECT|CANCEL|DELETE|EXPIRE|DISABLE/.test(st)) return;             // terminal-dead -> not protecting
      const id = String(g.id || g.trigger_id || g.triggerId || '').trim(); if (id) activeIds.add(id);
    });
    kiteGet('/orders', store.clientId, store.accessToken, (oErr, oRes) => {
      const orders = oErr ? [] : kiteRows(oRes?.data);
      const soldSyms = new Set();
      orders.forEach(o => {
        const side = String(o.transaction_type || o.transactionType || '').toUpperCase();
        const st = String(o.status || '').toUpperCase();
        if (side === 'SELL' && /COMPLETE|TRADED|FILLED/.test(st)) { const s = norm(o.tradingsymbol || o.trading_symbol || o.symbol); if (s) soldSyms.add(s); }
      });
      fetchZerodhaHeldSymbols((hErr, heldSet) => {
        if (hErr || !heldSet) return callback('Zerodha holdings failed: ' + (hErr || 'none'));  // never false-flag
        const now = Date.now();
        let flagged = 0;
        readOrderLog().filter(isCand).forEach(e => {
          const sym = norm(e.symbol);
          const gids = [];
          [e.zerodhaGttId, e.zerodhaGttT1Id].forEach(v => { if (v) gids.push(String(v).trim()); });
          const pg = parseZerodhaOrderIds(e.orderId); if (pg.gttId) gids.push(String(pg.gttId).trim());
          const protectedNow = gids.some(id => activeIds.has(id));
          const held = heldSet.has(sym);
          const exited = soldSyms.has(sym);
          if (!(held && !protectedNow && !exited)) {
            if (e.protectionCheckFirstAt) updateOrderLogRow(e.id, r => ({ ...r, protectionCheckFirstAt: '' }));
            return;
          }
          if (!e.protectionCheckFirstAt) { updateOrderLogRow(e.id, r => ({ ...r, protectionCheckFirstAt: new Date().toISOString() })); return; }
          if (now - (Date.parse(e.protectionCheckFirstAt) || now) < PROTECTION_RECHECK_GRACE_MS) return;
          updateOrderLogRow(e.id, r => ({ ...r,
            protectionUnverified: true, mtmCostDone: false, splitCostDone: false,
            reconcileNote: 'GTT protection was REJECTED at the broker (e.g. a T2T stock — same-day SELL not allowed). NO stop is live. Add a manual stop in Zerodha.',
            lastTrailError: 'Protection rejected — no live stop',
            status: 'ZERODHA ⚠ UNPROTECTED — GTT rejected, add manual stop' }));
          sendTelegram('🔴 <b>Stockkar — ' + (e.symbol || '') + ' has NO live stop</b>\nThe protective GTT was rejected at Zerodha (often a T2T stock — same-day SELL is not permitted). <b>Add a manual stop now.</b>', () => {});
          flagged++;
        });
        callback(null, { flagged });
      });
    });
  });
}

// ---- FYERS reconcile: infer exits from the order book (GTT fires a SELL) -----
function fyersOrderRows(payload) {
  return Array.isArray(payload) ? payload :
    Array.isArray(payload?.orderBook) ? payload.orderBook :
    Array.isArray(payload?.data) ? payload.data : [];
}
function inferFyersExit(entry, orderBook) {
  const symKey = String(entry.symbol || '').replace(/^(NSE|BSE):/i, '').replace('-EQ', '').replace(/\s/g, '').toUpperCase();
  // A filled SELL order on this symbol = the GTT (or a software exit) fired.
  const sells = (orderBook || []).filter(o => {
    const s = String(o.symbol || '').replace(/^(NSE|BSE):/i, '').replace('-EQ', '').toUpperCase();
    return s === symKey && Number(o.side) === -1 && Number(o.status) === 2; // sell, traded
  });
  if (!sells.length) return {};
  const exit = sells[sells.length - 1];
  const exitPrice = Number(exit.tradedPrice || exit.avgPrice || exit.limitPrice || 0);
  const entryPrice = Number(entry.entryPrice || entry.price || 0);
  const qty = Number(entry.qty || 0);
  const target = Number(entry.targetPrice || 0), sl = Number(entry.slPrice || 0);
  let exitType = 'EXITED';
  if (Number.isFinite(exitPrice) && exitPrice > 0) {
    if (target && exitPrice >= target * 0.999) exitType = 'TARGET HIT';
    else if (sl && exitPrice <= sl * 1.001) exitType = 'SL HIT';
  }
  const realisedPnl = (Number.isFinite(exitPrice) && entryPrice && qty) ? Number(((exitPrice - entryPrice) * qty).toFixed(2)) : '';
  return {
    exitType,
    exitPrice: Number.isFinite(exitPrice) && exitPrice > 0 ? Number(exitPrice.toFixed(2)) : '',
    realisedPnl, rawStatus: 'FYERS ' + exitType, exitOrderId: String(exit.id || ''),
  };
}
function refreshFyersOrderLogStatus(callback) {
  const store = readBrokerTokenStore().brokers.fyers;
  const status = getBrokerTokenStatus('fyers');
  if (!store?.clientId || !store?.accessToken) return callback('No FYERS token saved');
  if (status.status === 'expired') return callback('FYERS token expired. Reconnect in Settings.');
  fyersTradeRequest('GET', '/orders', null, (err, res) => {
    if (err) return callback('FYERS order status failed: ' + err);
    if (!res || res.status >= 400) return callback('FYERS order status failed: ' + fyersApiMsg(res, 'HTTP ' + res?.status));
    const orderBook = fyersOrderRows(res.data);
    let changed = 0;
    const checkedAt = new Date().toISOString();
    const next = readOrderLog().map(entry => {
      if (String(entry.broker || '').toLowerCase() !== 'fyers' || !isOpenOrderLogEntry(entry)) return entry;
      if (entry.splitT1) return entry; // split rows handled by the split-aware reconcile
      const inferred = inferFyersExit(entry, orderBook);
      if (!inferred.exitType) return { ...entry, lastStatusCheckAt: checkedAt };
      changed += 1;
      return { ...entry, status: inferred.rawStatus || entry.status, exitType: inferred.exitType, exitPrice: inferred.exitPrice, realisedPnl: inferred.realisedPnl, exitOrderId: inferred.exitOrderId || entry.exitOrderId || '', lastStatusCheckAt: checkedAt };
    });
    writeOrderLog(next);
    callback(null, { changed, data: next });
  });
}

// Reconcile "split T1 at broker" FYERS holds (two GTT OCOs). FYERS only exposes
// filled SELLs in the order book (no per-GTT leg status), so we resolve from the
// fills: a profit-priced partial fill -> T1 booked -> move legB SL to cost; total
// sold == full qty -> close with summed P&L. Conservative: partial/none -> OPEN.
function refreshFyersSplitOrderLogStatus(callback) {
  const isSplitOpen = e => String(e.broker || '').toLowerCase() === 'fyers' && e.splitT1 && e.fyersSplit && isOpenOrderLogEntry(e);
  if (!readOrderLog().some(isSplitOpen)) return callback(null, { changed: 0 });
  const store = readBrokerTokenStore().brokers.fyers;
  if (!store?.clientId || !store?.accessToken) return callback('No FYERS token saved');
  fyersTradeRequest('GET', '/orders', null, (err, res) => {
    if (err) return callback('FYERS split status failed: ' + err);
    if (!res || res.status >= 400) return callback('FYERS split status failed: ' + fyersApiMsg(res, 'HTTP ' + res?.status));
    const orderBook = fyersOrderRows(res.data);
    const checkedAt = new Date().toISOString();
    let changed = 0;
    const costMoves = [];
    const clean = s => String(s || '').replace(/^(NSE|BSE):/i, '').replace('-EQ', '').replace(/\s/g, '').toUpperCase();
    const next = readOrderLog().map(entry => {
      if (!isSplitOpen(entry)) return entry;
      const symKey = clean(entry.symbol);
      const fills = (orderBook || [])
        .filter(o => clean(o.symbol) === symKey && Number(o.side) === -1 && Number(o.status) === 2)
        .map(o => ({ qty: Number(o.filledQty || o.tradedQty || o.qty || 0), price: Number(o.tradedPrice || o.avgPrice || o.limitPrice || 0) }));
      const entryPx = Number(entry.entryPrice || entry.price || 0);
      const r = resolveSplitFromFills(fills, { entryPrice: entryPx, bookQty: Number(entry.splitLegAQty || 0), runnerQty: Number(entry.splitLegBQty || 0) });
      let patch = { lastStatusCheckAt: checkedAt };
      if (r.t1Booked) {
        if (!entry.mtmT1Done) { patch.mtmT1Done = true; patch.t1BookedAt = checkedAt; changed++; }
        if (!entry.splitCostDone) costMoves.push(entry.id);
      }
      if (r.closed) { changed++; return { ...entry, ...patch, status: 'FYERS ' + r.exitType + ' (split)', exitType: r.exitType, exitPrice: r.exitPrice > 0 ? r.exitPrice : '', realisedPnl: r.realisedPnl }; }
      return { ...entry, ...patch };
    });
    writeOrderLog(next);
    if (!costMoves.length) return callback(null, { changed });
    let i = 0;
    const doNext = () => {
      if (i >= costMoves.length) return callback(null, { changed });
      const id = costMoves[i++];
      const row = readOrderLog().find(r => r.id === id);
      if (!row || row.splitCostDone || !isOpenOrderLogEntry(row)) return doNext();
      const entryPx = Number(row.entryPrice || row.price || 0);
      // Rebuild legB GTT as (runner qty, SL=cost, target=T2).
      fyersModifyGttRemainder(row, Number(row.splitLegBQty || 0), entryPx, Number(row.targetPrice || 0), (mErr) => {
        if (!mErr) { const rows2 = readOrderLog().map(r => r.id === id ? { ...r, splitCostDone: true, mtmCostDone: true, slPrice: entryPx, brokerSlPrice: entryPx } : r); writeOrderLog(rows2); }
        doNext();
      });
    };
    doNext();
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
  // Protect-after-fill runs FIRST: place the Forever/GTT on any entry that has
  // now filled (and mark rejected entries dead) before the status reconciles read.
  if (rows.some(r => r.awaitingFill && String(r.broker || 'dhan').toLowerCase() === 'dhan')) tasks.push(placeProtectionForFilledDhanEntries);
  if (rows.some(r => r.awaitingFill && String(r.broker || '').toLowerCase() === 'zerodha')) tasks.push(placeProtectionForFilledZerodhaEntries);
  if (brokers.includes('dhan')) tasks.push(refreshDhanOrderLogStatus);
  // ENGINE cutover (STOCKKAR_ENGINE=1): the position engine owns the post-entry
  // lifecycle for Dhan-Forever and Zerodha-GTT rows — skip the legacy reconciles
  // it replaces (single writer). Entry statuses, orphan-cancel, protect-after-fill
  // and EMA trailing stay legacy in engine v1.
  const engineOwns = process.env.STOCKKAR_ENGINE === '1';
  if (!engineOwns && rows.some(r => r.dhanProtection === 'forever')) tasks.push(refreshDhanForeverOrderLogStatus);
  if (!engineOwns && rows.some(r => r.dhanProtection === 'forever-split')) tasks.push(refreshDhanForeverSplitOrderLogStatus);
  if (rows.some(r => /^forever/.test(String(r.dhanProtection || '')))) tasks.push(cancelOrphanedDhanForevers);
  if (!engineOwns && rows.some(r => /^forever/.test(String(r.dhanProtection || '')))) tasks.push(closeCompletedDhanForevers);
  if (!engineOwns && rows.some(r => /^forever/.test(String(r.dhanProtection || '')) && !r.protectionUnverified)) tasks.push(verifyDhanForeverProtection);
  if (brokers.includes('zerodha')) tasks.push(refreshZerodhaOrderLogStatus);
  if (!engineOwns && rows.some(r => String(r.broker || '').toLowerCase() === 'zerodha' && r.splitT1)) tasks.push(refreshZerodhaSplitOrderLogStatus);
  if (!engineOwns && rows.some(r => String(r.broker || '').toLowerCase() === 'zerodha' && r.splitT1 && r.zerodhaSplit)) tasks.push(closeCompletedZerodhaGtts);
  if (!engineOwns && rows.some(r => String(r.broker || '').toLowerCase() === 'zerodha' && !r.protectionUnverified && (r.zerodhaSplit || r.zerodhaGttId || r.zerodhaGttT1Id))) tasks.push(verifyZerodhaGttProtection);
  if (brokers.includes('fyers')) tasks.push(refreshFyersOrderLogStatus);
  if (rows.some(r => String(r.broker || '').toLowerCase() === 'fyers' && r.splitT1)) tasks.push(refreshFyersSplitOrderLogStatus);
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
        if (entry.dhanProtection === 'forever') return entry; // handled by the Forever reconcile
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

// Halt a scheduled algo for the day after an account error (e.g. an async
// insufficient-funds reject the placement response didn't show). It stops
// auto-retrying and resumes next day or when the user clicks Run now.
function haltAlgoJobForError(jobId, reason) {
  if (!jobId) return;
  const sched = readAlgoSchedule();
  const job = (sched.jobs || []).find(j => j.id === jobId);
  if (!job || !job.enabled || job.haltedDate === istDateKey()) return;
  job.haltedDate = istDateKey();
  job.haltedReason = String(reason || 'Account error').slice(0, 200);
  job.nextCheckAt = null;
  job.lastResult = { status: 'halted', error: job.haltedReason, at: new Date().toISOString(), message: 'Paused after an account error — resumes next day or when you click Run now.' };
  writeAlgoSchedule(sched);
  sendTelegram('⏸️ <b>Stockkar — algo paused</b>\n' + (job.config?.algoName || job.config?.screenerSlug || 'Algo') + ' stopped after: ' + job.haltedReason + '\nResumes next day or when you click Run now.', () => {});
  console.log('[ALGO HALT async]', jobId, job.haltedReason);
}

// Cancel ORPHANED Dhan Forever orders: the entry order was accepted by Dhan
// (so we placed the Forever) but then REJECTED async (e.g. insufficient funds),
// so there is no position - a resting Forever SELL would open a naked short if
// it triggered. The Forever reconcile only watches the Forever (which is fine),
// never the entry's status, so this reads the regular order book, finds entries
// that ended REJECTED/CANCELLED, cancels their Forever(s), and marks the row.
function cancelOrphanedDhanForevers(callback) {
  const isForeverOpen = e => String(e.broker || 'dhan').toLowerCase() === 'dhan'
    && /^forever/.test(String(e.dhanProtection || ''))
    && !e.awaitingFill   // protect-after-fill handles pending entries itself
    && !e.testMode && e.source !== 'test' && isOpenOrderLogEntry(e);
  if (!readOrderLog().some(isForeverOpen)) return callback(null, { cancelled: 0 });
  const store = readDhanTokenStore();
  if (!store?.token) return callback('No Dhan token saved');
  const req = https.request({ hostname: 'api.dhan.co', port: 443, path: '/v2/orders', method: 'GET', headers: { 'access-token': store.token, 'Content-Type': 'application/json' } }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      let p; try { p = JSON.parse(d); } catch { p = null; }
      if (res.statusCode >= 400) return callback('Dhan order book failed: HTTP ' + res.statusCode);
      const orders = Array.isArray(p) ? p : (Array.isArray(p?.data) ? p.data : []);
      const statusById = {}, reasonById = {};
      orders.forEach(o => {
        const id = String(o.orderId || o.orderid || '').trim();
        if (!id) return;
        statusById[id] = String(o.orderStatus || o.status || '').toUpperCase();
        reasonById[id] = String(o.omsErrorDescription || o.remarks || o.errorMessage || o.message || o.text || '');
      });
      const toFix = [];
      readOrderLog().forEach(e => {
        if (!isForeverOpen(e)) return;
        const entryId = e.dhanEntryOrderId || (String(e.orderId || '').match(/ENTRY:([^|\s]+)/i) || [])[1] || '';
        if (!entryId) return;
        const st = statusById[entryId];
        if (st && /REJECT|CANCELLED|EXPIRED/.test(st)) {  // entry never became a position
          const fids = [e.dhanForeverId, e.dhanForeverT1Id].filter(Boolean);
          const re = /FOREVER(?:-T1)?:([^|\s]+)/gi; let m; while ((m = re.exec(String(e.orderId || '')))) fids.push(m[1].trim());
          toFix.push({ id: e.id, jobId: e.jobId || '', foreverIds: [...new Set(fids.filter(Boolean))], entryStatus: st, reason: reasonById[entryId] || '' });
        }
      });
      if (!toFix.length) return callback(null, { cancelled: 0 });
      let i = 0, cancelled = 0;
      const next = () => {
        if (i >= toFix.length) return callback(null, { cancelled });
        const item = toFix[i++];
        let j = 0;
        const cancelNext = () => {
          if (j >= item.foreverIds.length) {
            patchOrderLogEntry(item.id, {
              status: 'DHAN ENTRY ' + (item.entryStatus.includes('REJECT') ? 'REJECTED' : item.entryStatus) + ' - no position, Forever cancelled',
              exitType: 'REJECTED',
              rejectionReason: 'Entry ' + item.entryStatus.toLowerCase() + (item.reason ? ' (' + item.reason + ')' : '') + '; orphaned Forever cancelled to avoid a naked short.',
              dhanProtection: 'forever-cancelled',
            });
            cancelled++;
            console.log('[ORPHAN FOREVER] cancelled for rejected entry, row', item.id);
            // Account-level reject (funds/margin) fails for EVERY stock - the
            // entry placement looked "ok" so the synchronous halt never fired.
            // Halt the algo for the day (resumes next day / on Run now).
            if (/insufficient|funds|margin|low\s*balance/i.test(item.reason)) haltAlgoJobForError(item.jobId, item.reason || 'Insufficient funds');
            return next();
          }
          dhanCancelForever(item.foreverIds[j++], () => cancelNext()); // best-effort
        };
        cancelNext();
      };
      next();
    });
  });
  req.on('error', e => callback('Dhan order book failed: ' + e.message));
  req.setTimeout(15000, () => req.destroy());
  req.end();
}

// Broker-truth close: when a Forever OCO COMPLETES (target/SL fills), Dhan drops
// it from /v2/forever/all, so the normal reconcile (which looks for a TRADED leg)
// can't see it and leaves the row stuck OPEN. Here we detect it by truth: if a
// Forever-protected position's Forever id(s) are GONE from the active list AND the
// symbol is NO LONGER held at Dhan, it closed at the broker -> mark it closed
// using the SELL fill(s) from the order book. FAIL-SAFE: never closes unless BOTH
// the forever list and holdings were fetched OK (a fetch error aborts), and only
// when the symbol is confirmed not-held.
function closeCompletedDhanForevers(callback) {
  const norm = s => String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const isOpenForever = e => String(e.broker || 'dhan').toLowerCase() === 'dhan'
    && /^forever/.test(String(e.dhanProtection || '')) && !e.awaitingFill
    && !e.testMode && e.source !== 'test' && isOpenOrderLogEntry(e);
  if (!readOrderLog().some(isOpenForever)) return callback(null, { changed: 0 });
  const store = readDhanTokenStore();
  if (!store?.token) return callback('No Dhan token saved');
  const getJson = (pathname, cb) => {
    const req = https.request({ hostname: 'api.dhan.co', port: 443, path: pathname, method: 'GET', headers: { 'access-token': store.token, 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        let p; try { p = JSON.parse(d); } catch { p = null; }
        if (res.statusCode === 404) return cb(null, []);                 // empty resource
        if (res.statusCode >= 400) return cb('HTTP ' + res.statusCode, null);
        cb(null, Array.isArray(p) ? p : (Array.isArray(p?.data) ? p.data : []));
      });
    });
    req.on('error', e => cb(e.message, null));
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  };
  getJson('/v2/forever/all', (fErr, foreverList) => {
    if (fErr) return callback('Dhan forever list failed: ' + fErr);       // can't confirm gone -> abort (safe)
    getJson('/v2/orders', (oErr, orders) => {
      if (oErr) orders = [];                                              // no order book -> exit price estimated from target/SL
      fetchDhanHeldSymbols((hErr, heldSet) => {
        if (hErr || !heldSet) return callback('Dhan holdings failed: ' + (hErr || 'none'));  // can't confirm not-held -> NEVER false-close
        const activeIds = new Set((foreverList || []).map(o => String(o.orderId || o.orderid || '').trim()).filter(Boolean));
        const sellsBySym = {};
        (orders || []).forEach(o => {
          const side = String(o.transactionType || o.transaction_type || '').toUpperCase();
          const status = String(o.orderStatus || o.status || '').toUpperCase();
          if (side !== 'SELL' || !/TRADED|EXECUTED|COMPLETE/.test(status)) return;
          const sym = norm(o.tradingSymbol || o.symbol || o.customSymbol);
          const q = Number(o.filledQty || o.filled_qty || o.tradedQty || o.quantity || 0);
          const px = Number(o.averageTradedPrice || o.avgPrice || o.tradedPrice || o.price || 0);
          if (!sym || !q || !px) return;
          (sellsBySym[sym] = sellsBySym[sym] || []).push({ q, px });
        });
        let changed = 0;
        const at = new Date().toISOString();
        const next = readOrderLog().map(e => {
          if (!isOpenForever(e)) return e;
          const fids = [];
          [e.dhanForeverId, e.dhanForeverT1Id].forEach(v => { if (v) fids.push(String(v).trim()); });
          const re = /FOREVER(?:-T1)?:([^|\s]+)/gi; let m; while ((m = re.exec(String(e.orderId || '')))) fids.push(m[1].trim());
          const sym = norm(e.symbol);
          if (fids.some(id => activeIds.has(id)) || heldSet.has(sym)) return e;   // Forever still active OR still held -> not closed
          // Forever gone AND not held -> closed at the broker. Reconstruct the exit.
          const entry = Number(e.entryPrice || e.price || 0);
          const qty = Number(e.qty || 0);
          const target = Number(e.targetPrice || 0);
          const slBase = Number(e.brokerSlPrice || e.slPrice || 0);
          const sells = sellsBySym[sym] || [];
          let pnl = 0, soldQty = 0;
          sells.forEach(s => { soldQty += s.q; pnl += (s.px - entry) * s.q; });
          // CROSS-DAY SPLIT: the order book is TODAY-only, so a T1 leg booked on an
          // earlier day is missing from today's sells — add its recorded P&L back.
          if (e.splitT1 && e.mtmT1Done && soldQty > 0 && soldQty < qty && Number(e.splitT1Pnl)) pnl += Number(e.splitT1Pnl);
          const estimated = soldQty <= 0;
          const maxSell = sells.length ? Math.max(...sells.map(s => s.px)) : 0;
          const minSell = sells.length ? Math.min(...sells.map(s => s.px)) : 0;
          // Representative exit = best/runner fill (matches how the split reconcile shows it).
          const exitPx = maxSell || (target > 0 ? target : slBase);
          const realisedPnl = estimated ? (entry && qty ? Number(((exitPx - entry) * qty).toFixed(2)) : '') : Number(pnl.toFixed(2));
          // Split rows: light up T1/T2 from the actual leg fills so the log reads like Test Mode.
          const flags = {};
          let exitType;
          if (e.splitT1) {
            const t1Pct = Number(e.t1Pct || 0);
            const t1Px = t1Pct > 0 ? entry * (1 + t1Pct / 100) : target; // same basis as the split reconcile
            const t2Hit = target > 0 && maxSell >= target * 0.999;
            const t1Hit = (t1Px > 0 && sells.some(s => s.px >= t1Px * 0.995)) || (t2Hit && sells.length >= 2);
            if (t1Hit && !e.mtmT1Done) { flags.mtmT1Done = true; flags.t1BookedAt = at; }
            if (t2Hit) flags.mtmT2Done = true;
            exitType = t2Hit ? 'TARGET HIT'
              : (slBase > 0 && minSell > 0 && minSell <= slBase * 1.001) ? 'SL HIT' : 'EXITED';
          } else {
            exitType = (target > 0 && exitPx >= target * 0.999) ? 'TARGET HIT'
              : (slBase > 0 && exitPx <= slBase * 1.001) ? 'SL HIT' : 'EXITED';
          }
          changed++;
          return { ...e, ...flags, exitType, exitPrice: roundPrice(exitPx), realisedPnl, exitEstimated: estimated,
            status: 'DHAN FOREVER ' + exitType + (e.splitT1 ? ' (split)' : ' (closed at broker)'), lastStatusCheckAt: at, reconciledAt: at, unrealisedPnl: undefined };
        });
        if (changed) writeOrderLog(next);
        callback(null, { changed });
      });
    });
  });
}

// RECHECK that protection is actually LIVE. Dhan returns 200 + an orderId for a
// Forever POST but validates via RMS asynchronously, so the order can be REJECTED
// after we recorded its id (classic: T2T stocks reject the same-day SELL). Trusting
// the 200 => a phantom "protected" row with no real stop. Here we verify by broker
// truth: if the entry is still HELD but there is NO active Forever guarding it and
// it hasn't been sold, the stop does not exist -> flag the row UNPROTECTED, clear
// any false "SL moved to cost", and alert. Two-strike grace (protectionCheckFirstAt)
// gives RMS time to decide before we alarm. FAIL-SAFE: aborts on any fetch error;
// only flags when the symbol is confirmed still held AND not sold.
const PROTECTION_RECHECK_GRACE_MS = 3 * 60 * 1000;
function verifyDhanForeverProtection(callback) {
  const norm = s => String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const isCand = e => String(e.broker || 'dhan').toLowerCase() === 'dhan'
    && /^forever/.test(String(e.dhanProtection || '')) && !e.awaitingFill
    && !e.testMode && e.source !== 'test' && !e.protectionUnverified && isOpenOrderLogEntry(e);
  if (!readOrderLog().some(isCand)) return callback(null, { flagged: 0 });
  const store = readDhanTokenStore();
  if (!store?.token) return callback('No Dhan token saved');
  const getJson = (pathname, cb) => {
    const req = https.request({ hostname: 'api.dhan.co', port: 443, path: pathname, method: 'GET', headers: { 'access-token': store.token, 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        let p; try { p = JSON.parse(d); } catch { p = null; }
        if (res.statusCode === 404) return cb(null, []);
        if (res.statusCode >= 400) return cb('HTTP ' + res.statusCode, null);
        cb(null, Array.isArray(p) ? p : (Array.isArray(p?.data) ? p.data : []));
      });
    });
    req.on('error', e => cb(e.message, null));
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  };
  getJson('/v2/forever/all', (fErr, foreverList) => {
    if (fErr) return callback('Dhan forever list failed: ' + fErr);          // can't verify -> abort (safe)
    getJson('/v2/orders', (oErr, orders) => {
      if (oErr) orders = [];
      fetchDhanHeldSymbols((hErr, heldSet) => {
        if (hErr || !heldSet) return callback('Dhan holdings failed: ' + (hErr || 'none'));  // never false-flag
        // A row is protected iff one of ITS OWN Forever ids is still present and not
        // rejected in the list (the exact matching the close-detection uses) — reliable
        // and immune to any symbol-field naming differences in the forever payload.
        const activeIds = new Set();
        (foreverList || []).forEach(o => {
          const st = String(o.orderStatus || o.status || '').toUpperCase();
          if (/REJECT|CANCEL|EXPIRE/.test(st)) return;
          const id = String(o.orderId || o.orderid || '').trim(); if (id) activeIds.add(id);
        });
        const soldSyms = new Set();
        (orders || []).forEach(o => {
          const side = String(o.transactionType || o.transaction_type || '').toUpperCase();
          const st = String(o.orderStatus || o.status || '').toUpperCase();
          if (side === 'SELL' && /TRADED|EXECUTED|COMPLETE/.test(st)) { const s = norm(o.tradingSymbol || o.symbol || o.customSymbol); if (s) soldSyms.add(s); }
        });
        const now = Date.now();
        let flagged = 0;
        readOrderLog().filter(isCand).forEach(e => {
          const sym = norm(e.symbol);
          const fids = [];
          [e.dhanForeverId, e.dhanForeverT1Id].forEach(v => { if (v) fids.push(String(v).trim()); });
          const re = /FOREVER(?:-T1)?:([^|\s]+)/gi; let m; while ((m = re.exec(String(e.orderId || '')))) fids.push(m[1].trim());
          const protectedNow = fids.some(id => activeIds.has(id));
          const held = heldSet.has(sym);
          const exited = soldSyms.has(sym);
          if (!(held && !protectedNow && !exited)) {                          // looks fine -> clear any pending strike
            if (e.protectionCheckFirstAt) updateOrderLogRow(e.id, r => ({ ...r, protectionCheckFirstAt: '' }));
            return;
          }
          if (!e.protectionCheckFirstAt) {                                    // strike 1: start the grace clock
            updateOrderLogRow(e.id, r => ({ ...r, protectionCheckFirstAt: new Date().toISOString() }));
            return;
          }
          if (now - (Date.parse(e.protectionCheckFirstAt) || now) < PROTECTION_RECHECK_GRACE_MS) return; // still in grace
          // strike 2 after grace, still HELD + unprotected + unsold -> the Forever was rejected.
          updateOrderLogRow(e.id, r => ({ ...r,
            protectionUnverified: true, mtmCostDone: false, splitCostDone: false,
            reconcileNote: 'Forever protection was REJECTED at the broker (e.g. a T2T stock — same-day SELL not allowed). NO stop is live. Add a manual stop in Dhan.',
            lastTrailError: 'Protection rejected — no live stop',
            status: 'DHAN ⚠ UNPROTECTED — Forever rejected, add manual stop' }));
          sendTelegram('🔴 <b>Stockkar — ' + (e.symbol || '') + ' has NO live stop</b>\nThe protective Forever order was rejected at Dhan (often a T2T stock — same-day SELL is not permitted). <b>Add a manual stop now.</b>', () => {});
          flagged++;
        });
        callback(null, { flagged });
      });
    });
  });
}

// Reconcile Forever-protected Dhan entries by their persistent Forever order id
// (GET /v2/forever/all). Conservative: only close a row on a confirmed TRADED
// leg (SL vs target by legName). Never false-close on a missing/empty response;
// a cancelled/rejected Forever is flagged as "protection lost" but kept OPEN
// (the position may still be held) so it isn't hidden.
function refreshDhanForeverOrderLogStatus(callback) {
  const hasForever = readOrderLog().some(e => String(e.broker || 'dhan').toLowerCase() === 'dhan' && e.dhanProtection === 'forever' && !e.awaitingFill && isOpenOrderLogEntry(e));
  if (!hasForever) return callback(null, { changed: 0 });
  const store = readDhanTokenStore();
  if (!store?.token) return callback('No Dhan token saved');
  const req = https.request({ hostname: 'api.dhan.co', port: 443, path: '/v2/forever/all', method: 'GET', headers: { 'access-token': store.token, 'Content-Type': 'application/json' } }, apiRes => {
    let data = ''; apiRes.on('data', c => data += c); apiRes.on('end', () => {
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      if (apiRes.statusCode === 404) return callback(null, { changed: 0 }); // no Forever orders on the account -> nothing to reconcile (not an error)
      if (apiRes.statusCode >= 400) return callback('Dhan forever status failed: ' + dhanApiMessage(parsed, 'HTTP ' + apiRes.statusCode));
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
      const statusOf = o => String(o.orderStatus || o.status || '').toUpperCase();
      let changed = 0;
      const checkedAt = new Date().toISOString();
      const next = readOrderLog().map(entry => {
        if (!(String(entry.broker || 'dhan').toLowerCase() === 'dhan' && entry.dhanProtection === 'forever' && !entry.awaitingFill && isOpenOrderLogEntry(entry))) return entry;
        const fid = dhanForeverIdFromEntry(entry);
        const legs = list.filter(o => String(o.orderId || '').trim() === fid);
        if (!legs.length) return { ...entry, lastStatusCheckAt: checkedAt }; // not found -> leave OPEN (no false close)
        const traded = legs.find(l => statusOf(l) === 'TRADED');
        if (traded) {
          const isTarget = String(traded.legName || '').toUpperCase().includes('TARGET');
          const exitType = isTarget ? 'TARGET HIT' : 'SL HIT';
          const px = Number(traded.price || traded.triggerPrice || 0) || (isTarget ? Number(entry.targetPrice || 0) : Number(entry.slPrice || 0));
          const entryPx = Number(entry.entryPrice || entry.price || 0), qty = Number(entry.qty || 0);
          changed++;
          return { ...entry, status: 'DHAN FOREVER ' + exitType, exitType, exitPrice: px > 0 ? Number(px.toFixed(2)) : '', realisedPnl: (px > 0 && entryPx && qty) ? Number(((px - entryPx) * qty).toFixed(2)) : '', lastStatusCheckAt: checkedAt };
        }
        const dead = legs.find(l => /CANCELLED|REJECTED|EXPIRED/.test(statusOf(l)));
        if (dead) {
          // Protection gone but position may still be held - keep OPEN, just warn.
          changed++;
          return { ...entry, reconcileNote: 'Forever protection ' + statusOf(dead).toLowerCase() + ' - re-arm a stop in Dhan', lastTrailError: 'Forever ' + statusOf(dead), lastStatusCheckAt: checkedAt };
        }
        return { ...entry, lastStatusCheckAt: checkedAt }; // PENDING/CONFIRM/TRANSIT -> still protected, open
      });
      writeOrderLog(next);
      callback(null, { changed });
    });
  });
  req.on('error', err => callback('Dhan forever status failed: ' + err.message));
  req.setTimeout(20000, () => req.destroy(new Error('Dhan forever status timed out')));
  req.end();
}

// Reconcile "split T1 at broker" Dhan holds (dhanProtection 'forever-split').
// Each row has TWO Forever OCOs: legA (dhanForeverT1Id = T1+SL on the booked
// qty) and legB (dhanForeverId = T2+SL on the runner). Jobs here:
//   1) When legA's TARGET fills (T1 booked) -> move legB's SL to cost, once.
//   2) When legB resolves (target=T2 or SL) -> the position is flat; close the
//      row with the combined two-leg realised P&L.
// Conservative: if a leg's state is unknown (vanished/pending) we leave the row
// OPEN — never a false close. Move-to-cost is retried each pass until it sticks.
function refreshDhanForeverSplitOrderLogStatus(callback) {
  const isSplitOpen = e => String(e.broker || 'dhan').toLowerCase() === 'dhan' && e.dhanProtection === 'forever-split' && isOpenOrderLogEntry(e);
  if (!readOrderLog().some(isSplitOpen)) return callback(null, { changed: 0 });
  const store = readDhanTokenStore();
  if (!store?.token) return callback('No Dhan token saved');
  const req = https.request({ hostname: 'api.dhan.co', port: 443, path: '/v2/forever/all', method: 'GET', headers: { 'access-token': store.token, 'Content-Type': 'application/json' } }, apiRes => {
    let data = ''; apiRes.on('data', c => data += c); apiRes.on('end', () => {
      let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
      if (apiRes.statusCode === 404) return callback(null, { changed: 0 }); // no Forever orders on the account -> nothing to reconcile (not an error)
      if (apiRes.statusCode >= 400) return callback('Dhan forever status failed: ' + dhanApiMessage(parsed, 'HTTP ' + apiRes.statusCode));
      const list = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.data) ? parsed.data : []);
      const statusOf = o => String(o.orderStatus || o.status || '').toUpperCase();
      // Resolve a Forever OCO id to which leg (if any) filled.
      const resolve = (fid) => {
        const id = String(fid || '').trim();
        if (!id) return { state: 'absent', px: 0 };
        const legs = list.filter(o => String(o.orderId || '').trim() === id);
        if (!legs.length) return { state: 'absent', px: 0 };          // vanished -> unknown, stay open
        const traded = legs.find(l => statusOf(l) === 'TRADED');
        if (traded) return { state: String(traded.legName || '').toUpperCase().includes('TARGET') ? 'target' : 'sl', px: Number(traded.price || traded.triggerPrice || 0) };
        if (legs.find(l => /CANCELLED|REJECTED|EXPIRED/.test(statusOf(l)))) return { state: 'gone', px: 0 };
        return { state: 'pending', px: 0 };
      };
      const checkedAt = new Date().toISOString();
      let changed = 0;
      const costMoves = []; // rows whose legB SL still needs moving to cost
      const next = readOrderLog().map(entry => {
        if (!isSplitOpen(entry)) return entry;
        const entryPx = Number(entry.entryPrice || entry.price || 0);
        const aQty = Number(entry.splitLegAQty || 0), bQty = Number(entry.splitLegBQty || 0);
        const t1Pct = Number(entry.t1Pct || 0);
        const t1Px = t1Pct > 0 ? Number((entryPx * (1 + t1Pct / 100)).toFixed(2)) : Number(entry.targetPrice || 0);
        const slPx = Number(entry.slPrice || 0), t2Px = Number(entry.targetPrice || 0);
        let A = resolve(entry.dhanForeverT1Id); const B = resolve(dhanForeverIdFromEntry(entry));
        // Broker-truth T1 book (Dhan drops a COMPLETED Forever from the list, so a
        // just-filled T1 leg reads as 'absent'): if T1's OCO has vanished while the
        // runner's OCO is STILL live/pending, T1 can only have hit TARGET — a shared-SL
        // hit would have closed the runner too. This ticks T1 + moves SL->cost DURING
        // the trade (like Test Mode), and is cross-day safe (no order-book dependence).
        if (A.state === 'absent' && B.state === 'pending') A = { state: 'target', px: t1Px };
        let patch = { lastStatusCheckAt: checkedAt };

        // (1) T1 booked -> flag it, and (once) move legB SL to cost.
        if (A.state === 'target') {
          if (!entry.mtmT1Done) {
            patch.mtmT1Done = true; patch.t1BookedAt = checkedAt;
            patch.splitT1Pnl = (entryPx && aQty) ? Number((((A.px || t1Px) - entryPx) * aQty).toFixed(2)) : '';
            changed++;
          }
          if (!entry.splitCostDone) costMoves.push(entry.id); // retried until it sticks
        }

        // (2) Closure once legB resolves (pure decision; shared with tests).
        const decision = resolveSplitExit({
          aState: A.state, aPx: A.px, bState: B.state, bPx: B.px,
          entryPrice: entryPx, slPrice: slPx, t2Price: t2Px, t1Price: t1Px, aQty, bQty,
        });
        if (decision.closed) {
          changed++;
          return { ...entry, ...patch, status: 'DHAN FOREVER ' + decision.exitType + ' (split)', exitType: decision.exitType, exitPrice: decision.exitPrice > 0 ? decision.exitPrice : '', realisedPnl: decision.realisedPnl };
        }

        // Protection on the runner gone but still held -> warn, keep open.
        if (B.state === 'gone') { patch.reconcileNote = 'Runner Forever ' + B.state + ' - re-arm a stop in Dhan'; patch.lastTrailError = 'Forever gone'; changed++; }
        return { ...entry, ...patch };
      });
      writeOrderLog(next);

      // Move legB SL to cost for any rows that booked T1 (retried each pass).
      if (!costMoves.length) return callback(null, { changed });
      let i = 0;
      const doNext = () => {
        if (i >= costMoves.length) return callback(null, { changed });
        const id = costMoves[i++];
        const row = readOrderLog().find(r => r.id === id);
        if (!row || row.splitCostDone || !isOpenOrderLogEntry(row)) return doNext();
        const entryPx = Number(row.entryPrice || row.price || 0);
        // Modify ONLY legB's SL (runner qty), keep its T2 target (OCO, not trailing).
        modifyDhanForeverStopLoss({ ...row, qty: Number(row.splitLegBQty || 0), emaTrailingEnabled: false }, entryPx, (mErr) => {
          if (!mErr) {
            const rows2 = readOrderLog().map(r => r.id === id ? { ...r, splitCostDone: true, mtmCostDone: true, slPrice: entryPx, brokerSlPrice: entryPx } : r);
            writeOrderLog(rows2);
          }
          doNext();
        });
      };
      doNext();
    });
  });
  req.on('error', err => callback('Dhan forever split status failed: ' + err.message));
  req.setTimeout(20000, () => req.destroy(new Error('Dhan forever split status timed out')));
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
  let done = false;
  const finish = (err, val) => { if (done) return; done = true; callback(err, val); };
  const req = https.request({ hostname, port: 443, path: apiPath, method: 'GET', headers }, (apiRes) => {
    let data = '';
    apiRes.on('data', c => data += c);
    apiRes.on('end', () => {
      let p;
      try { p = JSON.parse(data); } catch { p = data; }
      finish(null, { status: apiRes.statusCode, data: p, hostname, path: apiPath });
    });
  });
  req.on('error', err => finish(err.message, null));
  // Fail fast (well before nginx's ~60s proxy timeout) so the UI gets a clean
  // JSON error instead of an HTML 504 page when the Stockkar API is slow/down.
  // The 'timed out' marker lets the saved-filter resolver stop trying other
  // paths on the same unresponsive host instead of stacking up timeouts.
  req.setTimeout(15000, () => req.destroy(new Error('Stockkar API request timed out')));
  req.end();
}

function stockkarGet(apiPath, token, callback) {
  stockkarHostGet(STOCKKAR_HOST, apiPath, token, callback);
}

// Ã¢â€â‚¬Ã¢â€â‚¬ TradingView Scanner Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬Ã¢â€â‚¬
function fetchTVData(symbols, callback) {
  const tvSymbols = symbols.map(s => `NSE:${s.replace('.NS','').replace('-EQ','').replace(' ','').trim().toUpperCase()}`);
  const emaPeriods = [5, 9, 20, 21, 33, 50, 100, 200];
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
          return { symbol: d[0], ltp: d[1], open: d[2], high: d[3], low: d[4], volume: d[5], ema, ema5: ema[5], ema9: ema[9], ema20: ema[20], ema21: ema[21], ema33: ema[33], ema50: ema[50], ema100: ema[100], ema200: ema[200], rsi: d[base], change: d[base + 1], changeAbs: d[base + 2], avgVol10d: d[base + 3], high1M: d[base + 4], low1M: d[base + 5] };
        });
        recordTvHealth(symbols.length === 0 || results.length > 0, results.length === 0 ? 'empty market data response' : null);
        callback(null, results);
      } catch(e) { console.log('[SIGNAL] parse error:', e.message); recordTvHealth(false, 'market data parse error'); callback('Market data temporarily unavailable', null); }
    });
  });
  req.on('error', err => { console.log('[SIGNAL] fetch error:', err.message); recordTvHealth(false, 'market data connection error'); callback('Market data temporarily unavailable', null); });
  // Fail fast (before nginx's ~60s proxy timeout) so the UI gets a clean JSON
  // error instead of an HTML 504 page. Large baskets/slow data hit this.
  req.setTimeout(40000, () => req.destroy(new Error('market data request timed out')));
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
// NSE series per symbol (from the same scrip master): used to SKIP T2T
// (Trade-to-Trade) stocks at entry — their same-day protective SELL is
// rejected by RMS (the INDOAMIN incident), leaving a naked CNC position.
let dhanSeriesCache = {};
const T2T_SERIES = new Set(['BE', 'BZ', 'BT', 'T']);
function isT2TSymbol(symbol) {
  const s = String(symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  return T2T_SERIES.has(String(dhanSeriesCache[s] || '').toUpperCase());
}
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
      const seriesMap = {};

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
        // NSE series wins (EQ over anything; otherwise first seen). BSE rows never
        // overwrite an NSE series.
        if (exchangeKey === 'NSE' && series && (!seriesMap[symbol] || series === 'EQ')) seriesMap[symbol] = series;
      });

      dhanSecurityCache = map;
      dhanSecurityCacheAt = Date.now();
      dhanSeriesCache = seriesMap;
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

// Limit price for a stop-loss SELL placed on a GTT/trigger. We set the limit a
// touch BELOW the trigger so the stop still fills if price moves fast through it
// (a limit exactly at the trigger can miss in a gap). Used for limit-on-trigger
// brokers (Zerodha, FYERS, Angel); Dhan uses STOP_LOSS_MARKET so it needs none.
// Buffer is per-box configurable via STOCKKAR_SL_LIMIT_BUFFER_PCT (default 0.5%).
const SL_LIMIT_BUFFER_PCT = Math.max(0, Number(process.env.STOCKKAR_SL_LIMIT_BUFFER_PCT || 0.5));
function slLimitPrice(trigger) {
  return roundPrice(Number(trigger || 0) * (1 - SL_LIMIT_BUFFER_PCT / 100));
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
    pin: payload.pin || previous.pin || '',
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

// ---- FYERS auth (v3) -------------------------------------------------------
// Spec verified against the official fyers-apiv3 SDK: base api-t1.fyers.in/api/v3,
// auth header "{appId}:{accessToken}", appIdHash = sha256("{appId}:{secretKey}").
const FYERS_API = 'https://api-t1.fyers.in/api/v3';
function fyersAppIdHash(appId, secret) {
  return crypto.createHash('sha256').update(String(appId) + ':' + String(secret)).digest('hex');
}
function fyersLoginUrl(appId, redirectUri, state) {
  const p = new URLSearchParams({ client_id: String(appId), redirect_uri: String(redirectUri), response_type: 'code', state: state || 'stockkar' });
  return FYERS_API + '/generate-authcode?' + p.toString();
}
// Exchange the one-time auth_code (or full redirect URL) for an access token.
function fyersExchangeAuthCode(appId, secret, authCode, callback) {
  let code = String(authCode || '').trim();
  const m = code.match(/auth_code=([^&\s]+)/);
  if (m) code = decodeURIComponent(m[1]);
  if (!appId || !secret || !code) return callback('FYERS App ID, Secret and auth code are required.', null);
  const body = JSON.stringify({ grant_type: 'authorization_code', appIdHash: fyersAppIdHash(appId, secret), code });
  const req = https.request({
    hostname: 'api-t1.fyers.in', port: 443, path: '/api/v3/validate-authcode', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      let p; try { p = JSON.parse(d); } catch { p = null; }
      if (!p || p.s !== 'ok' || !p.access_token) return callback((p && (p.message || p.s)) || ('FYERS token exchange failed (HTTP ' + res.statusCode + ')'), null);
      callback(null, { accessToken: p.access_token, refreshToken: p.refresh_token || '' });
    });
  });
  req.on('error', e => callback('FYERS error: ' + e.message, null));
  req.setTimeout(20000, () => req.destroy(new Error('FYERS request timed out')));
  req.write(body); req.end();
}

// Refresh the daily access token without the browser login. FYERS needs the
// user's PIN here (refresh_token valid ~15 days). Returns a new access token.
function fyersRefreshToken(appId, secret, refreshToken, pin, callback) {
  if (!appId || !secret || !refreshToken || !pin) return callback('FYERS refresh needs App ID, Secret, refresh token and PIN.', null);
  const body = JSON.stringify({ grant_type: 'refresh_token', appIdHash: fyersAppIdHash(appId, secret), refresh_token: refreshToken, pin: String(pin) });
  const req = https.request({
    hostname: 'api-t1.fyers.in', port: 443, path: '/api/v3/validate-refresh-token', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      let p; try { p = JSON.parse(d); } catch { p = null; }
      if (!p || p.s !== 'ok' || !p.access_token) return callback((p && (p.message || p.s)) || ('FYERS refresh failed (HTTP ' + res.statusCode + ')'), null);
      callback(null, p.access_token);
    });
  });
  req.on('error', e => callback('FYERS error: ' + e.message, null));
  req.setTimeout(20000, () => req.destroy(new Error('FYERS request timed out')));
  req.write(body); req.end();
}

// Daily pre-open auto-renew using the stored refresh token + PIN. Mirrors the
// Dhan/Angel renewal pattern: at most one attempt per day, Telegram on success,
// renew-failed status (which the Telegram expiry watcher reports) on failure.
const FYERS_RENEW_HOUR_IST = Number(process.env.FYERS_RENEW_HOUR_IST || 7);
const FYERS_RENEW_MINUTE_IST = Number(process.env.FYERS_RENEW_MINUTE_IST || 30);
function checkFyersTokenRenewal() {
  const store = readBrokerTokenStore().brokers.fyers;
  if (!store?.clientId || !store?.clientSecret || !store?.refreshToken || !store?.pin) return;
  const now = getIstNow();
  const dateKey = istDateKey(now);
  if (store.lastRenewalDate === dateKey) return; // already attempted today
  const st = getBrokerTokenStatus('fyers');
  const pastSlot = now.getHours() * 60 + now.getMinutes() >= FYERS_RENEW_HOUR_IST * 60 + FYERS_RENEW_MINUTE_IST;
  // Renew at/after the morning slot, or immediately if the token is already dead.
  if (!pastSlot && st.status === 'active') return;
  // Mark the attempt first so a failure doesn't hammer the endpoint every tick.
  const s1 = readBrokerTokenStore();
  if (s1.brokers.fyers) { s1.brokers.fyers.lastRenewalDate = dateKey; s1.brokers.fyers.lastRenewalAttemptAt = new Date().toISOString(); writeBrokerTokenStore(s1); }
  fyersRefreshToken(store.clientId, store.clientSecret, store.refreshToken, store.pin, (err, accessToken) => {
    if (err) {
      const l = readBrokerTokenStore();
      if (l.brokers.fyers) { l.brokers.fyers.lastRenewalError = err; writeBrokerTokenStore(l); }
      console.log('[FYERS TOKEN] auto-renew failed: ' + err);
      return;
    }
    saveBrokerToken('fyers', { clientId: store.clientId, accessToken, source: 'daily-refresh', renewedAt: new Date().toISOString(), lastRenewalError: null });
    console.log('[FYERS TOKEN] auto-renewed for ' + dateKey);
    sendTelegram('✅ <b>Stockkar — FYERS token renewed</b>\nAuto-renewed for today. Your algos stay connected.', () => {});
  });
}

// ---- FYERS live trading (v3) ----------------------------------------------
// Mirrors the Zerodha model: entry order + a persistent GTT (OCO SL+target, or
// single SL when EMA trailing owns the target). Auth header is "{appId}:{token}".
function fyersTradeRequest(method, pathname, payload, callback) {
  const store = readBrokerTokenStore().brokers.fyers;
  if (!store?.clientId || !store?.accessToken) return callback('FYERS not connected. Connect FYERS in Settings.', null);
  const body = payload != null ? JSON.stringify(payload) : '';
  const headers = { 'Authorization': store.clientId + ':' + store.accessToken, 'Content-Type': 'application/json', 'version': '3' };
  if (body) headers['Content-Length'] = Buffer.byteLength(body);
  const req = https.request({ hostname: 'api-t1.fyers.in', port: 443, path: '/api/v3' + pathname, method, headers }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => { let p; try { p = JSON.parse(d); } catch { p = d; } callback(null, { status: res.statusCode, data: p }); });
  });
  req.on('error', e => callback('FYERS error: ' + e.message, null));
  req.setTimeout(20000, () => req.destroy(new Error('FYERS request timed out')));
  if (body) req.write(body);
  req.end();
}
function fyersSymbol(symbolRaw, exchange) {
  return (exchange === 'BSE' ? 'BSE' : 'NSE') + ':' + String(symbolRaw || '').replace(/^(NSE|BSE):/i, '').replace('-EQ', '').replace(/\s/g, '').toUpperCase() + '-EQ';
}
function fyersApiMsg(res, fallback) {
  return res?.data?.message || res?.data?.s || (typeof res?.data === 'string' ? res.data : '') || fallback || 'FYERS request failed';
}
function fyersGttIdFromEntry(entry) {
  if (entry?.fyersGttId) return String(entry.fyersGttId).trim();
  const m = String(entry?.orderId || '').match(/GTT:([^|\s]+)/i);
  return m ? m[1].trim() : '';
}

function placeFyersOrder(order, credentials, callback) {
  const entry = Number(order.entryPrice), sl = Number(order.slPrice), target = Number(order.targetPrice);
  const qty = Math.floor(Number(order.qty || 0));
  const symRaw = String(order.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  if (!symRaw || !entry || !sl || !target || !qty) return callback('Missing FYERS order fields', null);
  if (!(sl < entry && target > entry)) return callback('Invalid FYERS BUY setup: SL must be below entry and target above entry', null);
  const fsym = fyersSymbol(symRaw, order.exchange);
  const emaTrailingMode = isPostTargetEmaTrailingOrder(order);
  // 1) Entry: limit BUY (type 1, side 1). 2) GTT protection (persists across days).
  const entryPayload = { symbol: fsym, qty, type: 1, side: 1, productType: 'CNC', limitPrice: roundPrice(entry), stopPrice: 0, validity: 'DAY', disclosedQty: 0, offlineOrder: false };
  fyersTradeRequest('POST', '/orders/sync', entryPayload, (eErr, eRes) => {
    if (eErr) return callback('FYERS entry order failed: ' + eErr, null);
    if (eRes.status >= 400 || eRes.data?.s !== 'ok') return callback('FYERS entry order failed: ' + fyersApiMsg(eRes, 'HTTP ' + eRes.status), eRes);
    const entryId = eRes.data?.id || '';
    // OCO: leg1 = target (trigger above LTP), leg2 = SL (trigger below LTP).
    // Single (EMA trailing): leg1 = SL only; Stockkar manages the target.
    const mkOco = (q, tgt) => ({ side: -1, symbol: fsym, productType: 'CNC', orderInfo: {
      leg1: { price: roundPrice(tgt), triggerPrice: roundPrice(tgt), qty: q },
      leg2: { price: slLimitPrice(sl), triggerPrice: roundPrice(sl), qty: q } } });
    const mkSingle = (q) => ({ side: -1, symbol: fsym, productType: 'CNC', orderInfo: { leg1: { price: slLimitPrice(sl), triggerPrice: roundPrice(sl), qty: q } } });
    const gttIdOf = (gRes) => gRes.data?.id || gRes.data?.data?.id || '';

    const protectionFailed = (msg, gttData, reqPayload, label) => {
      sendTelegram('🔴 <b>Stockkar — FYERS stop-loss NOT placed for ' + symRaw + '</b>\nEntry filled but the GTT protection was rejected (' + msg + ').\n<b>Add a manual stop in FYERS now.</b>', () => {});
      return callback('FYERS entry placed but GTT protection (' + label + ') FAILED: ' + msg + '. Add a manual stop now.', {
        status: 500, data: { entry: eRes.data, gtt: gttData || null }, request: { entry: entryPayload, gtt: reqPayload },
        fyersEntryOrderId: entryId, fyersGttId: '', stopLossPrice: roundPrice(sl), softwareTargetTrailing: emaTrailingMode,
      });
    };

    // Proven single GTT (today's path): OCO target+SL, or SL-only when trailing.
    // Also the fail-safe fallback if a split leg can't be placed.
    const placeSingle = () => {
      const gttPayload = emaTrailingMode ? mkSingle(qty) : mkOco(qty, target);
      fyersTradeRequest('POST', '/gtt/orders/sync', gttPayload, (gErr, gRes) => {
        if (gErr || gRes.status >= 400 || gRes.data?.s !== 'ok') return protectionFailed(gErr || fyersApiMsg(gRes, 'HTTP ' + gRes?.status), gRes?.data, gttPayload, emaTrailingMode ? 'SL' : 'SL+target');
        callback(null, {
          status: gRes.status, data: { entry: eRes.data, gtt: gRes.data }, request: { entry: entryPayload, gtt: gttPayload, stopLossPrice: roundPrice(sl) },
          fyersEntryOrderId: entryId, fyersGttId: gttIdOf(gRes), softwareTargetOrder: emaTrailingMode, softwareTargetTrailing: emaTrailingMode,
        });
      });
    };

    // "Split T1 at broker": two GTT OCOs (legA T1+SL booked qty, legB T2+SL
    // runner). No-trailing only; kill-switch STOCKKAR_SPLIT_T1=0. Any failure
    // rolls back to the single GTT so protection is never lost.
    const splitPlan = (!emaTrailingMode && process.env.STOCKKAR_SPLIT_T1 !== '0') ? computeSplitBracket(order) : { split: false };
    if (!splitPlan.split) return placeSingle();
    fyersTradeRequest('POST', '/gtt/orders/sync', mkOco(splitPlan.legA.qty, splitPlan.legA.target), (aErr, aRes) => {
      if (aErr || aRes.status >= 400 || aRes.data?.s !== 'ok') return placeSingle(); // nothing placed -> safe fallback
      const idA = gttIdOf(aRes);
      fyersTradeRequest('POST', '/gtt/orders/sync', mkOco(splitPlan.legB.qty, splitPlan.legB.target), (bErr, bRes) => {
        if (bErr || bRes.status >= 400 || bRes.data?.s !== 'ok') return fyersCancelGtt(idA, () => placeSingle()); // roll back legA, then fallback
        callback(null, {
          status: bRes.status, data: { entry: eRes.data, gttT1: aRes.data, gttT2: bRes.data }, request: { entry: entryPayload, gttT1: mkOco(splitPlan.legA.qty, splitPlan.legA.target), gttT2: mkOco(splitPlan.legB.qty, splitPlan.legB.target), stopLossPrice: roundPrice(sl) },
          fyersEntryOrderId: entryId, fyersSplit: true, splitT1: true,
          fyersGttT1Id: idA, fyersGttId: gttIdOf(bRes),
          splitLegAQty: splitPlan.legA.qty, splitLegBQty: splitPlan.legB.qty,
          softwareTargetOrder: false, softwareTargetTrailing: false,
        });
      });
    });
  });
}

// Move-to-cost / EMA trail: modify the GTT SL leg trigger (leg2 for OCO, leg1 for single).
function modifyFyersGttStopLoss(entry, nextSl, callback) {
  const gttId = fyersGttIdFromEntry(entry);
  if (!gttId) return callback('No FYERS GTT id available');
  const sl = roundPrice(nextSl), qty = Math.floor(Number(entry.qty || 0));
  const leg = { price: slLimitPrice(nextSl), triggerPrice: sl, qty };
  const payload = { id: gttId, orderInfo: entry.emaTrailingEnabled ? { leg1: leg } : { leg2: leg } };
  fyersTradeRequest('PATCH', '/gtt/orders/sync', payload, (err, res) => {
    if (err) return callback(err);
    if (res.status >= 400 || res.data?.s !== 'ok') return callback('FYERS GTT SL modify failed: ' + fyersApiMsg(res, 'HTTP ' + res.status));
    callback(null, res);
  });
}
function fyersCancelGtt(gttId, callback) {
  if (!gttId) return callback(null, { skipped: true });
  fyersTradeRequest('DELETE', '/gtt/orders/sync', { id: String(gttId) }, (err, res) => {
    if (err) return callback(err);
    if (res.status >= 400 || res.data?.s !== 'ok') return callback('FYERS GTT cancel failed: ' + fyersApiMsg(res, 'HTTP ' + res.status));
    callback(null, res);
  });
}
function fyersPlaceSell(entry, qty, callback) {
  const q = Math.floor(Number(qty || 0));
  if (!q) return callback('Invalid FYERS sell qty');
  const fsym = fyersSymbol(entry.symbol, entry.exchange);
  fyersTradeRequest('POST', '/orders/sync', { symbol: fsym, qty: q, type: 2, side: -1, productType: 'CNC', limitPrice: 0, stopPrice: 0, validity: 'DAY', disclosedQty: 0, offlineOrder: false }, (err, res) => {
    if (err) return callback(err);
    if (res.status >= 400 || res.data?.s !== 'ok') return callback('FYERS sell failed: ' + fyersApiMsg(res, 'HTTP ' + res.status), res);
    callback(null, { status: res.status, data: res.data, orderId: res.data?.id || '' });
  });
}
// After T1: reshape the same GTT OCO to the remainder qty (SL=cost, target=T2),
// in place so the GTT id stays stable.
function fyersModifyGttRemainder(entry, qty, sl, target, callback) {
  const gttId = fyersGttIdFromEntry(entry);
  if (!gttId) return callback('No FYERS GTT id for remainder');
  const q = Math.floor(Number(qty || 0));
  if (!q) return callback('Invalid FYERS remainder qty');
  const payload = { id: gttId, orderInfo: {
    leg1: { price: roundPrice(target), triggerPrice: roundPrice(target), qty: q },
    leg2: { price: slLimitPrice(sl), triggerPrice: roundPrice(sl), qty: q } } };
  fyersTradeRequest('PATCH', '/gtt/orders/sync', payload, (err, res) => {
    if (err) return callback(err);
    if (res.status >= 400 || res.data?.s !== 'ok') return callback('FYERS remainder GTT modify failed: ' + fyersApiMsg(res, 'HTTP ' + res.status), res);
    callback(null, { status: res.status, data: res.data, gttId });
  });
}

// ---- Telegram alerts -------------------------------------------------------
const TELEGRAM_BROKER_NAMES = { dhan: 'Dhan', zerodha: 'Zerodha Kite', angelone: 'Angel One', upstox: 'Upstox' };
function readTelegramConfig() {
  return readJsonFile(TELEGRAM_FILE, null) || { enabled: false, botToken: '', chatId: '', alerts: { brokerExpiry: true }, lastAlert: {} };
}
function writeTelegramConfig(cfg) { writePrivateJson(TELEGRAM_FILE, cfg); }

// Low-level send with explicit creds (used by the test button before saving).
function sendTelegramRaw(botToken, chatId, text, callback) {
  callback = callback || (() => {});
  if (!botToken || !chatId) return callback('Telegram bot token and chat ID are required');
  const body = JSON.stringify({ chat_id: String(chatId), text, parse_mode: 'HTML', disable_web_page_preview: true });
  const req = https.request({
    hostname: 'api.telegram.org', port: 443, path: '/bot' + botToken + '/sendMessage', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      let p; try { p = JSON.parse(d); } catch { p = d; }
      if (res.statusCode >= 400 || (p && p.ok === false)) return callback((p && p.description) || ('Telegram HTTP ' + res.statusCode), p);
      callback(null, p);
    });
  });
  req.on('error', e => callback('Telegram error: ' + e.message));
  req.setTimeout(15000, () => req.destroy(new Error('Telegram request timed out')));
  req.write(body); req.end();
}

// Send using the saved config (no-op if alerts are off / not configured).
function sendTelegram(text, callback) {
  const cfg = readTelegramConfig();
  if (!cfg.enabled || !cfg.botToken || !cfg.chatId) return (callback || (() => {}))('Telegram not configured');
  sendTelegramRaw(cfg.botToken, cfg.chatId, text, callback);
}

// Read the bot's recent updates and return the chat ID of the latest message,
// so the user never has to visit @userinfobot - they just message the bot once.
function detectTelegramChat(botToken, callback) {
  if (!botToken) return callback('Enter your bot token first.');
  const req = https.request({ hostname: 'api.telegram.org', port: 443, path: '/bot' + botToken + '/getUpdates', method: 'GET' }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      let p; try { p = JSON.parse(d); } catch { p = null; }
      if (!p || p.ok === false) return callback((p && p.description) || ('Telegram HTTP ' + res.statusCode), null);
      const updates = Array.isArray(p.result) ? p.result : [];
      for (let i = updates.length - 1; i >= 0; i--) {
        const u = updates[i];
        const m = u.message || u.edited_message || u.channel_post || u.my_chat_member;
        if (m && m.chat && m.chat.id != null) {
          const c = m.chat;
          return callback(null, { chatId: String(c.id), name: c.title || [c.first_name, c.last_name].filter(Boolean).join(' ') || c.username || '' });
        }
      }
      callback('No message found yet. Open your bot in Telegram, send it any message (e.g. "hi"), then click Detect again.', null);
    });
  });
  req.on('error', e => callback('Telegram error: ' + e.message, null));
  req.setTimeout(15000, () => req.destroy(new Error('Telegram request timed out')));
  req.end();
}

// Watch broker token health and message once per state-change per day. Cheap:
// reads the already-computed statuses, sends at most a few messages a day.
function checkTelegramTokenAlerts() {
  const cfg = readTelegramConfig();
  if (!cfg.enabled || !cfg.botToken || !cfg.chatId || cfg.alerts?.brokerExpiry === false) return;
  const statuses = getAllBrokerTokenStatuses();
  const today = istDateKey();
  cfg.lastAlert = cfg.lastAlert || {};
  let changed = false;
  Object.entries(statuses).forEach(([brokerId, st]) => {
    if (!st || !st.configured) return;
    const state = (st.status === 'expired' || st.status === 'renew-failed' || st.status === 'near-expiry') ? st.status : null;
    if (!state) { if (cfg.lastAlert[brokerId]) { delete cfg.lastAlert[brokerId]; changed = true; } return; }
    const key = today + ':' + state;
    if (cfg.lastAlert[brokerId] === key) return; // already alerted for this state today
    cfg.lastAlert[brokerId] = key; changed = true;
    const name = TELEGRAM_BROKER_NAMES[brokerId] || brokerId;
    const head = state === 'expired' ? '🔴 ' + name + ' token expired'
      : state === 'renew-failed' ? '🟠 ' + name + ' token renewal failed'
      : '🟡 ' + name + ' token expiring soon';
    sendTelegram('<b>Stockkar — ' + head + '</b>\n' + (st.message || '') + '\nRe-login in Settings to keep your algos running.', () => {});
  });
  if (changed) writeTelegramConfig(cfg);
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
    renewalTimeIst: DHAN_RENEW_TIMES_IST.join(' & ') || (String(DHAN_RENEW_HOUR_IST).padStart(2, '0') + ':' + String(DHAN_RENEW_MINUTE_IST).padStart(2, '0')),
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
  if (!DHAN_RENEW_TIMES_IST.length) return;
  const now = getIstNow();
  const dateKey = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
  const nowMin = now.getHours() * 60 + now.getMinutes();
  // Slots already renewed today (reset automatically when the date changes).
  const doneSlots = (store.renewedSlots && store.renewedSlots.date === dateKey) ? (store.renewedSlots.slots || []) : [];
  // The earliest slot whose time has passed and that we haven't renewed yet today.
  const dueSlot = DHAN_RENEW_TIMES_IST.find(t => {
    const [h, m] = t.split(':').map(Number);
    return nowMin >= (h * 60 + m) && !doneSlots.includes(t);
  });
  if (!dueSlot) return;
  const status = getDhanTokenStatus();
  if (status.status === 'expired') return; // renewal needs a still-valid token
  renewStoredDhanToken('daily-' + dueSlot, (err) => {
    if (!err) {
      const latest = readDhanTokenStore();
      const prior = (latest.renewedSlots && latest.renewedSlots.date === dateKey) ? latest.renewedSlots.slots : [];
      latest.renewedSlots = { date: dateKey, slots: [...new Set([...prior, dueSlot])] };
      writeDhanTokenStore(latest);
    }
    console.log('[DHAN TOKEN]', err ? ('renew failed @' + dueSlot + ' IST: ' + err) : ('renewed @' + dueSlot + ' IST'));
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

// Parse the persistent Forever order id from a Forever-protected entry.
function dhanForeverIdFromEntry(entry) {
  if (entry?.dhanForeverId) return String(entry.dhanForeverId).trim();
  const m = String(entry?.orderId || '').match(/FOREVER:([^|\s]+)/i);
  return m ? m[1].trim() : '';
}

// Move-to-cost / trail for a Forever-protected Dhan hold: modify the SL leg of
// the persistent Forever order (PUT /v2/forever/orders/{id}). OCO keeps its
// target leg; SL-only (EMA trailing) just shifts the stop. The caller guarantees
// the SL never moves down.
function modifyDhanForeverStopLoss(entry, nextSl, callback) {
  const store = readDhanTokenStore();
  if (!store?.token) return callback('No Dhan token saved');
  const foreverId = dhanForeverIdFromEntry(entry);
  if (!foreverId) return callback('No Dhan Forever order id available');
  const emaTrailing = !!entry.emaTrailingEnabled;
  const slTrigger = roundPrice(nextSl);
  // SL leg is always market-on-trigger (matches placement); only raise its trigger.
  const payload = {
    dhanClientId: store.clientId,
    orderId: foreverId,
    orderFlag: emaTrailing ? 'SINGLE' : 'OCO',
    legName: 'STOP_LOSS_LEG',
    orderType: 'MARKET',
    quantity: Math.floor(Number(entry.qty || 0)),
    price: 0,
    triggerPrice: slTrigger,
    validity: 'DAY',
  };
  const body = JSON.stringify(payload);
  const req = https.request({ hostname: 'api.dhan.co', port: 443, path: '/v2/forever/orders/' + encodeURIComponent(foreverId), method: 'PUT',
    headers: { 'access-token': store.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, apiRes => {
    let data = ''; apiRes.on('data', c => data += c); apiRes.on('end', () => {
      let p; try { p = JSON.parse(data); } catch { p = data; }
      if (apiRes.statusCode >= 400) return callback(dhanApiMessage(p, 'Dhan Forever SL modify failed HTTP ' + apiRes.statusCode), { status: apiRes.statusCode, data: p, request: payload });
      callback(null, { status: apiRes.statusCode, data: p, request: payload });
    });
  });
  req.on('error', err => callback('Dhan Forever SL modify failed: ' + err.message, null));
  req.setTimeout(20000, () => req.destroy(new Error('Dhan Forever modify timed out')));
  req.write(body); req.end();
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

function angelOneSlLimitPrice(triggerPrice, bufferPct) {
  const trigger = Number(triggerPrice || 0);
  const pct = Number.isFinite(Number(bufferPct)) && Number(bufferPct) > 0 ? Number(bufferPct) : SL_LIMIT_BUFFER_PCT;
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
  angelRequest('POST', '/rest/secure/angelbroking/gtt/v1/createRule', store, accessToken, payload, (err, res) => {
    if (err) return callback('Angel One GTT create failed: ' + err, null);
    if (!res || res.status >= 400 || res.data?.status === false) {
      return callback('Angel One GTT create failed: ' + angelApiMessage(res?.data, 'HTTP ' + res?.status), res);
    }
    callback(null, res);
  });
}

function modifyAngelOneGttRule(store, accessToken, ruleId, params, callback) {
  const payload = { id: String(ruleId), ...buildAngelOneGttPayload(params) };
  angelRequest('POST', '/rest/secure/angelbroking/gtt/v1/modifyRule', store, accessToken, payload, (err, res) => {
    if (err) return callback('Angel One GTT modify failed: ' + err, null);
    if (!res || res.status >= 400 || res.data?.status === false) {
      return callback('Angel One GTT modify failed: ' + angelApiMessage(res?.data, 'HTTP ' + res?.status), res);
    }
    callback(null, res);
  });
}

function cancelAngelOneGttRule(store, accessToken, ruleId, callback) {
  if (!ruleId) return callback(null, { skipped: true });
  angelRequest('POST', '/rest/secure/angelbroking/gtt/v1/cancelRule', store, accessToken, { id: String(ruleId) }, (err, res) => {
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
    const entryId = entryRes?.data?.data?.order_id || entryRes?.data?.order_id || entryRes?.data?.data?.orderId || '';
    const ctx = { apiKey, accessToken, exchange, symbol, product, qty, entry, sl, target, emaTrailingMode,
      entryId, order: orderParams, entryForm, entryData: entryRes.data };
    // PROTECT AFTER FILL: place only the entry now; the protective GTT goes in
    // once the entry FILLS (placeProtectionForFilledZerodhaEntries).
    if (PROTECT_AFTER_FILL) {
      return callback(null, {
        status: entryRes.status, data: { entry: entryRes.data }, request: { entry: entryForm },
        awaitingFill: true, zerodhaEntryOrderId: entryId, softwareTargetTrailing: emaTrailingMode,
        pendingProtection: {
          broker: 'zerodha', exchange, symbol, product, qty, entry, sl, target, emaTrailingMode, entryId, entryForm,
          order: { symbol, entryPrice: entry, slPrice: sl, targetPrice: target, qty, t1Pct: orderParams.t1Pct, t1Qty: orderParams.t1Qty, t2Pct: orderParams.t2Pct, t1RR: orderParams.t1RR, t2RR: orderParams.t2RR, action: 'BUY' },
        },
      });
    }
    return placeZerodhaGttProtection(ctx, callback);
  });
}

// Place the protective GTT for a Zerodha long whose entry is in place. Extracted
// so it runs either immediately after entry acceptance (default) or once the
// entry FILLS (protect-after-fill reconcile). Result shape matches the broker
// extractors (extractPlacedOrderId / extractPlacedOrderLogFields for zerodha).
function placeZerodhaGttProtection(ctx, callback) {
  const { apiKey, accessToken, exchange, symbol, product, qty, entry, sl, target, emaTrailingMode, entryData, entryForm, order } = ctx;
  const sellLeg = (q, price) => ({ exchange, tradingsymbol: symbol, transaction_type: 'SELL', quantity: q, order_type: 'LIMIT', product, price: roundPrice(price) });
  const mkSingle = (q) => ({ type: 'single', condition: JSON.stringify({ exchange, tradingsymbol: symbol, trigger_values: [roundPrice(sl)], last_price: roundPrice(entry) }), orders: JSON.stringify([sellLeg(q, slLimitPrice(sl))]) });
  const mkTwoLeg = (q, tgt) => ({ type: 'two-leg', condition: JSON.stringify({ exchange, tradingsymbol: symbol, trigger_values: [roundPrice(sl), roundPrice(tgt)], last_price: roundPrice(entry) }), orders: JSON.stringify([sellLeg(q, slLimitPrice(sl)), sellLeg(q, tgt)]) });
  const gttTriggerId = (res) => res?.data?.data?.trigger_id || res?.data?.trigger_id || res?.data?.data?.triggerId || '';

  // Proven single GTT (today's path): two-leg OCO, or single SL when trailing.
  const placeSingle = () => {
    const gttForm = emaTrailingMode ? mkSingle(qty) : mkTwoLeg(qty, target);
    kitePost('/gtt/triggers', apiKey, accessToken, gttForm, (gttErr, gttRes) => {
      if (gttErr) return callback(gttErr, null);
      const ok = gttRes.status < 400;
      callback(ok ? null : 'Zerodha GTT failed: ' + JSON.stringify(gttRes.data), {
        status: gttRes.status,
        data: { entry: entryData, gtt: gttRes.data },
        request: { entry: entryForm, gtt: gttForm },
        softwareTargetTrailing: emaTrailingMode,
      });
    });
  };

  // "Split T1 at broker": two two-leg GTTs (legA = T1+SL booked, legB = T2+SL
  // runner). Any failure rolls back to the single GTT so protection is never lost.
  const splitPlan = (!emaTrailingMode && process.env.STOCKKAR_SPLIT_T1 !== '0') ? computeSplitBracket(order) : { split: false };
  if (!splitPlan.split) return placeSingle();
  kitePost('/gtt/triggers', apiKey, accessToken, mkTwoLeg(splitPlan.legA.qty, splitPlan.legA.target), (aErr, aRes) => {
    if (aErr || aRes.status >= 400) return placeSingle(); // nothing placed yet -> safe fallback
    const idA = gttTriggerId(aRes);
    kitePost('/gtt/triggers', apiKey, accessToken, mkTwoLeg(splitPlan.legB.qty, splitPlan.legB.target), (bErr, bRes) => {
      if (bErr || bRes.status >= 400) return zerodhaCancelGtt(idA, () => placeSingle()); // roll back legA, then fallback
      const idB = gttTriggerId(bRes);
      callback(null, {
        status: bRes.status,
        data: { entry: entryData, gttT1: aRes.data, gttT2: bRes.data },
        request: { entry: entryForm, gttT1: mkTwoLeg(splitPlan.legA.qty, splitPlan.legA.target), gttT2: mkTwoLeg(splitPlan.legB.qty, splitPlan.legB.target) },
        splitT1: true, zerodhaSplit: true,
        zerodhaGttT1Id: idA, zerodhaGttId: idB,
        splitLegAQty: splitPlan.legA.qty, splitLegBQty: splitPlan.legB.qty,
        softwareTargetOrder: false, softwareTargetTrailing: false,
      });
    });
  });
}

// Reconcile: for each Zerodha row awaiting its entry fill, read the order book
// and (a) place the GTT once the entry is COMPLETE, or (b) mark the row REJECTED
// (no GTT, no orphan) if the entry was rejected/cancelled.
function placeProtectionForFilledZerodhaEntries(callback) {
  const pending = readOrderLog().filter(e =>
    String(e.broker || '').toLowerCase() === 'zerodha' && e.awaitingFill && e.pendingProtection &&
    !e.testMode && e.source !== 'test' && isOpenOrderLogEntry(e));
  if (!pending.length) return callback(null, { changed: 0 });
  const store = readBrokerTokenStore().brokers.zerodha;
  if (!store?.clientId || !store?.accessToken) return callback('No Zerodha token saved');
  kiteGet('/orders', store.clientId, store.accessToken, (err, res) => {
    if (err) return callback('Zerodha order book failed: ' + err);
    if (!res || res.status >= 400) return callback('Zerodha order book failed: ' + JSON.stringify(res?.data || {}));
    const orders = kiteRows(res.data || []);
    const byId = {};
    orders.forEach(o => { const id = String(o.order_id || o.orderId || '').trim(); if (id) byId[id] = o; });
    let changed = 0;
    const queue = pending.slice();
    const step = () => {
      if (!queue.length) return callback(null, { changed });
      const row = queue.shift();
      const pp = row.pendingProtection || {};
      const o = byId[pp.entryId || row.zerodhaEntryOrderId];
      const st = String(o?.status || '').toUpperCase();
      const reason = String(o?.status_message || o?.status_message_raw || '');
      const filledSoFar = Math.floor(Number(o?.filled_quantity ?? o?.filledQuantity ?? 0));
      // REJECTED/CANCELLED with ZERO fills = no position. With fills > 0 (partial
      // fill, remainder cancelled) it FALLS THROUGH to the fill branch — those
      // shares are HELD and must be protected, never abandoned as "rejected".
      if (/REJECT|CANCEL/.test(st) && filledSoFar <= 0) {
        updateOrderLogRow(row.id, e => ({ ...e, awaitingFill: false, pendingProtection: null,
          status: 'REJECTED (entry ' + st.toLowerCase() + ' — no protection placed)', exitType: 'REJECTED',
          rejectionReason: reason || e.rejectionReason || '', lastStatusCheckAt: new Date().toISOString() }));
        changed++;
        if (/insufficient|funds|margin|low\s*balance/i.test(reason)) haltAlgoJobForError(row.jobId, reason || 'Insufficient funds');
        return step();
      }
      if (/COMPLETE/.test(st) || (/REJECT|CANCEL/.test(st) && filledSoFar > 0)) { // filled -> place GTT now
        // PARTIAL FILLS: protect the qty that actually FILLED (see the Dhan
        // equivalent) — an oversized GTT SELL would open a naked short.
        const orderedQty = Math.floor(Number(pp.qty || row.qty || 0));
        const filledQty = Math.floor(Number(o?.filled_quantity ?? o?.filledQuantity ?? 0)) || orderedQty;
        const fillPx = Number(o?.average_price || o?.averagePrice || 0);
        if (filledQty > 0 && orderedQty > 0 && filledQty < orderedQty) {
          updateOrderLogRow(row.id, e => ({ ...e, qty: filledQty,
            reconcileNote: 'PARTIAL FILL: ' + filledQty + '/' + orderedQty + ' filled — protection sized to ' + filledQty + '.' }));
          sendTelegram('🟠 <b>Stockkar — ' + (pp.symbol || row.symbol) + ' PARTIAL FILL</b>\n' + filledQty + ' of ' + orderedQty + ' filled. GTT protection is being placed for ' + filledQty + ' only.', () => {});
        }
        const ctx = { apiKey: store.clientId, accessToken: store.accessToken, exchange: pp.exchange, symbol: pp.symbol,
          product: pp.product, qty: filledQty, entry: fillPx > 0 ? fillPx : pp.entry, sl: pp.sl, target: pp.target, emaTrailingMode: pp.emaTrailingMode,
          entryId: pp.entryId, order: { ...(pp.order || {}), qty: filledQty }, entryForm: pp.entryForm || {}, entryData: { data: { order_id: pp.entryId } } };
        placeZerodhaGttProtection(ctx, (protErr, prot) => {
          if (!prot) {  // transport/throw with no result -> leave pending, retry next cycle
            updateOrderLogRow(row.id, e => ({ ...e, lastStatusCheckAt: new Date().toISOString(), lastTrailError: 'GTT retry: ' + protErr }));
            return step();
          }
          const newFields = extractPlacedOrderLogFields('zerodha', prot);
          const newId = extractPlacedOrderId('zerodha', prot);
          const newStatus = protErr ? ('ENTRY PLACED BUT PROTECTION FAILED: ' + protErr) : scheduledOrderStatusText('zerodha', null, prot);
          updateOrderLogRow(row.id, e => ({ ...e, ...newFields, awaitingFill: false, pendingProtection: null,
            ...(fillPx > 0 ? { entryPrice: fillPx } : {}),     // broker-truth entry price (incl. slippage)
            orderId: newId && newId !== 'N/A' ? newId : e.orderId, status: newStatus, lastStatusCheckAt: new Date().toISOString() }));
          changed++;
          step();
        });
        return;
      }
      return step();                                         // still pending -> leave
    };
    step();
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
        if (isTimeout(cfgErr)) return callback('Stockkar API not responding (timed out). Re-login your Stockkar token in Settings, then try again.');
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

  const isTimeout = (e) => /timed out/i.test(String(e || ''));
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
      // Host unresponsive: don't stack timeouts across every candidate path.
      if (isTimeout(result?.err)) return callback('Stockkar API not responding (timed out). Re-login your Stockkar token in Settings, then try again.');
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

// Read a score column, preferring the saved-screener "_END" column when present
// (a saved screener row carries BIG_PLAYER_SCORE_START/_END etc., not the plain
// big_player_score live column). Falls back to the live column so both sources
// work. Only Big Player / Momentum / Growth use the END column (per request).
function scoreFieldWithEnd(row, endKeys, baseKeys) {
  const end = findTechnicalField(row, endKeys);
  if (end !== undefined && end !== null && String(end).trim() !== '') return numberFromValue(end);
  return numberFromValue(findTechnicalField(row, baseKeys));
}

function getStockkarScoreValue(indicator, row) {
  const key = String(indicator || '').toLowerCase();
  if (key === 'big_player_score') {
    return scoreFieldWithEnd(row,
      ['big_player_score_end', 'bigplayer_score_end', 'big player score end'],
      ['big_player_score', 'bigplayer_score', 'big_player', 'bigplayer', 'big player score', 'Big Player Score', 'big player']);
  }
  if (key === 'growth_score') {
    return scoreFieldWithEnd(row,
      ['growth_score_end', 'growth score end'],
      ['growth_score', 'growth', 'Growth Score', 'growth score']);
  }
  if (key === 'momentum_score') {
    return scoreFieldWithEnd(row,
      ['momentum_score_end', 'momentum score end'],
      ['momentum_score', 'momentum', 'Momentum Score', 'momentum score']);
  }
  if (key === 'returns_efficiency') {
    return numberFromValue(findTechnicalField(row, [
      'returns_efficiency', 'returns_efficiency_score', 'returns efficiency', 'returns efficiency score',
      'Returns Efficiency', 'Returns Efficiency Score', 'return_efficiency', 'return_efficiency_score'
    ]));
  }
  if (key === 'long_term') {
    return numberFromValue(findTechnicalField(row, [
      'long_term_growth_score', 'long term growth score',   // saved/custom screener column
      'long_term', 'long_term_score', 'long term', 'long term score',
      'Long Term', 'Long Term Score'
    ]));
  }
  if (key === 'short_term') {
    return numberFromValue(findTechnicalField(row, [
      'short_term_growth_score', 'short term growth score',  // saved/custom screener column
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
  if (key === 'returns_efficiency') return 'Performance Meter';
  if (key === 'long_term') return 'Growth Compounder Meter';
  if (key === 'short_term') return 'Near Term Growth Meter';
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

// ---- EMA crossover support (daily snapshot history) ------------------------
function readEmaHistory() { return readJsonFile(EMA_HISTORY_FILE, {}) || {}; }

// Save today's EMA values for each scanned symbol, once per day (first scan of
// the day wins). One small file write per day; later scans skip. Zero extra
// network calls - it reuses the EMAs the scan already fetched.
function recordEmaSnapshotBatch(tvData) {
  if (!Array.isArray(tvData) || !tvData.length) return;
  const hist = readEmaHistory();
  const today = istDateKey();
  let changed = false;
  tvData.forEach(s => {
    const sym = String(s.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
    if (!sym) return;
    const snap = { date: today };
    let any = false;
    EMA_CROSS_PERIODS.forEach(p => { const v = Number(s['ema' + p]); if (Number.isFinite(v) && v > 0) { snap['e' + p] = v; any = true; } });
    if (!any) return;
    const arr = Array.isArray(hist[sym]) ? hist[sym] : [];
    if (arr.length && arr[arr.length - 1].date === today) return; // already saved today
    arr.push(snap);
    hist[sym] = arr.slice(-EMA_HISTORY_KEEP_DAYS);
    changed = true;
  });
  if (changed) { try { writePrivateJson(EMA_HISTORY_FILE, hist); } catch {} }
}

// Bullish crossover of fast EMA above slow EMA within the last `lookbackDays`:
// fast is now >= slow, and on a saved day inside the window fast was < slow.
function detectEmaCrossover(stock, hist, fast, slow, lookbackDays) {
  const fNow = Number(stock['ema' + fast]);
  const sNow = Number(stock['ema' + slow]);
  if (!Number.isFinite(fNow) || !Number.isFinite(sNow) || !(fNow >= sNow)) return false;
  const sym = String(stock.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const arr = (hist && hist[sym]) || [];
  if (!arr.length) return false; // no history yet (warms up over a few days)
  const cutoff = istDateKey(new Date(getIstNow().getTime() - (Number(lookbackDays) || 3) * 24 * 60 * 60 * 1000));
  // Any saved day within the window where fast was below slow => it has crossed up since.
  return arr.some(d => d.date >= cutoff && Number.isFinite(d['e' + fast]) && Number.isFinite(d['e' + slow]) && d['e' + fast] < d['e' + slow]);
}

function buildAlgoCandidates(tvData, cfg) {
  recordEmaSnapshotBatch(tvData);
  const emaHistory = readEmaHistory();
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
      if (String(filter.indicator) === 'cross') {
        const fast = Number(filter.fast), slow = Number(filter.slow), lb = Number(filter.lookbackDays || 3);
        const pass = detectEmaCrossover(stock, emaHistory, fast, slow, lb);
        return {
          indicator: 'cross', type: 'cross', fast, slow, lookbackDays: lb, value: NaN, distancePct: NaN, signal: null,
          pass,
          text: 'EMA ' + fast + ' crossed above EMA ' + slow + ' in last ' + lb + 'd' + (pass ? '' : ' (no cross)'),
        };
      }
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
    const noSl = slMethod === 'none';
    const slBase = slMethod === 'indicator' ? getIndicatorValue(cfg.slIndicator, stock, row) : ltp;
    // No-SL: no protective stop; exit comes from the T1/T2 (%) targets. The
    // broker "target" then uses T2% (so a gap to T2 still exits broker-side).
    const slPrice = noSl ? 0 : (slMethod === 'indicator' && slBase ? slBase * (1 - slIndicatorPct / 100) : ltp * (1 - slPct / 100));
    const slDistance = ltp - slPrice;
    const t1PctCfg = Number(cfg.t1Pct || 0);
    const t1QtyCfg = Number(cfg.t1Qty || 0);
    const t2PctCfg = Number(cfg.t2Pct || 0);
    // No-SL exits via the T1/T2 (%) targets. The shown/broker "target" is the
    // FULL-exit price: if T1 books the whole position (100% qty) it exits at T1;
    // otherwise the remainder exits at T2 (fall back to T1 if T2 is blank).
    const noSlExitPct = (t1QtyCfg >= 100 && t1PctCfg > 0) ? t1PctCfg : (t2PctCfg > 0 ? t2PctCfg : t1PctCfg);
    const targetPrice = noSl ? (noSlExitPct > 0 ? ltp * (1 + noSlExitPct / 100) : 0) : ltp + (slDistance * rrRatio);
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

// Rank qualified candidates "best risk entry" first so the top-N picked under
// Max Open Positions are the lowest-risk entries: closest to the entry EMA
// (smallest distance % = least extended), tie-broken by the tightest stop.
function rankByRiskEntry(candidates) {
  return [...candidates].sort((a, b) => {
    const da = Number(a.distancePct), db = Number(b.distancePct);
    const va = Number.isFinite(da) ? da : Infinity, vb = Number.isFinite(db) ? db : Infinity;
    if (va !== vb) return va - vb;                                            // closest to EMA first
    return (Number(a.slPct) || Infinity) - (Number(b.slPct) || Infinity);    // then tightest stop
  });
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
  // Protect-after-fill: entry placed, protection still pending. The row carries
  // just the entry id (so it counts as open and the reconcile can find it).
  if (orderRes?.awaitingFill) {
    const b = String(broker || '').toLowerCase();
    if (b === 'dhan') return orderRes.dhanEntryOrderId ? 'ENTRY:' + orderRes.dhanEntryOrderId : 'N/A';
    if (b === 'zerodha') return orderRes.zerodhaEntryOrderId ? 'ENTRY:' + orderRes.zerodhaEntryOrderId : 'N/A';
  }
  if (broker === 'zerodha') {
    const entryId = data.entry?.data?.order_id || data.entry?.order_id || data.entry?.data?.orderId || '';
    if (orderRes?.zerodhaSplit) {
      return [entryId && ('ENTRY:' + entryId), orderRes.zerodhaGttT1Id && ('GTT-T1:' + orderRes.zerodhaGttT1Id), orderRes.zerodhaGttId && ('GTT:' + orderRes.zerodhaGttId)].filter(Boolean).join(' | ') || 'N/A';
    }
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
  // Dhan Forever bracket: entry order id + persistent Forever order id(s).
  if (broker === 'dhan' && String(orderRes?.dhanProtection || '').startsWith('forever')) {
    return [
      orderRes.dhanEntryOrderId && ('ENTRY:' + orderRes.dhanEntryOrderId),
      orderRes.dhanForeverT1Id && ('FOREVER-T1:' + orderRes.dhanForeverT1Id),
      orderRes.dhanForeverId && ('FOREVER:' + orderRes.dhanForeverId),
    ].filter(Boolean).join(' | ') || 'N/A';
  }
  if (broker === 'fyers') {
    return [
      orderRes?.fyersEntryOrderId && ('ENTRY:' + orderRes.fyersEntryOrderId),
      orderRes?.fyersGttT1Id && ('GTT-T1:' + orderRes.fyersGttT1Id),
      orderRes?.fyersGttId && ('GTT:' + orderRes.fyersGttId),
    ].filter(Boolean).join(' | ') || 'N/A';
  }
  return data.orderId || data.order_id || data.data?.orderId || 'N/A';
}

function extractPlacedOrderLogFields(broker, orderRes) {
  const b = String(broker || '').toLowerCase();
  // Protect-after-fill: persist the awaiting-fill marker + the plan so the
  // reconcile can place protection once the entry fills.
  if (orderRes?.awaitingFill) {
    const f = { awaitingFill: true, pendingProtection: orderRes.pendingProtection || null };
    if (b === 'dhan') Object.assign(f, { dhanProtection: orderRes.dhanProtection || 'forever', dhanEntryOrderId: orderRes.dhanEntryOrderId || '', dhanForeverId: '', softwareTargetTrailing: !!orderRes.softwareTargetTrailing });
    if (b === 'zerodha') Object.assign(f, { zerodhaEntryOrderId: orderRes.zerodhaEntryOrderId || '' });
    return f;
  }
  if (b === 'dhan' && String(orderRes?.dhanProtection || '').startsWith('forever')) {
    return {
      dhanProtection: orderRes.dhanProtection,        // 'forever' or 'forever-split'
      dhanForeverId: orderRes.dhanForeverId || '',
      dhanEntryOrderId: orderRes.dhanEntryOrderId || '',
      softwareTargetOrder: !!orderRes.softwareTargetOrder,
      softwareTargetTrailing: !!orderRes.softwareTargetTrailing,
      // Split-T1 extras (present only for forever-split): the booked-half OCO id
      // and per-leg quantities, so the split-aware reconcile can track both legs.
      ...(orderRes.splitT1 ? { splitT1: true, dhanForeverT1Id: orderRes.dhanForeverT1Id || '', splitLegAQty: orderRes.splitLegAQty, splitLegBQty: orderRes.splitLegBQty } : {}),
    };
  }
  if (b === 'zerodha' && orderRes?.zerodhaSplit) {
    return { zerodhaSplit: true, splitT1: true, zerodhaGttT1Id: orderRes.zerodhaGttT1Id || '', zerodhaGttId: orderRes.zerodhaGttId || '', splitLegAQty: orderRes.splitLegAQty, splitLegBQty: orderRes.splitLegBQty };
  }
  if (b === 'fyers') {
    return {
      fyersEntryOrderId: orderRes?.fyersEntryOrderId || '',
      fyersGttId: orderRes?.fyersGttId || '',
      softwareTargetOrder: !!orderRes?.softwareTargetOrder,
      softwareTargetTrailing: !!orderRes?.softwareTargetTrailing,
      ...(orderRes?.fyersSplit ? { fyersSplit: true, splitT1: true, fyersGttT1Id: orderRes.fyersGttT1Id || '', splitLegAQty: orderRes.splitLegAQty, splitLegBQty: orderRes.splitLegBQty } : {}),
    };
  }
  if (b !== 'angelone') return {};
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
  // Protect-after-fill: entry placed, protection goes in once it fills. (Worded
  // so isOpenOrderLogEntry keeps it OPEN — no FAIL/REJECT/CANCEL token.)
  if (orderRes?.awaitingFill) return String(broker || '').toUpperCase() + ' ENTRY PENDING — awaiting fill, protection on fill';
  if (broker === 'zerodha' && orderRes?.zerodhaSplit) return 'ZERODHA ENTRY + 2x GTT OCO (T1/T2 split)';
  if (broker === 'zerodha') return 'ZERODHA ENTRY + GTT';
  if (broker === 'upstox') return 'UPSTOX COMING SOON';
  if (broker === 'angelone') return 'ANGEL ENTRY + SL GTT';
  if (broker === 'fyers' && orderRes?.fyersSplit) return 'FYERS ENTRY + 2x GTT OCO (T1/T2 split)';
  if (broker === 'fyers') return orderRes?.softwareTargetTrailing ? 'FYERS ENTRY + GTT SL' : 'FYERS ENTRY + GTT OCO';
  if (broker === 'dhan' && orderRes?.dhanProtection === 'forever-split') return 'DHAN ENTRY + 2x FOREVER OCO (T1/T2 split)';
  if (broker === 'dhan' && orderRes?.dhanProtection === 'forever') return orderRes.softwareTargetTrailing ? 'DHAN ENTRY + FOREVER SL' : 'DHAN ENTRY + FOREVER OCO';
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
  if (!['dhan', 'zerodha', 'angelone', 'fyers'].includes(broker)) return false;
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
  if (broker === 'dhan') return entry.dhanProtection === 'forever'
    ? modifyDhanForeverStopLoss(entry, nextSl, callback)
    : modifyDhanSuperOrderStopLoss(entry, nextSl, callback);
  if (broker === 'zerodha') return modifyZerodhaGttStopLoss(entry, nextSl, callback);
  if (broker === 'angelone') return modifyAngelOneGttStopLoss(entry, nextSl, callback);
  if (broker === 'fyers') return modifyFyersGttStopLoss(entry, nextSl, callback);
  callback('EMA trailing not implemented for ' + broker);
}

let emaTrailingTargetCheckInFlight = false;
let emaTrailingTargetLastCheckAt = 0;
function checkEmaTrailingTargetTriggers() {
  if (emaTrailingTargetCheckInFlight || Date.now() - emaTrailingTargetLastCheckAt < 60 * 1000) return;
  const rows = readOrderLog();
  const candidates = rows.filter(entry => {
    const broker = String(entry.broker || 'dhan').toLowerCase();
    return ['dhan', 'zerodha', 'angelone', 'fyers'].includes(broker) &&
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
  const runnerOnly = !!entry.splitT1 && !!entry.mtmT1Done;
  const qty = Number(runnerOnly ? entry.splitLegBQty || 0 : entry.qty || 0);
  const entryPrice = Number(entry.entryPrice || entry.price || 0);
  // Re-place at the HIGHEST stop reached so cancelling/restoring never drops a
  // trailed stop back down. For a long, the trailed SL sits above the original.
  const sl = Math.max(Number(entry.slPrice || 0), Number(entry.lastTrailSlPrice || 0), Number(entry.brokerSlPrice || 0));
  const target = Number(entry.targetPrice || 0);
  if (!symbol || !qty || !entryPrice || !sl) return callback('Missing Zerodha SL restore fields');
  const exchange = entry.exchange || 'NSE';
  const product = entry.segment === 'INTRADAY' ? 'MIS' : 'CNC';
  const emaMode = isPostTargetEmaTrailingOrder(entry);
  const orders = [{ exchange, tradingsymbol: symbol, transaction_type: 'SELL', quantity: qty, order_type: 'LIMIT', product, price: slLimitPrice(sl) }];
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
    callback(null, runnerOnly
      ? { orderId: newOrderId, zerodhaGttId: gttId, zerodhaGttT1Id: '', brokerSlPrice: roundPrice(sl) } // keep splitT1/zerodhaSplit -> split reconcile owns the runner
      : { orderId: newOrderId, zerodhaGttId: gttId, splitT1: false, zerodhaSplit: false, brokerSlPrice: roundPrice(sl) });
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

// Re-place a missing Dhan Forever stop. Split-aware: once T1 has booked we only
// re-arm the runner (legB) qty. Consolidates back to a single Forever so the
// normal (not split) reconcile manages it from here.
function restoreDhanStop(entry, callback) {
  const store = readDhanTokenStore();
  if (!store?.token || !store?.clientId) return callback('No Dhan token saved');
  const symbol = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const runnerOnly = !!entry.splitT1 && !!entry.mtmT1Done;
  const qty = Math.floor(runnerOnly ? Number(entry.splitLegBQty || 0) : Number(entry.qty || 0));
  const sl = Math.max(Number(entry.slPrice || 0), Number(entry.lastTrailSlPrice || 0), Number(entry.brokerSlPrice || 0));
  const target = Number(entry.targetPrice || 0);
  if (!symbol || !qty || !sl) return callback('Missing Dhan SL restore fields');
  loadDhanSecurityMap((lookupErr, securityMap) => {
    if (lookupErr) return callback('Security lookup failed: ' + lookupErr);
    const exchange = entry.exchange === 'BSE' ? 'BSE' : 'NSE';
    const securityId = entry.securityId || (securityMap && (securityMap[exchange + ':' + symbol] || securityMap[symbol]));
    if (!securityId) return callback('Security ID not found for ' + symbol);
    const segPart = exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ';
    const product = entry.segment || 'CNC';
    const slTrigger = roundPrice(sl);
    const useOco = !isPostTargetEmaTrailingOrder(entry) && target > slTrigger;
    const payload = useOco
      ? { dhanClientId: store.clientId, orderFlag: 'OCO', transactionType: 'SELL', exchangeSegment: segPart, productType: product, orderType: 'MARKET', validity: 'DAY', securityId: String(securityId), quantity: qty, price: 0, triggerPrice: slTrigger, price1: 0, triggerPrice1: roundPrice(target), quantity1: qty }
      : { dhanClientId: store.clientId, orderFlag: 'SINGLE', transactionType: 'SELL', exchangeSegment: segPart, productType: product, orderType: 'MARKET', validity: 'DAY', securityId: String(securityId), quantity: qty, price: 0, triggerPrice: slTrigger };
    dhanPost('/v2/forever/orders', store.token, payload, (err, res) => {
      if (err || (res && res.status >= 400)) return callback('Dhan SL re-place failed: ' + (err || dhanApiMessage(res?.data, 'HTTP ' + res?.status)));
      const fid = res.data?.orderId || res.data?.data?.orderId || '';
      if (!fid) return callback('Dhan SL re-place returned no Forever id');
      const eId = (String(entry.orderId || '').match(/ENTRY:([^|\s]+)/i) || [])[1] || entry.dhanEntryOrderId || '';
      const newOrderId = [eId && ('ENTRY:' + eId), 'FOREVER:' + fid].filter(Boolean).join(' | ');
      // runnerOnly (T1 already booked): keep the split model so software never
      // double-manages T2. Full re-arm: consolidate to a normal single Forever.
      callback(null, runnerOnly
        ? { orderId: newOrderId, dhanForeverId: fid, dhanForeverT1Id: '', dhanProtection: 'forever-split', splitT1: true, brokerSlPrice: slTrigger }
        : { orderId: newOrderId, dhanForeverId: fid, dhanForeverT1Id: '', dhanProtection: 'forever', splitT1: false, brokerSlPrice: slTrigger });
    });
  });
}

// Re-place a missing FYERS GTT stop. Split-aware like the Dhan/Zerodha restores.
function restoreFyersStop(entry, callback) {
  const symRaw = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const runnerOnly = !!entry.splitT1 && !!entry.mtmT1Done;
  const qty = Math.floor(runnerOnly ? Number(entry.splitLegBQty || 0) : Number(entry.qty || 0));
  const sl = Math.max(Number(entry.slPrice || 0), Number(entry.lastTrailSlPrice || 0), Number(entry.brokerSlPrice || 0));
  const target = Number(entry.targetPrice || 0);
  if (!symRaw || !qty || !sl) return callback('Missing FYERS SL restore fields');
  const fsym = fyersSymbol(symRaw, entry.exchange);
  const useOco = !isPostTargetEmaTrailingOrder(entry) && target > sl;
  const gttPayload = useOco
    ? { side: -1, symbol: fsym, productType: 'CNC', orderInfo: { leg1: { price: roundPrice(target), triggerPrice: roundPrice(target), qty }, leg2: { price: slLimitPrice(sl), triggerPrice: roundPrice(sl), qty } } }
    : { side: -1, symbol: fsym, productType: 'CNC', orderInfo: { leg1: { price: slLimitPrice(sl), triggerPrice: roundPrice(sl), qty } } };
  fyersTradeRequest('POST', '/gtt/orders/sync', gttPayload, (err, res) => {
    if (err || res.status >= 400 || res.data?.s !== 'ok') return callback('FYERS SL re-place failed: ' + (err || fyersApiMsg(res, 'HTTP ' + res?.status)));
    const gttId = res.data?.id || res.data?.data?.id || '';
    if (!gttId) return callback('FYERS SL re-place returned no GTT id');
    const eId = (String(entry.orderId || '').match(/ENTRY:([^|\s]+)/i) || [])[1] || entry.fyersEntryOrderId || '';
    const newOrderId = [eId && ('ENTRY:' + eId), 'GTT:' + gttId].filter(Boolean).join(' | ');
    callback(null, runnerOnly
      ? { orderId: newOrderId, fyersGttId: gttId, fyersGttT1Id: '', brokerSlPrice: roundPrice(sl) }   // keep splitT1/fyersSplit so the split reconcile manages the runner
      : { orderId: newOrderId, fyersGttId: gttId, fyersGttT1Id: '', splitT1: false, fyersSplit: false, brokerSlPrice: roundPrice(sl) });
  });
}

function restoreBrokerStop(entry, callback) {
  const broker = String(entry.broker || 'dhan').toLowerCase();
  if (broker === 'zerodha') return restoreZerodhaStop(entry, callback);
  if (broker === 'angelone') return restoreAngelStop(entry, callback);
  if (broker === 'dhan') return restoreDhanStop(entry, callback);
  if (broker === 'fyers') return restoreFyersStop(entry, callback);
  callback('Auto SL restore not supported for ' + broker);
}

// A Dhan entry whose Forever protection failed at placement: the BUY went
// through but the stop never got on the broker (status shows "...protection
// FAILED", no Forever id). isOpenOrderLogEntry treats it as closed (it has
// "FAILED"), so the normal restore would skip it - this brings it back in so the
// recovery re-arms the stop.
function isDhanForeverMissing(entry) {
  if (String(entry.broker || 'dhan').toLowerCase() !== 'dhan') return false;
  if (entry.manualClose || dhanForeverIdFromEntry(entry)) return false;
  const st = String(entry.status || '') + ' ' + String(entry.exitType || '');
  if (/(TARGET HIT|SL HIT|EXITED|CLOSED)/i.test(st)) return false;
  return /Forever protection.*FAIL|Add a manual stop in Dhan/i.test(String(entry.status || '') + ' ' + String(entry.rejectionReason || ''));
}

let restoreStopsInFlight = false;
let restoreStopsLastAt = 0;
function checkAndRestoreBrokerStops() {
  if (restoreStopsInFlight || Date.now() - restoreStopsLastAt < 60 * 1000) return;
  const openRows = readOrderLog().filter(entry => {
    const broker = String(entry.broker || 'dhan').toLowerCase();
    return ['zerodha', 'angelone', 'dhan', 'fyers'].includes(broker) &&
      !entry.testMode && entry.source !== 'test' &&
      Number(entry.slPrice || 0) > 0 &&
      (isOpenOrderLogEntry(entry) || isDhanForeverMissing(entry)) &&
      Number(entry.slRestoreAttempts || 0) < SL_RESTORE_MAX_ATTEMPTS;
  });
  if (!openRows.length) return;
  restoreStopsInFlight = true;
  restoreStopsLastAt = Date.now();

  // Per broker present, what currently protects each position (so we never place
  // a duplicate). zerodha/fyers: SYMBOLS with an active GTT. dhan: active Forever
  // ORDER IDs + held symbols (only re-arm a still-open position). angel:
  // per-entry entryHasBrokerStop. Any list we can't fetch stays null -> that
  // broker is skipped this cycle (never place blind).
  const ctx = { zerodha: null, fyers: null, dhanActive: null, dhanHeld: null };
  const allForeverIds = (entry) => {
    const out = [];
    [entry.dhanForeverId, entry.dhanForeverT1Id].forEach(v => { if (v) out.push(String(v).trim()); });
    const re = /FOREVER(?:-T1)?:([^|\s]+)/gi; let m;
    while ((m = re.exec(String(entry.orderId || '')))) out.push(m[1].trim());
    return [...new Set(out.filter(Boolean))];
  };

  const runRestores = () => {
    const claimedThisRun = new Set();
    const onCooldown = (sym) => {
      const ts = slRestoreRecent.get(sym);
      return ts && (Date.now() - ts) < SL_RESTORE_COOLDOWN_MS;
    };
    const candidates = openRows.filter(entry => {
      const broker = String(entry.broker || 'dhan').toLowerCase();
      const sym = String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
      if (onCooldown(sym) || claimedThisRun.has(sym)) return false; // cross-cycle + per-cycle dedup
      if (broker === 'angelone') {
        if (!entryHasBrokerStop(entry)) { claimedThisRun.add(sym); return true; }
        return false;
      }
      if (broker === 'zerodha') {
        if (!ctx.zerodha || ctx.zerodha.has(sym)) return false; // unverified or still protected
        claimedThisRun.add(sym); return true;
      }
      if (broker === 'fyers') {
        if (!ctx.fyers || ctx.fyers.has(sym)) return false;
        claimedThisRun.add(sym); return true;
      }
      if (broker === 'dhan') {
        if (!ctx.dhanActive || !ctx.dhanHeld) return false;             // couldn't verify -> skip
        if (!ctx.dhanHeld.has(sym)) return false;                       // not held -> position closed, don't restore
        if (ctx.dhanActive.syms.has(sym)) return false;                 // symbol already has an active Forever (robust, like Zerodha)
        if (allForeverIds(entry).some(id => ctx.dhanActive.ids.has(id))) return false; // belt-and-suspenders by id
        claimedThisRun.add(sym); return true;
      }
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
            rejectionReason: '',
            // A recovered protection-failure must get a CLEAN status (drop the
            // "...protection FAILED" text) so it reads as a healthy open position
            // again; otherwise isOpenOrderLogEntry keeps treating it as closed.
            status: isDhanForeverMissing(entry)
              ? ('DHAN ENTRY + FOREVER ' + (entry.emaTrailingEnabled ? 'SL' : 'OCO') + ' (recovered) @' + patch.brokerSlPrice)
              : ((entry.status || '').replace(/ \| UNPROTECTED[^|]*/g, '').trim() + ' | SL RESTORED @' + patch.brokerSlPrice).trim(),
          });
          slRestoreRecent.set(String(entry.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase(), Date.now());
          console.log('[SL RESTORE] ' + entry.symbol + ' re-placed SL @' + patch.brokerSlPrice);
        }
        next();
      });
    };
    next();
  };

  // --- Fetch each present broker's live protection list in parallel, then run.
  const need = b => openRows.some(e => String(e.broker || 'dhan').toLowerCase() === b);
  const fetchZerodhaActive = (cb) => {
    const z = readBrokerTokenStore().brokers.zerodha;
    if (!z?.clientId || !z?.accessToken) return cb(null);
    kiteGet('/gtt/triggers', z.clientId, z.accessToken, (err, res) => {
      if (err || !res || res.status >= 400) return cb(null);
      const rows = kiteRows(res.data);
      if (!rows.length && !Array.isArray(res.data?.data)) return cb(null);
      const set = new Set();
      rows.forEach(t => {
        const st = String(t.status || '').toLowerCase();
        if (st !== 'active' && st !== 'triggered') return;
        let cond = t.condition; if (typeof cond === 'string') { try { cond = JSON.parse(cond); } catch { cond = {}; } }
        const sym = String(cond?.tradingsymbol || cond?.tradingSymbol || '').replace(/\s/g, '').toUpperCase();
        if (sym) set.add(sym);
      });
      cb(set);
    });
  };
  const fetchFyersActive = (cb) => {
    const f = readBrokerTokenStore().brokers.fyers;
    if (!f?.clientId || !f?.accessToken) return cb(null);
    fyersTradeRequest('GET', '/gtt/orders', null, (err, res) => {
      if (err || !res || res.status >= 400) return cb(null);
      const list = Array.isArray(res.data?.data) ? res.data.data : (Array.isArray(res.data) ? res.data : []);
      if (!Array.isArray(list)) return cb(null);
      const set = new Set();
      list.forEach(g => {
        const st = String(g.status || g.orderStatus || '').toLowerCase();
        if (/cancel|reject|expire|complete|triggered/.test(st)) return; // only still-pending GTTs protect
        const sym = String(g.symbol || '').replace(/^(NSE|BSE):/i, '').replace('-EQ', '').replace(/\s/g, '').toUpperCase();
        if (sym) set.add(sym);
      });
      cb(set);
    });
  };
  const fetchDhanActive = (cb) => {
    const store = readDhanTokenStore();
    if (!store?.token) return cb(null);
    const r = https.request({ hostname: 'api.dhan.co', port: 443, path: '/v2/forever/all', method: 'GET', headers: { 'access-token': store.token, 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => {
        let p; try { p = JSON.parse(d); } catch { p = null; }
        if (res.statusCode >= 400) return cb(null);
        const list = Array.isArray(p) ? p : (Array.isArray(p?.data) ? p.data : []);
        // Collect active Forevers by SYMBOL (robust, like Zerodha — a stored id
        // can be lost on a concurrent write) AND by id (belt-and-suspenders).
        const syms = new Set(), ids = new Set();
        list.forEach(o => {
          const st = String(o.orderStatus || o.status || '').toUpperCase();
          if (/TRADED|CANCELLED|REJECTED|EXPIRED/.test(st)) return; // only still-active Forevers protect
          const sym = String(o.tradingSymbol || o.symbol || '').replace(/^(NSE|BSE):/i, '').replace('-EQ', '').replace(/\s/g, '').toUpperCase();
          if (sym) syms.add(sym);
          const id = String(o.orderId || '').trim();
          if (id) ids.add(id);
        });
        cb({ syms, ids });
      });
    });
    r.on('error', () => cb(null));
    r.setTimeout(15000, () => r.destroy());
    r.end();
  };

  const jobs = [];
  if (need('zerodha')) jobs.push(cb => fetchZerodhaActive(s => { ctx.zerodha = s; cb(); }));
  if (need('fyers')) jobs.push(cb => fetchFyersActive(s => { ctx.fyers = s; cb(); }));
  if (need('dhan')) {
    jobs.push(cb => fetchDhanActive(s => { ctx.dhanActive = s; cb(); }));
    jobs.push(cb => fetchDhanHeldSymbols((e, s) => { ctx.dhanHeld = e ? null : s; cb(); }));
  }
  if (!jobs.length) return runRestores();
  let done = 0;
  jobs.forEach(j => j(() => { if (++done === jobs.length) runRestores(); }));
}

// ---- Test Mode paper-trading simulator -------------------------------------
// Test orders place nothing live, but we still simulate the trade so the Order
// Log shows a live unrealised P&L, then a TARGET HIT / SL HIT / EOD exit with a
// realised P&L - just like a real run, for backtest-style confidence.
const TEST_EOD_MIN = (() => {
  const m = String(process.env.TEST_EOD_IST || '15:20').match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 15 * 60 + 20;
})();
let testSimInFlight = false;
let testSimLastAt = 0;
// Build a paper protective result with the SAME shape the live placement
// functions return (so the row built from it via extractPlacedOrderId /
// extractPlacedOrderLogFields / scheduledOrderStatusText is byte-identical to a
// live row). Split vs single is decided by the same computeSplitBracket as live.
function paperProtectionResult(broker, entry, entryId, emaTrailingMode) {
  const fid = () => 'PAPER-PROT-' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
  const b = String(broker || 'dhan').toLowerCase();
  const splitPlan = (!emaTrailingMode && process.env.STOCKKAR_SPLIT_T1 !== '0') ? computeSplitBracket(entry) : { split: false };
  if (b === 'zerodha') {
    if (splitPlan.split) return { status: 200, zerodhaSplit: true, splitT1: true, zerodhaGttT1Id: fid(), zerodhaGttId: fid(), splitLegAQty: splitPlan.legA.qty, splitLegBQty: splitPlan.legB.qty, data: { entry: { data: { order_id: entryId } } }, softwareTargetOrder: false, softwareTargetTrailing: false };
    return { status: 200, data: { entry: { data: { order_id: entryId } }, gtt: { data: { trigger_id: fid() } } }, softwareTargetTrailing: emaTrailingMode };
  }
  if (splitPlan.split) return { status: 200, dhanProtection: 'forever-split', splitT1: true, dhanEntryOrderId: entryId, dhanForeverId: fid(), dhanForeverT1Id: fid(), splitLegAQty: splitPlan.legA.qty, splitLegBQty: splitPlan.legB.qty, softwareTargetOrder: false, softwareTargetTrailing: false };
  return { status: 200, dhanProtection: 'forever', dhanEntryOrderId: entryId, dhanForeverId: fid(), softwareTargetOrder: emaTrailingMode, softwareTargetTrailing: emaTrailingMode };
}

// Build the paper placement result (pending-fill when protect-after-fill is on,
// else the protected result) — mirrors live placeBrokerSuperOrder return shape.
function paperOrderResult(broker, order) {
  const b = String(broker || 'dhan').toLowerCase();
  const emaTrailingMode = isPostTargetEmaTrailingOrder(order);
  const entryId = 'PAPER-ENTRY-' + Date.now().toString(36) + Math.random().toString(16).slice(2, 6);
  if (PROTECT_AFTER_FILL && (b === 'dhan' || b === 'zerodha')) {
    if (b === 'dhan') return { status: 200, awaitingFill: true, dhanProtection: 'forever', dhanEntryOrderId: entryId, dhanForeverId: '', softwareTargetTrailing: emaTrailingMode, stopLossPrice: roundPrice(order.slPrice), pendingProtection: { broker: 'dhan', paper: true, emaTrailingMode, entryId } };
    return { status: 200, awaitingFill: true, zerodhaEntryOrderId: entryId, softwareTargetTrailing: emaTrailingMode, pendingProtection: { broker: 'zerodha', paper: true, emaTrailingMode, entryId } };
  }
  return paperProtectionResult(b, order, entryId, emaTrailingMode);
}

// PAPER BROKER PASS — the single Test-Mode lifecycle driver. Runs only on the
// separate test order log and drives the SAME lifecycle as live, using live LTP
// to simulate the broker events the live reconciles get from the API:
//   pending entry -> fill (LTP<=limit) -> place Forever/GTT (identical status)
//   -> move-SL-to-cost / split T1 then T2 (reused mtm.js engine) -> SL/TARGET/EOD
//   exit, plus the reject path (entry expires unfilled = no protection placed).
// No network, no real orders; identical status strings by reusing live helpers.
function runPaperBrokerPass() {
  if (testSimInFlight || Date.now() - testSimLastAt < 55 * 1000) return;
  const now = getIstNow();
  if (now.getDay() === 0 || now.getDay() === 6) return;        // weekdays only
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 9 * 60 + 15) return;                              // not before the open
  const norm = (s) => String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const today = istDateKey(now);
  const istKeyOf = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return istDateKey(new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })));
  };
  // CNC positions hold across days (like the live Forever/GTT), so an open
  // *filled* CNC test trade keeps resolving on later days too. A *pending* entry
  // only lives for its own day (entry order is DAY validity) — it fills or
  // expires the same session.
  const isOpenTest = (e) => (e.testMode || e.source === 'test') && !e.exitType && !e.testClosedAt
    && Number(e.qty || 0) > 0
    && (!e.awaitingFill || istKeyOf(e.recordedAt || e.time) === today);
  const open = readTestOrderLog().filter(isOpenTest);
  if (!open.length) return;
  const symbols = [...new Set(open.map(e => norm(e.symbol)).filter(Boolean))];
  if (!symbols.length) return;
  testSimInFlight = true;
  testSimLastAt = Date.now();
  fetchTVDataCached(symbols, (err, tvData) => {
    testSimInFlight = false;
    if (err) return;
    const bySym = {};
    (tvData || []).forEach(r => { const k = norm(r.symbol); if (k) bySym[k] = r; });
    const eod = mins >= TEST_EOD_MIN;
    const at = new Date().toISOString();
    let changed = false;
    const next = readTestOrderLog().map(e => {
      if (!isOpenTest(e)) return e;
      const broker = String(e.broker || 'dhan').toLowerCase();
      const ltp = Number(bySym[norm(e.symbol)]?.ltp || 0);
      const entryPrice = Number(e.entryPrice || e.price || 0);
      const qty = Number(e.qty || 0);
      if (!ltp || !entryPrice) return e;

      // --- Stage A: entry pending (protect-after-fill) -> fill or expire ---
      if (e.awaitingFill) {
        if (ltp <= entryPrice) {                              // BUY LIMIT fills at/below limit
          const emaTrailingMode = !!(e.pendingProtection && e.pendingProtection.emaTrailingMode);
          const entryId = e.dhanEntryOrderId || e.zerodhaEntryOrderId || ('PAPER-ENTRY-' + e.id);
          const prot = paperProtectionResult(broker, e, entryId, emaTrailingMode);
          changed = true;
          return { ...e, ...extractPlacedOrderLogFields(broker, prot), awaitingFill: false, pendingProtection: null,
            orderId: extractPlacedOrderId(broker, prot) || e.orderId, status: scheduledOrderStatusText(broker, null, prot),
            paperFillPrice: entryPrice, paperFilledAt: at, lastStatusCheckAt: at };
        }
        if (eod) { changed = true; return { ...e, awaitingFill: false, pendingProtection: null, exitType: 'REJECTED', result: 'REJECTED', status: 'REJECTED (entry expired — no fill, no protection placed)', testClosedAt: at, lastStatusCheckAt: at }; }
        return e;                                             // still waiting on fill
      }

      const fillPx = Number(e.paperFillPrice || entryPrice);
      const pnlAt = (px, q = qty) => Number(((px - fillPx) * q).toFixed(2));
      const round = (n) => roundPrice(n);
      // CNC holds overnight (Forever/GTT persists) — only INTRADAY squares off at
      // EOD. So a filled CNC position never EOD-exits; it resolves on SL/target/trail.
      const isIntraday = ['MIS', 'INTRADAY'].includes(String(e.segment || 'CNC').toUpperCase());
      const eodExit = eod && isIntraday;

      // --- Split-T1 two-OCO: resolve both legs with the same engine as live ---
      if (e.splitT1) {
        const sp = computeSplitBracket(e);
        if (sp.split) {
          const aBooked = !!e.paperT1Booked;                  // T1 already filled in a prior pass -> stays booked
          let effSl = Number(e.brokerSlPrice) || sp.sl;
          const patch = {};
          // Pre-T1 cost%: move BOTH legs' SL to cost when price crosses the cost
          // trigger (mirrors live STOCKKAR_SPLIT_COST_BOTH_LEGS). Both legs share
          // cost, so a dip back to cost before T1 exits the whole lot at breakeven.
          const costTrig = (SPLIT_COST_BOTH_LEGS && Number(e.costPct || 0) > 0 && !e.mtmCostDone && !aBooked) ? fillPx * (1 + Number(e.costPct) / 100) : 0;
          if (costTrig && ltp >= costTrig) { patch.mtmCostDone = true; patch.splitCostDone = true; patch.brokerSlPrice = round(fillPx); effSl = fillPx; }
          const aState = aBooked ? 'target' : (ltp <= effSl ? 'sl' : (ltp >= sp.legA.target ? 'target' : 'pending'));
          const bState = ltp <= effSl ? 'sl' : (ltp >= sp.legB.target ? 'target' : 'pending');
          // T1 booked -> set the flags the order log reads (mtmT1Done drives the
          // T1 cell + the runner qty), mark paperT1Booked, move runner SL to cost.
          if (aState === 'target' && !aBooked) { patch.paperT1Booked = true; patch.mtmT1Done = true; patch.mtmRemainingQty = sp.legB.qty; patch.mtmStatus = 'T1 book ' + sp.legA.qty; }
          if (aState === 'target' && !e.mtmCostDone && !patch.mtmCostDone) { patch.brokerSlPrice = round(fillPx); patch.mtmCostDone = true; effSl = fillPx; }
          const res = resolveSplitExit({ entryPrice: fillPx, slPrice: effSl, t1Price: sp.legA.target, t2Price: sp.legB.target, aQty: sp.legA.qty, bQty: sp.legB.qty, aState, bState });
          if (res.closed) {
            const t2Hit = res.exitType === 'TARGET HIT';
            changed = true;
            return { ...e, ...patch, ...(res.t1Booked || aBooked ? { mtmT1Done: true } : {}), ...(t2Hit ? { mtmT2Done: true } : {}),
              exitType: res.exitType, exitPrice: res.exitPrice, realisedPnl: res.realisedPnl, result: res.exitType, testClosedAt: at, lastStatusCheckAt: at, unrealisedPnl: undefined };
          }
          if (eodExit) { const px = round(ltp); changed = true; return { ...e, ...patch, exitType: 'EOD EXIT', exitPrice: px, realisedPnl: pnlAt(px), result: 'EOD EXIT', testClosedAt: at, lastStatusCheckAt: at, unrealisedPnl: undefined }; }
          const px = round(ltp); const up = pnlAt(px);
          if (Object.keys(patch).length || e.unrealisedPnl !== up || e.testLtp !== px) { changed = true; return { ...e, ...patch, testLtp: px, unrealisedPnl: up, lastStatusCheckAt: at }; }
          return e;
        }
      }

      // --- EMA trailing (after target arms it): trail the SL up the EMA each
      //     pass, exactly like live (trailingEmaValue, never lower the SL),
      //     book at market if the trail sits at/above price, else stop out when
      //     price falls to the trailed SL. ---
      if (e.emaTrailingEnabled && String(e.emaTrailingTrigger || 'afterTarget') === 'afterTarget') {
        const tvRow = bySym[norm(e.symbol)];
        const target = Number(e.targetPrice || 0);
        let curSl = Math.max(Number(e.lastTrailSlPrice || 0), Number(e.brokerSlPrice || 0), Number(e.slPrice || 0));
        const wasArmed = !!e.emaTrailingArmedAt;
        const armed = wasArmed || (target > 0 && ltp >= target);
        const patch = {};
        if (armed && !wasArmed) { patch.emaTrailingArmedAt = at; patch.emaTrailingStatus = 'target-armed'; }
        if (armed) {
          const ema = trailingEmaValue(e, tvRow);
          const pct = Number(e.emaTrailingPct || 0);
          const nextSl = (Number.isFinite(ema) && pct >= 0) ? round(ema * (1 - pct / 100)) : NaN;
          if (Number.isFinite(nextSl) && nextSl > 0) {
            if (nextSl >= ltp) {   // trail at/above price -> book at market now
              changed = true;
              return { ...e, ...patch, exitType: 'TARGET HIT', exitPrice: round(ltp), realisedPnl: pnlAt(round(ltp)), result: 'TARGET HIT', emaTrailingStatus: 'trail-exit', testClosedAt: at, lastStatusCheckAt: at, unrealisedPnl: undefined };
            }
            if (!(curSl && nextSl <= curSl)) { patch.brokerSlPrice = nextSl; patch.lastTrailSlPrice = nextSl; patch.emaTrailingStatus = 'trailed'; curSl = nextSl; }
            else if (!patch.emaTrailingStatus) patch.emaTrailingStatus = 'no-raise';
          }
        }
        if (curSl > 0 && ltp <= curSl) {   // initial SL or trailed SL hit
          const armedExit = wasArmed || !!patch.emaTrailingArmedAt;
          changed = true;
          return { ...e, ...patch, exitType: armedExit ? 'EXITED' : 'SL HIT', exitPrice: curSl, realisedPnl: pnlAt(curSl), result: armedExit ? 'EXITED' : 'SL HIT', testClosedAt: at, lastStatusCheckAt: at, unrealisedPnl: undefined };
        }
        if (eodExit) { const px = round(ltp); changed = true; return { ...e, ...patch, exitType: 'EOD EXIT', exitPrice: px, realisedPnl: pnlAt(px), result: 'EOD EXIT', testClosedAt: at, lastStatusCheckAt: at, unrealisedPnl: undefined }; }
        const px = round(ltp); const up = pnlAt(px);
        if (Object.keys(patch).length || e.unrealisedPnl !== up || e.testLtp !== px) { changed = true; return { ...e, ...patch, testLtp: px, unrealisedPnl: up, lastTrailCheckAt: at, lastStatusCheckAt: at }; }
        return e;
      }

      // --- Single OCO (+ software move-to-cost via the same mtm.js engine) ---
      const { actions, patch: mtmPatch } = computeMtmActions(e, ltp);
      let extra = { ...mtmPatch };
      let effSl = Number(e.brokerSlPrice) || Number(e.slPrice);
      actions.forEach(a => { if (a.type === 'MOVE_SL_TO_COST') { extra.brokerSlPrice = round(a.newSl); extra.mtmCostDone = true; effSl = Number(a.newSl); } });
      const tgt = Number(e.targetPrice || 0);
      if (effSl > 0 && ltp <= effSl) { const atCost = !!extra.mtmCostDone && Math.abs(effSl - fillPx) < 0.01; changed = true; return { ...e, ...extra, exitType: atCost ? 'EXITED' : 'SL HIT', exitPrice: effSl, realisedPnl: pnlAt(effSl), result: atCost ? 'EXITED' : 'SL HIT', testClosedAt: at, lastStatusCheckAt: at, unrealisedPnl: undefined }; }
      if (tgt > 0 && ltp >= tgt) { changed = true; return { ...e, ...extra, exitType: 'TARGET HIT', exitPrice: tgt, realisedPnl: pnlAt(tgt), result: 'TARGET HIT', testClosedAt: at, lastStatusCheckAt: at, unrealisedPnl: undefined }; }
      if (eodExit) { const px = round(ltp); changed = true; return { ...e, ...extra, exitType: 'EOD EXIT', exitPrice: px, realisedPnl: pnlAt(px), result: 'EOD EXIT', testClosedAt: at, lastStatusCheckAt: at, unrealisedPnl: undefined }; }
      const px = round(ltp); const up = pnlAt(px);
      if (Object.keys(extra).length || e.unrealisedPnl !== up || e.testLtp !== px) { changed = true; return { ...e, ...extra, testLtp: px, unrealisedPnl: up, lastStatusCheckAt: at }; }
      return e;
    });
    if (changed) writeTestOrderLog(next);
  });
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
    t1Pct: Number(cfg.t1Pct || 0) || 0,
    t1RR: Number(cfg.t1RR || 0) || 0,
    t1Qty: Number(cfg.t1Qty || 0) || 0,
    t2Pct: Number(cfg.t2Pct || 0) || 0,
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
  const t2Pct = Number(cfg.t2Pct || 0);
  const t2RR = Number(cfg.t2RR || 0);
  if (mtmLiveExitEnabled(broker) && stock.entryPrice > stock.slPrice) {
    if (t2Pct > 0) return roundPrice(stock.entryPrice * (1 + t2Pct / 100));
    if (t2RR > 0) return roundPrice(stock.entryPrice + t2RR * (stock.entryPrice - stock.slPrice));
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
      orderType: 'MARKET',
      validity: 'DAY',
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
      { exchange, tradingsymbol: symbol, transaction_type: 'SELL', quantity: q, order_type: 'LIMIT', product, price: slLimitPrice(sl) },
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
      if (['dhanSell', 'zerodhaSell', 'fyersSell', 'angelSell', 'angelExit'].includes(op.op)) acc.exitOrderIds.push(res?.orderId || '');
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
      case 'fyersSell': return fyersPlaceSell(entry, op.qty, next);
      case 'fyersGttRemainder': return fyersModifyGttRemainder(entry, op.qty, op.sl, op.target, next);
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
  const b = String(broker || 'dhan').toLowerCase();
  // FYERS live MTM exits (software T1/T2 + EMA trail-breach market exit) follow
  // the same single flag that gates FYERS live placement, so STOCKKAR_FYERS_LIVE=1
  // turns FYERS fully live (placement + exits) in one switch.
  if (b === 'fyers') return process.env.STOCKKAR_FYERS_LIVE === '1';
  return MTM_EXIT_ALLOWED_BROKERS.includes(b);
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
    !entry.mtmT2Done &&
    // "Split T1 at broker" orders carry T1/T2/SL as two broker OCOs, so software
    // must NOT also book T1 (that would double-sell). Their only software task
    // (move legB SL to cost after T1) is handled by the split-aware reconcile.
    !entry.splitT1 &&
    Number(entry.entryPrice || entry.price || 0) > 0 &&
    isOpenOrderLogEntry(entry) &&
    // EMA trailing owns the SL AFTER the target arms. Before that, still allow a
    // one-time Move-SL-to-Cost so a trailing trade gets breakeven protection
    // pre-target. Once armed (or cost already done), the trail takes over. T1/T2
    // stay off for trailing (their %s are 0), so only move-to-cost can fire here.
    (!entry.emaTrailingEnabled || (Number(entry.costPct) > 0 && !entry.mtmCostDone && !entry.emaTrailingArmedAt))
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
  // The test store's full lifecycle is driven by runPaperBrokerPass instead, so
  // it isn't double-processed here.
  runMtmPass(readOrderLog, writeOrderLog, false, () => {
    mtmCheckInFlight = false;
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

// Symbols that EXITED (SL/target/cost/EOD) within the last `cooldownDays` — so
// the algo won't immediately re-buy a stock it just traded out of. Empty when
// the cooldown is 0/off. Uses the exit timestamp (falls back through the row's
// close stamps) so once the cooldown lapses the stock is eligible again.
function recentlyExitedSymbols(broker, useTestLog, cooldownDays) {
  const days = Number(cooldownDays || 0);
  if (!(days > 0)) return new Set();
  const b = String(broker || '').toLowerCase();
  const rows = useTestLog ? readTestOrderLog() : readOrderLog();
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const isExit = e => /(SL HIT|TARGET HIT|EXITED|EOD)/i.test(String(e.exitType || e.result || ''));
  const exitTime = e => {
    const t = new Date(e.testClosedAt || e.reconciledAt || e.lastStatusCheckAt || e.recordedAt || 0).getTime();
    return Number.isFinite(t) ? t : 0;
  };
  const set = new Set();
  rows.forEach(e => {
    if (b && String(e.broker || 'dhan').toLowerCase() !== b) return;
    if (!isExit(e)) return;                 // only real exits (not rejected/cancelled)
    if (exitTime(e) < cutoff) return;       // exited longer ago than the cooldown -> eligible again
    const sym = String(e.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
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

// Count THIS ALGO's own positions still held at the broker: broker-held symbols
// that THIS job placed (jobId + source=auto in the order log). Broker truth so
// order-log drift can't hide a held position; jobId so it counts only this
// algo's positions (NOT other algos, NOT manual holdings) — a new algo isn't
// blocked by what other algos hold. Empty broker set (test/non-Dhan) -> 0.
function algoHeldPositionCount(brokerHeldSet, jobId) {
  if (!brokerHeldSet || !brokerHeldSet.size || !jobId) return 0;
  const norm = s => String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const algoSyms = new Set(readOrderLog().filter(e => e.jobId === jobId && e.source === 'auto' && !e.testMode).map(e => norm(e.symbol)));
  let n = 0;
  brokerHeldSet.forEach(s => { if (algoSyms.has(norm(s))) n++; });
  return n;
}

// Live unrealised P&L: stamp each OPEN live position with its current LTP and
// (LTP - entry) * qty, so the Live Trade Log shows a running P&L just like Test
// Mode. Display only — places nothing; the broker owns the actual exits.
let liveUpnlInFlight = false, liveUpnlLastAt = 0;
function updateLiveUnrealisedPnl() {
  if (liveUpnlInFlight || Date.now() - liveUpnlLastAt < 55 * 1000) return;
  if (!withinMarketHours()) return;
  const norm = s => String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const isLiveOpen = e => !e.testMode && e.source !== 'test' && isOpenOrderLogEntry(e)
    && Number(e.qty || 0) > 0 && Number(e.entryPrice || e.price || 0) > 0;
  const open = readOrderLog().filter(isLiveOpen);
  if (!open.length) return;
  const symbols = [...new Set(open.map(e => norm(e.symbol)).filter(Boolean))];
  if (!symbols.length) return;
  liveUpnlInFlight = true; liveUpnlLastAt = Date.now();
  fetchTVDataCached(symbols, (err, tvData) => {
    liveUpnlInFlight = false;
    if (err) return;
    const bySym = {}; (tvData || []).forEach(r => { const k = norm(r.symbol); if (k) bySym[k] = r; });
    let changed = false;
    const next = readOrderLog().map(e => {
      if (!isLiveOpen(e)) return e;
      const ltp = Number(bySym[norm(e.symbol)]?.ltp || 0);
      const entry = Number(e.entryPrice || e.price || 0);
      const qty = Number(e.qty || 0);
      if (!ltp || !entry) return e;
      const px = roundPrice(ltp);
      const up = Number(((px - entry) * qty).toFixed(2));
      if (e.liveLtp === px && e.unrealisedPnl === up) return e;
      changed = true;
      return { ...e, liveLtp: px, unrealisedPnl: up };
    });
    if (changed) writeOrderLog(next);
  });
}

// Move BOTH split OCO legs' SL to cost (entry), keeping each leg's own target
// (legA→T1, legB→T2). Used for the pre-T1 cost%-triggered move. Never lowers the
// SL (cost > original SL for a BUY). Reuses the per-broker leg modifiers.
function moveSplitLegsToCost(row, callback) {
  const b = String(row.broker || 'dhan').toLowerCase();
  const entryPx = Number(row.entryPrice || row.price || 0);
  const cost = roundPrice(entryPx);
  const aQty = Number(row.splitLegAQty || 0), bQty = Number(row.splitLegBQty || 0);
  if (!(cost > 0) || !aQty || !bQty) return callback('Missing split fields for cost move');
  if (b === 'dhan') {
    modifyDhanForeverStopLoss({ ...row, qty: bQty }, cost, (eB) => {                              // legB (runner)
      modifyDhanForeverStopLoss({ ...row, dhanForeverId: row.dhanForeverT1Id, qty: aQty }, cost, (eA) => { // legA (booked half)
        callback(eA || eB ? ('legB:' + (eB || 'ok') + ' | legA:' + (eA || 'ok')) : null);
      });
    });
    return;
  }
  if (b === 'zerodha') {
    const risk = entryPx - Number(row.slPrice || 0);
    const t1Pct = Number(row.t1Pct || 0), t1RR = Number(row.t1RR || 0);
    const t1Px = t1Pct > 0 ? roundPrice(entryPx * (1 + t1Pct / 100)) : (t1RR > 0 && risk > 0 ? roundPrice(entryPx + t1RR * risk) : Number(row.targetPrice || 0));
    const t2Px = Number(row.targetPrice || 0);
    const gttB = row.zerodhaGttId || parseZerodhaOrderIds(row.orderId).gttId;
    zerodhaModifyGttRemainder({ ...row, orderId: 'GTT:' + gttB }, bQty, cost, t2Px, (eB) => {       // legB (runner) -> SL cost, keep T2
      zerodhaModifyGttRemainder({ ...row, orderId: 'GTT:' + row.zerodhaGttT1Id }, aQty, cost, t1Px, (eA) => { // legA -> SL cost, keep T1
        callback(eA || eB ? ('legB:' + (eB || 'ok') + ' | legA:' + (eA || 'ok')) : null);
      });
    });
    return;
  }
  callback('split cost-both-legs not supported for ' + b);
}

// Pre-T1 "Move SL to Cost %": once price crosses the cost trigger, move BOTH
// split legs' SL to cost (entry) — even before T1. ON by default so a configured
// cost% works as expected on split positions; disable with
// STOCKKAR_SPLIT_COST_BOTH_LEGS=0. After T1 the split reconcile still owns the
// runner move; this only adds the before-T1 both-legs case.
const SPLIT_COST_BOTH_LEGS = process.env.STOCKKAR_SPLIT_COST_BOTH_LEGS !== '0';
let splitCostInFlight = false, splitCostLastAt = 0;
function checkSplitMoveToCost() {
  if (process.env.STOCKKAR_ENGINE === '1') return; // engine cutover owns pre-T1 cost moves
  if (!SPLIT_COST_BOTH_LEGS) return;
  if (splitCostInFlight || Date.now() - splitCostLastAt < 55 * 1000) return;
  if (!withinMarketHours()) return;
  const norm = s => String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const isCand = e => {
    const b = String(e.broker || 'dhan').toLowerCase();
    return (b === 'dhan' || b === 'zerodha') && e.splitT1 && !e.testMode && e.source !== 'test'
      && Number(e.costPct || 0) > 0 && !e.splitCostDone && !e.mtmCostDone && !e.mtmT1Done
      && !e.emaTrailingEnabled && !e.protectionUnverified && isOpenOrderLogEntry(e);
  };
  const cands = readOrderLog().filter(isCand);
  if (!cands.length) return;
  const symbols = [...new Set(cands.map(e => norm(e.symbol)).filter(Boolean))];
  if (!symbols.length) return;
  splitCostInFlight = true; splitCostLastAt = Date.now();
  fetchTVDataCached(symbols, (err, tvData) => {
    splitCostInFlight = false;
    if (err) return;
    const bySym = {}; (tvData || []).forEach(r => { const k = norm(r.symbol); if (k) bySym[k] = r; });
    const due = cands.filter(e => {
      const ltp = Number(bySym[norm(e.symbol)]?.ltp || 0);
      const entry = Number(e.entryPrice || e.price || 0);
      const costTrig = entry > 0 ? entry * (1 + Number(e.costPct) / 100) : 0;
      return ltp > 0 && costTrig > 0 && ltp >= costTrig;
    });
    let i = 0;
    const step = () => {
      if (i >= due.length) return;
      const id = due[i++].id;
      const row = readOrderLog().find(r => r.id === id);
      if (!row || row.splitCostDone || row.mtmT1Done || !isOpenOrderLogEntry(row)) return step();
      moveSplitLegsToCost(row, (mErr) => {
        const entryPx = roundPrice(Number(row.entryPrice || row.price || 0));
        if (!mErr) {
          writeOrderLog(readOrderLog().map(r => r.id === id ? { ...r, splitCostDone: true, mtmCostDone: true, brokerSlPrice: entryPx, slPrice: entryPx, lastTrailError: '' } : r));
          sendTelegram('🟢 <b>Stockkar — SL moved to cost (both legs)</b> for ' + row.symbol + ' @ ' + entryPx + ' (pre-T1).', () => {});
        } else {
          writeOrderLog(readOrderLog().map(r => r.id === id ? { ...r, lastTrailError: 'Split cost move: ' + mErr } : r)); // retried next pass
        }
        step();
      });
    };
    step();
  });
}

function runScheduledAlgo(job, callback) {
  const cfg = job.config || {};
  const tradedToday = new Set(Array.isArray(job.tradedSymbols) ? job.tradedSymbols.map(s => String(s).toUpperCase()) : []);
  // Symbols hard-rejected earlier today (ban/circuit/no-margin): skip re-trying
  // but they don't count as executed trades, so they're tracked separately.
  const parkedToday = new Set(Array.isArray(job.parkedSymbols) ? job.parkedSymbols.map(s => String(s).toUpperCase()) : []);
  const heldOpen = openHeldSymbols(cfg.broker, !!cfg.testMode);
  // Broker-truth holdings (Dhan): populated before the scan so already-held
  // symbols are skipped at SELECTION time, not attempted-and-blocked at
  // placement every check (which spammed the log). Fail-safe: stays empty on a
  // fetch error, and the placement-level guard still blocks any re-buy.
  const brokerHeld = new Set();
  // No-re-entry cooldown: skip a stock that exited (SL/target/cost/EOD) within
  // the last N days. 0/unset = off (existing behaviour). Per-algo, env fallback.
  const reentryCooldownDays = Number(cfg.reentryCooldownDays ?? process.env.STOCKKAR_REENTRY_COOLDOWN_DAYS ?? 0);
  const exitedRecently = recentlyExitedSymbols(cfg.broker, !!cfg.testMode, reentryCooldownDays);
  // T2T (BE/BZ series) stocks are skipped at SELECTION: their same-day protective
  // SELL is RMS-rejected, which would leave a naked CNC position (INDOAMIN).
  // Kill switch STOCKKAR_SKIP_T2T=0. Fail-open: an empty series cache skips
  // nothing (the UNPROTECTED recheck still catches any that slip through).
  const skipT2T = process.env.STOCKKAR_SKIP_T2T !== '0';
  const skipHeld = sym => tradedToday.has(sym) || parkedToday.has(sym) || heldOpen.has(sym) || brokerHeld.has(sym) || exitedRecently.has(sym) || (skipT2T && isT2TSymbol(sym));
  const maxTrades = Number(cfg.maxTrades || 0);
  const remainingTrades = maxTrades > 0 ? Math.max(0, maxTrades - tradedToday.size) : Infinity;
  // Concurrent open-position cap (auto-throttles new entries until some close).
  // Safety: an algo must NEVER run uncapped (it would open a position in EVERY
  // qualifying stock). If unset/0, fall back to a conservative default cap
  // (STOCKKAR_DEFAULT_MAX_OPEN, default 5) instead of unlimited.
  const maxOpenPositions = Number(cfg.maxOpenPositions) > 0 ? Number(cfg.maxOpenPositions) : Math.max(1, Number(process.env.STOCKKAR_DEFAULT_MAX_OPEN || 5));
  const openNow = openPositionsForJob(job.id, !!cfg.testMode);
  const remainingOpenSlots = maxOpenPositions > 0 ? Math.max(0, maxOpenPositions - openNow) : Infinity;
  const entryLimit = Math.min(remainingTrades, remainingOpenSlots);
  const token = cfg.stockkarToken || cfg.skToken;
  if (!token) return callback('No Stockkar token saved in schedule');
  const testMode = !!cfg.testMode;
  const brokerContext = testMode ? { broker: cfg.broker || 'dhan', credentials: {} } : resolveScheduledBrokerCredentials(cfg);
  if (brokerContext.error) return callback(brokerContext.error);
  const broker = brokerContext.broker;
  const credentials = brokerContext.credentials;
  const logScreenerName = cfg.algoName || cfg.screenerSourceName || cfg.screenerName || cfg.screenerSlug || '';
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
      let qualified = rankByRiskEntry(buildAlgoCandidates(tvData, { ...cfg, screenerStocks: filtered }).filter(r => r.withinEMA));
      const freshQualified = qualified.filter(r => !skipHeld(String(r.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase()));
      // Algo-only cap, drift-proof: count the algo's own positions still held at
      // Dhan (broker-held symbols that appear as an auto entry in the order log).
      // Broker truth means log drift / a changed job id can't undercount it, and
      // the source=auto filter means your MANUAL holdings don't count against it.
      const openEff = Math.max(openNow, algoHeldPositionCount(brokerHeld, job.id));
      const slotsEff = maxOpenPositions > 0 ? Math.max(0, maxOpenPositions - openEff) : Infinity;
      const limitEff = Math.min(remainingTrades, slotsEff);
      const toTrade = Number.isFinite(limitEff) ? freshQualified.slice(0, limitEff) : freshQualified;
      const results = [];

      const placeNext = (i) => {
        if (i >= toTrade.length) {
          return callback(null, { scanned: symbols.length, qualified: qualified.length, freshQualified: freshQualified.length, selected: toTrade.length, alreadyTraded: tradedToday.size, alreadyHeld: heldOpen.size, reentryBlocked: exitedRecently.size, openPositions: openEff, maxOpenPositions, orders: results });
        }
        const stock = toTrade[i];
        const sym = String(stock.symbol || '').replace('NSE:', '');
        if (testMode) {
          // Paper trade: build a live-shaped row via the SAME helpers as a real
          // order, so its status + lifecycle are identical to live.
          const paperOrder = { symbol: sym, action: 'BUY', entryPrice: stock.entryPrice, slPrice: stock.slPrice, targetPrice: mtmEntryTargetPrice(cfg, stock, broker), qty: stock.qty, emaTrailingEnabled: !!cfg.emaTrailingEnabled, segment: cfg.segment || 'CNC', exchange: cfg.exchange || 'NSE', ...mtmConfigFields({ ...cfg, qty: stock.qty }) };
          const pr = paperOrderResult(broker, paperOrder);
          const prStatus = scheduledOrderStatusText(broker, null, pr);
          results.push({ symbol: sym, ok: true, testMode: true, status: prStatus });
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
            orderId: extractPlacedOrderId(broker, pr),
            ...extractPlacedOrderLogFields(broker, pr),
            rejectionReason: '',
            status: prStatus,
            result: '',
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
          slMethod: cfg.slMethod || 'pct',
          t1Pct: cfg.t1Pct || 0, t1Qty: cfg.t1Qty || 0, t2Pct: cfg.t2Pct || 0,
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

  const beginScan = () => {
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
      let qualified = rankByRiskEntry(buildAlgoCandidates(tvData, { ...cfg, screenerStocks: stocks }).filter(r => r.withinEMA));
      const freshQualified = qualified.filter(r => !skipHeld(String(r.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase()));
      // Algo-only cap, drift-proof: count the algo's own positions still held at
      // Dhan (broker-held symbols that appear as an auto entry in the order log).
      // Broker truth means log drift / a changed job id can't undercount it, and
      // the source=auto filter means your MANUAL holdings don't count against it.
      const openEff = Math.max(openNow, algoHeldPositionCount(brokerHeld, job.id));
      const slotsEff = maxOpenPositions > 0 ? Math.max(0, maxOpenPositions - openEff) : Infinity;
      const limitEff = Math.min(remainingTrades, slotsEff);
      const toTrade = Number.isFinite(limitEff) ? freshQualified.slice(0, limitEff) : freshQualified;
      const results = [];

      const placeNext = (i) => {
        if (i >= toTrade.length) {
          return callback(null, { scanned: symbols.length, qualified: qualified.length, freshQualified: freshQualified.length, selected: toTrade.length, alreadyTraded: tradedToday.size, alreadyHeld: heldOpen.size, reentryBlocked: exitedRecently.size, openPositions: openEff, maxOpenPositions, orders: results });
        }
        const stock = toTrade[i];
        const sym = String(stock.symbol || '').replace('NSE:', '');
        if (testMode) {
          // Paper trade: build a live-shaped row via the SAME helpers as a real
          // order, so its status + lifecycle are identical to live.
          const paperOrder = { symbol: sym, action: 'BUY', entryPrice: stock.entryPrice, slPrice: stock.slPrice, targetPrice: mtmEntryTargetPrice(cfg, stock, broker), qty: stock.qty, emaTrailingEnabled: !!cfg.emaTrailingEnabled, segment: cfg.segment || 'CNC', exchange: cfg.exchange || 'NSE', ...mtmConfigFields({ ...cfg, qty: stock.qty }) };
          const pr = paperOrderResult(broker, paperOrder);
          const prStatus = scheduledOrderStatusText(broker, null, pr);
          results.push({ symbol: sym, ok: true, testMode: true, status: prStatus });
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
            orderId: extractPlacedOrderId(broker, pr),
            ...extractPlacedOrderLogFields(broker, pr),
            rejectionReason: '',
            status: prStatus,
            result: '',
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
          slMethod: cfg.slMethod || 'pct',
          t1Pct: cfg.t1Pct || 0, t1Qty: cfg.t1Qty || 0, t2Pct: cfg.t2Pct || 0,
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
  };

  // Dhan: load broker-truth holdings first so already-held symbols are skipped
  // at SELECTION (no repeated attempt-and-block each check). Fail-safe: on a
  // fetch error proceed with an empty set (placement-level de-dup still guards).
  if (String(cfg.broker || 'dhan').toLowerCase() === 'dhan' && !cfg.testMode) {
    return fetchDhanHeldSymbols((hErr, heldSet) => {
      if (!hErr && heldSet) heldSet.forEach(s => brokerHeld.add(s));
      beginScan();
    });
  }
  beginScan();
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

// ---- No-SL live placement: entry order + up to 2 target GTTs (no stop) ------
function noSlTargetLegs(order) {
  const entry = Number(order.entryPrice || 0);
  const qty = Math.floor(Number(order.qty || 0));
  if (!entry || qty <= 0) return [];
  const t1Pct = Number(order.t1Pct || 0), t2Pct = Number(order.t2Pct || 0), t1QtyPct = Number(order.t1Qty || 0);
  const t1Price = roundPrice(entry * (1 + t1Pct / 100));
  const t2Price = roundPrice(entry * (1 + t2Pct / 100));
  const t1BookQty = Math.floor(qty * t1QtyPct / 100);
  // T1 books the entire position (e.g. 100% qty) -> single full-qty exit at T1,
  // T2 is irrelevant in that case.
  const t1Full = t1Pct > 0 && t1BookQty >= qty;
  const hasT1 = t1Pct > 0 && t1BookQty >= 1 && t1BookQty < qty;
  const hasT2 = t2Pct > 0;
  if (t1Full) return [{ qty, price: t1Price, tag: 'T1' }];
  if (hasT1 && hasT2) return [{ qty: t1BookQty, price: t1Price, tag: 'T1' }, { qty: qty - t1BookQty, price: t2Price, tag: 'T2' }];
  if (hasT2) return [{ qty, price: t2Price, tag: 'T2' }];
  if (hasT1) return [{ qty, price: t1Price, tag: 'T1' }];
  return [];
}

// Throttle Dhan order POSTs: split-T1 fires 3 calls/stock (entry + 2 Forever),
// which bursts past Dhan's rate limit ("Too many requests"). Serialize with a
// min gap (STOCKKAR_DHAN_ORDER_GAP_MS, default 400ms ~= 2.5 orders/sec).
let _dhanPostNextAt = 0;
const DHAN_ORDER_GAP_MS = Math.max(0, Number(process.env.STOCKKAR_DHAN_ORDER_GAP_MS || 400));
function dhanPost(pathname, token, payload, callback) {
  const wait = Math.max(0, _dhanPostNextAt - Date.now());
  _dhanPostNextAt = Date.now() + wait + DHAN_ORDER_GAP_MS;
  setTimeout(() => {
    const body = JSON.stringify(payload);
    const req = https.request({ hostname: 'api.dhan.co', port: 443, path: pathname, method: 'POST', headers: { 'access-token': token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, apiRes => {
      let data = ''; apiRes.on('data', c => data += c); apiRes.on('end', () => { let p; try { p = JSON.parse(data); } catch { p = data; } callback(null, { status: apiRes.statusCode, data: p }); });
    });
    req.on('error', e => callback(e.message, null));
    req.setTimeout(20000, () => req.destroy(new Error('Dhan request timed out')));
    req.write(body); req.end();
  }, wait);
}

function placeNoSlZerodha(order, creds, callback) {
  const apiKey = creds?.zerodhaApiKey || creds?.apiKey || creds?.clientId;
  const accessToken = creds?.zerodhaAccessToken || creds?.accessToken;
  const symbol = String(order.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const qty = Math.floor(Number(order.qty || 0)), entry = Number(order.entryPrice || 0);
  if (!apiKey || !accessToken) return callback('Missing Zerodha API key or access token', null);
  if (!symbol || !qty || !entry) return callback('Missing Zerodha No-SL order fields', null);
  const exchange = order.exchange || 'NSE', product = order.segment === 'INTRADAY' ? 'MIS' : 'CNC';
  const entryForm = { exchange, tradingsymbol: symbol, transaction_type: 'BUY', quantity: String(qty), product, order_type: 'LIMIT', price: String(roundPrice(entry)), validity: 'DAY' };
  kitePost('/orders/regular', apiKey, accessToken, entryForm, (eErr, eRes) => {
    if (eErr) return callback(eErr, null);
    if (eRes.status >= 400) return callback('Zerodha entry order failed: ' + JSON.stringify(eRes.data), eRes);
    const entryId = eRes.data?.data?.order_id || '';
    const legs = noSlTargetLegs(order), gttIds = [], warnings = [];
    let i = 0;
    const next = () => {
      if (i >= legs.length) return callback(null, { status: eRes.status, data: { entry: eRes.data, targetGttIds: gttIds }, request: { entry: entryForm }, zerodhaEntryOrderId: entryId, noSl: true, warnings });
      const leg = legs[i++];
      const gttForm = { type: 'single',
        condition: JSON.stringify({ exchange, tradingsymbol: symbol, trigger_values: [roundPrice(leg.price)], last_price: roundPrice(entry) }),
        orders: JSON.stringify([{ exchange, tradingsymbol: symbol, transaction_type: 'SELL', quantity: leg.qty, order_type: 'LIMIT', product, price: roundPrice(leg.price * 0.998) }]) };
      kitePost('/gtt/triggers', apiKey, accessToken, gttForm, (gErr, gRes) => {
        if (gErr || (gRes && gRes.status >= 400)) warnings.push(leg.tag + ' target GTT failed: ' + (gErr || JSON.stringify(gRes?.data)));
        else { const id = gRes.data?.data?.trigger_id || gRes.data?.trigger_id || ''; if (id) gttIds.push(leg.tag + ':' + id); }
        next();
      });
    };
    next();
  });
}

function placeNoSlAngel(order, creds, callback) {
  const store = { clientId: creds?.apiKey || creds?.clientId, accountId: creds?.accountId };
  const accessToken = creds?.accessToken;
  const symbol = String(order.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const qty = Math.floor(Number(order.qty || 0)), entry = Number(order.entryPrice || 0);
  if (!store.clientId || !store.accountId || !accessToken) return callback('Missing Angel One token', null);
  if (!symbol || !qty || !entry) return callback('Missing Angel One No-SL order fields', null);
  resolveAngelOneInstrument(symbol, order.exchange || 'NSE', (lErr, info) => {
    if (lErr) return callback(lErr, null);
    const productType = angelOneProductType(order.segment);
    const entryPayload = { variety: 'NORMAL', tradingsymbol: info.instrument.tradingSymbol, symboltoken: info.instrument.token, transactiontype: 'BUY', exchange: info.instrument.exchange || info.exchange, ordertype: 'LIMIT', producttype: productType, duration: 'DAY', price: String(roundPrice(entry)), squareoff: '0', stoploss: '0', quantity: String(qty) };
    angelRequest('POST', '/rest/secure/angelbroking/order/v1/placeOrder', store, accessToken, entryPayload, (eErr, eRes) => {
      if (eErr) return callback('Angel One entry order failed: ' + eErr, null);
      if (!eRes || eRes.status >= 400 || eRes.data?.status === false) return callback('Angel One entry order failed: ' + angelApiMessage(eRes?.data, 'HTTP ' + eRes?.status), eRes);
      const entryId = angelOneOrderId(eRes.data);
      const legs = noSlTargetLegs(order), ruleIds = [], warnings = [];
      let i = 0;
      const next = () => {
        if (i >= legs.length) return callback(null, { status: eRes.status, data: { entry: eRes.data, targetRuleIds: ruleIds }, request: { entry: entryPayload }, angelOneEntryOrderId: entryId, noSl: true, warnings });
        const leg = legs[i++];
        createAngelOneGttRule(store, accessToken, { instrument: info.instrument, transactionType: 'SELL', triggerPrice: roundPrice(leg.price), price: roundPrice(leg.price * 0.998), qty: leg.qty, productType, exchange: info.exchange }, (gErr, gRes) => {
          if (gErr) warnings.push(leg.tag + ' target GTT failed: ' + gErr);
          else { const id = angelOneRuleId(gRes.data); if (id) ruleIds.push(leg.tag + ':' + id); }
          next();
        });
      };
      next();
    });
  });
}

function placeNoSlDhan(order, dhanClient, dhanToken, callback) {
  const store = readDhanTokenStore();
  if (!store?.clientId || !store?.token) return callback('Dhan credentials missing', null);
  const symbol = String(order.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const qty = Math.floor(Number(order.qty || 0)), entry = Number(order.entryPrice || 0);
  if (!symbol || !qty || !entry) return callback('Missing Dhan No-SL order fields', null);
  loadDhanSecurityMap((lookupErr, securityMap) => {
    if (lookupErr) return callback('Security lookup failed: ' + lookupErr, null);
    const exchange = order.exchange === 'BSE' ? 'BSE' : 'NSE';
    const securityId = order.securityId || (securityMap && (securityMap[exchange + ':' + symbol] || securityMap[symbol]));
    if (!securityId) return callback('Security ID not found for ' + symbol, null);
    const segPart = order.exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ';
    const entryPayload = { dhanClientId: store.clientId, transactionType: 'BUY', exchangeSegment: segPart, productType: order.segment || 'CNC', orderType: 'LIMIT', securityId: String(securityId), quantity: qty, price: roundPrice(entry), validity: 'DAY' };
    dhanPost('/v2/orders', store.token, entryPayload, (eErr, eRes) => {
      if (eErr) return callback('Dhan entry order failed: ' + eErr, null);
      if (eRes.status >= 400) return callback('Dhan entry order failed: ' + dhanApiMessage(eRes.data, 'HTTP ' + eRes.status), eRes);
      const entryId = eRes.data?.orderId || eRes.data?.data?.orderId || '';
      const legs = noSlTargetLegs({ ...order, securityId }), foreverIds = [], warnings = [];
      let i = 0;
      const next = () => {
        if (i >= legs.length) return callback(null, { status: eRes.status, data: { entry: eRes.data, targetForeverIds: foreverIds }, request: { entry: entryPayload }, dhanEntryOrderId: entryId, noSl: true, warnings });
        const leg = legs[i++];
        const fPayload = { dhanClientId: store.clientId, orderFlag: 'SINGLE', transactionType: 'SELL', exchangeSegment: segPart, productType: order.segment || 'CNC', orderType: 'LIMIT', validity: 'DAY', securityId: String(securityId), quantity: leg.qty, price: roundPrice(leg.price), triggerPrice: roundPrice(leg.price) };
        dhanPost('/v2/forever/orders', store.token, fPayload, (fErr, fRes) => {
          if (fErr || (fRes && fRes.status >= 400)) warnings.push(leg.tag + ' target order failed: ' + (fErr || dhanApiMessage(fRes?.data, '')));
          else { const id = fRes.data?.orderId || fRes.data?.data?.orderId || ''; if (id) foreverIds.push(leg.tag + ':' + id); }
          next();
        });
      };
      next();
    });
  });
}

// Dhan CNC protection as a persistent Forever order (Kite-GTT-style): a normal
// entry order, then a Forever order that survives overnight (unlike a day-only
// Super Order), so swing/positional holds stay protected across days and the id
// stays queryable. Matches the Super Order's target logic: Forever OCO (SL +
// target) normally, or Forever SL-only when EMA trailing is on (target is then a
// software activation level Stockkar manages). T1/T2 partial booking and
// move-to-cost are software-managed and modify this Forever order.
// Gated OFF (STOCKKAR_DHAN_FOREVER=1) until validated with a small live trade;
// management (modify/reconcile by forever id) routes on dhanProtection next.
function placeDhanForeverBracket(order, dhanClient, dhanToken, callback) {
  const entry = Number(order.entryPrice);
  const sl = Number(order.slPrice);
  const target = Number(order.targetPrice);
  const qty = Math.floor(Number(order.qty || 0));
  const symbol = String(order.symbol || '').replace(/\s/g, '').toUpperCase();
  if (!dhanClient || !dhanToken) return callback('Dhan credentials missing. Save Client ID and access token in Settings first.', null);
  if (!symbol || !entry || !sl || !target || !qty) return callback('Missing order fields', null);
  if (!Number.isInteger(qty) || qty <= 0) return callback('Invalid quantity: must be a positive whole number', null);
  if (!(sl < entry && target > entry)) return callback('Invalid BUY setup: SL must be below entry and target above entry', null);
  if ((target - entry) < 0.05 || (entry - sl) < 0.05) return callback('Invalid SL/target: too close to entry', null);
  if (getDhanTokenStatus().status === 'expired') return callback('Dhan token expired. Generate a fresh token in Settings before placing orders.', null);
  if (!order.allowDuplicate && hasOpenSameDayDhanOrder(symbol)) {
    return callback('Safety block: open Dhan order already exists today for ' + symbol + '. Refresh Order Log or cancel/close broker order before placing again.', null);
  }
  const store = readDhanTokenStore();
  loadDhanSecurityMap((lookupErr, securityMap) => {
    if (lookupErr) return callback('Security lookup failed: ' + lookupErr, null);
    const exchange = order.exchange === 'BSE' ? 'BSE' : 'NSE';
    const securityId = order.securityId || (securityMap && (securityMap[exchange + ':' + symbol] || securityMap[symbol]));
    if (!securityId) return callback('Security ID not found for ' + symbol, null);
    const segPart = order.exchange === 'BSE' ? 'BSE_EQ' : 'NSE_EQ';
    const product = order.segment || 'CNC';
    // 1) Entry order (immediate). 2) Forever OCO protecting the long.
    const entryPayload = { dhanClientId: store.clientId, transactionType: 'BUY', exchangeSegment: segPart, productType: product, orderType: 'LIMIT', securityId: String(securityId), quantity: qty, price: roundPrice(entry), validity: 'DAY' };
    dhanPost('/v2/orders', store.token, entryPayload, (eErr, eRes) => {
      if (eErr) return callback('Dhan entry order failed: ' + eErr, null);
      if (eRes.status >= 400) return callback('Dhan entry order failed: ' + dhanApiMessage(eRes.data, 'HTTP ' + eRes.status), { status: eRes.status, data: eRes.data, request: entryPayload });
      const entryId = eRes.data?.orderId || eRes.data?.data?.orderId || '';
      const slTrigger = roundPrice(sl);
      // Match the Super Order's target logic: the broker holds the target too
      // (Forever OCO) UNLESS EMA trailing is on, where the target is only a
      // software activation level and Stockkar trails the SL - so SL-only here.
      const emaTrailingMode = isPostTargetEmaTrailingOrder(order);
      const ctx = { clientId: store.clientId, token: store.token, segPart, product, securityId: String(securityId),
        symbol, slTrigger, target, qty, emaTrailingMode, entryId, order, entryPayload, entryData: eRes.data, entryStatus: eRes.status };
      // PROTECT AFTER FILL: place only the entry now; the protective Forever(s)
      // go in once the entry actually FILLS (placeProtectionForFilledDhanEntries),
      // so a pending/rejected LIMIT entry never leaves a naked or orphaned stop.
      if (PROTECT_AFTER_FILL) {
        return callback(null, {
          status: eRes.status, data: { entry: eRes.data }, request: { entry: entryPayload, stopLossPrice: slTrigger },
          dhanProtection: 'forever', awaitingFill: true, dhanEntryOrderId: entryId, dhanForeverId: '',
          softwareTargetTrailing: emaTrailingMode, stopLossPrice: slTrigger,
          pendingProtection: serializeDhanPendingProtection(ctx),
        });
      }
      return placeDhanForeverProtection(ctx, callback);
    });
  });
}

// Place the protective Forever order(s) for a Dhan long whose entry is in place.
// Extracted so it can run either immediately after entry acceptance (default) or
// later, once the entry FILLS, from the protect-after-fill reconcile. `ctx`
// carries the entry context; the result shape matches the broker-order log
// extractors (extractPlacedOrderId / extractPlacedOrderLogFields).
function placeDhanForeverProtection(ctx, callback) {
  const { clientId, token, segPart, product, securityId, symbol, slTrigger, target, qty, emaTrailingMode, entryId, order, entryPayload, entryData } = ctx;
  // SL (and target, for OCO) execute as MARKET on trigger so they always fill -
  // no gap-down miss, and no price/price1 leg-mapping risk.
  const mkOco = (q, tgt) => ({ dhanClientId: clientId, orderFlag: 'OCO', transactionType: 'SELL', exchangeSegment: segPart, productType: product, orderType: 'MARKET', validity: 'DAY', securityId: String(securityId),
    quantity: q, price: 0, triggerPrice: slTrigger,
    price1: 0, triggerPrice1: roundPrice(tgt), quantity1: q });
  const mkSingleSl = (q) => ({ dhanClientId: clientId, orderFlag: 'SINGLE', transactionType: 'SELL', exchangeSegment: segPart, productType: product, orderType: 'MARKET', validity: 'DAY', securityId: String(securityId), quantity: q, price: 0, triggerPrice: slTrigger });

  // Entry placed but protection failed - surface clearly + Telegram, entry stays tracked.
  const protectionFailed = (failMsg, foreverData, reqPayload, label) => {
    sendTelegram('🔴 <b>Stockkar — Dhan stop-loss NOT placed for ' + (symbol || '') + '</b>\nEntry filled but the Forever ' + label + ' was rejected (' + failMsg + ').\n<b>Add a manual stop in Dhan now.</b>', () => {});
    return callback('Entry placed but Forever protection (' + label + ') FAILED: ' + failMsg + '. Add a manual stop in Dhan now.', {
      status: 500, data: { entry: entryData, forever: foreverData || null }, request: { entry: entryPayload, forever: reqPayload },
      dhanProtection: 'forever', dhanEntryOrderId: entryId, dhanForeverId: '', stopLossPrice: slTrigger, softwareTargetTrailing: emaTrailingMode,
    });
  };

  // Proven single Forever (today's path): OCO SL+T2, or SL-only when trailing.
  // Also the fail-safe fallback if a split leg can't be placed.
  const placeSingle = () => {
    const foreverPayload = emaTrailingMode ? mkSingleSl(qty) : mkOco(qty, target);
    const label = emaTrailingMode ? 'SL' : 'SL+target OCO';
    dhanPost('/v2/forever/orders', token, foreverPayload, (fErr, fRes) => {
      if (fErr || (fRes && fRes.status >= 400)) return protectionFailed(fErr || dhanApiMessage(fRes?.data, 'HTTP ' + fRes?.status), fRes?.data, foreverPayload, label);
      const foreverId = fRes.data?.orderId || fRes.data?.data?.orderId || '';
      callback(null, {
        status: fRes.status, data: { entry: entryData, forever: fRes.data }, request: { entry: entryPayload, forever: foreverPayload, stopLossPrice: slTrigger },
        dhanProtection: 'forever', dhanEntryOrderId: entryId, dhanForeverId: foreverId,
        softwareTargetOrder: emaTrailingMode, softwareTargetTrailing: emaTrailingMode,
      });
    });
  };

  // "Split T1 at broker": two OCOs (legA = T1+SL on the booked qty, legB =
  // T2+SL on the runner). No-trailing only; kill-switch STOCKKAR_SPLIT_T1.
  // Any failure rolls back to the single OCO so protection is never lost.
  const splitPlan = (!emaTrailingMode && process.env.STOCKKAR_SPLIT_T1 !== '0') ? computeSplitBracket(order) : { split: false };
  if (!splitPlan.split) return placeSingle();
  const aPayload = mkOco(splitPlan.legA.qty, splitPlan.legA.target);
  const bPayload = mkOco(splitPlan.legB.qty, splitPlan.legB.target);
  dhanPost('/v2/forever/orders', token, aPayload, (aErr, aRes) => {
    if (aErr || (aRes && aRes.status >= 400)) return placeSingle(); // nothing placed yet -> safe fallback
    const idA = aRes.data?.orderId || aRes.data?.data?.orderId || '';
    dhanPost('/v2/forever/orders', token, bPayload, (bErr, bRes) => {
      if (bErr || (bRes && bRes.status >= 400)) return dhanCancelForever(idA, () => placeSingle()); // roll back legA, then fallback
      const idB = bRes.data?.orderId || bRes.data?.data?.orderId || '';
      callback(null, {
        status: bRes.status,
        data: { entry: entryData, foreverT1: aRes.data, foreverT2: bRes.data },
        request: { entry: entryPayload, foreverT1: aPayload, foreverT2: bPayload, stopLossPrice: slTrigger },
        dhanProtection: 'forever-split', splitT1: true,
        dhanEntryOrderId: entryId,
        dhanForeverId: idB,            // runner OCO = primary id (modify/reconcile use this)
        dhanForeverT1Id: idA,          // booked-half OCO
        splitLegAQty: splitPlan.legA.qty, splitLegBQty: splitPlan.legB.qty,
        softwareTargetOrder: false, softwareTargetTrailing: false,
      });
    });
  });
}

// JSON-safe snapshot of what placeDhanForeverProtection needs, stored on the
// order-log row while the entry is pending. The live token is re-read at fill
// time (not persisted here).
function serializeDhanPendingProtection(ctx) {
  return {
    broker: 'dhan', clientId: ctx.clientId, segPart: ctx.segPart, product: ctx.product, securityId: String(ctx.securityId),
    symbol: ctx.symbol, slTrigger: ctx.slTrigger, target: ctx.target, qty: ctx.qty, emaTrailingMode: !!ctx.emaTrailingMode,
    entryId: ctx.entryId, entryPayload: ctx.entryPayload,
    order: {
      symbol: ctx.order?.symbol, entryPrice: ctx.order?.entryPrice, slPrice: ctx.order?.slPrice, targetPrice: ctx.order?.targetPrice,
      qty: ctx.qty, t1Pct: ctx.order?.t1Pct, t1Qty: ctx.order?.t1Qty, t2Pct: ctx.order?.t2Pct,
      t1RR: ctx.order?.t1RR, t2RR: ctx.order?.t2RR, action: ctx.order?.action || 'BUY',
    },
  };
}

// Reconcile: for each Dhan row awaiting its entry fill, read the order book and
// (a) place the Forever protection once the entry is TRADED, or (b) mark the row
// REJECTED (no protection, no orphan) if the entry was rejected/cancelled.
function placeProtectionForFilledDhanEntries(callback) {
  const pending = readOrderLog().filter(e =>
    String(e.broker || 'dhan').toLowerCase() === 'dhan' && e.awaitingFill && e.pendingProtection &&
    !e.testMode && e.source !== 'test' && isOpenOrderLogEntry(e));
  if (!pending.length) return callback(null, { changed: 0 });
  const store = readDhanTokenStore();
  if (!store?.token) return callback('No Dhan token saved');
  const req = https.request({ hostname: 'api.dhan.co', port: 443, path: '/v2/orders', method: 'GET', headers: { 'access-token': store.token, 'Content-Type': 'application/json' } }, res => {
    let d = ''; res.on('data', c => d += c); res.on('end', () => {
      let p; try { p = JSON.parse(d); } catch { p = null; }
      if (res.statusCode >= 400) return callback('Dhan order book failed: HTTP ' + res.statusCode);
      const orders = Array.isArray(p) ? p : (Array.isArray(p?.data) ? p.data : []);
      const byId = {};
      orders.forEach(o => { const id = String(o.orderId || o.orderid || '').trim(); if (id) byId[id] = o; });
      let changed = 0;
      const queue = pending.slice();
      const step = () => {
        if (!queue.length) return callback(null, { changed });
        const row = queue.shift();
        const pp = row.pendingProtection || {};
        const o = byId[pp.entryId || row.dhanEntryOrderId];
        const st = String(o?.orderStatus || o?.status || '').toUpperCase();
        const reason = String(o?.omsErrorDescription || o?.remarks || o?.errorMessage || o?.message || '');
        const filledSoFar = Math.floor(Number(o?.filledQty ?? o?.filled_qty ?? o?.tradedQty ?? 0));
        // REJECTED/CANCELLED with ZERO fills = entry never became a position. With
        // fills > 0 (partial fill, remainder cancelled) it FALLS THROUGH to the fill
        // branch — those shares are HELD and must be protected, never abandoned.
        if (/REJECT|CANCELLED|EXPIRED/.test(st) && filledSoFar <= 0) {
          updateOrderLogRow(row.id, e => ({ ...e, awaitingFill: false, pendingProtection: null,
            status: 'REJECTED (entry ' + st.toLowerCase() + ' — no protection placed)', exitType: 'REJECTED',
            rejectionReason: reason || e.rejectionReason || '', lastStatusCheckAt: new Date().toISOString() }));
          changed++;
          if (/insufficient|funds|margin|low\s*balance/i.test(reason)) haltAlgoJobForError(row.jobId, reason || 'Insufficient funds');
          return step();
        }
        // PART_TRADED = still working: wait (protecting now would size to the partial
        // and leave later fills naked). The terminal cancel-after-partial case above
        // is what finally protects a permanently-partial entry.
        if (/PART/.test(st) && !/REJECT|CANCELLED|EXPIRED/.test(st)) return step();
        if (/(TRADED|EXECUTED|COMPLETE)/.test(st) || (/REJECT|CANCELLED|EXPIRED/.test(st) && filledSoFar > 0)) { // filled -> place protection now
          // PARTIAL FILLS: protect the qty that actually FILLED, never the ordered
          // qty — an oversized protective SELL would open a naked short when it
          // triggers. The row's qty is corrected to match and the trader is told.
          const orderedQty = Math.floor(Number(pp.qty || row.qty || 0));
          const filledQty = Math.floor(Number(o?.filledQty ?? o?.filled_qty ?? o?.tradedQty ?? 0)) || orderedQty;
          const fillPx = Number(o?.averageTradedPrice || o?.avgPrice || o?.tradedPrice || 0);
          const partial = filledQty > 0 && orderedQty > 0 && filledQty < orderedQty;
          if (partial) {
            updateOrderLogRow(row.id, e => ({ ...e, qty: filledQty,
              reconcileNote: 'PARTIAL FILL: ' + filledQty + '/' + orderedQty + ' filled — protection sized to ' + filledQty + '.' }));
            sendTelegram('🟠 <b>Stockkar — ' + (pp.symbol || row.symbol) + ' PARTIAL FILL</b>\n' + filledQty + ' of ' + orderedQty + ' filled. Protection is being placed for ' + filledQty + ' only.', () => {});
          }
          const ctx = { clientId: pp.clientId || store.clientId, token: store.token, segPart: pp.segPart, product: pp.product,
            securityId: pp.securityId, symbol: pp.symbol, slTrigger: pp.slTrigger, target: pp.target, qty: filledQty,
            emaTrailingMode: pp.emaTrailingMode, entryId: pp.entryId,
            order: { ...(pp.order || {}), qty: filledQty, ...(fillPx > 0 ? { entryPrice: fillPx } : {}) },
            entryPayload: pp.entryPayload || {}, entryData: { orderId: pp.entryId } };
          placeDhanForeverProtection(ctx, (protErr, prot) => {
            if (!prot) {  // transport/throw with no result -> leave pending, retry next cycle
              updateOrderLogRow(row.id, e => ({ ...e, lastStatusCheckAt: new Date().toISOString(), lastTrailError: 'Protection retry: ' + protErr }));
              return step();
            }
            const newFields = extractPlacedOrderLogFields('dhan', prot);
            const newId = extractPlacedOrderId('dhan', prot);
            const newStatus = protErr ? ('ENTRY PLACED BUT PROTECTION FAILED: ' + protErr) : scheduledOrderStatusText('dhan', null, prot);
            updateOrderLogRow(row.id, e => ({ ...e, ...newFields, awaitingFill: false, pendingProtection: null,
              ...(fillPx > 0 ? { entryPrice: fillPx } : {}),   // broker-truth entry price (incl. slippage)
              orderId: newId && newId !== 'N/A' ? newId : e.orderId, status: newStatus, lastStatusCheckAt: new Date().toISOString() }));
            changed++;
            step();
          });
          return;
        }
        return step();                                       // still pending -> leave
      };
      step();
    });
  });
  req.on('error', err => callback('Dhan order book failed: ' + err.message));
  req.setTimeout(15000, () => req.destroy(new Error('Dhan order book timed out')));
  req.end();
}

// Broker-truth: what the account actually holds right now (delivery holdings +
// intraday positions), so a drifted order log can't cause a duplicate or a
// re-buy of a stock already held. Cached ~30s to avoid redundant calls in a run.
let _dhanHeldCache = { at: 0, set: null };
function fetchDhanHeldSymbols(callback) {
  if (_dhanHeldCache.set && Date.now() - _dhanHeldCache.at < 30000) return callback(null, _dhanHeldCache.set);
  const store = readDhanTokenStore();
  if (!store?.token) return callback('No Dhan token', null);
  const get = (pathname, cb) => {
    const req = https.request({ hostname: 'api.dhan.co', port: 443, path: pathname, method: 'GET', headers: { 'access-token': store.token, 'Content-Type': 'application/json' } }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => { let p; try { p = JSON.parse(d); } catch { p = null; } if (res.statusCode >= 400) return cb('HTTP ' + res.statusCode, null); cb(null, Array.isArray(p) ? p : (Array.isArray(p?.data) ? p.data : [])); }); });
    req.on('error', e => cb(e.message, null));
    req.setTimeout(15000, () => req.destroy(new Error('Dhan holdings/positions timed out')));
    req.end();
  };
  get('/v2/holdings', (hErr, holdings) => {
    if (hErr) return callback(hErr, null);
    get('/v2/positions', (pErr, positions) => {
      if (pErr) return callback(pErr, null);
      const set = new Set();
      const add = (sym, qty) => { const s = String(sym || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase(); if (s && Number(qty) > 0) set.add(s); };
      // Consider EVERY quantity bucket (totalQty, dpQty settled, t1Qty unsettled CNC,
      // availableQty): close-detection and the UNPROTECTED verify treat "not held" as
      // evidence, so a freshly-bought (unsettled) holding must never read as not-held.
      (holdings || []).forEach(h => add(h.tradingSymbol || h.symbol,
        Math.max(Number(h.totalQty) || 0, (Number(h.dpQty) || 0) + (Number(h.t1Qty) || 0), Number(h.availableQty) || 0, Number(h.quantity) || 0)));
      (positions || []).forEach(p => add(p.tradingSymbol || p.symbol, p.netQty ?? p.netQuantity ?? p.buyQty ?? 0));
      _dhanHeldCache = { at: Date.now(), set };
      callback(null, set);
    });
  });
}

function placeBrokerSuperOrder({ broker, order, credentials }, callback) {
  const brokerId = String(broker || 'dhan').toLowerCase();
  // No-SL live placement is fail-safe OFF by default (STOCKKAR_NOSL_LIVE=1 to
  // enable after validating in Test Mode + a small live trade). When off, no
  // naked order is placed. The SL pipeline below is completely unaffected.
  if (String(order?.slMethod) === 'none') {
    if (process.env.STOCKKAR_NOSL_LIVE !== '1') {
      return callback('No-SL live orders are not enabled yet. Validate in Test Mode first (it fully simulates T1/T2 exits). To go live, set STOCKKAR_NOSL_LIVE=1 after a small test trade.', null);
    }
    const sb = brokerId === 'dhan' ? readDhanTokenStore() : readBrokerTokenStore().brokers[brokerId];
    const creds = { ...(credentials || {}),
      ...(brokerId === 'dhan' && sb ? { dhanClient: sb.clientId, dhanToken: sb.token, accessToken: sb.token } : {}),
      ...(brokerId !== 'dhan' && sb ? { clientId: sb.clientId, accountId: sb.accountId, accessToken: sb.accessToken, apiKey: sb.clientId, zerodhaApiKey: sb.clientId, zerodhaAccessToken: sb.accessToken } : {}) };
    if (brokerId === 'zerodha') return placeNoSlZerodha(order, creds, callback);
    if (brokerId === 'angelone') return placeNoSlAngel(order, creds, callback);
    if (brokerId === 'dhan') return placeNoSlDhan(order, creds.dhanClient, creds.dhanToken, callback);
    return callback('No-SL live is only supported for Dhan, Zerodha and Angel One.', null);
  }
  const storedBroker = brokerId === 'dhan' ? readDhanTokenStore() : readBrokerTokenStore().brokers[brokerId];
  const mergedCredentials = {
    ...(credentials || {}),
    ...(brokerId === 'dhan' && storedBroker ? { dhanClient: storedBroker.clientId, dhanToken: storedBroker.token, accessToken: storedBroker.token } : {}),
    ...(brokerId !== 'dhan' && storedBroker ? { clientId: storedBroker.clientId, accountId: storedBroker.accountId, accessToken: storedBroker.accessToken, apiKey: storedBroker.clientId, zerodhaApiKey: storedBroker.clientId, zerodhaAccessToken: storedBroker.accessToken, upstoxToken: storedBroker.accessToken } : {}),
  };
  if (brokerId === 'dhan') {
    const dhanClient = mergedCredentials?.dhanClient || mergedCredentials?.clientId;
    const dhanToken = mergedCredentials?.dhanToken || mergedCredentials?.accessToken;
    // Persistent Forever protection is now the DEFAULT for CNC swing/positional
    // holds (survives overnight). Intraday keeps the day-validity Super Order.
    // Kill-switch: set STOCKKAR_DHAN_FOREVER=0 to force the Super Order back.
    const useForever = process.env.STOCKKAR_DHAN_FOREVER !== '0'
      && String(order?.segment || 'CNC').toUpperCase() === 'CNC';
    const place = () => useForever
      ? placeDhanForeverBracket(order, dhanClient, dhanToken, callback)
      : placeSuperOrder(order, dhanClient, dhanToken, callback);
    // Broker-truth de-dup: never re-buy a stock already held at Dhan, even if the
    // order log has drifted. Fail-safe: on any holdings-fetch error, proceed (the
    // existing same-day log guard inside placeSuperOrder still applies).
    if (order?.allowDuplicate) return place();
    const sym = String(order?.symbol || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
    return fetchDhanHeldSymbols((hErr, heldSet) => {
      if (!hErr && heldSet && heldSet.has(sym)) {
        return callback('Safety block: ' + sym + ' is already held at Dhan (holdings/positions). Skipped to avoid a duplicate / re-buy.', null);
      }
      place();
    });
  }
  if (brokerId === 'zerodha') {
    return placeZerodhaGttOrder(order, mergedCredentials, callback);
  }
  if (brokerId === 'upstox') {
    return callback('Upstox broker execution is coming soon. Please use Dhan, Zerodha, or Test Mode for now.', null);
  }
  if (brokerId === 'fyers') {
    // Phase 1: FYERS is connect + Test Mode only. Live placement is gated OFF
    // until validated with a small live trade (Phase 2). Never place naked.
    if (process.env.STOCKKAR_FYERS_LIVE !== '1') {
      return callback('FYERS live orders are being validated — paper-trade it in Test Mode for now. (Live FYERS placement is enabled after a confirmed test trade.)', null);
    }
    return placeFyersOrder(order, mergedCredentials, callback);
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
      latestJob.parkedSymbols = [];
      latestJob.haltedDate = '';        // new day -> clear any account-error halt
      latestJob.haltedReason = '';
      latestJob.checkCount = 0;
      latestJob.lastCheckAt = null;
      latestJob.nextCheckAt = null;
      latestJob.lastResult = { status: 'monitoring', at: now.toISOString(), message: 'Monitoring window started' };
    }
    // Halted after an account error today -> don't auto-retry; wait for Run now.
    if (latestJob.haltedDate === dateKey) return;
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
      // Only positions that actually executed count as trades (TRADES column +
      // same-day no-repeat). A soft rejection leaves the symbol eligible for the
      // next scan; a hard rejection (ban/circuit/no-margin) is parked separately
      // so it isn't retried all day yet doesn't inflate the trade count.
      const traded = new Set(Array.isArray(doneJob.tradedSymbols) ? doneJob.tradedSymbols.map(s => String(s).toUpperCase()) : []);
      const parked = new Set(Array.isArray(doneJob.parkedSymbols) ? doneJob.parkedSymbols.map(s => String(s).toUpperCase()) : []);
      let haltReason = '';
      let executedCount = 0, softFailed = 0, firstFail = '';
      (result?.orders || []).forEach(o => {
        const sym = String(o.symbol || '').toUpperCase();
        if (!sym) return;
        // o.ok is !orderErr, but a broker can HTTP-reject (status >= 400) with no
        // transport error, so an executed trade also requires a non-4xx status.
        // CRITICAL: "Entry placed but ... protection FAILED" means the BUY DID go
        // through (only the stop failed) -> it MUST count as executed so the stock
        // is not re-bought every check. The SL is re-armed by the recovery pass.
        const entryPlaced = /entry placed/i.test(String(o.error || ''));
        const executed = (o.ok && !(Number(o.status) >= 400)) || entryPlaced;
        if (executed) { traded.add(sym); parked.delete(sym); executedCount++; return; }
        const reason = [o.error, o.data ? JSON.stringify(o.data) : '', o.status].filter(Boolean).join(' ');
        if (isHardRejectReason(reason)) { parked.add(sym); return; }   // per-symbol ban/circuit -> parked, not a systemic halt
        softFailed++;
        if (!firstFail) firstFail = (o.error || reason).slice(0, 200);
        // Account/config-level failures (no funds/margin, rate limit, token,
        // INVALID IP / not whitelisted, forbidden) fail for EVERY stock - don't
        // churn the whole basket. Halt for the day; user resumes with Run now.
        if (/insufficient|funds|margin|too many request|rate limit|breaching rate|token|unauthor|invalid\s*ip|ip\s*not|not\s*whitelist|whitelist|forbidden/i.test(reason)) haltReason = haltReason || (o.error || reason).slice(0, 200);
      });
      // Safety net: nothing got through and several orders soft-failed -> a
      // systemic problem (bad IP/token/network) that will fail every stock. Halt
      // regardless of the exact wording so it can never churn hundreds of orders.
      if (!haltReason && executedCount === 0 && softFailed >= 3) haltReason = 'All ' + softFailed + ' orders failed: ' + firstFail;
      doneJob.tradedSymbols = Array.from(traded);
      doneJob.parkedSymbols = Array.from(parked);
      if (haltReason && doneJob.enabled) {
        doneJob.haltedDate = dateKey;
        doneJob.haltedReason = haltReason;
        doneJob.nextCheckAt = null;
        doneJob.lastResult = { status: 'halted', error: haltReason, at: new Date().toISOString(), message: 'Paused after an account error — resumes next day or when you click Run now.' };
        writeAlgoSchedule(done);
        sendTelegram('⏸️ <b>Stockkar — algo paused</b>\n' + (doneJob.config?.algoName || doneJob.config?.screenerSlug || 'Algo') + ' stopped after: ' + haltReason + '\nResumes next day or when you click Run now.', () => {});
        console.log('[ALGO HALT]', job.id, haltReason);
        return;
      }
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
    const stored = configured ? readJsonFile(APP_LOCK_FILE) : null;
    const out = { ok: true, configured, unlocked: configured && hasAppLockSession(req), hasDobReset: !!stored?.dobHash, timedResetDelayLabel: appLockResetDelayLabel() };
    if (stored?.timedResetAt) {
      out.timedResetPending = true;
      out.timedResetAvailableAt = new Date(stored.timedResetAt + APP_LOCK_RESET_DELAY_MS).toISOString();
      out.timedResetReady = Date.now() >= stored.timedResetAt + APP_LOCK_RESET_DELAY_MS;
    }
    sendJSON(out);
    return;
  }

  // ---- Timed reset: no secret needed. Request it, wait the delay, then set a
  // new PIN. Logging in normally during the wait cancels it (owner is present).
  if (parsedUrl.pathname === '/app-lock/timed-reset/request' && req.method === 'POST') {
    if (!fs.existsSync(APP_LOCK_FILE)) return sendJSON({ ok: false, setupRequired: true, error: 'Create your App Lock PIN first.' }, 409);
    const stored = readJsonFile(APP_LOCK_FILE);
    if (!stored.timedResetAt) { stored.timedResetAt = Date.now(); writePrivateJson(APP_LOCK_FILE, stored); }
    return sendJSON({ ok: true, availableAt: new Date(stored.timedResetAt + APP_LOCK_RESET_DELAY_MS).toISOString() });
  }

  if (parsedUrl.pathname === '/app-lock/timed-reset/cancel' && req.method === 'POST') {
    if (fs.existsSync(APP_LOCK_FILE)) { const s = readJsonFile(APP_LOCK_FILE); delete s.timedResetAt; writePrivateJson(APP_LOCK_FILE, s); }
    return sendJSON({ ok: true, message: 'Timed reset cancelled.' });
  }

  if (parsedUrl.pathname === '/app-lock/timed-reset/complete' && req.method === 'POST') {
    getBody(({ pin }) => {
      if (!fs.existsSync(APP_LOCK_FILE)) return sendJSON({ ok: false, setupRequired: true, error: 'Create your App Lock PIN first.' }, 409);
      const stored = readJsonFile(APP_LOCK_FILE);
      if (!stored.timedResetAt) return sendJSON({ ok: false, error: 'No timed reset is in progress. Start one first.' }, 409);
      const readyAt = stored.timedResetAt + APP_LOCK_RESET_DELAY_MS;
      if (Date.now() < readyAt) {
        const mins = Math.ceil((readyAt - Date.now()) / 60000);
        return sendJSON({ ok: false, error: `Timed reset not ready yet. Available in about ${mins >= 60 ? Math.ceil(mins / 60) + ' hour(s)' : mins + ' minute(s)'}.` }, 425);
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
      if (!stored?.dobHash) return sendJSON({ ok: false, error: 'This PIN has no date-of-birth reset set. Use the timed reset or SSH recovery.' }, 409);

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
      const stored = readJsonFile(APP_LOCK_FILE) || {};

      // Brute-force defense: after repeated wrong PINs, lock out with an escalating
      // cooldown that persists across restarts (in app_lock.json). A 6-digit PIN is
      // only 1e6 combos, so unlimited fast guesses must not be allowed.
      const LOGIN_MAX_FAILS = 5;
      const LOCK_STEPS_MS = [60e3, 5 * 60e3, 15 * 60e3, 60 * 60e3]; // 1m, 5m, 15m, 60m
      const now = Date.now();
      if (stored.loginLockUntil && now < stored.loginLockUntil) {
        const mins = Math.ceil((stored.loginLockUntil - now) / 60000);
        return sendJSON({ ok: false, lockedOut: true, error: `Too many wrong PIN attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` }, 429);
      }

      if (!verifyAppLockPin(pin)) {
        const fails = (stored.loginFails || 0) + 1;
        const next = { ...stored, loginFails: fails };
        let body, code;
        if (fails >= LOGIN_MAX_FAILS) {
          const level = Math.min(stored.loginLockLevel || 0, LOCK_STEPS_MS.length - 1);
          next.loginLockUntil = now + LOCK_STEPS_MS[level];
          next.loginLockLevel = (stored.loginLockLevel || 0) + 1;
          next.loginFails = 0;
          const mins = Math.ceil(LOCK_STEPS_MS[level] / 60000);
          body = { ok: false, lockedOut: true, error: `Too many wrong PIN attempts. Locked for ${mins} minute${mins === 1 ? '' : 's'}.` };
          code = 429;
        } else {
          const left = LOGIN_MAX_FAILS - fails;
          body = { ok: false, error: `Incorrect App Lock PIN. ${left} attempt${left === 1 ? '' : 's'} left before lockout.` };
          code = 401;
        }
        writePrivateJson(APP_LOCK_FILE, next);
        return sendJSON(body, code);
      }

      // Correct PIN -> clear fail/lock counters, and cancel any pending timed reset
      // (owner is present, which defeats an attacker's reset request).
      const s = { ...stored };
      delete s.loginFails; delete s.loginLockUntil; delete s.loginLockLevel; delete s.timedResetAt;
      writePrivateJson(APP_LOCK_FILE, s);
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
    // Set OR reset the Update PIN. Safe to overwrite without the old PIN because
    // this path is App-Lock-sensitive (isAppLockSensitivePath) — only an app
    // already unlocked with the App-Lock PIN can reach it. So a forgotten Update
    // PIN can be reset directly from the UI, no box access needed.
    getBody(({ pin }) => {
      if (!/^\d{6,12}$/.test(String(pin || ''))) return sendJSON({ ok: false, error: 'Choose a 6 to 12 digit PIN.' }, 400);
      const existed = fs.existsSync(UPDATE_PIN_FILE);
      writePrivateJson(UPDATE_PIN_FILE, { ...hashUpdatePin(pin), createdAt: new Date().toISOString() });
      UPDATE_SESSIONS.clear();   // old update sessions no longer valid after a PIN change
      sendJSON({ ok: true, message: existed ? 'Update PIN reset. Use the new PIN to unlock updates.' : 'Update PIN configured.' });
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

  // Manually mark a stuck-open row as closed (log edit only - never touches the
  // broker). Frees the position slot when reconciliation can't auto-detect a
  // broker-side close (e.g. a completed Super Order that dropped off Dhan's list).
  if (parsedUrl.pathname === '/order-log/mark-closed' && req.method === 'POST') {
    getBody(({ id, orderId, exitPrice }) => {
      let found = false;
      const px = Number(exitPrice);
      const next = readOrderLog().map(e => {
        const match = (id && e.id === id) || (orderId && String(e.orderId) === String(orderId));
        if (!match || found) return e;
        found = true;
        const entryPx = Number(e.entryPrice ?? e.price ?? 0);
        const qty = Number(e.qty || 0);
        const hasPx = Number.isFinite(px) && px > 0;
        return {
          ...e,
          status: 'CLOSED (manual)',
          exitType: e.exitType || 'EXITED',
          exitPrice: hasPx ? Number(px.toFixed(2)) : (e.exitPrice ?? ''),
          realisedPnl: hasPx && entryPx && qty ? Number(((px - entryPx) * qty).toFixed(2)) : (e.realisedPnl ?? ''),
          manualClose: true,
          closedAt: new Date().toISOString(),
        };
      });
      if (!found) return sendJSON({ ok: false, error: 'Order not found in the log.' });
      writeOrderLog(next);
      sendJSON({ ok: true, data: next });
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
      parkedSymbols: Array.isArray(job.parkedSymbols) ? job.parkedSymbols : [],
      openPositions: openPositionsForJob(job.id, !!job.config?.testMode),
      haltedReason: job.haltedDate === istDateKey() ? (job.haltedReason || 'Account error') : '',
      lastResult: job.lastResult,
      config: job.config ? {
        algoTab: job.config.algoTab,
        algoName: job.config.algoName || '',
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
        maxOpenPositions: job.config.maxOpenPositions,
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

  // Manual "Run now": clear the interval wait on active algos so the very next
  // scheduler pass scans immediately and fills any free position slots. Reuses
  // every existing guard (open-position cap, skip/parked sets, token, test mode,
  // trading window) - it only skips the wait, it does not bypass any limit.
  if (parsedUrl.pathname === '/algo-schedule/run-now' && req.method === 'POST') {
    getBody((body) => {
      const schedule = readAlgoSchedule();
      const jobs = Array.isArray(schedule.jobs) ? schedule.jobs : [];
      const targetId = body && body.id;
      const targets = jobs.filter(j => j.enabled && (!targetId || j.id === targetId));
      if (!targets.length) return sendJSON({ ok: false, error: targetId ? 'Algo not found or not active' : 'No active algos to run' });
      const now = getIstNow();
      const day = now.getDay();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      let due = 0, busy = 0, outsideWindow = 0;
      targets.forEach(job => {
        if (job.lastResult?.status === 'running') { busy++; return; }
        const startMinutes = timeToMinutes(job.config?.runTime, '09:15');
        const endMinutes = timeToMinutes(job.config?.endTime, '10:30');
        const inWindow = day !== 0 && day !== 6 &&
          allowedScheduleDays(job.config).includes(day) &&
          nowMinutes >= startMinutes && nowMinutes <= endMinutes;
        if (!inWindow) { outsideWindow++; return; }
        job.nextCheckAt = null;            // skip the remaining interval wait
        job.haltedDate = '';               // manual Run now clears an account-error halt
        job.haltedReason = '';
        due++;
      });
      writeAlgoSchedule(schedule);
      if (due > 0) setImmediate(checkBackendSchedule); // scan now, asynchronously
      return sendJSON({
        ok: true,
        triggered: due,
        busy,
        outsideWindow,
        message: due > 0
          ? 'Checking ' + due + ' active algo' + (due > 1 ? 's' : '') + ' now — new positions will be placed for any free slots.'
          : (busy > 0
              ? 'Algo is already running a check right now.'
              : 'Outside the trading window — algos only run between their start and end time on weekdays.'),
      });
    });
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
        if (stockCount > FREE_TIER_LIMITS.maxStocksPerAlgo) return sendJSON({ ok: false, error: 'Your algo basket has ' + stockCount + ' stocks, but the algo scans the whole basket each cycle. Reduce it to ' + FREE_TIER_LIMITS.maxStocksPerAlgo + ' or fewer (free-tier limit): select fewer stocks in the Screener before Configure Algo, or use a smaller screener/watchlist. (The "qualified" count is just today\'s matches, not the basket size.)' });
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
          if (countAlgoConfigStocks(newCfg) > FREE_TIER_LIMITS.maxStocksPerAlgo) return sendJSON({ ok: false, error: 'Your algo basket has ' + countAlgoConfigStocks(newCfg) + ' stocks. Reduce to ' + FREE_TIER_LIMITS.maxStocksPerAlgo + ' or fewer (free-tier limit).' });
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
    getBody(({ symbols, screenerStocks, entryFilters, slMethod, slPct, slIndicator, slIndicatorPct, emaTrailingEnabled, emaTrailingIndicator, emaTrailingPct, emaTrailingTimeframe, emaTrailingTrigger, rrRatio, capitalPerTrade, sectorFilters, industryFilters, priceMin, priceMax, costPct, t1Pct, t1Qty, t2Pct }) => {
      const filteredStocks = filterStocksBySectorIndustry(screenerStocks || [], sectorFilters, industryFilters);
      const hasFilters = (Array.isArray(sectorFilters) && sectorFilters.length) || (Array.isArray(industryFilters) && industryFilters.length);
      const filteredSymbols = hasFilters ? extractSymbolsFromStocks(filteredStocks) : symbols;
      fetchTVData(filteredSymbols, (err, tvData) => {
        if (err) return sendJSON({ ok: false, error: err });
        const results = buildAlgoCandidates(tvData, { screenerStocks: filteredStocks.length ? filteredStocks : screenerStocks, entryFilters, slMethod, slPct, slIndicator, slIndicatorPct, emaTrailingEnabled, emaTrailingIndicator, emaTrailingPct, emaTrailingTimeframe, emaTrailingTrigger, rrRatio, capitalPerTrade, priceMin, priceMax, costPct, t1Pct, t1Qty, t2Pct });

        sendJSON({ ok: true, data: results, qualified: rankByRiskEntry(results.filter(r => r.withinEMA)) });
      });
    });
    return;
  }

  // ---- Telegram alerts ----
  if (parsedUrl.pathname === '/telegram/status' && req.method === 'GET') {
    const cfg = readTelegramConfig();
    sendJSON({ ok: true, enabled: !!cfg.enabled, configured: !!(cfg.botToken && cfg.chatId), hasBotToken: !!cfg.botToken, chatId: cfg.chatId || '', alerts: cfg.alerts || { brokerExpiry: true } });
    return;
  }
  if (parsedUrl.pathname === '/telegram/save' && req.method === 'POST') {
    getBody(({ enabled, botToken, chatId, alerts }) => {
      const cfg = readTelegramConfig();
      // Keep the stored token if the field was left blank (so it isn't wiped).
      cfg.botToken = (typeof botToken === 'string' && botToken.trim()) ? botToken.trim() : cfg.botToken;
      cfg.chatId = (chatId != null && String(chatId).trim()) ? String(chatId).trim() : cfg.chatId;
      cfg.enabled = !!enabled;
      cfg.alerts = { brokerExpiry: alerts?.brokerExpiry !== false };
      if (!cfg.botToken || !cfg.chatId) cfg.enabled = false;
      writeTelegramConfig(cfg);
      sendJSON({ ok: true, enabled: cfg.enabled, configured: !!(cfg.botToken && cfg.chatId) });
    });
    return;
  }
  if (parsedUrl.pathname === '/telegram/detect-chat' && req.method === 'POST') {
    getBody(({ botToken }) => {
      const cfg = readTelegramConfig();
      const bt = (typeof botToken === 'string' && botToken.trim()) ? botToken.trim() : cfg.botToken;
      detectTelegramChat(bt, (err, info) => {
        if (err) return sendJSON({ ok: false, error: err });
        sendJSON({ ok: true, chatId: info.chatId, name: info.name });
      });
    });
    return;
  }
  if (parsedUrl.pathname === '/telegram/test' && req.method === 'POST') {
    getBody(({ botToken, chatId }) => {
      const cfg = readTelegramConfig();
      const bt = (typeof botToken === 'string' && botToken.trim()) ? botToken.trim() : cfg.botToken;
      const cid = (chatId != null && String(chatId).trim()) ? String(chatId).trim() : cfg.chatId;
      sendTelegramRaw(bt, cid, '✅ <b>Stockkar test alert</b>\nYour Telegram alerts are connected. You will be notified when a broker token expires.', (err) => {
        if (err) return sendJSON({ ok: false, error: err });
        sendJSON({ ok: true });
      });
    });
    return;
  }

  // ---- FYERS connect (beta) ----
  if (parsedUrl.pathname === '/fyers/login-url' && req.method === 'POST') {
    getBody(({ appId, redirectUri }) => {
      if (!appId || !redirectUri) return sendJSON({ ok: false, error: 'Enter your FYERS App ID and Redirect URI first.' });
      sendJSON({ ok: true, url: fyersLoginUrl(appId, redirectUri) });
    });
    return;
  }
  if (parsedUrl.pathname === '/fyers/connect' && req.method === 'POST') {
    getBody(({ appId, secretKey, authCode, pin }) => {
      fyersExchangeAuthCode(appId, secretKey, authCode, (err, tok) => {
        if (err) return sendJSON({ ok: false, error: err });
        saveBrokerToken('fyers', { clientId: appId, clientSecret: secretKey, accessToken: tok.accessToken, refreshToken: tok.refreshToken, pin: (pin != null && String(pin).trim()) ? String(pin).trim() : undefined, source: 'settings' });
        const st = getBrokerTokenStatus('fyers');
        sendJSON({ ok: true, status: st.status, expiresAt: st.expiresAt || null });
      });
    });
    return;
  }
  if (parsedUrl.pathname === '/fyers/renew' && req.method === 'POST') {
    getBody(({ pin }) => {
      const store = readBrokerTokenStore().brokers.fyers;
      if (!store?.clientId || !store?.clientSecret || !store?.refreshToken) {
        return sendJSON({ ok: false, error: 'Connect FYERS first (no saved refresh token). Use Generate Login URL + Connect.' });
      }
      const usePin = (pin != null && String(pin).trim()) ? String(pin).trim() : store.pin;
      if (!usePin) return sendJSON({ ok: false, error: 'Enter your FYERS PIN to renew.' });
      fyersRefreshToken(store.clientId, store.clientSecret, store.refreshToken, usePin, (err, accessToken) => {
        if (err) return sendJSON({ ok: false, error: err + ' (If your refresh token has expired after ~15 days, reconnect with Generate Login URL.)' });
        saveBrokerToken('fyers', { clientId: store.clientId, accessToken, pin: usePin, source: 'manual-refresh', renewedAt: new Date().toISOString(), lastRenewalError: null });
        const st = getBrokerTokenStatus('fyers');
        sendJSON({ ok: true, status: st.status, expiresAt: st.expiresAt || null });
      });
    });
    return;
  }
  if (parsedUrl.pathname === '/fyers/status' && req.method === 'GET') {
    const st = getBrokerTokenStatus('fyers');
    sendJSON({ ok: true, configured: !!st.configured, status: st.status, expiresAt: st.expiresAt || null, minutesLeft: st.minutesLeft != null ? st.minutesLeft : null });
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

  if (parsedUrl.pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex, nofollow' });
    return res.end('User-agent: *\nDisallow: /\n');
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

// Crash-loop self-heal (safe + only when needed). If the app has restarted many
// times in a short window it's likely crash-looping on a bug a fix on `main` may
// resolve. Pull the latest FAST-FORWARD ONLY (never a destructive git op) ONCE
// per 60-min cooldown, then exit so pm2 restarts with the new code. It cannot
// loop (cooldown) and won't trigger on normal restarts (needs >= 5 boots in
// 10 min). Disable entirely with STOCKKAR_SELF_HEAL=0.
function selfHealIfCrashLooping() {
  if (process.env.STOCKKAR_SELF_HEAL === '0') return;
  const bootFile = path.join(DATA_DIR, 'boot_loop.json');
  const now = Date.now();
  let state = { boots: [], lastHealAt: 0 };
  try { state = JSON.parse(fs.readFileSync(bootFile, 'utf8')) || state; } catch {}
  state.boots = (Array.isArray(state.boots) ? state.boots : []).filter(t => now - t < 10 * 60 * 1000);
  state.boots.push(now);
  try { fs.writeFileSync(bootFile, JSON.stringify(state)); } catch {}
  if (state.boots.length < 5) return;                          // not a crash loop -> normal start
  if (now - (state.lastHealAt || 0) < 60 * 60 * 1000) return;  // already tried recently -> never loop
  try {
    console.log('[SELF-HEAL] crash loop detected (' + state.boots.length + ' restarts/10min) — pulling latest from main (ff-only)');
    require('child_process').execSync('git pull --ff-only', { cwd: __dirname, timeout: 30000, stdio: 'ignore' });
    state.lastHealAt = now; state.boots = [];
    try { fs.writeFileSync(bootFile, JSON.stringify(state)); } catch {}
    try { sendTelegram('🩹 <b>Stockkar self-heal</b>\nA crash loop was detected — pulled the latest fix from main and is restarting.', () => {}); } catch {}
    console.log('[SELF-HEAL] pulled latest; restarting so the new code takes effect');
    setTimeout(() => process.exit(1), 1500);                   // pm2 restarts with the pulled code
  } catch (e) {
    console.log('[SELF-HEAL] git pull failed (will keep running on current code): ' + (e && e.message ? e.message : e));
  }
}

// ---- ENGINE SHADOW MODE (STOCKKAR_ENGINE_SHADOW=1, staging validation) -------
// Runs the new pure position engine (engine.js) against the real Dhan snapshot
// (brokers/dhan.js) beside the existing reconciles, and LOGS what it WOULD do.
// Strictly read-only: no order-log writes, no broker writes, no alerts sent.
// Purpose: compare engine decisions vs current reconcile outcomes on live data
// for a few sessions before any cutover (strangler-pattern validation).
const ENGINE_SHADOW = process.env.STOCKKAR_ENGINE_SHADOW === '1';

// Map an order-log row to an engine position. Best-effort: rows that don't map
// cleanly are skipped and logged (that itself is migration signal).
// Map an order-log row to an engine position. Used by BOTH shadow mode (read-
// only compare) and the cutover executor (engine as writer). In cutover mode the
// engine's own persisted fields (engineState/enginePendingSl/engineGraceAt) take
// precedence so state survives across passes and restarts.
function engineShadowPosition(row, engine) {
  const broker = String(row.broker || 'dhan').toLowerCase();
  const entryPx = Number(row.entryPrice || row.price || 0);
  const t1Pct = Number(row.t1Pct || 0);
  const costPct = Number(row.costPct || 0);
  const legs = [];
  const fids = {};
  const re = /(ENTRY|FOREVER-T1|FOREVER|GTT-T1|GTT):([^|\s]+)/gi; let m;
  while ((m = re.exec(String(row.orderId || '')))) fids[m[1].toUpperCase()] = m[2].trim();
  const t1Id = broker === 'zerodha' ? (row.zerodhaGttT1Id || fids['GTT-T1'] || '') : (row.dhanForeverT1Id || fids['FOREVER-T1'] || '');
  const runId = broker === 'zerodha' ? (row.zerodhaGttId || fids['GTT'] || '') : (row.dhanForeverId || fids['FOREVER'] || '');
  if (row.splitT1 && t1Id) legs.push({ id: t1Id, role: 't1', qty: Number(row.splitLegAQty || 0) });
  if (runId) legs.push({ id: runId, role: row.splitT1 ? 'runner' : 'single', qty: Number(row.splitT1 ? row.splitLegBQty : row.qty) || 0 });
  const state = row.engineState && engine.STATE[row.engineState] ? row.engineState
    : row.awaitingFill ? engine.STATE.ENTRY_PENDING
    : row.protectionUnverified ? engine.STATE.UNPROTECTED
    : engine.STATE.PROTECTED; // open + protected is the reconciles' working assumption
  return {
    state, symbol: row.symbol, qty: Number(row.qty || 0),
    entryPrice: entryPx, slPrice: Number(row.slPrice || 0), targetPrice: Number(row.targetPrice || 0),
    t1Price: t1Pct > 0 ? entryPx * (1 + t1Pct / 100) : Number(row.targetPrice || 0),
    costTrigger: costPct > 0 ? entryPx * (1 + costPct / 100) : 0,
    entryId: row.dhanEntryOrderId || row.zerodhaEntryOrderId || fids['ENTRY'] || '',
    legs, t1Booked: !!row.mtmT1Done, costMoved: !!row.mtmCostDone,
    t1Pnl: Number(row.splitT1Pnl || 0), splitT1: !!row.splitT1,
    pendingSl: row.enginePendingSl || null,
    graceStartAt: Number(row.engineGraceAt || 0) || Date.parse(row.protectionCheckFirstAt || '') || 0,
    ltp: Number(row.testLtp || row.liveLtp || 0),
  };
}

function engineShadowCompare(brokerName, rows, snap, engine) {
  rows.forEach(row => {
    const pos = engineShadowPosition(row, engine);
    const r = engine.transition(pos, snap, {});
    const changed = r.state !== pos.state || r.actions.length || r.alerts.length || Object.keys(r.patch).length;
    if (!changed) return;
    console.log('[ENGINE-SHADOW][' + brokerName + '] ' + pos.symbol
      + ' ' + pos.state + (r.state !== pos.state ? ' -> ' + r.state : ' (unchanged)')
      + (Object.keys(r.patch).length ? ' patch=' + JSON.stringify(r.patch) : '')
      + (r.actions.length ? ' actions=' + JSON.stringify(r.actions) : '')
      + (r.alerts.length ? ' ALERTS=' + JSON.stringify(r.alerts) : '')
      + ' | row-status="' + String(row.status || '').slice(0, 60) + '"');
  });
}

function runEngineShadow() {
  if (!ENGINE_SHADOW) return;
  if (process.env.STOCKKAR_ENGINE === '1') return; // cutover active: engine IS the writer, nothing to shadow
  try {
    const engine = require('./engine');
    const all = readOrderLog().filter(e => !e.testMode && e.source !== 'test' && isOpenOrderLogEntry(e));

    // Dhan: forever-protected rows.
    const dhanRows = all.filter(e => String(e.broker || 'dhan').toLowerCase() === 'dhan'
      && /^forever/.test(String(e.dhanProtection || '')));
    const dhanStore = readDhanTokenStore();
    if (dhanRows.length && dhanStore?.token) {
      require('./brokers/dhan').getSnapshot({ token: dhanStore.token, clientId: dhanStore.clientId }, (err, snap) => {
        try {
          if (err) return console.log('[ENGINE-SHADOW][dhan] snapshot failed (engine would do NOTHING): ' + err);
          engineShadowCompare('dhan', dhanRows, snap, engine);
        } catch (e2) { console.log('[ENGINE-SHADOW][dhan] compare error: ' + (e2 && e2.message)); }
      });
    }

    // Zerodha: GTT-protected rows.
    const zRows = all.filter(e => String(e.broker || '').toLowerCase() === 'zerodha'
      && (e.zerodhaGttId || e.zerodhaGttT1Id || e.zerodhaSplit || parseZerodhaOrderIds(e.orderId).gttId));
    const zStore = readBrokerTokenStore().brokers.zerodha;
    if (zRows.length && zStore?.clientId && zStore?.accessToken) {
      require('./brokers/zerodha').getSnapshot({ apiKey: zStore.clientId, accessToken: zStore.accessToken }, (err, snap) => {
        try {
          if (err) return console.log('[ENGINE-SHADOW][zerodha] snapshot failed (engine would do NOTHING): ' + err);
          engineShadowCompare('zerodha', zRows, snap, engine);
        } catch (e2) { console.log('[ENGINE-SHADOW][zerodha] compare error: ' + (e2 && e2.message)); }
      });
    }
  } catch (e) { console.log('[ENGINE-SHADOW] error: ' + (e && e.message)); } // shadow may NEVER crash live
}

// ---- ENGINE CUTOVER (STOCKKAR_ENGINE=1): the engine becomes the WRITER --------
// Scope v1 (post-entry management only): PROTECTED/UNPROTECTED/CLOSED lifecycle —
// T1 booking, SL->cost, verify-after-modify, close reconstruction, UNPROTECTED
// detection. Entry placement, protect-after-fill and EMA trailing stay on the
// legacy code for now. When ON, the legacy reconciles this replaces are skipped
// (single writer); when OFF (default), behavior is EXACTLY as before.
// Gate to enable: >=3 clean shadow sessions per docs/ARCHITECTURE.md.
const ENGINE_MODE = process.env.STOCKKAR_ENGINE === '1';

// Translate an engine result into an order-log row patch. The engine speaks
// facts (t1Booked, costMoved, exitType); the row speaks UI fields (mtmT1Done,
// splitCostDone, status text). This is the ONLY place that mapping lives.
function engineRowPatch(row, r, brokerName) {
  const at = new Date().toISOString();
  const p = { engineState: r.state, lastStatusCheckAt: at };
  const rp = r.patch || {};
  // Append-only event history (capped): every state change / action / alert is
  // recorded on the row, so a wrong-looking position can be reconstructed
  // ("when did it go wrong?") instead of debated.
  if (r.state !== row.engineState || (r.actions || []).length || (r.alerts || []).length) {
    const ev = { at, s: (row.engineState || '?') + '>' + r.state };
    if ((r.actions || []).length) ev.a = r.actions.map(x => x.type + (x.reason ? ':' + x.reason : ''));
    if ((r.alerts || []).length) ev.w = r.alerts.map(x => x.type);
    p.events = [...(Array.isArray(row.events) ? row.events : []), ev].slice(-30);
  }
  if (rp.t1Booked) { p.mtmT1Done = true; p.t1BookedAt = at; }
  if (rp.t1Pnl !== undefined) p.splitT1Pnl = rp.t1Pnl;
  if (rp.costMoved === true) { p.mtmCostDone = true; p.splitCostDone = true; }
  if (rp.costMoved === false) { p.mtmCostDone = false; p.splitCostDone = false; }
  if (rp.slPrice !== undefined) { p.slPrice = rp.slPrice; p.brokerSlPrice = rp.slPrice; }
  if ('pendingSl' in rp) p.enginePendingSl = rp.pendingSl;
  if (rp.graceStartAt !== undefined) p.engineGraceAt = rp.graceStartAt;
  if (r.state === 'CLOSED') {
    p.exitType = rp.exitType || 'EXITED';
    p.exitPrice = rp.exitPrice;
    p.realisedPnl = rp.realisedPnl;
    p.exitEstimated = !!rp.exitEstimated;
    if (rp.t2Done) p.mtmT2Done = true;
    if (rp.t1Booked) p.mtmT1Done = true;
    p.status = brokerName.toUpperCase() + ' ' + p.exitType + (row.splitT1 ? ' (split)' : '') + ' [engine]';
    p.unrealisedPnl = undefined; p.reconciledAt = at;
  } else if (r.state === 'UNPROTECTED') {
    p.protectionUnverified = true;
    p.status = brokerName.toUpperCase() + ' ⚠ UNPROTECTED — no live stop, add a manual stop [engine]';
    p.lastTrailError = 'Protection not live at broker';
    p.reconcileNote = 'Engine verified by broker truth: position held but no protective order is live.';
  } else if (r.state === 'PROTECTED' && row.protectionUnverified) {
    p.protectionUnverified = false; p.reconcileNote = ''; p.lastTrailError = '';
  }
  return p;
}

// Execute engine actions via the EXISTING, battle-tested broker write functions.
// Crucial difference from the legacy flow: success here only sets
// enginePendingSl — the ✓ appears when a LATER snapshot shows the new trigger.
// Modify a position's SL to an arbitrary price on every leg that carries the
// shared stop (split: both legs; single: the one order). Same broker write fns
// as moveSplitLegsToCost, generalized to any price for re-asserts.
function engineModifySl(row, price, callback) {
  const broker = String(row.broker || 'dhan').toLowerCase();
  const sl = roundPrice(Number(price));
  if (!(sl > 0)) return callback('bad SL price');
  if (row.splitT1) {
    const aQty = Number(row.splitLegAQty || 0), bQty = Number(row.splitLegBQty || 0);
    const entryPx = Number(row.entryPrice || row.price || 0);
    if (broker === 'dhan') {
      return modifyDhanForeverStopLoss({ ...row, qty: bQty, emaTrailingEnabled: false }, sl, (eB) => {
        modifyDhanForeverStopLoss({ ...row, dhanForeverId: row.dhanForeverT1Id, qty: aQty, emaTrailingEnabled: false }, sl, (eA) => {
          callback(eA || eB ? ('legB:' + (eB || 'ok') + ' | legA:' + (eA || 'ok')) : null);
        });
      });
    }
    if (broker === 'zerodha') {
      const risk = entryPx - Number(row.slPrice || 0);
      const t1Pct = Number(row.t1Pct || 0), t1RR = Number(row.t1RR || 0);
      const t1Px = t1Pct > 0 ? roundPrice(entryPx * (1 + t1Pct / 100)) : (t1RR > 0 && risk > 0 ? roundPrice(entryPx + t1RR * risk) : Number(row.targetPrice || 0));
      const gttB = row.zerodhaGttId || parseZerodhaOrderIds(row.orderId).gttId;
      return zerodhaModifyGttRemainder({ ...row, orderId: 'GTT:' + gttB }, bQty, sl, Number(row.targetPrice || 0), (eB) => {
        zerodhaModifyGttRemainder({ ...row, orderId: 'GTT:' + row.zerodhaGttT1Id }, aQty, sl, t1Px, (eA) => {
          callback(eA || eB ? ('legB:' + (eB || 'ok') + ' | legA:' + (eA || 'ok')) : null);
        });
      });
    }
    return callback('unsupported broker ' + broker);
  }
  if (broker === 'dhan') return modifyDhanForeverStopLoss({ ...row, emaTrailingEnabled: false }, sl, callback);
  if (broker === 'zerodha') return modifyZerodhaGttStopLoss({ ...row, emaTrailingEnabled: false }, sl, callback);
  callback('unsupported broker ' + broker);
}

function engineExecuteAction(row, action, callback) {
  const markPending = (price, toCost) => (err) => {
    if (err) return callback(err);
    updateOrderLogRow(row.id, rw => ({ ...rw, enginePendingSl: { price, at: Date.now(), toCost: !!toCost } }));
    callback(null);
  };

  if (action.type === 'MOVE_SL_TO_COST') {
    const cost = roundPrice(Number(row.entryPrice || row.price || 0));
    if (!(cost > 0)) return callback('no entry price');
    if (action.reason === 'pre-T1' && row.splitT1) return moveSplitLegsToCost(row, markPending(cost, true));
    return engineModifySl(row, cost, markPending(cost, true));
  }

  if (action.type === 'MODIFY_SL') { // re-assert a drifted stop to the expected SL
    const want = roundPrice(Number(action.price));
    if (!(want > 0)) return callback('bad reassert price');
    return engineModifySl(row, want, markPending(want, false));
  }

  if (action.type === 'REARM_PROTECTION') {
    // Held with NO live stop: re-place protection via the proven restore path.
    // Executor owns throttling: the global kill switch, attempt caps and a
    // per-row cooldown; on success the engine re-verifies (PROTECTION_PENDING).
    if (!SL_AUTORESTORE_ENABLED) return callback('auto-restore disabled (STOCKKAR_SL_AUTORESTORE=0) — manual stop required');
    const attempts = Number(row.slRestoreAttempts || 0);
    if (attempts >= SL_RESTORE_MAX_ATTEMPTS) return callback('re-arm attempts exhausted (' + attempts + ') — manual stop required');
    if (row.engineRearmAt && Date.now() - Number(row.engineRearmAt) < 10 * 60 * 1000) return callback(null); // cooling down
    updateOrderLogRow(row.id, rw => ({ ...rw, engineRearmAt: Date.now(), slRestoreAttempts: attempts + 1 }));
    return restoreBrokerStop(row, (err, patch) => {
      if (err) return callback('re-arm failed: ' + err);
      updateOrderLogRow(row.id, rw => ({ ...rw, ...patch, engineState: 'PROTECTION_PENDING', protectionUnverified: false,
        slRestoredAt: new Date().toISOString(), lastTrailError: '' }));
      sendTelegram('🟢 <b>Stockkar — ' + row.symbol + ' protection RE-ARMED</b>\nStop re-placed @' + (patch?.brokerSlPrice || row.slPrice) + '. Verifying at the broker on the next pass.', () => {});
      callback(null);
    });
  }

  if (action.type === 'REFRESH_PROTECTION') {
    // Expiring GTT (Zerodha, 1-year validity): a modify to the SAME parameters
    // resets the expiry clock. Once per day per row.
    if (row.engineRefreshAt && Date.now() - Number(row.engineRefreshAt) < 20 * 60 * 60 * 1000) return callback(null);
    updateOrderLogRow(row.id, rw => ({ ...rw, engineRefreshAt: Date.now() }));
    const sl = roundPrice(Number(row.brokerSlPrice || row.slPrice || 0));
    return engineModifySl(row, sl, (err) => {
      if (err) return callback('refresh failed: ' + err);
      sendTelegram('🔄 <b>Stockkar — ' + row.symbol + ' protection refreshed</b>\nGTT was within 30 days of its 1-year expiry; re-asserted to extend it.', () => {});
      callback(null);
    });
  }

  callback(null); // unknown action types are ignored (forward compatibility)
}

function engineCutoverPass(brokerName, rows, snap, engine) {
  rows.forEach(row => {
    const pos = engineShadowPosition(row, engine);
    if (pos.state === engine.STATE.ENTRY_PENDING) return; // v1: entry lifecycle stays legacy
    const r = engine.transition(pos, snap, {});
    const patch = engineRowPatch(row, r, brokerName);
    updateOrderLogRow(row.id, rw => ({ ...rw, ...patch }));
    (r.actions || []).forEach(a => engineExecuteAction({ ...row, ...patch }, a, (err) => {
      if (err) console.log('[ENGINE][' + brokerName + '] action ' + a.type + ' failed for ' + row.symbol + ': ' + err);
    }));
    (r.alerts || []).forEach(al => {
      const msg = al.type === 'UNPROTECTED'
        ? '🔴 <b>Stockkar — ' + row.symbol + ' has NO live stop</b>\n' + (al.reason || '') + '\n<b>Add a manual stop now.</b>'
        : '🟠 <b>Stockkar — ' + row.symbol + ': ' + al.type + '</b>\n' + (al.reason || '');
      sendTelegram(msg, () => {});
    });
    if (r.state !== pos.state || (r.actions || []).length) {
      console.log('[ENGINE][' + brokerName + '] ' + row.symbol + ' ' + pos.state + ' -> ' + r.state
        + ((r.actions || []).length ? ' actions=' + JSON.stringify(r.actions) : ''));
    }
  });
}

function runEngineCutover() {
  if (!ENGINE_MODE) return;
  try {
    const engine = require('./engine');
    const all = readOrderLog().filter(e => !e.testMode && e.source !== 'test' && !e.awaitingFill && isOpenOrderLogEntry(e));
    const dhanRows = all.filter(e => String(e.broker || 'dhan').toLowerCase() === 'dhan'
      && /^forever/.test(String(e.dhanProtection || '')));
    const dhanStore = readDhanTokenStore();
    if (dhanRows.length && dhanStore?.token) {
      require('./brokers/dhan').getSnapshot({ token: dhanStore.token, clientId: dhanStore.clientId }, (err, snap) => {
        try {
          if (err) return console.log('[ENGINE][dhan] snapshot failed — no evidence, no action: ' + err);
          engineCutoverPass('dhan', dhanRows, snap, engine);
        } catch (e2) { console.log('[ENGINE][dhan] pass error: ' + (e2 && e2.message)); }
      });
    }
    const zRows = all.filter(e => String(e.broker || '').toLowerCase() === 'zerodha'
      && (e.zerodhaGttId || e.zerodhaGttT1Id || e.zerodhaSplit || parseZerodhaOrderIds(e.orderId).gttId));
    const zStore = readBrokerTokenStore().brokers.zerodha;
    if (zRows.length && zStore?.clientId && zStore?.accessToken) {
      require('./brokers/zerodha').getSnapshot({ apiKey: zStore.clientId, accessToken: zStore.accessToken }, (err, snap) => {
        try {
          if (err) return console.log('[ENGINE][zerodha] snapshot failed — no evidence, no action: ' + err);
          engineCutoverPass('zerodha', zRows, snap, engine);
        } catch (e2) { console.log('[ENGINE][zerodha] pass error: ' + (e2 && e2.message)); }
      });
    }
  } catch (e) { console.log('[ENGINE] error: ' + (e && e.message)); }
}

// ---- DAILY OPERATIONAL ASSURANCE (kill switch STOCKKAR_DAILY_ASSURANCE=0) -----
// Read-only checks + Telegram digests that PROVE the current features are working
// at the broker, instead of finding out when one fails:
//   08:45 IST  token preflight     — dead token = every feature silently stops
//   09:00 IST  protection audit    — each held position's stop is LIVE at the
//                                    EXPECTED price (catches failed trails,
//                                    corporate-action GTT deletions, T2T rejects)
//   15:35 IST  EOD reconciliation  — today's closes + open-position protection
//   boot+90s   recovery audit      — after any restart/self-heal (issues only)
// Never places/modifies/cancels anything.
const DAILY_ASSURANCE = process.env.STOCKKAR_DAILY_ASSURANCE !== '0';
const ASSURANCE_DONE = { preflight: '', audit: '', eod: '' };

function assuranceOpenRows() {
  return readOrderLog().filter(e => !e.testMode && e.source !== 'test' && !e.awaitingFill && isOpenOrderLogEntry(e));
}

function assuranceProtectiveIds(row) {
  const ids = [];
  [row.dhanForeverId, row.dhanForeverT1Id, row.zerodhaGttId, row.zerodhaGttT1Id].forEach(v => { if (v) ids.push(String(v).trim()); });
  const re = /(?:FOREVER(?:-T1)?|GTT(?:-T1)?):([^|\s]+)/gi; let m;
  while ((m = re.exec(String(row.orderId || '')))) ids.push(m[1].trim());
  return [...new Set(ids.filter(Boolean))];
}

// Compare one broker's open rows against its snapshot. Returns human-readable
// issue lines (empty = everything protected at the expected stop).
function auditBrokerProtection(rows, snap) {
  const norm = s => String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
  const issues = [];
  rows.forEach(row => {
    const sym = norm(row.symbol);
    const held = Number((snap.heldQty || {})[sym] || 0) > 0;
    const states = assuranceProtectiveIds(row).map(id => (snap.protections || {})[id]).filter(Boolean);
    const live = states.filter(p => p.status === 'live');
    if (live.length) {
      // costMoved tick = promise the stop sits at entry; audit against the promise.
      let expected = Number(row.brokerSlPrice || row.slPrice || 0);
      const entryPx = Number(row.entryPrice || row.price || 0);
      if (row.mtmCostDone && entryPx > 0 && expected < entryPx * 0.998) expected = entryPx;
      const trig = Number((live.find(p => Number(p.triggerPrice) > 0) || {}).triggerPrice || 0);
      if (expected > 0 && trig > 0 && Math.abs(trig - expected) > Math.max(0.05, expected * 0.002)) {
        issues.push('⚠ ' + row.symbol + ': stop at broker is ' + trig + ' but app expects ' + expected + ' — a trail/cost move may have FAILED silently');
      }
      return;
    }
    if (held) { issues.push('🔴 ' + row.symbol + ': HELD with NO live protective order — add a manual stop NOW'); return; }
    issues.push('ℹ ' + row.symbol + ': open in the log but not held and unprotected — should close on the next reconcile (watch it)');
  });
  return issues;
}

// Sweep the order log for IMPOSSIBLE states (engine.invariantViolations): e.g.
// T2 ticked without T1 on a split, cost-tick on an unprotected row, split+EMA
// trailing together. The engine can't produce these; if one appears, some other
// code path wrote a lie — surface it instead of displaying it silently.
function auditRowInvariants(rows) {
  try {
    const { invariantViolations } = require('./engine');
    const lines = [];
    rows.forEach(row => {
      const open = isOpenOrderLogEntry(row);
      invariantViolations({
        splitT1: !!row.splitT1,
        t1Booked: !!row.mtmT1Done, t2Done: !!row.mtmT2Done,
        emaTrailingEnabled: !!row.emaTrailingEnabled,
        qty: Number(row.qty || 0), legAQty: Number(row.splitLegAQty || 0), legBQty: Number(row.splitLegBQty || 0),
        open, closed: !open && !!row.exitType, exitType: row.exitType,
        realisedPnl: open ? row.realisedPnl : undefined,
        unprotected: !!row.protectionUnverified, costMoved: !!row.mtmCostDone,
      }).forEach(msg => lines.push('🧿 ' + row.symbol + ': ' + msg));
    });
    return lines;
  } catch (e) { return []; }
}

function runProtectionAudit(kind, quiet) {
  try {
    const all = assuranceOpenRows();
    const jobs = [];
    const dhanRows = all.filter(e => String(e.broker || 'dhan').toLowerCase() === 'dhan' && /^forever/.test(String(e.dhanProtection || '')));
    const dhanStore = readDhanTokenStore();
    if (dhanRows.length && dhanStore?.token) jobs.push(cb => require('./brokers/dhan').getSnapshot({ token: dhanStore.token, clientId: dhanStore.clientId }, (err, snap) => cb(err ? ['🔴 Dhan snapshot failed: ' + err + ' — protection state UNKNOWN'] : auditBrokerProtection(dhanRows, snap), 'Dhan', dhanRows.length)));
    const zRows = all.filter(e => String(e.broker || '').toLowerCase() === 'zerodha' && (e.zerodhaGttId || e.zerodhaGttT1Id || e.zerodhaSplit || parseZerodhaOrderIds(e.orderId).gttId));
    const zStore = readBrokerTokenStore().brokers.zerodha;
    if (zRows.length && zStore?.clientId && zStore?.accessToken) jobs.push(cb => require('./brokers/zerodha').getSnapshot({ apiKey: zStore.clientId, accessToken: zStore.accessToken }, (err, snap) => cb(err ? ['🔴 Zerodha snapshot failed: ' + err + ' — protection state UNKNOWN'] : auditBrokerProtection(zRows, snap), 'Zerodha', zRows.length)));
    if (!jobs.length) return;
    const sections = []; let done = 0;
    jobs.forEach(job => job((issues, name, count) => {
      sections.push({ name, count, issues });
      if (++done < jobs.length) return;
      const allIssues = sections.flatMap(s => s.issues)
        .concat(auditRowInvariants(readOrderLog().filter(e => !e.testMode && e.source !== 'test')));
      // Closed-today lines for the EOD digest.
      let closedLines = [];
      if (kind === 'EOD') {
        const today = getIstNow().toLocaleDateString('en-CA');
        closedLines = readOrderLog().filter(e => !e.testMode && e.exitType && /HIT|EXITED/.test(String(e.exitType)) &&
          String(new Date(e.reconciledAt || e.lastStatusCheckAt || 0).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })) === today)
          .slice(0, 15).map(e => '• ' + e.symbol + ' ' + e.exitType + (e.realisedPnl !== '' && e.realisedPnl !== undefined ? ' (' + (Number(e.realisedPnl) >= 0 ? '+' : '') + e.realisedPnl + ')' : ''));
      }
      if (quiet && !allIssues.length) return; // boot recovery: only speak when something is wrong
      const head = kind === 'EOD' ? '🌇 <b>Stockkar — EOD Reconciliation</b>' : kind === 'BOOT' ? '♻️ <b>Stockkar — Post-restart Audit</b>' : '🛡 <b>Stockkar — Morning Protection Audit</b>';
      const posLine = sections.map(s => s.name + ': ' + s.count + ' open').join(' | ');
      const body = allIssues.length ? allIssues.join('\n') : '✅ Every position has live protection at the expected stop.';
      sendTelegram(head + '\n' + posLine + '\n' + body + (closedLines.length ? '\n<b>Closed today:</b>\n' + closedLines.join('\n') : ''), () => {});
      if (allIssues.length) console.log('[ASSURANCE][' + kind + '] issues:\n' + allIssues.join('\n'));
    }));
  } catch (e) { console.log('[ASSURANCE] audit error: ' + (e && e.message)); }
}

function runTokenPreflight() {
  try {
    const checks = []; const results = [];
    const dhanStore = readDhanTokenStore();
    if (dhanStore?.token) checks.push(cb => require('./brokers/dhan').getSnapshot({ token: dhanStore.token, clientId: dhanStore.clientId }, err => cb('Dhan', err)));
    const zStore = readBrokerTokenStore().brokers.zerodha;
    if (zStore?.clientId && zStore?.accessToken) checks.push(cb => require('./brokers/zerodha').getSnapshot({ apiKey: zStore.clientId, accessToken: zStore.accessToken }, err => cb('Zerodha', err)));
    if (!checks.length) return;
    let done = 0;
    checks.forEach(check => check((name, err) => {
      results.push(err ? '🔴 ' + name + ': ' + err + ' — FIX THE TOKEN BEFORE OPEN or every feature is blind today' : '✅ ' + name + ' token OK');
      if (++done < checks.length) return;
      sendTelegram('🎫 <b>Stockkar — Pre-market Token Check (8:45)</b>\n' + results.join('\n'), () => {});
    }));
  } catch (e) { console.log('[ASSURANCE] preflight error: ' + (e && e.message)); }
}

// ---- DRIFT AUTO-FIX (pre-cutover; kill switch STOCKKAR_DRIFT_AUTOFIX=0) ------
// The legacy trail/cost-move paths trust a broker 200 on modify, but brokers
// validate modifies ASYNC — so a stop can sit at the WRONG price while the app
// shows the new one. Every few minutes this compares each open position's live
// trigger at the broker against the expected SL and, DIRECTION-AWARE for longs:
//   broker trigger BELOW expected -> re-assert the modify (raise it back) + alert
//   broker trigger ABOVE expected -> adopt broker truth into the row (never lower)
// The fix itself is NOT trusted: nothing is ticked; the next cycle re-reads the
// broker and only silence (no more mismatch) means fixed — else it retries
// (max 3/day per row, 10-min cooldown) and the 9:00/15:35 audits escalate.
// Superseded by the engine's rule (5) when STOCKKAR_ENGINE=1.
const DRIFT_AUTOFIX = process.env.STOCKKAR_DRIFT_AUTOFIX !== '0';
let driftFixInFlight = false;
function checkDriftedStops() {
  if (!DRIFT_AUTOFIX || process.env.STOCKKAR_ENGINE === '1') return;
  if (driftFixInFlight || !withinMarketHours()) return;
  driftFixInFlight = true;
  const done = () => { driftFixInFlight = false; };
  try {
    const today = getIstNow().toLocaleDateString('en-CA');
    const norm = s => String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
    const fixable = row => {
      if (row.testMode || row.source === 'test' || row.awaitingFill || !isOpenOrderLogEntry(row)) return false;
      if (row.protectionUnverified) return false;                       // no live stop: the RESTORE path owns it
      if (row.driftFixAt && Date.now() - Number(row.driftFixAt) < 10 * 60 * 1000) return false;
      if (row.driftFixDay === today && Number(row.driftFixCount || 0) >= 3) return false;
      return Number(row.brokerSlPrice || row.slPrice || 0) > 0;
    };
    const processBroker = (brokerName, rows, snap, next) => {
      let i = 0;
      const step = () => {
        if (i >= rows.length) return next();
        const row = rows[i++];
        const sym = norm(row.symbol);
        const held = Number((snap.heldQty || {})[sym] || 0);
        const idStates = assuranceProtectiveIds(row)
          .map(id => ({ id, st: (snap.protections || {})[id] }))
          .filter(x => x.st);
        const live = idStates.filter(x => x.st.status === 'live');
        const cancelFn = brokerName === 'dhan' ? dhanCancelForever : zerodhaCancelGtt;

        // (a) ORPHANED PROTECTION (Zerodha; Dhan has its own orphan pass): entry is
        // DEAD at the broker + symbol NOT held + protection still LIVE -> the stop
        // guards nothing; if it fired it would SELL what we do not hold.
        if (brokerName === 'zerodha' && live.length && held <= 0) {
          const entryId = String(row.zerodhaEntryOrderId || (String(row.orderId || '').match(/ENTRY:([^|\s]+)/i) || [])[1] || '').trim();
          const ent = entryId ? (snap.entries || {})[entryId] : null;
          if (ent && ent.status === 'dead') {
            let j = 0;
            const cancelNext = () => {
              if (j >= live.length) {
                updateOrderLogRow(row.id, r => ({ ...r, exitType: 'REJECTED',
                  status: 'ZERODHA ENTRY DEAD — no position, orphaned GTT cancelled',
                  rejectionReason: (r.rejectionReason || '') + ' Orphaned GTT cancelled to avoid a naked short.',
                  lastStatusCheckAt: new Date().toISOString() }));
                sendTelegram('🟠 <b>Stockkar — ' + row.symbol + ' orphaned GTT cancelled</b>\nEntry never became a position; its protective GTT was cancelled so it cannot fire into nothing.', () => {});
                return step();
              }
              cancelFn(live[j++].id, () => cancelNext()); // best-effort; audits re-flag on failure
            };
            return cancelNext();
          }
        }

        // (b) DUPLICATE ATTRIBUTABLE PROTECTION: more of the row's OWN ids live than
        // the position needs (re-arm/restore race) -> first fired order exits the
        // position, the survivor later fires into nothing. Keep the CURRENT field
        // ids, cancel historical extras. Unattributable surplus is audit-only.
        const expectedLegs = row.splitT1 ? 2 : 1;
        if (live.length > expectedLegs) {
          const keep = new Set([row.dhanForeverId, row.dhanForeverT1Id, row.zerodhaGttId, row.zerodhaGttT1Id]
            .filter(Boolean).map(v => String(v).trim()));
          const extras = live.filter(x => !keep.has(x.id));
          if (extras.length && !(row.integrityFixAt && Date.now() - Number(row.integrityFixAt) < 30 * 60 * 1000)) {
            updateOrderLogRow(row.id, r => ({ ...r, integrityFixAt: Date.now() }));
            let j = 0;
            const cancelNext = () => {
              if (j >= extras.length) {
                sendTelegram('🟠 <b>Stockkar — ' + row.symbol + ' DUPLICATE protection cancelled</b>\n' + extras.length + ' extra protective order(s) from an earlier re-arm were cancelled (kept the current one). A duplicate would have fired AFTER the position closed.', () => {});
                return step();
              }
              cancelFn(extras[j++].id, () => cancelNext());
            };
            return cancelNext();
          }
        }

        // (c) PROTECTION QTY > HELD QTY (e.g. a partial manual exit): the resting
        // stop would over-SELL when it fires. Single-leg rows: shrink protection to
        // the held qty. Splits: alert only (which leg to shrink is a human call).
        const liveQty = live.reduce((s, x) => s + Number(x.st.qty || 0), 0);
        if (held > 0 && liveQty > held && !(row.integrityFixAt && Date.now() - Number(row.integrityFixAt) < 30 * 60 * 1000)) {
          if (!row.splitT1 && live.length === 1) {
            updateOrderLogRow(row.id, r => ({ ...r, integrityFixAt: Date.now(), qty: held }));
            const slNow = Number(row.brokerSlPrice || row.slPrice || 0);
            const shrink = brokerName === 'dhan'
              ? cb => modifyDhanForeverStopLoss({ ...row, qty: held, emaTrailingEnabled: false }, slNow, cb)
              : cb => zerodhaModifyGttRemainder(row, held, slNow, Number(row.targetPrice || 0), cb);
            return shrink((err) => {
              sendTelegram((err ? '🔴' : '🟠') + ' <b>Stockkar — ' + row.symbol + ' protection qty ' + (err ? 'fix FAILED' : 'corrected') + '</b>\nStop covered ' + liveQty + ' but only ' + held + ' held' + (err ? ' (' + err + ') — fix manually.' : ' — protection resized to ' + held + ' (an over-sell on trigger would open a short).'), () => {});
              step();
            });
          }
          sendTelegram('🟠 <b>Stockkar — ' + row.symbol + ' protection/held qty mismatch</b>\nProtective orders cover ' + liveQty + ' but only ' + held + ' held (split position — adjust the legs manually in the broker).', () => {});
          updateOrderLogRow(row.id, r => ({ ...r, integrityFixAt: Date.now() }));
        }

        // (d) DRIFTED STOP (direction-aware; see header comment).
        // A "SL moved to cost ✓" tick is a PROMISE that the stop sits at entry.
        // If the row's recorded SL is below entry (a legacy trusted-on-write
        // failure that corrupted the field too), the promise wins: expect cost.
        let expected = Number(row.brokerSlPrice || row.slPrice || 0);
        const entryPx = Number(row.entryPrice || row.price || 0);
        if (row.mtmCostDone && entryPx > 0 && expected < entryPx * 0.998) expected = roundPrice(entryPx);
        const tol = Math.max(0.05, expected * 0.002);
        const trigs = live.filter(x => Number(x.st.triggerPrice) > 0).map(x => Number(x.st.triggerPrice));
        if (!trigs.length) return step();                               // nothing verifiable -> audits handle it
        const below = trigs.filter(t => expected - t > tol);
        const above = Math.max(...trigs);
        if (below.length) {
          const count = (row.driftFixDay === today ? Number(row.driftFixCount || 0) : 0) + 1;
          updateOrderLogRow(row.id, r => ({ ...r, driftFixAt: Date.now(), driftFixDay: today, driftFixCount: count }));
          return engineModifySl(row, expected, (err) => {
            sendTelegram((err ? '🔴' : '🟠') + ' <b>Stockkar — ' + row.symbol + ' stop DRIFT ' + (err ? 'fix FAILED' : 'auto-fixed') + '</b>\nBroker held the stop at ' + below[0] + ' but it should be ' + expected + '. ' + (err ? 'Re-assert failed (' + err + ') — attempt ' + count + '/3. Check manually.' : 'Re-asserted to ' + expected + ' (attempt ' + count + '/3) — will re-verify next cycle.'), () => {});
            console.log('[DRIFT-FIX] ' + row.symbol + ' ' + below[0] + ' -> ' + expected + (err ? ' FAILED: ' + err : ' re-asserted'));
            step();
          });
        }
        if (above - expected > tol) {                                    // broker is MORE protective: adopt, never lower
          updateOrderLogRow(row.id, r => ({ ...r, slPrice: above, brokerSlPrice: above,
            reconcileNote: 'Adopted broker stop ' + above + ' (row expected ' + expected + ' — broker truth wins upward).' }));
          console.log('[DRIFT-FIX] ' + row.symbol + ' adopted higher broker stop ' + above);
        }
        step();
      };
      step();
    };
    const all = readOrderLog().filter(fixable);
    const dhanRows = all.filter(e => String(e.broker || 'dhan').toLowerCase() === 'dhan' && /^forever/.test(String(e.dhanProtection || '')));
    const zRows = all.filter(e => String(e.broker || '').toLowerCase() === 'zerodha' && (e.zerodhaGttId || e.zerodhaGttT1Id || e.zerodhaSplit || parseZerodhaOrderIds(e.orderId).gttId));
    const dhanStore = readDhanTokenStore();
    const zStore = readBrokerTokenStore().brokers.zerodha;
    const runZ = () => {
      if (!zRows.length || !zStore?.clientId || !zStore?.accessToken) return done();
      require('./brokers/zerodha').getSnapshot({ apiKey: zStore.clientId, accessToken: zStore.accessToken }, (err, snap) => {
        if (err) return done();                                          // no evidence, no action
        processBroker('zerodha', zRows, snap, done);
      });
    };
    if (dhanRows.length && dhanStore?.token) {
      require('./brokers/dhan').getSnapshot({ token: dhanStore.token, clientId: dhanStore.clientId }, (err, snap) => {
        if (err) return runZ();
        processBroker('dhan', dhanRows, snap, runZ);
      });
    } else runZ();
  } catch (e) { console.log('[DRIFT-FIX] error: ' + (e && e.message)); done(); }
}

function checkDailyAssurance() {
  if (!DAILY_ASSURANCE) return;
  const ist = getIstNow();
  const day = ist.getDay();
  if (day === 0 || day === 6) return; // market closed
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const key = ist.toLocaleDateString('en-CA');
  if (mins >= 8 * 60 + 45 && mins <= 9 * 60 + 10 && ASSURANCE_DONE.preflight !== key) { ASSURANCE_DONE.preflight = key; runTokenPreflight(); }
  if (mins >= 9 * 60 && mins <= 15 * 60 + 30 && ASSURANCE_DONE.audit !== key) { ASSURANCE_DONE.audit = key; runProtectionAudit('MORNING'); }
  if (mins >= 15 * 60 + 35 && mins <= 17 * 60 && ASSURANCE_DONE.eod !== key) { ASSURANCE_DONE.eod = key; runProtectionAudit('EOD'); }
}

if (require.main === module) {
  selfHealIfCrashLooping();
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
    checkTelegramTokenAlerts();
    checkFyersTokenRenewal();
    setInterval(checkTelegramTokenAlerts, 3 * 60 * 1000);
    setInterval(checkFyersTokenRenewal, 5 * 60 * 1000);
    setInterval(checkMtmRules, 60 * 1000);
    setInterval(checkAlgoScreenerRefresh, 3 * 60 * 1000);
    setInterval(reconcileBrokerOrders, 5 * 60 * 1000);
    if (ENGINE_SHADOW) { console.log('  ENGINE SHADOW MODE: ON (read-only validation)'); setInterval(runEngineShadow, 2 * 60 * 1000); }
    if (ENGINE_MODE) { console.log('  ENGINE CUTOVER: ON (engine is the writer for Dhan/Zerodha post-entry lifecycle)'); setInterval(runEngineCutover, 2 * 60 * 1000); }
    // Warm the scrip-master/series cache so the T2T entry gate has data before
    // the first scan (12h cache; re-warmed every 6h).
    loadDhanSecurityMap(() => {});
    setInterval(() => loadDhanSecurityMap(() => {}), 6 * 60 * 60 * 1000);
    if (DRIFT_AUTOFIX) setInterval(checkDriftedStops, 5 * 60 * 1000);
    if (DAILY_ASSURANCE) {
      setInterval(checkDailyAssurance, 60 * 1000);
      // Boot recovery: after any restart/self-heal, audit protection state before
      // the day goes on (speaks ONLY if something is wrong).
      setTimeout(() => { if (assuranceOpenRows().length) runProtectionAudit('BOOT', true); }, 90 * 1000);
    }
    setInterval(checkBackendSchedule, 30000);
    setInterval(checkDhanTokenRenewal, 60000);
    setInterval(checkBrokerTokenRenewal, 60000);
    setInterval(checkDailyEmaTrailing, 10 * 60 * 1000);
    setInterval(checkEmaTrailingTargetTriggers, 3 * 60 * 1000);
    setInterval(checkAndRestoreBrokerStops, 2 * 60 * 1000);
    setInterval(runPaperBrokerPass, 60 * 1000);
    setInterval(updateLiveUnrealisedPnl, 60 * 1000);
    setInterval(checkSplitMoveToCost, 60 * 1000);
    setInterval(checkAngelOneSoftwareTargets, 3 * 60 * 1000);
    setInterval(checkSavedScreenerMonitors, 5 * 60 * 1000);
  });
}

module.exports = handleRequest;


