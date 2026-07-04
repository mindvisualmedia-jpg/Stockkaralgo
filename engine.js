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
  const realisedPnl = estimated ? (entry && qty ? round2((exitPrice - entry) * qty) : 0) : round2(pnl);
  const split = (pos.legs || []).some(l => l.role === 't1');
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
  return { exitType, exitPrice, realisedPnl, exitEstimated: estimated, t1Booked, t2Done };
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
      // once the broker's own list shows the new trigger on every live leg.
      if (pos.pendingSl && num(pos.pendingSl.price) > 0) {
        const want = num(pos.pendingSl.price);
        const confirmed = liveLegs.length > 0
          && liveLegs.every(l => Math.abs(num(l.triggerPrice) - want) < 0.011);
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
      }
      return out;
    }

    default:
      return out; // unknown state -> never act on what we don't understand
  }
}

module.exports = { STATE, transition, reconstructClose, normSym, DEFAULT_GRACE_MS };
