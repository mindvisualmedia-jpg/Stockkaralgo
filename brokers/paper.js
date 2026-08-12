/**
 * brokers/paper.js — the PAPER broker adapter for Test Mode.
 *
 * Same contract as brokers/dhan.js, zerodha.js and fyers.js: getSnapshot()
 * returns ONE sweep of "broker truth" in the engine's snapshot shape. The
 * difference is that this broker is simulated from the test order log and the
 * live LTP rather than fetched over HTTPS.
 *
 * WHY THIS EXISTS
 *
 * runPaperBrokerPass() in server.js already simulates Test Mode well: it reuses
 * computeSplitBracket, resolveSplitExit, the cost move and the SL->T1 lock, so
 * the RULES match live. What it cannot do is exercise the engine, because it
 * mutates state directly from price. The engine's whole premise is the
 * opposite:
 *
 *     A WRITE NEVER ADVANCES STATE. Only broker-read EVIDENCE confirms it.
 *
 * So Test Mode has always simulated a PERFECT broker - orders always fill,
 * protection always exists, nothing is ever rejected and nothing vanishes.
 * Those are precisely the failures the engine was built for, and they were the
 * only thing paper could not reproduce.
 *
 * This adapter turns a test row into evidence, so the engine can drive Test
 * Mode exactly as it drives Dhan. And because the "broker" is ours, it can be
 * asked to misbehave on purpose - see FAULTS.
 *
 * Pure and I/O-free: buildSnapshot(rows, ltpBySymbol, opts) is a function of its
 * inputs, which is what makes every rule here unit-testable.
 */
'use strict';

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function normSym(s) { return String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase(); }

/**
 * Deterministic 0-99 bucket for a row id.
 *
 * Deliberately NOT Math.random: a fault that cannot be reproduced cannot be
 * debugged, and a test that flips at random is worse than no test. The same row
 * always lands in the same bucket, so "reject 5%" means the same 5% every run.
 */
function bucket(id, salt) {
  const s = String(salt || '') + '|' + String(id || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h) % 100;
}

/**
 * Parse "reject:5,vanish:2,slip:10" into { reject: 5, vanish: 2, slip: 10 }.
 * Anything unparseable is ignored rather than throwing - a malformed env var
 * must not stop Test Mode.
 */
function parseFaults(spec) {
  const out = {};
  String(spec || '').split(/[,;\s]+/).filter(Boolean).forEach(part => {
    const m = part.match(/^([a-z]+)\s*:\s*(\d+(?:\.\d+)?)$/i);
    if (m) out[m[1].toLowerCase()] = Number(m[2]);
  });
  return out;
}

// The order ids the engine's position mapper reads, in the same format the live
// brokers write them, so a paper row maps identically to a live one.
function idsFromRow(row) {
  const broker = String(row.broker || 'dhan').toLowerCase();
  const fids = {};
  // Angel One ids were missing here (2026-08-12 audit): an angelone test row
  // fell through to the Dhan fields, which only ever worked because paper
  // wrote Dhan-shaped ids for every broker. Now that paper is broker-faithful,
  // this must know T1GTT/SLGTT too.
  const re = /(ENTRY|FOREVER-T1|FOREVER|GTT-T1|GTT|T1GTT|SLGTT):([^|\s]+)/gi;
  let m;
  while ((m = re.exec(String(row.orderId || '')))) fids[m[1].toUpperCase()] = m[2].trim();
  const t1 = broker === 'zerodha' ? (row.zerodhaGttT1Id || fids['GTT-T1'] || '')
    : broker === 'fyers' ? (row.fyersGttT1Id || fids['GTT-T1'] || '')
    : broker === 'angelone' ? (row.angelOneGttT1Id || fids['T1GTT'] || '')
    : (row.dhanForeverT1Id || fids['FOREVER-T1'] || '');
  const run = broker === 'zerodha' ? (row.zerodhaGttId || fids['GTT'] || '')
    : broker === 'fyers' ? (row.fyersGttId || fids['GTT'] || '')
    : broker === 'angelone' ? (row.angelOneSlRuleId || row.mtmRemainderSlOrderId || fids['SLGTT'] || '')
    : (row.dhanForeverId || fids['FOREVER'] || '');
  const entry = row.dhanEntryOrderId || row.zerodhaEntryOrderId || row.fyersEntryOrderId || row.angelOneEntryOrderId
    || fids['ENTRY'] || ('PAPER-ENTRY-' + (row.id || ''));
  return { entry, t1, run };
}

const isTestRow = (e) => !!(e && (e.testMode || e.source === 'test'));
const isClosed = (e) => !!(e && (e.exitType || e.testClosedAt));

/**
 * Build one engine snapshot from the test order log.
 *
 * @param {object[]} rows  test order log rows
 * @param {object} ltpBySymbol  { SYMBOL: ltp } - normalised symbols
 * @param {object} [opts]
 * @param {boolean} [opts.eod]      past the intraday square-off cutoff
 * @param {object|string} [opts.faults]  { reject, vanish } percentages, or a
 *                                       "reject:5,vanish:2" spec
 * @returns {{complete:boolean, protections:object, entries:object, heldQty:object, sells:object}}
 */
