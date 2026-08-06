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

module.exports = { entryAllowed, deriveActiveBroker };
