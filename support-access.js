'use strict';
/**
 * SUPPORT ACCESS — a second, weaker door into a box, opened by its owner.
 *
 * The problem (owner, 2026-09-13): "our aim is to debug user issues and solve
 * them without logging into server AWS or Oracle" — and, separately, "we don't
 * want to pull data". So: no telemetry pipeline, no copy of anyone's trades on
 * our servers, no inbound port. Instead the customer grants a TIME-LIMITED,
 * READ-ONLY pass to their own box and sends the link; support looks at the
 * live machine and the pass expires on its own.
 *
 * What this module decides (pure, no I/O — the caller mints, stores and
 * expires the token):
 *   1. WHICH requests a support pass may make. An explicit ALLOW-LIST of
 *      read-only routes, GET only. Anything not named here is refused —
 *      including every POST, so a support session can never place an order,
 *      cancel a trigger, change a setting, touch a broker token, trigger an
 *      update or alter the App Lock. A deny-list would be one new route away
 *      from a hole; an allow-list fails closed by construction.
 *   2. WHAT may leave the box in a response. Diagnostic routes call the broker
 *      with real credentials, so their payloads are redacted on the way out.
 *      Belt and braces: nothing here is supposed to echo a token, and this
 *      guarantees it even if one day something does.
 *
 * The pass is deliberately NOT a second App Lock: it cannot unlock the app, it
 * carries no session, and it dies at its expiry whatever else happens.
 */

const MAX_HOURS = 8;          // a support window, not a standing key
const DEFAULT_HOURS = 2;
const MIN_MINUTES = 15;

// Read-only routes a support pass may call. Every one of these only READS:
// it must not write a file, place an order, or change a credential.
//
// NAMED, NEVER A PREFIX (2026-09-13, caught the day after this shipped). The
// list said '/debug/' and meant "the diagnostics" - but /debug/angelone/oco-probe
// is a GET that CREATES and MODIFIES a real Angel One rule, so a read-only pass
// could place an order at the customer's broker. A prefix is a promise about
// every route anyone adds under it later; only names are a decision.
const ALLOW_PREFIXES = [];
const ALLOW_PATHS = [
  '/debug/broker',            // the one call that says what is wrong here
  '/debug/audit',             // per-row: what the row claims vs what the broker shows
  '/debug/sync',              // the sync observer's divergences
  '/debug/protection',        // raw Dhan Forever payloads
  '/debug/zerodha',           // raw per-broker snapshots
  '/debug/angelone',
  '/debug/fyers',
  '/debug/close',             // why a row did or did not close
  '/debug/chase',             // stuck exits
  '/debug/ledger',            // P&L read back from fills
  // NOT '/debug/angelone/oco-probe': it places a real rule.
  '/order-log',               // the rows themselves — the artefact every incident lives in
  '/order-log/rollups',
  '/test-order-log',
  '/entitlements',
  '/holdings',
  '/protection/extra',        // the extra-trigger PLAN (cancelling is POST, therefore refused)
  '/broker-token-status',     // which token is dead, and the renewal error behind it
  '/broker-capabilities',
  '/risk-settings',
  '/saved-screener-monitors',
  '/signal-health',
  '/telegram/status',
  '/gsheet/status',
  '/fyers/status',
  '/update/status',
  '/algo-schedule/status',
  '/algo-schedule/job',
  '/app-lock/status',
  '/support/session',         // "what am I allowed to do, and until when"
];

/** May a support pass make this request? GET (and HEAD) only, allow-list only. */
function allows(method, pathname) {
  const m = String(method || '').toUpperCase();
  if (m !== 'GET' && m !== 'HEAD') return false;
  const p = String(pathname || '').split('?')[0];
  if (ALLOW_PATHS.includes(p)) return true;
  return ALLOW_PREFIXES.some(prefix => p.startsWith(prefix));
}

// Keys whose VALUE is a credential, whatever the broker calls it.
const SECRET_KEY = /(^|[_-])(token|secret|password|passwd|pin|salt|hash|signature|sig)$|^(access[_-]?token|refresh[_-]?token|feed[_-]?token|api[_-]?key|apikey|client[_-]?secret|private[_-]?key|authorization|auth|jwt|session|cookie|key)$/i;
// A JWT or an obviously token-shaped blob sitting in a value we did not name.
const TOKEN_SHAPED = /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}/;

/**
 * Deep-copy a payload with every credential removed. Numbers, prices, symbols
 * and order ids are untouched — those are the whole point of a diagnostic.
 */
function redactSecrets(value, depth = 0) {
  if (depth > 12 || value == null) return value;
  if (typeof value === 'string') return TOKEN_SHAPED.test(value) ? '[redacted]' : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => redactSecrets(v, depth + 1));
  const out = {};
  Object.keys(value).forEach(k => {
    if (SECRET_KEY.test(k)) {
      const v = value[k];
      // Keep the SHAPE (present / absent / how long) — "is a token saved at
      // all" is itself a diagnostic — without the value.
      out[k] = (v === null || v === undefined || v === '' || v === false) ? v
        : (typeof v === 'boolean' || typeof v === 'number') ? v
        : '[redacted]';
      return;
    }
    out[k] = redactSecrets(value[k], depth + 1);
  });
  return out;
}

/** The window a grant covers. Hours are clamped; anything unparseable = default. */
function grantWindow(hours, now = Date.now()) {
  const h = Number(hours);
  const safe = Number.isFinite(h) && h > 0 ? Math.min(h, MAX_HOURS) : DEFAULT_HOURS;
  const ms = Math.max(safe * 60 * 60 * 1000, MIN_MINUTES * 60 * 1000);
  return { hours: safe, grantedAt: now, expiresAt: now + ms };
}

/** Is this stored grant usable right now? */
function grantLive(grant, now = Date.now()) {
  if (!grant || !grant.hash || !grant.salt) return false;
  if (grant.revokedAt) return false;
  return Number(grant.expiresAt || 0) > now;
}

module.exports = { allows, redactSecrets, grantWindow, grantLive,
  ALLOW_PATHS, ALLOW_PREFIXES, MAX_HOURS, DEFAULT_HOURS, MIN_MINUTES };
