'use strict';

/**
 * sync.js — the canonical diff between the ORDER LOG and BROKER TRUTH.
 *
 * The engine answers "what should happen to THIS position?". Nothing answered
 * "does the broker agree with the log, right now, about everything?" - so the
 * answer lived scattered across ~20 per-broker passes and two daily audits that
 * reported and never repaired. Design: docs/SYNC.md.
 *
 * PURE. A function of (rows, snapshot, opts). No I/O, no clock, no broker calls
 * - it runs on the snapshot the engine already fetched, so it costs nothing.
 * It DECIDES NOTHING about repair: it names divergences and the evidence for
 * them. Policy (what may auto-repair, what only alerts) lives above it.
 *
 * ---------------------------- EVIDENCE HIERARCHY ---------------------------
 *   E1 fills          a traded SELL/BUY with qty+px. Beats settlement lag.
 *   E2 order state    live / fired / rejected / gone, by id.
 *   E3 holdings       subject to T+1 lag in BOTH directions.
 *   E4 absence        weakest. Never sufficient for a destructive verdict.
 * The 2026-08-13 FYERS incident was an act on E4: a list parsed empty, so every
 * position "had no protection" and four had their live stops cancelled.
 * ---------------------------------------------------------------------------
 *
 * SETTLEMENT (T+1) is bound into the rules, not left to callers:
 *   - buy side: shares bought TODAY may be missing from holdings, so a row that
 *     filled today is never PHANTOM on absence alone.
 *   - sell side: a sold CNC position LINGERS in holdings until T+1, so a
 *     covering SELL fill always beats "still held" (the engine's rule).
 *   - post-T1: a runner-sized protection against a T1-reduced holding is
 *     CORRECT, not surplus - leg roles come from ids.js.
 */

const { rowIds, knownProtectionIds } = require('./ids');
const brokerPolicy = require('./broker-policy');

/** Divergence codes. Closed set: if something cannot be named here, it is not
 *  yet understood well enough to act on. */
const CODES = {
  ENTRY_DIVERGENCE: 'ENTRY_DIVERGENCE',
  UNPROTECTED: 'UNPROTECTED',
  UNDER_PROTECTED: 'UNDER_PROTECTED',
  SURPLUS_PROTECTION: 'SURPLUS_PROTECTION',
  ORPHAN_TRIGGER: 'ORPHAN_TRIGGER',
  PHANTOM_ROW: 'PHANTOM_ROW',
  QTY_MISMATCH: 'QTY_MISMATCH',
  STOP_DRIFT: 'STOP_DRIFT',
  ID_UNKNOWN: 'ID_UNKNOWN',
};

const SEVERITY = { [CODES.UNPROTECTED]: 'critical', [CODES.UNDER_PROTECTED]: 'critical',
  [CODES.ORPHAN_TRIGGER]: 'critical', [CODES.ENTRY_DIVERGENCE]: 'critical',
  [CODES.SURPLUS_PROTECTION]: 'warn', [CODES.QTY_MISMATCH]: 'warn', [CODES.STOP_DRIFT]: 'warn',
  [CODES.ID_UNKNOWN]: 'warn', [CODES.PHANTOM_ROW]: 'info' };

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
function normSym(s) {
  return String(s || '').replace(/^(NSE|BSE):/i, '').replace(/-(EQ|BE|BZ|SM|ST)$/i, '')
    .replace(/\s/g, '').toUpperCase();
}
const istDay = (ms) => { try { return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); } catch { return ''; } };

/** Total the broker considers yours. Contract v2 splits settled/unsettled;
 *  heldQty remains the total during migration. Unsettled counts: you carry the
 *  risk whether or not the shares have settled. */
function heldTotal(snap, sym) {
  const v2 = snap.held && snap.held[sym];
  if (v2 && typeof v2 === 'object') return num(v2.total !== undefined ? v2.total : (num(v2.settled) + num(v2.unsettled)));
  return num((snap.heldQty || {})[sym]);
}

/**
 * @param {object[]} rows   OPEN, non-test rows for ONE broker (caller filters)
 * @param {object} snap     that broker's adapter snapshot
 * @param {object} [opts]   { now, prior, driftTolerance }
 *        prior: { [key]: { strikes } } from the previous run - a divergence
 *        must be seen `minStrikes` times running before it is `confirmed`.
 * @returns {{ suspectRead, divergences, stats }}
 */
