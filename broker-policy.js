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
 * Liveness-probe failure classification (2026-08-11 regression, backported).
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
  if (/\b(429|500|502|503|504)\b|too\s*many\s*request|rate\s*limit|breaching\s*rate/.test(t)) return 'transient';
  if (/timeout|timed\s*out|etimedout|esockettimedout|socket\s*hang\s*up|econnreset|econnrefused|econnaborted|enotfound|eai_again|getaddrinfo|network|dns/.test(t)) return 'transient';
  if (/\b(401|403)\b|unauthor|forbidden|access\s*denied/.test(t)) return 'auth';
  if (/invalid\s*(access\s*)?token|token\s*(is\s*)?(invalid|expired)|expired\s*token|session\s*(has\s*)?expired/.test(t)) return 'auth';
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

module.exports = { entryAllowed, deriveActiveBroker, probeFailureKind, probeMarksAuthFailure, PROBE_FAIL_STREAK_RED };
