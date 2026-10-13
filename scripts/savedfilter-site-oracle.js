'use strict';
// scripts/savedfilter-site-oracle.js - run the stockkar.in Stocklab page's OWN
// code, headless, to get the exact /api/global-filter/stocks query it sends for
// a saved screener. Read-only with respect to the site: it reads the site repo
// with `git show <ref>:<path>` and transpiles in memory; nothing is written there.
//
// WHY (2026-10-13). savedfilter-query.js is a hand PORT of the page's
// translation. The site keeps adding filters (MACD, RSI vs its average,
// Bollinger Bands, ADX, growth-meter trends, chart presets), and a port that
// lags drops a filter SILENTLY - a wider basket, wrong stocks. Live captures
// need a logged-in browser; this needs only the site repo. It mounts the real
// page component (ScreenerPageContent) under a tiny hooks runtime, answers its
// API calls from fixtures (the saved config, the live ranges, the calendars),
// lets the page apply the screen exactly as `?saved=<slug>` does, and records
// the results request the page's real fetchStocks sends.
//
// Usage:
//   node scripts/savedfilter-site-oracle.js --site "<path to stockkar-app>" [--ref origin/main]
//        [--captured]          compare the ORACLE with the captured queries (validates the oracle)
//        [--configs file.json] extra configs [{slug,name,filters}] compared oracle-vs-port
//        [--json out.json]     write {slug: siteQuery} for every config compared
// Without --captured it compares the oracle with savedfilter-query.js (the port).
// Needs the site repo's node_modules (typescript, date-fns) - read, never changed.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');

const SHIMS = (() => {
  // ---- a tiny hooks runtime: slots by call order, like React ----------------
  const R = { slots: [], idx: 0, effects: [], dirty: false };
  const depsEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  function useState(init) {
    const i = R.idx++;
    if (!(i in R.slots)) R.slots[i] = { v: typeof init === 'function' ? init() : init };
    const s = R.slots[i];
    if (!s.set) s.set = (nv) => { const val = typeof nv === 'function' ? nv(s.v) : nv; if (!Object.is(val, s.v)) { s.v = val; R.dirty = true; } };
    return [s.v, s.set];
  }
  function useRef(init) { const i = R.idx++; if (!(i in R.slots)) R.slots[i] = { current: init }; return R.slots[i]; }
  function useMemo(fn, deps) {
    const i = R.idx++; const p = R.slots[i];
    if (p && deps && depsEqual(p.deps, deps)) return p.v;
    const v = fn(); R.slots[i] = { v, deps }; return v;
  }
  function useCallback(fn, deps) { return useMemo(() => fn, deps); }
  function useEffect(fn, deps) {
    const i = R.idx++; const p = R.slots[i];
    if (!p || !deps || !depsEqual(p.deps, deps)) { R.slots[i] = { deps }; R.effects.push(fn); }
  }
  function useReducer(reducer, init, initFn) {
    const [s, set] = useState(() => (initFn ? initFn(init) : init));
    return [s, (a) => set((prev) => reducer(prev, a))];
  }
  const Stub = function Stub() { return null; };
  const React = {
    createElement: () => null, Fragment: Stub, Suspense: Stub, StrictMode: Stub,
    useState, useEffect, useLayoutEffect: useEffect, useInsertionEffect: useEffect, useRef, useMemo, useCallback, useReducer,
    useTransition: () => [false, (cb) => cb()], startTransition: (cb) => cb(), useDeferredValue: (v) => v, useId: () => 'oracle-id',
    useContext: () => ({}), createContext: (v) => ({ Provider: Stub, Consumer: Stub, _v: v }), useSyncExternalStore: (s, g) => g(),
    useImperativeHandle: () => {}, memo: (c) => c, forwardRef: (c) => c, lazy: () => Stub, Children: { map: () => [], toArray: () => [] },
    cloneElement: () => null, isValidElement: () => false,
  };
  React.default = React; React.__esModule = true;
  return { R, React, Stub };
})();