function reconcile(rows, snap, opts = {}) {
  const now = num(opts.now) || Date.now();
  const prior = opts.prior || {};
  const minStrikes = opts.minStrikes === undefined ? 2 : num(opts.minStrikes);
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const out = { suspectRead: false, divergences: [], stats: { rows: list.length, symbols: 0 } };

  // FAIL-SAFE, same as the engine: incomplete evidence changes nothing. A
  // partial snapshot is not a small truth, it is an unknown one.
  if (!snap || snap.complete !== true) { out.stats.skipped = 'incomplete-snapshot'; return out; }

  // ---- GATE 0: is the READ trustworthy? ------------------------------------
  // If not one id we know about appears in what we just fetched, doubt the
  // reader, not the broker. Report nothing at all rather than a page of
  // confident falsehoods (2026-08-13: the audits had no such gate and declared
  // four healthy FYERS positions naked).
  const seen = new Set(Object.keys(snap.protections || {}).map(String));
  if (brokerPolicy.readLooksBroken(knownProtectionIds(list), seen)) {
    out.suspectRead = true;
    out.stats.skipped = 'suspect-read';
    return out;
  }

  const add = (code, symbol, evidence, extra = {}) => {
    const key = code + '|' + symbol + '|' + (extra.id || extra.rowId || '');
    const strikes = num((prior[key] || {}).strikes) + 1;
    out.divergences.push({
      code, symbol, severity: SEVERITY[code] || 'warn',
      key, strikes, confirmed: strikes >= minStrikes,
      evidence, ...extra,
    });
  };

  // ---- index the broker side ----------------------------------------------
  const liveBySym = {};   // symbol -> { ids[], qty, unknownQty, count }
  const stateById = {};
  Object.entries(snap.protections || {}).forEach(([id, p]) => {
    stateById[String(id)] = p;
    if (!p || p.status !== 'live') return;
    const s = normSym(p.symbol);
    if (!s) return;                                  // unattributable: counted per row only
    const cur = liveBySym[s] = liveBySym[s] || { ids: [], qty: 0, unknownQty: false, count: 0 };
    cur.ids.push(String(id)); cur.count++;
    if (num(p.qty) > 0) cur.qty += num(p.qty); else cur.unknownQty = true;
  });
  const soldBySym = {};
  Object.entries(snap.sells || {}).forEach(([sym, fills]) => {
    soldBySym[normSym(sym)] = (Array.isArray(fills) ? fills : []).reduce((t, f) => t + num(f.qty), 0);
  });
  const openSellBySym = {};
  Object.entries(snap.openSells || {}).forEach(([sym, q]) => { openSellBySym[normSym(sym)] = num(q); });

  // ---- index the app side --------------------------------------------------
  const bySym = {};
  list.forEach(row => {
    const s = normSym(row.symbol);
    if (!s) return;
    (bySym[s] = bySym[s] || []).push(row);
  });
  out.stats.symbols = Object.keys(bySym).length;
  const ownedIds = new Set();
  list.forEach(row => rowIds(row).all.forEach(id => ownedIds.add(String(id))));

  // ---- PER ROW -------------------------------------------------------------
  list.forEach(row => {
    const sym = normSym(row.symbol);
    const ids = rowIds(row);
    const held = heldTotal(snap, sym);
    const filledToday = istDay(Date.parse(row.recordedAt || row.time || 0) || 0) === istDay(now);

    // ENTRY: the row still waits for a fill the broker already gave it.
    if (row.awaitingFill) {
      const ent = ids.entry ? stateById[ids.entry] || (snap.entries || {})[ids.entry] : null;
      const entFilled = ent && ent.status === 'filled';
      if (entFilled || held > 0) {
        add(CODES.ENTRY_DIVERGENCE, sym,
          { entryId: ids.entry, entryStatus: (ent || {}).status || 'unknown', held,
            filledQty: num((ent || {}).filledQty) },
          { rowId: row.id, repair: 'adopt-fill' });
      }
      return;   // an unfilled row has nothing else to reconcile
    }

    // ID_UNKNOWN: a leg we own is in NO list. E4 only, so it never concludes
    // "unprotected" by itself - it escalates to the symbol-level check below.
    const unknown = ids.legs.filter(l => l.id && !stateById[l.id]);
    if (unknown.length && ids.legs.length) {
      add(CODES.ID_UNKNOWN, sym, { ids: unknown.map(l => l.id), inSnapshot: seen.size },
        { rowId: row.id, repair: 'none' });
    }

    // STOP_DRIFT: a live stop sitting somewhere other than promised. When the
    // row claims cost-move is done, the promise is "at or above entry".
    const liveLegs = ids.legs.map(l => ({ ...l, state: stateById[l.id] }))
      .filter(l => l.state && l.state.status === 'live');
    if (liveLegs.length) {
      let expected = num(row.brokerSlPrice || row.slPrice);
      const entryPx = num(row.entryPrice || row.price);
      if (row.mtmCostDone && entryPx > 0 && expected < entryPx * 0.998) expected = entryPx;
      const withTrigger = liveLegs.filter(l => num(l.state.triggerPrice) > 0);
      const tol = opts.driftTolerance === undefined ? 0.002 : num(opts.driftTolerance);
      withTrigger.forEach(l => {
        const trig = num(l.state.triggerPrice);
        if (expected > 0 && Math.abs(trig - expected) > Math.max(0.05, expected * tol)) {
          add(CODES.STOP_DRIFT, sym, { at: trig, expected, leg: l.role },
            { rowId: row.id, id: l.id, repair: 'reassert-sl' });
        }
      });
    }

    // PHANTOM_ROW: open in the log, gone at the broker.
    //   E1 (a covering sell) closes it outright - that beats holdings lag.
    //   E3 alone is only trusted once the position is no longer same-day, and
    //   never while an exit is still working.
    if (held <= 0 && !openSellBySym[sym]) {
      const sold = num(soldBySym[sym]);
      const rowQty = num(row.mtmT1Done ? (row.splitLegBQty || row.mtmRemainingQty || row.qty) : row.qty);
      const covering = rowQty > 0 && sold >= rowQty * 0.99;
      if (covering) {
        add(CODES.PHANTOM_ROW, sym, { soldQty: sold, rowQty, basis: 'sell-fills' },
          { rowId: row.id, repair: 'close-from-fills' });
      } else if (!filledToday && !sold) {
        add(CODES.PHANTOM_ROW, sym, { soldQty: 0, rowQty, basis: 'not-held-aged' },
          { rowId: row.id, repair: 'close-needs-review' });
      }
    }
  });

  // ---- PER SYMBOL (rows summed: two rows on one symbol is legal) -----------
  Object.entries(bySym).forEach(([sym, symRows]) => {
    const open = symRows.filter(r => !r.awaitingFill);
    if (!open.length) return;
    const held = heldTotal(snap, sym);
    const live = liveBySym[sym] || { ids: [], qty: 0, unknownQty: false, count: 0 };
    const rowQty = open.reduce((t, r) =>
      t + num(r.mtmT1Done ? (r.splitLegBQty || r.mtmRemainingQty || r.qty) : r.qty), 0);
    const exitInFlight = num(openSellBySym[sym]) > 0;

    if (held > 0 && !live.count && !exitInFlight) {
      add(CODES.UNPROTECTED, sym, { held, liveCount: 0 }, { repair: 'rearm' });
    } else if (held > 0 && live.count && !live.unknownQty && live.qty < held && !exitInFlight) {
      // The half-bracket class (ADVANCE, FEDFINA, V2RETAIL on 2026-08-13): a
      // leg is live so every existence-based check reads green while part of
      // the position carries no stop at all.
      add(CODES.UNDER_PROTECTED, sym,
        { held, covered: live.qty, uncovered: held - live.qty, ids: live.ids }, { repair: 'none' });
    }

    // QTY_MISMATCH: broker and log disagree on size. Same-day is excluded -
    // holdings lag alone explains it - and an exit in flight moves the number
    // under us.
    const anyToday = open.some(r => istDay(Date.parse(r.recordedAt || r.time || 0) || 0) === istDay(now));
    if (held > 0 && rowQty > 0 && held !== rowQty && !anyToday && !exitInFlight) {
      add(CODES.QTY_MISMATCH, sym,
        { held, rowQty, delta: held - rowQty,
          reading: held > rowQty ? 'extra-at-broker-maybe-manual' : 'row-oversized-exits-would-over-sell' },
        { repair: 'none' });
    }
  });

  // ---- SURPLUS (broker-wide, rows or no rows) ------------------------------
  // Scanned over the BROKER side, not over rows: on 2026-08-13 GAIL (5 triggers
  // for 8 shares against 2 held) and YESBANK (4 x 21 against 21) had no open
  // row at all - their rows had closed and the duplicates outlived them. A
  // row-scoped check sees nothing while the account carries a pile of stops
  // that will RMS-reject each other when they fire.
  //
  // Reported, never repaired: choosing which stop on a HELD symbol dies is a
  // decision about money, and some of these are the user's own.
  Object.entries(liveBySym).forEach(([sym, live]) => {
    const held = heldTotal(snap, sym);
    if (!(held > 0) || live.count < 2 || live.unknownQty || live.qty <= held) return;
    if (num(openSellBySym[sym]) > 0) return;      // legs firing right now move the count
    add(CODES.SURPLUS_PROTECTION, sym,
      { held, covered: live.qty, surplus: live.qty - held, count: live.count, ids: live.ids },
      { repair: 'none' });
  });

  // ---- ORPHAN TRIGGERS (broker side with no app side) ----------------------
  // MANUAL-POSITION RULE (inherited from auditOrphansAndNaked): a live stop on
  // a symbol the user HOLDS is their own protection on their own shares. Never
  // ours to question. Only a trigger against NOTHING is an orphan.
  Object.entries(liveBySym).forEach(([sym, live]) => {
    if (heldTotal(snap, sym) > 0) return;
    const unowned = live.ids.filter(id => !ownedIds.has(id));
    if (!unowned.length) return;
    add(CODES.ORPHAN_TRIGGER, sym, { held: 0, ids: unowned, count: unowned.length },
      { id: unowned[0], repair: 'cancel-trigger' });
  });

  out.stats.divergences = out.divergences.length;
  out.stats.confirmed = out.divergences.filter(d => d.confirmed).length;
  return out;
}

/** Carry strike counts to the next run: only keys still diverging survive, so
 *  a resolved divergence starts from zero if it returns. */
function nextPrior(result) {
  const p = {};
  ((result && result.divergences) || []).forEach(d => { p[d.key] = { strikes: d.strikes }; });
  return p;
}

module.exports = { reconcile, nextPrior, CODES, normSym };
