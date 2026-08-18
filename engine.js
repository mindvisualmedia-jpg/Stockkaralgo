'use strict';
// engine.js — Stockkar position engine: a PURE state machine for long CNC
// positions. No I/O, no broker code, no timers — everything here is a function
// of (position, broker snapshot, now), which makes every rule unit-testable and
// identical across brokers and across live/test.
//
// Core principle (the fix for every incident this engine exists for):
//   A WRITE NEVER ADVANCES STATE. Placing/modifying an order only moves the
//   position into a *_PENDING shape; only broker-read EVIDENCE (the snapshot)
//   confirms it. "Protected" means "seen live at the broker", never "we sent it".
//
// States:
//   ENTRY_PENDING       entry order placed, not filled yet
//   ENTRY_DEAD          entry rejected/cancelled/expired — no position ever existed
//   PROTECTION_PENDING  entry filled; protection placed (or due) but NOT yet seen live
//   PROTECTED           protection verified live at the broker
//   UNPROTECTED         position held at the broker with NO live protection (ALERT)
//   TARGETS_ONLY        a No-SL row: NO stop by design; T1/T2 SELL triggers stand while held
//   CLOSED              flat at the broker; exit reconstructed from fills
//
// Snapshot shape (built by a broker adapter, or a paper adapter in Test Mode):
//   {
//     complete: true,                    // false => engine changes NOTHING (fail-safe)
//     protections: { [orderId]: { status: 'live'|'rejected'|'gone'|'traded_target'|'traded_sl',
//                                 triggerPrice?, px? } },
//     entries:     { [orderId]: { status: 'pending'|'filled'|'dead', fillPrice?, filledQty? } },
//     heldQty:     { [SYMBOL]: qty },    // holdings + net positions (broker truth)
//     sells:       { [SYMBOL]: [{ qty, px }] },  // completed SELL fills
//   }
//
// Position shape (mapped from an order-log row):
//   { state, symbol, qty, entryPrice, slPrice, targetPrice, t1Price, costTrigger,
//     entryId, legs: [{ id, role: 'single'|'t1'|'runner', qty }],
//     t1Booked, costMoved, pendingSl: { price, at, toCost }|null,
//     graceStartAt, ltp }
//
// transition() returns { state, patch, actions, alerts } — the caller (reconciler)
// applies the patch, executes actions via the broker adapter, and delivers alerts.
// Actions are requests, not facts: their effect is only believed once a later
// snapshot shows it (see pendingSl / PROTECTION_PENDING).

const STATE = {
  ENTRY_PENDING: 'ENTRY_PENDING',
  ENTRY_DEAD: 'ENTRY_DEAD',
  PROTECTION_PENDING: 'PROTECTION_PENDING',
  PROTECTED: 'PROTECTED',
  UNPROTECTED: 'UNPROTECTED',
  EXIT_PENDING: 'EXIT_PENDING',   // a stop/target FIRED; its SELL is standing at the broker, not yet filled
  TARGETS_ONLY: 'TARGETS_ONLY',   // a No-SL row: NO stop by design; T1/T2 SELL triggers stand at the broker while held
  CLOSED: 'CLOSED',
};

const DEFAULT_GRACE_MS = 3 * 60 * 1000; // RMS async-decision window (two-strike)

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function round2(v) { return Number(num(v).toFixed(2)); }
function normSym(s) { return String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase(); }

function legState(snap, id) {
  const key = String(id || '').trim();
  if (!key) return { status: 'gone' };
  return (snap.protections || {})[key] || { status: 'gone' }; // absent from broker list => gone
}

// A fill that PROVABLY belongs to another Stockkar row: tagged with a different
// Stockkar tag, or spawned by a protection id some other row names. Manual
// (untagged, unlinked) fills are never foreign - symbol-level fallback keeps them.
function foreignFill(pos, snap, f) {
  if (!f) return false;
  const myTag = String(pos.tag || '');
  const tag = String(f.tag || '');
  if (tag && /^SK[A-Z0-9]{6,18}$/.test(tag) && tag !== myTag) {
    // another row's tag - foreign if that tag is one of ours (or we simply know it is not this row's)
    if (!snap.ownedTags || !snap.ownedTags.has || snap.ownedTags.has(tag) || myTag) return true;
  }
  const legId = String(f.legId || f.algoId || '');
  if (legId) {
    const mine = (pos.legs || []).some(l => String(l.id) === legId);
    if (!mine && snap.ownedIds && snap.ownedIds.has && snap.ownedIds.has(legId)) return true;
  }
  return false;
}