function makeSiteOracle(opts) {
  const site = opts.site;
  const ref = opts.ref || 'origin/main';
  const nm = (p) => path.join(site, 'node_modules', p);
  const ts = require(nm('typescript'));
  const show = (p) => execFileSync('git', ['-C', site, 'show', ref + ':' + p], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const exists = (p) => { try { execFileSync('git', ['-C', site, 'cat-file', '-e', ref + ':' + p], { stdio: 'ignore' }); return true; } catch { return false; } };
  const transpile = (src, fileName) => ts.transpileModule(src, { fileName, compilerOptions: {
    jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true, allowJs: true,
  } }).outputText;
  // Modules whose LOGIC decides the query run for real; the rest are UI and stubbed.
  const REAL = ['@/utils/rollingDates', '@/app/components/Services/FetchStocks', '@/app/components/GlobalFilter/patternShape',
    '@/app/components/GlobalFilter/Filters'];
  const resolveAt = (spec) => {
    const base = spec.replace(/^@\//, '');
    for (const ext of ['', '.js', '.jsx', '.ts', '.tsx']) if (exists(base + ext)) return base + ext;
    return null;
  };

  const { R, React, Stub } = SHIMS;
  let world = null;   // per-run inputs: config, defaults, calendars, requests
  const axiosStub = {
    get: async (url) => {
      const u = String(url);
      world.requests.push(u);
      const pathOnly = u.split('?')[0];
      if (/\/api\/saved-filter\/slug\//.test(pathOnly)) return { data: { name: world.name || 'oracle', filters: world.config } };
      if (pathOnly === '/api/global-filter/filters/ranges') return { data: world.defaults.ranges };
      if (pathOnly === '/api/global-filter/available-quarters') return { data: world.defaults.latestQuarter ? [{ key: world.defaults.latestQuarter, label: world.defaults.latestQuarter }] : [] };
      if (pathOnly === '/api/global-filter/valid-trading-dates') return { data: { dates: world.calendars.daily.slice() } };
      if (pathOnly === '/api/global-filter/fyoc/available-weeks') return { data: { weeks: world.calendars.weekly.slice() } };
      if (pathOnly === '/api/global-filter/fyoc/available-months') return { data: { months: world.calendars.monthly.slice() } };
      if (pathOnly === '/api/global-filter/stocks') return { data: { count: 0, data: [] } };
      return { data: {} };
    },
    post: async () => ({ data: {} }), put: async () => ({ data: {} }), delete: async () => ({ data: {} }),
    interceptors: { request: { use() {} }, response: { use() {} } }, defaults: { headers: { common: {} } },
  };
  axiosStub.default = axiosStub; axiosStub.__esModule = true;

  const stubModule = () => new Proxy({ __esModule: true, default: Stub }, {
    get(t, k) { return k in t ? t[k] : Stub; },
  });
  const SPECIAL = {
    react: React,
    'next/navigation': { __esModule: true, useSearchParams: () => ({ get: (k) => (world && world.search[k]) || null, toString: () => '' }),
      useRouter: () => ({ push() {}, replace() {}, prefetch() {}, back() {} }), usePathname: () => '/stocklab/global-filter' },
    'next/dynamic': { __esModule: true, default: () => Stub },
    'next/link': { __esModule: true, default: Stub },
    'next/image': { __esModule: true, default: Stub },
    sonner: { __esModule: true, toast: Object.assign(() => {}, { success() {}, error() {}, info() {}, warning() {}, message() {}, dismiss() {} }) },
    '@/utils/axiosInstance': axiosStub,
    '@/app/context/AuthContext': { __esModule: true, useAuth: () => ({ user: { id: 1, email: 'oracle@local', plan: 'pro', is_pro: true }, loading: false, isAuthenticated: true }) },
    '@/hooks/useFeatureAccess': { __esModule: true, default: () => new Proxy({ isGuest: false, isProUser: true }, { get: (t, k) => (k in t ? t[k] : () => true) }) },
    '@/hooks/useLivePrices': { __esModule: true, useLivePrices: () => ({ tickerData: {} }) },
  };
  const cache = {};
  function loadModule(file, src) {
    if (cache[file]) return cache[file].exports;
    const code = transpile(src, file);
    const module = { exports: {} };
    cache[file] = module;
    const fn = vm.runInContext('(function (exports, require, module, __filename, __dirname) {' + code + '\n})', ctx, { filename: file });
    fn(module.exports, (spec) => req(spec), module, file, path.dirname(file));
    return module.exports;
  }
  function req(spec) {
    if (SPECIAL[spec]) return SPECIAL[spec];
    if (/\.css$/.test(spec)) return {};
    if (REAL.includes(spec)) { const f = resolveAt(spec); if (f) return loadModule(f, show(f)); }
    if (spec === 'date-fns' || spec.startsWith('date-fns/')) { try { return require(nm(spec)); } catch { return stubModule(); } }
    return stubModule();
  }

  // ---- the browser globals the page touches at render / in effects ----------
  const noop = () => {};
  const storage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() }; };
  const sandbox = {
    console: { log: noop, info: noop, warn: noop, error: noop, debug: noop },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop, queueMicrotask,
    URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, Promise, JSON, Math, Date, Intl,
    requestAnimationFrame: (cb) => setTimeout(cb, 0), cancelAnimationFrame: noop,
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
    localStorage: storage(), sessionStorage: storage(),
    navigator: { userAgent: 'oracle', clipboard: { writeText: async () => {} } },
    process: { env: {} },
  };
  sandbox.window = {
    ...sandbox, location: { search: '', href: 'https://www.stockkar.in/stocklab/global-filter', pathname: '/stocklab/global-filter', origin: 'https://www.stockkar.in' },
    addEventListener: noop, removeEventListener: noop, dispatchEvent: noop, innerWidth: 1366, innerHeight: 900, scrollTo: noop, scrollY: 0,
    matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
    getComputedStyle: () => ({}), open: noop, history: { replaceState: noop, pushState: noop },
  };
  sandbox.document = { addEventListener: noop, removeEventListener: noop, getElementById: () => null, querySelector: () => null,
    querySelectorAll: () => [], createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop, click: noop }),
    body: { style: {}, appendChild: noop, removeChild: noop, classList: { add: noop, remove: noop } }, documentElement: { style: {}, classList: { add: noop, remove: noop } },
    visibilityState: 'visible', cookie: '' };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  // ---- the page itself --------------------------------------------------------
  const PAGE = 'app/(main)/stocklab/global-filter/page.jsx';
  const pageSrc = show(PAGE) + '\n;module.exports.__ScreenerPageContent = ScreenerPageContent;\n';
  const page = loadModule(PAGE, pageSrc);
  const Content = page.__ScreenerPageContent;
  if (typeof Content !== 'function') throw new Error('ScreenerPageContent not found in ' + PAGE + ' at ' + ref);

  const flush = () => new Promise((r) => setTimeout(r, 0));
  async function queryFor(config, o) {
    o = o || {};
    world = { config, name: o.name, defaults: o.defaults, calendars: { daily: [], weekly: [], monthly: [], ...(o.calendars || {}) },
      search: { saved: o.slug || 'oracle' }, requests: [] };
    R.slots = []; R.effects = []; R.idx = 0;
    const errors = [];
    for (let pass = 0; pass < 60; pass++) {
      R.idx = 0; R.effects = []; R.dirty = false;
      try { Content(); } catch (e) { errors.push('render: ' + (e && e.stack || e)); break; }
      const fx = R.effects;
      for (const f of fx) { try { f(); } catch (e) { errors.push('effect: ' + (e && e.message || e)); } }
      for (let k = 0; k < 8; k++) await flush();
      if (!R.dirty) break;
    }
    const stocks = world.requests.filter((u) => u.startsWith('/api/global-filter/stocks?'));
    const results = stocks.filter((u) => /[?&]limit=20(&|$)/.test(u) && /[?&]offset=0(&|$)/.test(u));
    const last = results[results.length - 1] || null;
    return { query: last ? last.split('?')[1] : null, stocksRequests: stocks, errors };
  }
  return { queryFor, ref };
}

