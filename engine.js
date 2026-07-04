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
  const exitPrice = round2(maxSell || (target > 0 ? target : slBase));
  const split = (pos.legs || []).some(l => l.role === 't1') || !!pos.splitT1;
  // CROSS-DAY SPLITS: broker order books are TODAY-only, so a T1 leg that booked
  // on an earlier day is missing from today's fills. Its P&L was recorded when it
  // booked (t1Pnl) — add it back, otherwise the close silently drops that leg.
  const bookedLegMissingFromFills = split && pos.t1Booked && soldQty > 0 && soldQty < qty;
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

// Position INVARIANTS — flag combinations that can NEVER be true of a real
// position. The engine can't produce them by construction; this detects them
// arriving from anywhere else (legacy reconciles, old data, manual edits).
// Input is a plain facts object so order-log rows can be checked directly.
function invariantViolations(p) {
  const v = [];
  const split = !!p.splitT1;
  if (split && p.t2Done && !p.t1Booked) v.push('T2 ticked but T1 not booked — impossible: T2 (above T1) can only fill after T1');
  if (split && p.emaTrailingEnabled) v.push('split-T1 and EMA trailing on the same position — mutually exclusive by placement design');
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
  const held = num((snap.heldQty || {})[sym]) > 0;
  const sells = (snap.sells || {})[sym] || [];
  const legs = (pos.legs || []).map(l => ({ ...l, ...legState(snap, l.id) }));
  const liveLegs = legs.filter(l => l.status === 'live');

  // Grace helper: first sighting starts the clock; only after graceMs of the
  // SAME condition do we act on it (RMS decides async; never alarm on strike 1).
  const graceExpired = () => pos.graceStartAt && (now - num(pos.graceStartAt)) >= graceMs;
  const startGrace = () => { if (!pos.graceStartAt) out.patch.graceStartAt = now; };
  const clearGrace = () => { if (pos.graceStartAt) out.patch.graceStartAt = 0; };

  switch (pos.state) {
    case STATE.ENTRY_PENDING: {
      const ent = (snap.entries || {})[String(pos.entryId || '').trim()];
      if (!ent || ent.status === 'pending') return out;
      if (ent.status === 'dead') { out.state = STATE.ENTRY_DEAD; return out; }
      // filled -> protection is now DUE; nothing is protected until seen live.
      out.state = STATE.PROTECTION_PENDING;
      if (num(ent.fillPrice) > 0) out.patch.entryPrice = num(ent.fillPrice);
      if (num(ent.filledQty) > 0) out.patch.filledQty = num(ent.filledQty);
      out.actions.push({ type: 'PLACE_PROTECTION' });
      return out;
    }

    case STATE.ENTRY_DEAD:
    case STATE.CLOSED:
      return out; // terminal

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
        const t1Hit = t1Leg.status === 'traded_target'
          || (t1Leg.status !== 'live' && runnerLeg && runnerLeg.status === 'live');
        if (t1Hit) {
          out.patch.t1Booked = true;
          out.patch.t1BookedAt = now;
          const t1Px = num(t1Leg.px) || num(pos.t1Price);
          const legAQty = num(t1Leg.qty);
          if (t1Px > 0 && num(pos.entryPrice) > 0 && legAQty > 0) {
            out.patch.t1Pnl = round2((t1Px - num(pos.entryPrice)) * legAQty);
          }
          if (!pos.costMoved && runnerLeg.status === 'live') {
            out.actions.push({ type: 'MOVE_SL_TO_COST', legIds: [runnerLeg.id], reason: 'post-T1' });
          }
        }
      }

      // (2) Confirmed close: nothing live protecting AND broker says flat.
      if (!liveLegs.length) {
        if (!held) {
          out.state = STATE.CLOSED;
          Object.assign(out.patch, reconstructClose(pos, sells));
          clearGrace();
          return out;
        }
        // Held but nothing guarding it: protection died under us (broker deleted
        // the GTT on a corporate action, leg rejected, etc.).
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
      if (num(pos.costTrigger) > 0 && !pos.costMoved && !pos.t1Booked && !pos.pendingSl
          && num(pos.ltp) >= num(pos.costTrigger)) {
        out.actions.push({ type: 'MOVE_SL_TO_COST', legIds: liveLegs.map(l => l.id), reason: 'pre-T1' });
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

module.exports = { STATE, transition, reconstructClose, invariantViolations, normSym, DEFAULT_GRACE_MS };
