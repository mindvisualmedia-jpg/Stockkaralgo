/**
 * Single-active-broker policy — pure decisions, no I/O.
 *
 * The product rule: one broker at a time. New ENTRIES may only go to the
 * active broker; every other configured broker is "finishing" - its open
 * positions keep their stop-losses, targets and exit management until they
 * close, but it gets no new positions. Running brokers side by side is the
 * 'multibroker' licence add-on.
 *
 * Enforcement lives at the entry choke point only (placeBrokerSuperOrder,
 * beside the licence gate). NOTHING here is consulted by protection,
 * modification, exit, token-renewal or login paths - a policy bug must never
 * strand a live position.
 */
'use strict';

/**
 * May a NEW entry go to `orderBroker`?
 *
 * Fail-open by design, mirroring the licence gate: no active broker recorded
 * (fresh install, unreadable file) means no enforcement, because blocking the
 * ONLY broker a customer has over our own bookkeeping is the one outcome this
 * feature must never produce.
 */
function entryAllowed({ orderBroker, activeBroker, multiBroker, enforce }) {
  if (enforce === false) return true;          // env escape hatch
  if (multiBroker) return true;                // paid add-on: no limit
  if (!activeBroker) return true;              // nothing recorded: fail open
  return String(orderBroker || 'dhan').toLowerCase() === String(activeBroker).toLowerCase();
}

/**
 * First-run migration: which broker is "the one they actually use"?
 *
 * Called once, when an updated box has configured brokers but no recorded
 * choice. The most recent token activity wins - daily-login brokers are
 * re-authenticated every trading morning, so the broker being logged into is
 * the broker being traded. Explicit user switches overwrite this forever.
 *
 * @param candidates [{ broker, configured, lastAuthAt }]
 * @returns broker id or null (nothing configured = nothing to enforce)
 */
function deriveActiveBroker(candidates) {
  const rows = (Array.isArray(candidates) ? candidates : [])
    .filter(c => c && c.configured && c.broker)
    .map(c => ({ broker: String(c.broker).toLowerCase(), at: Date.parse(c.lastAuthAt || '') || 0 }))
    .sort((a, b) => b.at - a.at);
  return rows.length ? rows[0].broker : null;
}

/**
 * #14 — Zerodha entry instrument gate (pure; caller supplies the facts).
 *
 * Kite appends the NSE series to non-EQ tradingsymbols ("IWEL-BE",
 * "KALAHRIDHAAN-ST"), so a plain screener symbol sent to Kite for a non-EQ
 * scrip either errors ("instrument not found") or "maps" to nothing. The
 * selection-time SME/T2T skip is fail-open (empty series cache skips
 * nothing), so placement needs its own gate. Policy, matching Dhan:
 *   - SME series (SM/ST/NS/NT): REFUSED — lot-traded, thin, circuit-prone.
 *   - T2T series (BE/BZ/BT/T): REFUSED — same-day protective SELL is
 *     RMS-rejected, which strands a naked CNC position.
 *   - any other non-EQ series: REFUSED, naming the real Kite symbol — we
 *     only trade EQ-series equities on Zerodha.
 *   - unknown to the NSE scrip master (when the master IS loaded): REFUSED
 *     (delisted/renamed — Kite would reject it cryptically anyway).
 * Fail-open (returns ''): BSE, already-suffixed symbols (broker-sourced, e.g.
 * adopted holdings), EQ series, or no scrip-master data at all. ENTRIES ONLY:
 * protection/exit paths must never consult this — a held position gets
 * managed whatever its series.
 *
 * @returns '' when the entry may proceed, else the human-readable refusal.
 */
