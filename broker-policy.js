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

module.exports = { entryAllowed, deriveActiveBroker, zerodhaInstrumentGate };