// Reconstruct a confirmed-flat exit from actual SELL fills. Split-aware: lights
// T1/T2 and labels TARGET/SL/EXITED the way Test Mode reads. (This is the SAMHI
// logic, written once for every broker.)
function reconstructClose(pos, sells) {
  const entry = num(pos.entryPrice);
  const qty = num(pos.qty);
  const target = num(pos.targetPrice);
  const slBase = num(pos.slPrice);
  const fills = (sells || []).filter(s => num(s.qty) > 0 && num(s.px) > 0);
  let pnl = 0, soldQty = 0;
  fills.forEach(s => { soldQty += num(s.qty); pnl += (num(s.px) - entry) * num(s.qty); });
  const estimated = soldQty <= 0;
  const maxSell = fills.length ? Math.max(...fills.map(s => num(s.px))) : 0;
  const minSell = fills.length ? Math.min(...fills.map(s => num(s.px))) : 0;
  // ZERO fills: never assume the TARGET (a stop-out at cost would read "TARGET
  // HIT"); assume the STOP — conservative, never overstates profit (rule E1).
  let exitPrice = round2(maxSell || (estimated && slBase > 0 ? slBase : (target > 0 ? target : slBase)));
  // DUPLICATE ROWS ON ONE SYMBOL (2026-08-18: GENUSPOWER bought three times on
  // Angel by choice, three 1-share rows). Fills are symbol-level (limitation
  // L5), so each 1-share row saw three sells and booked three shares of P&L.
  // Which fill belonged to which lot is not recoverable; the honest figure is
  // the fills' VWAP x THIS row's quantity - never more shares than the row
  // holds. Only engages when the fills exceed the row (a normal close is untouched).
  const runnerQty = num(((pos.legs || []).find(l => l.role === 'runner') || {}).qty);
  const rowQty = (pos.t1Booked && runnerQty > 0) ? runnerQty : qty;
  let overFilled = false;
  if (rowQty > 0 && soldQty > rowQty * 1.01) {
    const vwap = fills.reduce((s, x) => s + num(x.px) * num(x.qty), 0) / soldQty;
    pnl = (vwap - entry) * rowQty + ((pos.t1Booked && runnerQty > 0) ? num(pos.t1Pnl) : 0);
    exitPrice = round2(vwap);
    overFilled = true;
  }
  if (estimated) {
    // No fill evidence -> no TARGET/SL claim; plain EXITED, flagged estimated.
    let t1B = !!pos.t1Booked;
    return { exitType: 'EXITED', exitPrice, realisedPnl: (num(pos.entryPrice) && num(pos.qty)) ? round2((exitPrice - num(pos.entryPrice)) * num(pos.qty)) : 0, exitEstimated: true, t1Booked: t1B, t2Done: false };
  }
  const split = (pos.legs || []).some(l => l.role === 't1') || !!pos.splitT1;
  // CROSS-DAY SPLITS: broker order books are TODAY-only, so a T1 leg that booked
  // on an earlier day is missing from today's fills. Its P&L was recorded when it
  // booked (t1Pnl) — add it back, otherwise the close silently drops that leg.
  const bookedLegMissingFromFills = split && pos.t1Booked && soldQty > 0 && soldQty < qty && !overFilled;
  if (bookedLegMissingFromFills && num(pos.t1Pnl)) pnl += num(pos.t1Pnl);
  const realisedPnl = estimated ? (entry && qty ? round2((exitPrice - entry) * qty) : 0) : round2(pnl);
  let exitType, t1Booked = !!pos.t1Booked, t2Done = false;
  if (split) {
    const t1Px = num(pos.t1Price) || target;
    const t2Hit = target > 0 && maxSell >= target * 0.999;
    const t1Hit = (t1Px > 0 && fills.some(s => num(s.px) >= t1Px * 0.995)) || (t2Hit && fills.length >= 2);
    if (t1Hit) t1Booked = true;
    if (t2Hit) t2Done = true;
    exitType = t2Hit ? 'TARGET HIT'
      : (slBase > 0 && minSell > 0 && minSell <= slBase * 1.001) ? 'SL HIT' : 'EXITED';
  } else {
    exitType = (target > 0 && exitPrice >= target * 0.999) ? 'TARGET HIT'
      : (slBase > 0 && exitPrice <= slBase * 1.001) ? 'SL HIT' : 'EXITED';
  }
  if (t2Done) t1Booked = true; // INVARIANT: T2 fills only after T1 — never emit T2 without T1
  return { exitType, exitPrice, realisedPnl, exitEstimated: estimated, t1Booked, t2Done };
}

// Close reconstruction for a TARGETS_ONLY (No-SL) position. No stop exists, so
// the label is TARGET HIT only when a fill reached the LOWEST target leg;
// anything else is a plain EXITED (a manual sale at the broker). Exit price is
// the fills' VWAP (what legacy wrote). Zero fills = ESTIMATED at the last
// price, never at a target (rule E1: never overstate).
function reconstructTargetsOnlyClose(pos, sells) {
  const entry = num(pos.entryPrice), qty = num(pos.qty);
  const fills = (sells || []).filter(s => num(s.qty) > 0 && num(s.px) > 0);
  const soldQty = fills.reduce((s, x) => s + num(x.qty), 0);
  const tLegs = (pos.legs || []).filter(l => l.role === 'target-t1' || l.role === 'target-t2');
  const prices = tLegs.map(l => num(l.price)).filter(p => p > 0);
  const minTarget = prices.length ? Math.min(...prices) : num(pos.targetPrice);
  if (soldQty <= 0) {
    const px = num(pos.ltp) > 0 ? num(pos.ltp) : entry;
    return { exitType: 'EXITED', exitPrice: round2(px), realisedPnl: (entry && qty) ? round2((px - entry) * qty) : 0,
      exitEstimated: true, t1Booked: !!pos.t1Booked, t2Done: false, soldQty: 0 };
  }
  const notional = fills.reduce((s, x) => s + num(x.px) * num(x.qty), 0);
  const vwap = notional / soldQty;
  const maxSell = Math.max(...fills.map(s => num(s.px)));
  let pnl = (vwap - entry) * soldQty;
  // A cross-day T1: its fill is not in today's book; its P&L was recorded when it booked.
  if (pos.t1Booked && soldQty < qty && num(pos.t1Pnl)) pnl += num(pos.t1Pnl);
  const targetHit = minTarget > 0 && maxSell >= minTarget * 0.995;
  const t2 = tLegs.find(l => l.role === 'target-t2');
  const t2Done = !!(t2 && num(t2.price) > 0 && maxSell >= num(t2.price) * 0.995);
  const t1Booked = !!(pos.t1Booked || (tLegs.length === 2 && targetHit));
  return { exitType: targetHit ? 'TARGET HIT' : 'EXITED', exitPrice: round2(vwap), realisedPnl: round2(pnl),
    exitEstimated: false, t1Booked, t2Done, soldQty };
}

// Position INVARIANTS — flag combinations that can NEVER be true of a real
// position. The engine can't produce them by construction; this detects them
// arriving from anywhere else (legacy reconciles, old data, manual edits).
// Input is a plain facts object so order-log rows can be checked directly.
function invariantViolations(p) {
  const v = [];
  const split = !!p.splitT1;
  if (split && p.t2Done && !p.t1Booked) v.push('T2 ticked but T1 not booked — impossible: T2 (above T1) can only fill after T1');
  // (split + trailing was flagged here until 2026-08-18; it is now the normal
  // shape: T1/T2 rest at the broker and rule 7 trails every live leg's stop)
  if (split) {
    const a = num(p.legAQty), b = num(p.legBQty), q = num(p.qty);
    if (a > 0 && b > 0 && q > 0 && a + b !== q) v.push('split leg quantities (' + a + '+' + b + ') do not sum to position qty (' + q + ')');
  }
  if (p.open && p.realisedPnl !== undefined && p.realisedPnl !== '' && p.realisedPnl !== null) {
    v.push('realised P&L set while the position is still OPEN');
  }
  if (p.unprotected && p.costMoved) v.push('"SL moved to cost" ticked on an UNPROTECTED position — the tick refers to a stop that does not exist');
  if (p.closed && !p.exitType) v.push('closed without an exit type');
  return v;
}