function zerodhaInstrumentGate({ symbol, exchange, series, lot, nseKnown }) {
  const s = String(symbol || '').replace(/^(NSE|BSE):/i, '').replace(/\s/g, '').toUpperCase();
  if (!s) return 'Missing symbol';
  if (String(exchange || 'NSE').toUpperCase() !== 'NSE') return '';   // BSE: fail open
  if (s.includes('-')) return '';                 // already a Kite-suffixed symbol (broker-sourced)
  const ser = String(series || '').toUpperCase();
  const lotN = Math.floor(Number(lot || 0));
  if (ser === 'EQ') return '';
  if (['SM', 'ST', 'NS', 'NT'].includes(ser)) {
    return s + ' is an SME scrip (series ' + ser + ')'
      + (lotN > 1 ? ' that trades only in lots of ' + lotN : ' that trades only in whole lots')
      + ' — Stockkar skips SME stocks.';
  }
  if (['BE', 'BZ', 'BT', 'T'].includes(ser)) {
    return s + ' is a T2T scrip (series ' + ser + ') — its same-day protective SELL would be RMS-rejected, leaving the position naked. Skipped.';
  }
  if (ser) return s + ' trades as ' + s + '-' + ser + ' on Kite (series ' + ser + ', not a normal EQ equity) — Stockkar trades only EQ-series stocks on Zerodha.';
  if (nseKnown === false) return s + ' is not in the NSE scrip master — delisted, renamed, or not an NSE equity. Entry refused before the broker rejects it cryptically.';
  return '';                                       // no data: fail open, like selection
}

/**
 * Liveness-probe failure classification (2026-08-11 regression).
 *
 * "Connected = proven probe" shipped with one flaw: ANY probe error was
 * recorded as proof the broker REFUSED the credentials, so the card went red
 * with "Broker rejected the credentials". A rate limit, a 15s timeout or a
 * transient 5xx — none of which say anything about the token — produced the
 * same verdict as a real 401. Users saw "Not connected" on a correct Dhan
 * token and re-saved it repeatedly (what actually fixed it was the 5-minute
 * re-probe throttle expiring).
 *
 * The rule now: a probe may only turn the badge RED when it PROVES a
 * credential problem. Everything else leaves the previous verdict alone and
 * is retried soon.
 *
 * 'auth'      the broker refused these credentials (or refused this box's IP)
 *             — persistent, actionable, red is correct.
 * 'transient' could not complete the call — says nothing about the token.
 *
 * Unknown wording is treated as TRANSIENT (never claim rejection without
 * proof), but persistent failure is itself evidence: probeMarksAuthFailure
 * escalates to red after PROBE_FAIL_STREAK_RED consecutive failures of any
 * kind, so a genuine problem we cannot parse still surfaces within minutes.
 */
const PROBE_FAIL_STREAK_RED = 3;

function probeFailureKind(errText) {
  const t = String(errText || '').toLowerCase();
  if (!t) return 'transient';
  // Transient FIRST: "HTTP 429 ..." and "timeout ..." must never be read as
  // auth just because some other word matches later.
  // Dhan's documented codes decide before any generic HTTP-status guess:
  // DH-904 rate limit, DH-908 internal, DH-909 network are transient;
  // DH-901 invalid authentication and DH-902 invalid access are auth.
  if (/dh-?90[489]|rate_limit/.test(t)) return 'transient';
  if (/dh-?90[12]|invalid_authentication|invalid[_\s]*access\b/.test(t)) return 'auth';
  if (/\b(429|500|502|503|504)\b|too\s*many\s*request|rate\s*limit|breaching\s*rate/.test(t)) return 'transient';
  if (/timeout|timed\s*out|etimedout|esockettimedout|socket\s*hang\s*up|econnreset|econnrefused|econnaborted|enotfound|eai_again|getaddrinfo|network|dns/.test(t)) return 'transient';
  if (/\b(401|403)\b|unauthor|forbidden|access\s*denied/.test(t)) return 'auth';
  if (/invalid\s*(access\s*)?token|token\s*(is\s*)?(invalid|expired)|expired\s*token|session\s*(has\s*)?expired/.test(t)) return 'auth';
  // Dhan's expired-token wording, verbatim: "Client ID or user generated
  // access token is invalid or expired." (arrives as HTTP 400, not 401.)
  if (/access\s*token\s*is\s*(invalid|expired)|invalid\s*or\s*expired/.test(t)) return 'auth';
  if (/invalid\s*(api\s*key|apikey|client|credential)|bad\s*credential|incorrect\s*(api\s*key|credential)/.test(t)) return 'auth';
  // Dhan "Invalid IP": this box's egress IP is not whitelisted. Persistent and
  // actionable (whitelist it), so RED is the honest answer.
  if (/invalid\s*ip|ip\s*not\s*(allow|whitelist)|not\s*whitelist/.test(t)) return 'auth';
  return 'transient';
}