module.exports = { makeSiteOracle };

// ---- CLI ----------------------------------------------------------------------
if (require.main === module) {
  const argv = process.argv.slice(2);
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const site = arg('--site');
  if (!site) { console.error('usage: --site <path to stockkar-app> [--ref origin/main] [--captured] [--configs file.json] [--json out.json]'); process.exit(2); }
  const ROOT = path.join(__dirname, '..');
  const DIR = path.join(ROOT, 'test', 'fixtures', 'savedfilters');
  const QDOC = JSON.parse(fs.readFileSync(path.join(DIR, '_site-queries.json'), 'utf8'));
  const DEFAULTS = JSON.parse(fs.readFileSync(path.join(DIR, '_site-defaults.json'), 'utf8'));
  const MANIFEST = JSON.parse(fs.readFileSync(path.join(DIR, '_manifest.json'), 'utf8'));
  const rd = require(path.join(ROOT, 'rollingdates'));
  const { buildSavedFilterQuery } = require(path.join(ROOT, 'savedfilter-query'));
  // Same calendar as savedfilter.parity.test.js: weekdays back from the capture day.
  const CAL = []; const d = new Date((DEFAULTS.latestTradingDate || '2026-09-07') + 'T00:00:00Z');
  while (CAL.length < 80) { if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) CAL.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); }
  CAL.reverse();
  const calendars = { daily: CAL, weekly: [], monthly: [] };
  const IGNORE = new Set(['limit', 'offset']);
  const asMap = (P) => { const m = {}; for (const k of new Set(P.keys())) if (!IGNORE.has(k)) m[k] = P.getAll(k).sort().join(' | '); return m; };
  const diff = (a, b) => {
    const out = [];
    Object.keys(a).filter((k) => !(k in b)).forEach((k) => out.push('only-oracle ' + k + '=' + a[k]));
    Object.keys(b).filter((k) => !(k in a)).forEach((k) => out.push('only-other ' + k + '=' + b[k]));
    Object.keys(a).filter((k) => k in b && a[k] !== b[k]).forEach((k) => out.push('differs ' + k + ': oracle=' + a[k] + ' other=' + b[k]));
    return out;
  };
  (async () => {
    const oracle = makeSiteOracle({ site, ref: arg('--ref', 'origin/main') });
    const items = MANIFEST.map((m) => ({ slug: m.slug, name: m.name, filters: JSON.parse(fs.readFileSync(path.join(DIR, m.slug + '.json'), 'utf8')).filters }));
    const extra = arg('--configs') ? JSON.parse(fs.readFileSync(arg('--configs'), 'utf8')) : [];
    const captured = argv.includes('--captured');
    let same = 0; const bad = []; const out = {};
    for (const it of (captured ? items : items.concat(extra))) {
      if (captured && QDOC.excluded && QDOC.excluded[it.slug]) continue;
      const r = await oracle.queryFor(it.filters, { slug: it.slug, name: it.name, defaults: DEFAULTS, calendars });
      out[it.slug] = r.query;
      if (!r.query) { bad.push([it.slug, it.name, ['NO RESULTS QUERY; errors: ' + r.errors.slice(0, 3).join(' || ')]]); continue; }
      const o = asMap(new URLSearchParams(r.query));
      let other;
      if (captured) other = asMap(new URLSearchParams(QDOC.queries[it.slug]));
      else {
        const resolved = rd.hasRollingDates(it.filters) ? rd.resolveRollingFilterDates(it.filters, calendars) : it.filters;
        other = asMap(buildSavedFilterQuery(resolved, { limit: 20, offset: 0, defaults: DEFAULTS }));
      }
      const dd = diff(o, other);
      if (dd.length) bad.push([it.slug, it.name, dd]); else same++;
    }
    console.log('oracle @' + oracle.ref + ' vs ' + (captured ? 'CAPTURED site queries' : 'savedfilter-query.js (port)') + ': ' + same + ' identical, ' + bad.length + ' different');
    bad.forEach(([s, n, dd]) => { console.log('\n' + s + ' "' + n + '"'); dd.forEach((x) => console.log('   ' + x)); });
    if (arg('--json')) fs.writeFileSync(arg('--json'), JSON.stringify(out, null, 1));
    process.exit(bad.length ? 1 : 0);
  })().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
}