function transition(pos, snap, opts = {}) {
  const now = num(opts.now) || Date.now();
  const graceMs = opts.graceMs === undefined ? DEFAULT_GRACE_MS : num(opts.graceMs);
  const out = { state: pos.state, patch: {}, actions: [], alerts: [] };

  // FAIL-SAFE: no complete broker evidence -> change nothing, do nothing.
  if (!snap || snap.complete !== true) return out;

  const sym = normSym(pos.symbol);
  const heldQty = num((snap.heldQty || {})[sym]);
  const held = heldQty > 0;
  // FILL IDENTITY (2026-08-19, order tags). Fills are per SYMBOL at every broker,
  // but a fill can carry proof of WHOSE it is: the tag Stockkar put on the order
  // (tag), or the protection leg that spawned it (legId / Dhan algoId). A fill
  // that provably belongs to ANOTHER of our rows is excluded from this one;
  // anything unidentified stays symbol-level (unchanged) - exact where the
  // broker gives identity, never a missed close where it does not.
  const sells = ((snap.sells || {})[sym] || []).filter(f => !foreignFill(pos, snap, f));
  const openSellQty = num((snap.openSells || {})[sym]);   // an exit SELL working at the broker (HEALTHX class)
  const legs = (pos.legs || []).map(l => ({ ...l, ...legState(snap, l.id) }));
  const liveLegs = legs.filter(l => l.status === 'live');

  // Grace helper: first sighting starts the clock; only after the grace period of
  // the SAME condition do we act on it (RMS decides async; never alarm on strike 1).
  // When the broker returned an EMPTY protections list, absence is weak evidence
  // (transient API glitch / list lag on a just-placed order) -> 4x longer grace.
  const emptyList = !Object.keys(snap.protections || {}).length;
  const effGraceMs = emptyList ? Math.max(graceMs * 4, graceMs) : graceMs;
  const graceExpired = () => pos.graceStartAt && (now - num(pos.graceStartAt)) >= effGraceMs;
  const startGrace = () => { if (!pos.graceStartAt) out.patch.graceStartAt = now; };
  const clearGrace = () => { if (pos.graceStartAt) out.patch.graceStartAt = 0; };

  switch (pos.state) {
    case STATE.ENTRY_PENDING: {
      const ent = (snap.entries || {})[String(pos.entryId || '').trim()];
      if (!ent || ent.status === 'pending') return out;
      if (ent.status === 'dead') {
        // THE GNA GUARD (#37, ported 2026-08-17). A book that says
        // REJECTED/CANCELLED with zero fills is not proof of no position: GNA's
        // book said "no fill" while 1 share sat in holdings - the row was
        // rejected and the share ran untracked and unprotected. Holdings
        // outrank the book. Same rule as legacy entryNoFillDecision (mtm.js),
        // copied here because engine.js is the leaf and imports nothing.
        //
        // Built against this week's OWN mistakes, deliberately:
        //  - a snapshot with NO holdings map is not "not held" - it is unknown.
        //    Absence is E4 and never grounds a destructive verdict; WAIT.
        //  - the held count sizes protection DOWN, never up: it is capped at the
        //    ordered qty, because an adapter can over-count (Angel sums
        //    holdings+positions where the others take max - unverified live).
        //    Protecting fewer shares than held is a visible UNDER_PROTECTED in
        //    sync.js; protecting more than held is an RMS reject and a naked
        //    position. Err toward the visible failure.
        //  - the alert names the evidence so a human can check it.
        const holdingsRead = snap.heldQty && typeof snap.heldQty === 'object';
        if (!holdingsRead) return out;                       // unknown -> wait
        const heldNow = num(snap.heldQty[sym]);
        if (heldNow > 0) {
          const protectQty = Math.min(heldNow, num(pos.qty) > 0 ? num(pos.qty) : heldNow);
          out.state = STATE.PROTECTION_PENDING;
          out.patch.entryFillFromHoldings = true;
          out.patch.filledQty = protectQty;
          out.alerts.push({ type: 'BOOK_LIE', symbol: pos.symbol,
            reason: 'order book says ' + ent.status + ' but ' + heldNow + ' held \u2014 protecting ' + protectQty + ' instead of rejecting' });
          out.actions.push({ type: 'PLACE_PROTECTION', filledQty: protectQty, fillPrice: 0, reason: 'book-lie' });
          return out;
        }
        out.state = STATE.ENTRY_DEAD;
        // Any protection placed for this entry (Dhan places the Forever at
        // ENTRY time, before the fill) is now an ORPHAN: a standing SELL
        // trigger against shares never bought = a naked short when it fires
        // (legacy cancelOrphanedDhanForevers, ported 2026-08-17). Ask the
        // executor to cancel every leg it knows of.
        if (legs.length) out.actions.push({ type: 'CANCEL_ORPHAN_PROTECTION', legIds: legs.map(l => l.id), reason: 'entry-' + ent.status });
        return out;
      }
      // filled -> protection is now DUE; nothing is protected until seen live.
      out.state = STATE.PROTECTION_PENDING;
      if (num(ent.fillPrice) > 0) out.patch.entryPrice = num(ent.fillPrice);
      if (num(ent.filledQty) > 0) out.patch.filledQty = num(ent.filledQty);
      // The action carries the FILL TRUTH explicitly (2026-08-17): the executor
      // sizes protection to what filled, not to what was ordered - a partial
      // fill protected at the ordered qty is an over-sell waiting to happen.
      out.actions.push({ type: 'PLACE_PROTECTION',
        filledQty: num(ent.filledQty) > 0 ? num(ent.filledQty) : num(pos.qty),
        fillPrice: num(ent.fillPrice) > 0 ? num(ent.fillPrice) : 0 });
      return out;
    }

    case STATE.ENTRY_DEAD: {
      // Terminal for the POSITION - but its protection may still be standing
      // (a cancel failed, or the box restarted mid-way). Keep asking until no
      // leg reads live; the executor owns retries and cooldowns.
      const stillLive = legs.filter(l => l.status === 'live');
      if (stillLive.length) out.actions.push({ type: 'CANCEL_ORPHAN_PROTECTION', legIds: stillLive.map(l => l.id), reason: 'entry-dead-protection-standing' });
      return out;
    }

    case STATE.CLOSED: {
      // Terminal - EXCEPT when the close was ESTIMATED (no fill price came
      // back; we booked the exit at the SL/target level) and RECENT. Broker-
      // state lag produces false closes: a leg reads terminal, we close, and
      // the shares are still held. Legacy fixed those with a separate
      // reopen pass; the engine re-checks its own verdict against truth
      // (2026-08-17). A CONFIRMED close (a real fill) is never re-opened.
      if (!pos.exitEstimated || pos.reopened) return out;
      const ageMs = now - num(pos.closedAt);
      const REOPEN_WINDOW_MS = num(opts.reopenWindowMs) || 8 * 60 * 60 * 1000;
      if (!(num(pos.closedAt) > 0) || ageMs > REOPEN_WINDOW_MS) return out;
      const liveNow = legs.some(l => l.status === 'live');
      if (held || liveNow) {
        // Back to the state the evidence supports: protected if a leg is
        // live, else UNPROTECTED (held with nothing guarding it) so the
        // normal re-arm path takes over immediately.
        out.state = liveNow ? STATE.PROTECTED : STATE.UNPROTECTED;
        out.patch.reopened = true;
        out.patch.reopenedAt = now;
        out.patch.exitType = '';
        out.patch.exitPrice = null;
        out.patch.realisedPnl = null;
        out.patch.exitEstimated = false;
        out.alerts.push({ type: 'REOPENED', symbol: pos.symbol,
          reason: 'was marked closed (estimated exit) but is still ' + (held ? 'HELD' : 'PROTECTED') + ' at the broker \u2014 tracking resumed' + (liveNow ? '' : '; NO live stop, re-arm follows') });
      }
      return out;
    }

    case STATE.PROTECTION_PENDING: {
      if (!legs.length) { out.actions.push({ type: 'PLACE_PROTECTION' }); return out; }
      if (legs.every(l => l.status === 'live')) {
        // EVIDENCE: every protective order is live at the broker.
        out.state = STATE.PROTECTED;
        out.patch.protectionVerifiedAt = now;
        clearGrace();
        return out;
      }
      // Placed but not (all) live: rejected async (T2T!) or still materialising.
      if (held && sells.length === 0) {
        startGrace();
        if (graceExpired()) {
          out.state = STATE.UNPROTECTED;
          out.patch.costMoved = false; // any cost tick against dead orders is false
          out.alerts.push({ type: 'UNPROTECTED', symbol: pos.symbol, reason: 'protection never went live (rejected at broker — e.g. T2T same-day SELL)' });
        }
        return out;
      }
      if (!held && sells.length > 0) { // filled and instantly closed (rare)
        out.state = STATE.CLOSED;
        Object.assign(out.patch, reconstructClose(pos, sells));
        return out;
      }
      return out; // holdings not reflecting yet -> wait, fail-safe
    }

    case STATE.PROTECTED: {
      const t1Leg = legs.find(l => l.role === 't1');
      const runnerLeg = legs.find(l => l.role === 'runner');

      // (1) Live T1 book. Evidence either way: the T1 leg shows traded_target,
      // OR it VANISHED while the runner is still live — legs share the SL, so an
      // SL hit would have closed the runner too => T1 can only have hit target.
      if (t1Leg && !pos.t1Booked) {
        // THIRD TELL (2026-08-13, V2RETAIL). The first two both fail on FYERS
        // when the runner leg is already dead: its GTT list reports a fired rule
        // as "fired" and never says WHICH leg, and the runner-still-live tell
        // needs a runner. V2RETAIL booked T1 at the broker and the app never
        // knew — no t1Booked, no t1Pnl, and the runner then read as an
        // unexplained naked position.
        // A stop-out closes the WHOLE position, so legA terminal + a SELL fill
        // covering legA's quantity + exactly the runner's quantity still held
        // can only be a T1 book. Quantity is the evidence when leg state cannot
        // be.
        const runnerQty = num(runnerLeg && runnerLeg.qty);
        const soldQty = sells.reduce((s, x) => s + num(x.qty), 0);
        const partialLeftover = runnerQty > 0 && heldQty > 0 && heldQty <= runnerQty
          && soldQty >= num(t1Leg.qty) * 0.99;
        const t1Hit = t1Leg.status === 'traded_target'
          || (t1Leg.status !== 'live' && runnerLeg && runnerLeg.status === 'live')
          || (t1Leg.status !== 'live' && partialLeftover);
        if (t1Hit) {
          out.patch.t1Booked = true;
          out.patch.t1BookedAt = now;
          const t1Px = num(t1Leg.px) || num(pos.t1Price);
          const legAQty = num(t1Leg.qty);
          if (t1Px > 0 && num(pos.entryPrice) > 0 && legAQty > 0) {
            out.patch.t1Pnl = round2((t1Px - num(pos.entryPrice)) * legAQty);
          }
          // Only a LIVE runner can be moved. When it is gone the position is
          // unprotected, and (2) below raises that instead - never pretend a
          // dead leg was moved to cost.
          if (!pos.costMoved && runnerLeg && runnerLeg.status === 'live') {
            // NEVER LOWER (2026-08-18): a trail may already hold the stop above
            // entry; then cost is already locked - tick it, send nothing.
            const curSlR = Math.max(num(pos.slPrice), num(runnerLeg.triggerPrice));
            if (num(pos.entryPrice) > curSlR + 0.011) out.actions.push({ type: 'MOVE_SL_TO_COST', legIds: [runnerLeg.id], reason: 'post-T1' });
            else out.patch.costMoved = true;
          }
        }
      }

      // (2) Confirmed close: nothing live protecting.
      if (!liveLegs.length) {
        // A SELL fill covering the (remaining) position is POSITIVE exit evidence
        // and OVERRIDES the holdings-settlement lag (a sold CNC position lingers in
        // holdings until T+1). Close on it even while "held".
        const soldQty = sells.reduce((s, x) => s + num(x.qty), 0);
        const runnerLeg2 = (pos.legs || []).find(l => l.role === 'runner');
        const remainingQty = (pos.t1Booked && runnerLeg2) ? num(runnerLeg2.qty) : num(pos.qty);
        const coveringSell = remainingQty > 0 && soldQty >= remainingQty * 0.99;
        const hasSell = sells.some(s => num(s.qty) > 0 && num(s.px) > 0);
        if (coveringSell || (!held && hasSell)) {
          out.state = STATE.CLOSED;
          Object.assign(out.patch, reconstructClose(pos, sells));
          clearGrace();
          return out;
        }
        if (!held) {
          // Not held + no SELL: can be broker-state LAG on a fresh position (legs
          // not listed yet; fresh buy not in holdings). Never fabricate a
          // target-price exit on weak evidence — require the grace to persist.
          startGrace();
          if (graceExpired()) {
            out.state = STATE.CLOSED;
            Object.assign(out.patch, reconstructClose(pos, sells));
          }
          return out;
        }
        // A SELL is WORKING at the broker: the stop (or target) fired and its
        // exit has not filled yet - illiquid, lower circuit, a limit priced above
        // the market. That is EXIT_PENDING, not UNPROTECTED (HEALTHX 2026-07-24:
        // re-arming beside a standing SELL is the fire-instantly-and-RMS-reject
        // loop). Ported into the engine 2026-08-17 as a first-class state.
        if (openSellQty > 0) {
          out.state = STATE.EXIT_PENDING;
          out.patch.exitPendingAt = pos.exitPendingAt || now;
          clearGrace();
          return out;
        }
        // Held, no covering sell, nothing guarding it: protection died under us
        // (broker deleted the GTT on a corporate action, leg rejected, etc.).
        startGrace();
        if (graceExpired()) {
          out.state = STATE.UNPROTECTED;
          out.patch.costMoved = false;
          out.alerts.push({ type: 'UNPROTECTED', symbol: pos.symbol, reason: 'protection vanished while position still held' });
        }
        return out;
      }
      clearGrace(); // something live is guarding us

      // (3) Pre-T1 move-SL-to-cost on BOTH legs once price crosses the trigger.
      // out.patch.t1Booked: T1 was booked THIS tick by (1) above, which already
      // ordered the post-T1 move. Reading only pos.t1Booked emitted both, so the
      // healthy path sent the same modify twice every time T1 booked.
      if (num(pos.costTrigger) > 0 && !pos.costMoved && !pos.t1Booked && !out.patch.t1Booked && !pos.pendingSl
          && num(pos.ltp) >= num(pos.costTrigger)) {
        // NEVER LOWER (2026-08-18): if every live leg's stop already sits at or
        // above entry (a trail got there first), cost is locked - tick, no send.
        const curSl3 = Math.max(num(pos.slPrice), ...liveLegs.map(l => num(l.triggerPrice)));
        if (num(pos.entryPrice) > curSl3 + 0.011) out.actions.push({ type: 'MOVE_SL_TO_COST', legIds: liveLegs.map(l => l.id), reason: 'pre-T1' });
        else out.patch.costMoved = true;
      }

      // (3b) MOVE SL TO T1 (2026-08-18; legacy checkSplitSlToT1 ported - it was
      // gated off on engine boxes with no engine twin). After T1 has BOOKED,
      // once price sits slToT1Pct% above the T1 price, the RUNNER's stop locks
      // at T1. Fires once (slT1Done, set on VERIFICATION via pendingSl.toT1 -
      // a failed modify retries next pass, exactly like cost-move); never
      // lowers a stop (a trail may already sit higher: then only the flag is
      // set); never at/above the market; waits for any pending modify.
      if (pos.t1Booked && !pos.slT1Done && !pos.pendingSl && num(pos.slT1Trigger) > 0 && num(pos.t1Price) > 0
          && num(pos.ltp) >= num(pos.slT1Trigger)) {
        const runner = liveLegs.find(l => l.role === 'runner') || (liveLegs.length === 1 ? liveLegs[0] : null);
        const curSl = Math.max(num(pos.slPrice), ...liveLegs.map(l => num(l.triggerPrice)));
        const lock = round2(num(pos.t1Price));
        if (runner && lock > curSl + 0.011 && lock < num(pos.ltp)) {
          out.actions.push({ type: 'MODIFY_SL', price: lock, legIds: [runner.id], reason: 'sl-to-t1' });
        } else {
          out.patch.slT1Done = true;   // already at/above T1 (or nothing live to move): nothing to send, do not ask again
        }
      }

      // (4) VERIFY-AFTER-MODIFY: an SL modify we sent earlier is only believed
      // once the broker's own list shows the new trigger on every VERIFIABLE leg.
      // Legs that report no trigger (e.g. a Zerodha GTT in triggered-but-working
      // state) can't confirm OR deny — they are excluded, never treated as "not
      // yet" (which would loop the modify forever).
      if (pos.pendingSl && num(pos.pendingSl.price) > 0) {
        const want = num(pos.pendingSl.price);
        const verifiable = liveLegs.filter(l => num(l.triggerPrice) > 0);
        const confirmed = verifiable.length > 0
          && verifiable.every(l => Math.abs(num(l.triggerPrice) - want) < 0.011);
        if (confirmed) {
          out.patch.slPrice = want;
          out.patch.slVerifiedAt = now;
          out.patch.pendingSl = null;
          if (pos.pendingSl.toCost) out.patch.costMoved = true;
          if (pos.pendingSl.toT1) out.patch.slT1Done = true;   // rule 3b, believed only now
        } else if ((now - num(pos.pendingSl.at)) >= graceMs) {
          out.patch.pendingSl = null; // stop believing; surface it
          out.alerts.push({ type: 'SL_MODIFY_UNCONFIRMED', symbol: pos.symbol,
            reason: 'SL modify to ' + want + ' was sent but the broker never showed it — stop may be STALE at ' + num(pos.slPrice) });
        }
      }

      // (5) RE-ASSERT a drifted stop — DIRECTION-AWARE for a long position:
      //   - broker trigger BELOW expected  => under-protected (a trail/cost modify
      //     failed silently) -> raise it back up (MODIFY_SL) + alert.
      //   - broker trigger ABOVE expected  => the broker is MORE protective than
      //     the row (a trail landed but the row update was lost) -> adopt broker
      //     truth into the row. NEVER lower a stop to match a stale expectation.
      // Never fires while a modify is pending verification.
      if (!pos.pendingSl && num(pos.slPrice) > 0) {
        // A costMoved tick is a PROMISE that the stop sits at entry (cost). If the
        // recorded SL is below entry, the promise wins over the field.
        const want = (pos.costMoved && num(pos.entryPrice) > num(pos.slPrice))
          ? num(pos.entryPrice) : num(pos.slPrice);
        const tol = Math.max(0.05, want * 0.002);
        const below = liveLegs.filter(l => num(l.triggerPrice) > 0 && (want - num(l.triggerPrice)) > tol);
        const above = liveLegs.filter(l => num(l.triggerPrice) > 0 && (num(l.triggerPrice) - want) > tol);
        if (below.length) {
          out.actions.push({ type: 'MODIFY_SL', price: want, legIds: below.map(l => l.id), reason: 'reassert-drift' });
          out.alerts.push({ type: 'SL_DRIFT', symbol: pos.symbol,
            reason: 'stop at broker is ' + num(below[0].triggerPrice) + ' but should be ' + want + ' — re-asserting' });
        } else if (above.length) {
          // Adopt the highest broker trigger as the position's SL (broker truth wins upward).
          out.patch.slPrice = Math.max(...above.map(l => num(l.triggerPrice)));
          out.patch.slAdoptedAt = now;
        }
      }

      // (6) REFRESH expiring protection (Zerodha GTTs die after 1 year): any live
      // leg within 30 days of expiry -> re-assert it (a modify resets the clock).
      const REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
      const expiring = liveLegs.filter(l => num(l.expiresAt) > 0 && (num(l.expiresAt) - now) < REFRESH_WINDOW_MS);
      if (expiring.length && !pos.pendingSl) {
        out.actions.push({ type: 'REFRESH_PROTECTION', legIds: expiring.map(l => l.id), reason: 'expiring' });
      }

      // (7) TRAILING (2026-08-17). Ported from the legacy daily pass so the
      // engine owns EVERY write to the stop - two writers (cost-move here,
      // trail there) on one stop is the class of race the cutover removes.
      //
      // The engine decides; the caller supplies what needs I/O or a clock:
      //   pos.trail = { enabled, mode:'ema'|'peak', pct, armPrice, armed,
      //                 ema (today's settled value, floored to the entry EMA
      //                 by the caller), peak (high-water mark so far),
      //                 lastDay, today (IST date keys), afterCheckTime }
      // Rules, each preserved from legacy on purpose:
      //   - arms once ltp >= armPrice (the "when to start trailing" level, or
      //     the legacy targetPrice for rows without one); armed is sticky
      //   - EMA mode runs ONCE per IST day, and only after the daily check
      //     time, so it trails a SETTLED EMA, never a half-formed candle
      //   - peak mode: the stop follows the high-water mark; the mark itself is
      //     patched every tick so it survives restarts
      //   - the stop NEVER moves down, and never fires while a modify is
      //     pending verification (rule 4 must confirm the previous one first)
      //   - a stop that would sit at/above the market is not sent: it would
      //     fire on arrival (the NAHARINDUS lesson)
      const tr = pos.trail;
      if (tr && tr.enabled && !pos.pendingSl && liveLegs.length && num(pos.ltp) > 0) {
        const ltp = num(pos.ltp);
        if (!tr.armed && num(tr.armPrice) > 0 && ltp >= num(tr.armPrice)) {
          out.patch.trailArmed = true;
          out.patch.trailArmedAt = now;
          out.patch.trailPeak = ltp;               // seed the mark at the arming price
        }
        const armed = tr.armed || out.patch.trailArmed;
        if (armed) {
          const peakMode = String(tr.mode) === 'peak';
          const peak = Math.max(num(tr.peak), ltp, num(out.patch.trailPeak));
          if (peakMode && peak > num(tr.peak)) out.patch.trailPeak = peak;
          const dueToday = peakMode || (tr.today && tr.lastDay !== tr.today && tr.afterCheckTime);
          const base = peakMode ? peak : num(tr.ema);
          const pct = num(tr.pct);
          if (dueToday && base > 0 && pct >= 0) {
            const nextSl = round2(base * (1 - pct / 100));
            const curSl = Math.max(num(pos.slPrice), ...liveLegs.map(l => num(l.triggerPrice)));
            if (!peakMode) out.patch.trailLastDay = tr.today;   // one EMA decision per day, raise or not
            if (nextSl > curSl + 0.011 && nextSl < ltp) {
              out.actions.push({ type: 'MODIFY_SL', price: nextSl, legIds: liveLegs.map(l => l.id), reason: 'trail-' + (peakMode ? 'peak' : 'ema') });
            }
          }
        }
      }

      // (8) STOP BREACHED WHILE THE STOP STANDS (2026-08-17; the legacy Angel
      // SL backstop, ported so the engine is the only writer - same decision
      // as mtm.slBackstopDecision). Price sits through the stop by a margin for
      // TWO consecutive passes while a leg still reads live, the shares are
      // still held, and no exit SELL is working: the trigger did not fire
      // (Angel rules have done exactly this; a suspended trigger on any broker
      // looks the same). Ask the executor to cancel what stands and exit at
      // market - cancel-first, never sell beside a live trigger. Enabled per
      // broker by the caller (opts.breachBackstop, market hours only); fires
      // ONCE per position (breachExitAt latch - the executor clears it if the
      // cancel was refused, so it retries); the sighting counter is patched
      // onto the position so a restart costs at most one extra pass.
      if (opts.breachBackstop && held && !pos.pendingSl && liveLegs.length && num(pos.ltp) > 0 && openSellQty <= 0 && !(num(pos.breachExitAt) > 0)) {
        const stop = Math.max(num(pos.slPrice), ...liveLegs.map(l => num(l.triggerPrice)));
        const marginPct = opts.breachMarginPct === undefined ? 0.3 : num(opts.breachMarginPct);
        const through = stop > 0 && num(pos.ltp) <= stop * (1 - marginPct / 100);
        const n = through ? num(pos.breachSightings) + 1 : 0;
        if (n !== num(pos.breachSightings)) out.patch.breachSightings = n;
        if (through && n >= 2) {
          const runnerLeg8 = (pos.legs || []).find(l => l.role === 'runner');
          const remaining8 = (pos.t1Booked && runnerLeg8) ? num(runnerLeg8.qty) : num(pos.qty);
          out.patch.breachExitAt = now;
          out.actions.push({ type: 'EXIT_BREACHED_STOP', legIds: liveLegs.map(l => l.id), qty: remaining8, ltp: num(pos.ltp), stop,
            reason: 'price ' + num(pos.ltp) + ' through standing stop ' + stop + ' (' + n + ' sightings)' });
          out.alerts.push({ type: 'STOP_NOT_FIRING', symbol: pos.symbol,
            reason: 'price ' + num(pos.ltp) + ' is through the stop ' + stop + ' but the trigger is still standing at the broker \u2014 cancelling it and exiting at market' });
        }
      }
      return out;
    }

    case STATE.EXIT_PENDING: {
      // (a) The SELL filled: E1 evidence closes the row with real prices.
      const soldQty = sells.reduce((s, x) => s + num(x.qty), 0);
      const runnerLegX = (pos.legs || []).find(l => l.role === 'runner');
      const remainingQty = (pos.t1Booked && runnerLegX) ? num(runnerLegX.qty) : num(pos.qty);
      const covering = remainingQty > 0 && soldQty >= remainingQty * 0.99;
      if (covering || (!held && sells.some(s => num(s.qty) > 0 && num(s.px) > 0))) {
        out.state = STATE.CLOSED;
        Object.assign(out.patch, reconstructClose(pos, sells));
        return out;
      }
      // (b) The SELL is no longer working and we still hold: the exit was
      //     cancelled/rejected under us -> the position is naked again.
      if (openSellQty <= 0) {
        if (!held) {   // not held, no sell seen: broker lag or a cross-day fill - wait it out
          startGrace();
          if (graceExpired()) { out.state = STATE.CLOSED; Object.assign(out.patch, reconstructClose(pos, sells)); }
          return out;
        }
        out.state = STATE.UNPROTECTED;
        out.alerts.push({ type: 'UNPROTECTED', symbol: pos.symbol, reason: 'exit order vanished without a fill \u2014 position naked' });
        return out;
      }
      // (c) Still working. A market-type exit that has sat unfilled past the
      //     chase window is STUCK (a resting LIMIT priced above the market
      //     never fills - HEALTHX): ask the executor to cancel it and re-place
      //     at market. Age, attempt cap and cooldown are the ENGINE's to state;
      //     the executor owns the broker calls and never sells beside a live
      //     order (cancel-all-first, or bail).
      const chaseWaitMs = num(opts.chaseWaitMs) || 3 * 60 * 1000;
      const chaseCooldownMs = num(opts.chaseCooldownMs) || 10 * 60 * 1000;
      const chaseMax = opts.chaseMaxAttempts === undefined ? 2 : num(opts.chaseMaxAttempts);
      const since = num(pos.exitPendingAt);
      const attempts = num(pos.exitChaseAttempts);
      const lastAt = num(pos.exitChaseLastAt);
      if (pos.exitOrderType === 'market' && since > 0 && (now - since) >= chaseWaitMs
          && attempts < chaseMax && (!lastAt || (now - lastAt) >= chaseCooldownMs)) {
        out.actions.push({ type: 'CHASE_EXIT', qty: remainingQty, reason: 'exit-stuck-' + Math.round((now - since) / 60000) + 'min' });
      }
      return out;
    }

    case STATE.TARGETS_ONLY: {
      // NO-SL rows (2026-08-17): there is NO stop by design; T1/T2 are
      // broker-side SELL triggers (Dhan Forever SINGLE / Kite GTT / Angel rule)
      // and the row's whole job is to keep every UNFILLED leg standing while
      // the shares are held. Ported from legacy planNoSlRow (nosl.test.js) with
      // the engine's evidence discipline on top:
      //   - E1 fills close it; a fired-leg CLAIM never does (TATASTEEL class)
      //   - a leg is re-placed only against HELD shares, sized DOWN to what is
      //     held minus what other live legs already cover. A cross-day T1 fill
      //     is invisible in today's book: legacy re-placed T1 there = over-sell
      //   - never place a SELL beside a working SELL (HEALTHX class)
      //   - "not held" is a verdict only after grace; ENTRY_DEAD only on a book
      //     'dead', or an entry that vanished across the day boundary having
      //     NEVER been seen held (heldSeenAt is the engine's own memory)
      //   - a missing holdings map is unknown, not "not held" (GNA lesson)
      const tLegs = legs.filter(l => l.role === 'target-t1' || l.role === 'target-t2');
      const t1 = tLegs.find(l => l.role === 'target-t1');
      const t2 = tLegs.find(l => l.role === 'target-t2');
      const qty = num(pos.qty);
      const entryPx = num(pos.entryPrice);
      const soldQty = sells.reduce((s, x) => s + num(x.qty), 0);
      const hasFill = sells.some(s => num(s.qty) > 0 && num(s.px) > 0);
      const ent = (snap.entries || {})[String(pos.entryId || '').trim()];
      const closeNow = () => { out.state = STATE.CLOSED; Object.assign(out.patch, reconstructTargetsOnlyClose(pos, sells)); clearGrace(); };
      // (a) fills cover the position -> CLOSED on E1, held or not (T+1 lag)
      if (qty > 0 && soldQty >= qty * 0.99) { closeNow(); return out; }
      if (!held) {
        const holdingsRead = snap.heldQty && typeof snap.heldQty === 'object';
        if (!holdingsRead) return out;                       // unknown -> wait
        if (ent && ent.status === 'pending') { clearGrace(); return out; }   // entry still working
        if (hasFill) { closeNow(); return out; }             // partly sold and flat: what sold is the exit
        const bookDead = !!(ent && ent.status === 'dead');
        const neverHeld = !(num(pos.heldSeenAt) > 0);
        if (bookDead || (neverHeld && !ent)) {
          // (c) never became a position. Book says dead: act now. Book silent
          //     (cross-day) and never seen held: only after grace.
          if (!bookDead) { startGrace(); if (!graceExpired()) return out; }
          out.state = STATE.ENTRY_DEAD;
          const liveT = tLegs.filter(l => l.status === 'live');
          if (liveT.length) out.actions.push({ type: 'CANCEL_ORPHAN_PROTECTION', legIds: liveT.map(l => l.id), reason: bookDead ? 'entry-dead' : 'entry-expired' });
          return out;
        }
        // Held before, not held now, no fill in today's book: sold on an earlier
        // day, or lag. Grace, then close (flagged estimated; the CLOSED re-check
        // reopens it if the shares reappear).
        startGrace();
        if (graceExpired()) closeNow();
        return out;
      }
      clearGrace();
      if (!(num(pos.heldSeenAt) > 0)) out.patch.heldSeenAt = now;
      // (b) T1 booked? Two tells, either suffices: fills covering T1's qty
      //     while T2 stands, or the QUANTITY tell - the T1 leg no longer live
      //     and no more than T2's qty still held (a cross-day T1 fill). A bare
      //     fired claim on the leg is NOT a tell: fired is not filled. The
      //     quantity tell is withheld when today's book shows the entry itself
      //     only PARTLY filled (then a small holding proves nothing about T1).
      if (t1 && t2 && !pos.t1Booked) {
        const t1Qty = num(t1.qty);
        const entKnownPartial = !!(ent && ent.status === 'filled' && num(ent.filledQty) > 0 && num(ent.filledQty) < qty * 0.99);
        const fillTell = t1Qty > 0 && soldQty >= t1Qty * 0.99;
        const qtyTell = t1.status !== 'live' && heldQty <= num(t2.qty) && !entKnownPartial;
        if (fillTell || qtyTell) {
          out.patch.t1Booked = true;
          out.patch.t1BookedAt = now;
          const fills = sells.filter(s => num(s.qty) > 0 && num(s.px) > 0);
          const fq = fills.reduce((s, x) => s + num(x.qty), 0);
          const vwap = fq > 0 ? fills.reduce((s, x) => s + num(x.px) * num(x.qty), 0) / fq : 0;
          const px = fillTell ? (vwap || num(t1.price)) : num(t1.price);
          if (px > 0 && entryPx > 0 && t1Qty > 0) out.patch.t1Pnl = round2((px - entryPx) * t1Qty);
        }
      }
      const t1Done = !!(pos.t1Booked || out.patch.t1Booked);
      // (d) every UNFILLED leg must stand at the broker. A working SELL for
      //     this symbol means an exit is in flight - never place beside it.
      if (openSellQty > 0) return out;
      const liveCover = tLegs.filter(l => l.status === 'live').reduce((s, l) => s + num(l.qty), 0);
      let room = heldQty - liveCover;
      tLegs.forEach(l => {
        if (l.status === 'live') return;
        if (l.role === 'target-t1' && t1Done) return;   // T1 booked: its leg is gone by design
        const want = num(l.qty);
        const q = Math.min(want, Math.max(0, room));
        if (q <= 0 || !(num(l.price) > 0)) return;      // nothing left to cover (or no price to place at)
        room -= q;
        const tag = l.role === 'target-t1' ? 'T1' : 'T2';
        out.actions.push({ type: 'PLACE_TARGET_LEG', tag, qty: q, price: num(l.price), legId: l.id || '', reason: 'leg-' + (l.status || 'gone') });
        if (q < want) out.alerts.push({ type: 'TARGET_LEG_SIZED_DOWN', symbol: pos.symbol,
          reason: tag + ' target leg re-placed for ' + q + ' (planned ' + want + '): only ' + heldQty + ' held' + (liveCover ? ', ' + liveCover + ' already covered by a live leg' : '') });
      });
      return out;
    }

    case STATE.UNPROTECTED: {
      // Manual exit resolves it; the broker going flat is the evidence.
      if (!held && sells.length > 0) {
        out.state = STATE.CLOSED;
        Object.assign(out.patch, reconstructClose(pos, sells));
        return out;
      }
      // Protection re-appearing (re-placed by us or re-armed manually with known ids).
      if (legs.length && legs.some(l => l.status === 'live')) {
        out.state = STATE.PROTECTED;
        out.patch.protectionVerifiedAt = now;
        return out;
      }
      // ADOPT (2026-08-18). A row that knows NO protection id (its stop was
      // rejected at entry, or an old row) while the broker shows exactly ONE
      // live protection on this symbol that no row of ours names: that is the
      // user's own stop, placed after the "add a manual stop" alert. Adopt it
      // as this row's leg instead of re-arming beside it (a duplicate stop is
      // a double sell when it fires). One candidate only - two or more is
      // ambiguous and the sync observer reports it; the human decides.
      if (held && !(pos.legs || []).length) {
        const symLive = Object.entries(snap.protections || {})
          .filter(([id, p]) => p && p.status === 'live' && normSym(p.symbol) === sym
            && !(snap.ownedIds && snap.ownedIds.has && snap.ownedIds.has(String(id))));
        if (symLive.length === 1) {
          const [id, p] = symLive[0];
          out.patch.adoptLegId = String(id);
          out.patch.adoptLegQty = num(p.qty);
          out.patch.adoptLegTrigger = num(p.triggerPrice);
          out.alerts.push({ type: 'ADOPTED_PROTECTION', symbol: pos.symbol,
            reason: 'no stop of ours on record, but one live trigger stands at the broker for this symbol (id ' + id + (num(p.triggerPrice) > 0 ? ', trigger ' + num(p.triggerPrice) : '') + ') \u2014 adopting it as this position\'s stop' });
          return out;
        }
      }
      // A working SELL means the exit is in flight - never re-arm beside it.
      if (openSellQty > 0) { out.state = STATE.EXIT_PENDING; out.patch.exitPendingAt = pos.exitPendingAt || now; return out; }
      // Still held with no live stop -> ask for a RE-ARM every pass. The executor
      // owns throttling (attempt caps, cooldowns, the auto-restore kill switch);
      // the engine only states the fact: this position needs protection NOW.
      if (held) out.actions.push({ type: 'REARM_PROTECTION', reason: 'held-unprotected' });
      return out;
    }

    default:
      return out; // unknown state -> never act on what we don't understand
  }
}

module.exports = { STATE, transition, reconstructClose, reconstructTargetsOnlyClose, invariantViolations, normSym, DEFAULT_GRACE_MS, foreignFill };