/** Should this failed probe turn the badge red? */
function probeMarksAuthFailure(errText, consecutiveFailures) {
  if (probeFailureKind(errText) === 'auth') return true;
  return Number(consecutiveFailures || 0) >= PROBE_FAIL_STREAK_RED;
}

/**
 * READ SANITY (2026-08-13 FYERS incident).
 *
 * If NONE of the protection ids we know about appear in the list we just
 * fetched, the likely fault is the READ — a response-shape change, an id-field
 * mismatch, a glitch — not N simultaneous broker cancellations. Acting on such a
 * read flags every healthy position at once and, worse, lets a re-arm CANCEL
 * live protection before replacing it.
 *
 * This exact condition was detected and logged on 2026-08-13:
 *   "SANITY: 0/8 known GTT ids in the fetched list — restores SKIPPED"
 * ...by the LEGACY restore pass, while the engine — which the cutover had made
 * the writer — walked straight past it and cancelled four positions' stops. The
 * guard was never the problem; its absence on the new write path was.
 *
 * Deliberate trade-off: with a single open row whose protection genuinely was
 * cancelled, this is indistinguishable from a broken read, so the flag is
 * suppressed. That costs a delayed alarm (the morning naked-holdings audit
 * still catches it); the opposite default costs live stops.
 */
/**
 * MTF (Margin Trading Facility) support, per broker. ONE table, read by BOTH
 * the wizard (to grey the pill) and the server (to refuse the order) - the
 * server exposes it, the client never keeps its own copy. Two copies of a
 * capability fact is exactly the drift class that produced this defect.
 *
 * Audit 2026-08-17 found the wizard offered MTF for every broker while:
 *   - Dhan / Zerodha: genuine MTF (per-scrip approved lists)
 *   - FYERS: the entry hard-coded productType 'CNC' - MTF was SILENTLY placed
 *     as CNC. The customer believed they were leveraged and paid full cash.
 *   - Angel One: productType from segment mapped anything but INTRADAY to
 *     DELIVERY - the same silent downgrade.
 * A silent downgrade is a misrepresentation of what was bought. The rule now:
 * an MTF order to a broker that does not offer it is REFUSED with a reason,
 * never converted.
 */
const MTF_SUPPORT = Object.freeze({
  dhan: true,
  zerodha: true,
  fyers: false,      // no MTF product on FYERS API v3 order placement
  angelone: false,   // SmartAPI product types: DELIVERY / INTRADAY / MARGIN / BO / CO - no MTF
  upstox: false,
});
function brokerSupportsMtf(brokerId) {
  return MTF_SUPPORT[String(brokerId || 'dhan').toLowerCase()] === true;
}
/** Entry-time gate. Returns '' (allowed) or a human reason (refused). */
function mtfEntryBlock({ broker, segment }) {
  if (String(segment || 'CNC').toUpperCase() !== 'MTF') return '';
  const b = String(broker || 'dhan').toLowerCase();
  if (brokerSupportsMtf(b)) return '';
  return 'MTF is not offered on ' + b.toUpperCase() + '. This algo is set to MTF, so the entry was NOT placed '
    + '(it will not be quietly placed as CNC either). Edit the algo and choose CNC, or run it on Dhan / Zerodha.';
}