function buildSnapshot(rows, ltpBySymbol, opts = {}) {
  const faults = typeof opts.faults === 'string' ? parseFaults(opts.faults) : (opts.faults || {});
  const ltps = ltpBySymbol || {};
  const out = { complete: true, protections: {}, entries: {}, heldQty: {}, sells: {} };

  (Array.isArray(rows) ? rows : []).filter(isTestRow).forEach(row => {
    const sym = normSym(row.symbol);
    if (!sym) return;
    const ids = idsFromRow(row);
    const qty = num(row.qty);
    const entryPx = num(row.entryPrice || row.price);
    const ltp = num(ltps[sym]);

    // ---- closed: flat at the broker, protection gone, exit reconstructable ---
    if (isClosed(row)) {
      [ids.t1, ids.run].filter(Boolean).forEach(id => { out.protections[id] = { status: 'gone' }; });
      if (ids.entry) out.entries[ids.entry] = { status: 'filled', fillPrice: num(row.paperFillPrice || entryPx), filledQty: qty };
      const px = num(row.exitPrice);
      if (px && qty) (out.sells[sym] = out.sells[sym] || []).push({ qty, px });
      return;
    }

    // ---- entry not filled yet ------------------------------------------------
    if (row.awaitingFill) {
      // A BUY LIMIT fills at or below its limit. No LTP yet = no evidence, so
      // the order simply stays pending; the engine will do nothing, which is
      // the correct fail-safe.
      if (!ltp) { out.entries[ids.entry] = { status: 'pending' }; return; }
      if (ltp <= entryPx) {
        out.entries[ids.entry] = { status: 'filled', fillPrice: entryPx, filledQty: qty };
        // Filled this very sweep: held at the broker, but protection has NOT
        // been placed yet. That is exactly PROTECTION_PENDING, and it is a state
        // the old simulator skipped straight past.
        out.heldQty[sym] = num(out.heldQty[sym]) + qty;
        return;
      }
      // Entry order is DAY validity: unfilled at the close is dead, and no
      // position ever existed.
      out.entries[ids.entry] = { status: opts.eod ? 'dead' : 'pending' };
      return;
    }

    // ---- filled and open -----------------------------------------------------
    const fillPx = num(row.paperFillPrice || entryPx);
    out.entries[ids.entry] = { status: 'filled', fillPrice: fillPx, filledQty: qty };

    const legs = [];
    if (row.splitT1 && ids.t1 && !row.mtmT1Done) {
      legs.push({ id: ids.t1, target: num(row.t1Price) || (num(row.t1Pct) > 0 ? fillPx * (1 + num(row.t1Pct) / 100) : num(row.targetPrice)) });
    }
    if (ids.run) legs.push({ id: ids.run, target: num(row.targetPrice) });

    // The stop the "broker" is actually holding - brokerSlPrice is what a live
    // cost move / T1 lock writes, so honour it over the original.
    const sl = num(row.brokerSlPrice) || num(row.slPrice);

    let anyLive = false;
    legs.forEach(leg => {
      if (!leg.id) return;

      // --- injected faults: the failures a REAL broker has ------------------
      // rejected: accepted with an id, then killed asynchronously by RMS. This
      // is the T2T/BE-series incident that started the whole engine project.
      if (faults.reject && bucket(leg.id, 'reject') < faults.reject) {
        out.protections[leg.id] = { status: 'rejected' };
        return;
      }
      // vanish: silently absent from the broker's list while the position is
      // still held -> the engine must report UNPROTECTED.
      if (faults.vanish && bucket(leg.id, 'vanish') < faults.vanish) {
        out.protections[leg.id] = { status: 'gone' };
        return;
      }

      if (ltp && sl && ltp <= sl) { out.protections[leg.id] = { status: 'traded_sl', px: sl }; return; }
      if (ltp && leg.target && ltp >= leg.target) { out.protections[leg.id] = { status: 'traded_target', px: leg.target }; return; }
      out.protections[leg.id] = { status: 'live', triggerPrice: sl };
      anyLive = true;
    });

    // Held quantity is broker truth: what is still open after any booked T1.
    const remaining = row.splitT1 && row.mtmT1Done ? num(row.mtmRemainingQty || row.splitLegBQty) : qty;
    if (remaining > 0) out.heldQty[sym] = num(out.heldQty[sym]) + remaining;

    // A leg that traded is a completed SELL fill at the broker.
    legs.forEach(leg => {
      const p = out.protections[leg.id];
      if (!p || (p.status !== 'traded_sl' && p.status !== 'traded_target')) return;
      const legQty = row.splitT1
        ? (leg.id === ids.t1 ? num(row.splitLegAQty) : num(row.splitLegBQty))
        : qty;
      if (legQty > 0) (out.sells[sym] = out.sells[sym] || []).push({ qty: legQty, px: num(p.px) });
    });
    void anyLive;
  });

  return out;
}

/**
 * Adapter entry point. Same (creds, cb) signature as the live brokers so the
 * shadow harness and the cutover executor can treat paper as just another
 * broker.
 *
 * creds: { rows, ltp, eod, faults }
 */
function getSnapshot(creds, cb) {
  try {
    const c = creds || {};
    const snap = buildSnapshot(c.rows, c.ltp, {
      eod: !!c.eod,
      faults: c.faults !== undefined ? c.faults : process.env.STOCKKAR_PAPER_FAULTS,
    });
    cb(null, snap);
  } catch (e) {
    // Same contract as a failed HTTPS sweep: no snapshot means the engine does
    // nothing at all.
    cb('paper snapshot failed: ' + (e && e.message), null);
  }
}

module.exports = { getSnapshot, buildSnapshot, parseFaults, bucket, idsFromRow, normSym };