function readLooksBroken(knownIds, seenIds, opts) {
  const known = [...new Set((knownIds || []).filter(Boolean).map(String))];
  if (!known.length) return false;                      // nothing known -> nothing to doubt
  const seen = seenIds instanceof Set ? seenIds : new Set((seenIds || []).map(String));
  if (known.some(id => seen.has(id))) return false;     // any match -> the reader works
  // 0/N known. Two ESCAPE HATCHES (GFLLIMITED, 2026-08-21): the gate held
  // "flags and re-arms SKIPPED" for FOUR DAYS on a box where every tracked
  // bracket was genuinely gone - a naked +13% position went unhealed because
  // the fail-safe could not tell "broken read" from "everything really died".
  const o = opts || {};
  // PERSISTENCE is the only escape - deliberately NOT "list has items":
  // the 2026-08-13 incident was a wrong-key PARSE, and a parse regression
  // could fabricate a plausible list of strangers; trusting items on sight
  // would hand that bug an instant mass re-arm. Instead the gate holds for
  // 3 consecutive suspect passes (~6-8 min): a transient glitch never lives
  // that long, a genuine all-brackets-gone state waits minutes instead of
  // the 4 days GFLLIMITED waited, and a real regression gets a loud alert
  // plus an 8-minute shield instead of silent trust either way.
  if (Number(o.consecutiveSuspects) >= 3) return false;
  return true;
}

/**
 * The broker refusing calls (rate limit) says NOTHING about the order — and
 * retrying into it keeps the window hot. On 2026-08-13 four FYERS rows re-armed
 * every cycle; the cancels landed, the re-places hit "Request limit reached",
 * and the retries themselves sustained the limit while ARIS sat naked with its
 * 3-attempt budget spent on throttles rather than on real failures.
 */
function isRateLimitError(text) {
  const t = String(text || '').toLowerCase();
  return /request\s*limit\s*reached|rate\s*limit|too\s*many\s*request|breaching\s*rate|\b429\b/.test(t);
}

/**
 * NEVER OPEN A POSITION YOU CANNOT PROTECT (2026-08-13, SOUTHWEST).
 *
 * At 14:29 a FYERS entry filled and its GTT was refused — "Request limit
 * reached" — leaving stock held with no stop. The broker had already told us
 * minutes earlier that it was refusing protective writes; we placed the buy
 * anyway, because entry placement never consulted that fact.
 *
 * An entry and its stop are one decision. If the stop cannot be placed, the
 * entry is not a good trade with a missing accessory — it is a different,
 * worse trade that nobody chose. So a broker that is currently refusing
 * protective orders blocks NEW entries; exits, protection and management are
 * untouched, exactly like the licence and one-broker gates.
 *
 * Caller supplies the facts (both are epoch ms, 0 = not blocked).
 */
function entryProtectionBlock({ throttledUntil, capacityBlockedUntil, now }) {
  const n = Number(now || 0);
  if (Number(capacityBlockedUntil || 0) > n) {
    return 'the broker refused a protective order because its GTT/trigger book is full. '
      + 'New entries are paused until slots are freed — cancel unused GTTs at the broker, '
      + 'then entries resume automatically. Open positions stay fully managed.';
  }
  if (Number(throttledUntil || 0) > n) {
    return 'the broker is rate-limiting API calls right now, so a stop-loss cannot be placed. '
      + 'This entry was skipped rather than opening a position with no protection — '
      + 'it will be reconsidered on the next scan.';
  }
  return null;
}

module.exports = { entryAllowed, deriveActiveBroker, zerodhaInstrumentGate, probeFailureKind, probeMarksAuthFailure, PROBE_FAIL_STREAK_RED, readLooksBroken, isRateLimitError, entryProtectionBlock, MTF_SUPPORT, brokerSupportsMtf, mtfEntryBlock };
