'use strict';
// position-edit.js — the owner edits ONE open position from the Order Log:
// stop, T1/T2, how much T1 books, trailing, move-to-cost, move-to-T1
// (owner, 2026-09-23: "add edit option in orderlog for each stock ... whatever
// we want to modify - SL T1 T2 Trailing etc - and same should be updated in
// broker").
//
// PURE. Given the row, the requested changes and what the broker shows right
// now (live price, held quantity), it decides what is allowed, what changes on
// the row, what the broker must be asked to do, and what the engine will do
// next. The dialog's preview and the server's apply read the SAME plan, so the
// owner is never shown one thing and sent another.
//
// How a change reaches the broker (each path is the one already proven live):
//   - stop only                -> MODIFY: the modify every trail uses daily
//   - targets, Zerodha/FYERS/  -> MODIFY: those modifies already restate the
//     Angel One                   targets from the row on every trail step
//   - targets, Dhan            -> REBRACKET: Dhan's modify moves the stop leg
//                                 only, and a target-leg modify has never been
//                                 proven here; placing a new bracket has
//   - T1 book size, T1 on/off  -> REBRACKET on every broker: resizing legs by
//     (single <-> split)          modify would under-cover the shares between
//                                 the two calls; place-new-then-cancel never does
//   - trailing, move-to-cost,  -> ROW ONLY: Stockkar applies those rules itself
//     move-to-T1
const { computeMtmPlan } = require('./mtm');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const has = (v) => v !== undefined && v !== null && v !== '';
const r2 = (v) => Math.round(v * 100) / 100;
const inr = (v) => '₹' + (Math.round(num(v) * 100) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const pctOf = (price, entry) => (entry > 0 && price > 0 ? Math.round(((price / entry) - 1) * 100 * 1e6) / 1e6 : 0);
const TRAIL_MODES = ['ema', 'peak', 'step'];
const EMA_INDICATORS = ['ema5', 'ema9', 'ema10', 'ema20', 'ema21', 'ema50', 'ema100', 'ema200'];
const trailName = (mode) => (mode === 'peak' ? 'Peak' : mode === 'step' ? 'Step' : 'EMA');

// What the position looks like NOW - the same numbers the engine and the
// modify paths use (targets from computeMtmPlan, planned off the ORIGINAL stop
// so an R:R target does not drift as the stop moves).
function currentView(row) {
  const entry = num(row.entryPrice || row.price);
  const plan = computeMtmPlan({ ...row, slPrice: num(row.slPriceOriginal) || num(row.slPrice) });
  const split = !!row.splitT1;
  const t1Booked = split && !!row.mtmT1Done;
  const runnerNoTarget = !!row.runnerNoTarget;
  const softwareTarget = !!(row.softwareTargetTrailing || row.softwareTargetOrder);
  const qty = Math.floor(num(row.qty));
  const legA = Math.floor(num(row.splitLegAQty)), legB = Math.floor(num(row.splitLegBQty));
  const remaining = t1Booked ? (legB || Math.floor(num(row.mtmRemainingQty)) || qty) : qty;
  const stop = num(row.brokerSlPrice) || num(row.slPrice);
  const t1 = split ? num(plan.t1Price) : 0;
  const t2 = split ? (runnerNoTarget ? 0 : (num(plan.t2Price) || num(row.targetPrice))) : 0;
  const target = split ? t2 : num(row.targetPrice);
  // does the broker bracket carry a target leg? (what was PLACED decides)
  const brokerTarget = !softwareTarget && (split || num(row.targetPrice) > 0);
  const trail = {
    enabled: !!row.emaTrailingEnabled,
    mode: TRAIL_MODES.includes(String(row.trailMode)) ? String(row.trailMode) : 'ema',
    pct: num(row.emaTrailingPct),
    indicator: String(row.emaTrailingIndicator || ''),
    timeframe: String(row.emaTrailingTimeframe || '1D').toUpperCase() === '1W' ? '1W' : '1D',
    stepMovePct: num(row.stepMovePct),
    startMode: num(row.trailStartRR) > 0 ? 'rr' : 'pct',
    startVal: num(row.trailStartRR) > 0 ? num(row.trailStartRR) : num(row.trailStartPct),
    armed: !!(row.trailArmed || row.emaTrailingArmedAt),
  };
  return { entry, plan, split, t1Booked, runnerNoTarget, softwareTarget, brokerTarget, qty, legA, legB, remaining,
    stop, t1, t2, target, t1QtyPct: split ? num(row.t1Qty) : 0, costPct: num(row.costPct), slToT1Pct: num(row.slToT1Pct),
    costDone: !!row.mtmCostDone, slT1Done: !!row.mtmSlT1Done, trail };
}

// The fields the dialog opens with - one source for the form and the plan.
function editableSnapshot(row) {
  const v = currentView(row);
  return {
    stop: v.stop, split: v.split, t1Booked: v.t1Booked, runnerNoTarget: v.runnerNoTarget, brokerTarget: v.brokerTarget,
    softwareTarget: v.softwareTarget, t1: v.t1, t1QtyPct: v.t1QtyPct, t2: v.t2, target: v.target,
    qty: v.qty, remaining: v.remaining, legA: v.legA, legB: v.legB, entry: v.entry,
    costPct: v.costPct, slToT1Pct: v.slToT1Pct, trail: v.trail,
  };
}

// Why this position cannot be edited at all right now ('' = it can).
function editBlocker(row, ctx) {
  const now = num(ctx && ctx.now) || Date.now();
  if (!row) return 'Position not found.';
  if (row.testMode || row.source === 'test') return 'Test-mode positions have no broker orders to change.';
  if (ctx && ctx.open === false) return 'This position is closed - there is nothing to change.';
  if (row.awaitingFill) return 'The entry has not filled yet. You can edit it once it fills and its stop is placed.';
  if (row.exitPending) return 'The stop has fired and the exit order is working at the broker - nothing to change now.';
  if (row.noSl) return 'No-SL positions (targets only) cannot be edited here yet.';
  if (row.enginePendingSl) return 'A stop change is still being confirmed by the broker. Try again in a minute.';
  if (num(row.editLockUntil) > now) return 'An edit is already being applied to this position. Try again in a minute.';
  const broker = String(row.broker || 'dhan').toLowerCase();
  if (!['dhan', 'zerodha', 'fyers', 'angelone'].includes(broker)) return 'Editing is not supported for ' + broker + '.';
  return '';
}

// changes: { slPrice, targetPrice, split, t1Price, t1Qty, t2Price,
//            trail: { enabled, mode, pct, indicator, timeframe, stepMovePct, startMode, startVal },
//            costPct, slToT1Pct }   - every field optional; absent = unchanged
// ctx:     { ltp, heldQty, tick(v), now, open }
function planPositionEdit(row, changes, ctx) {
  ctx = ctx || {};
  changes = changes || {};
  const tick = typeof ctx.tick === 'function' ? (v) => num(ctx.tick(v)) : (v) => r2(num(v));
  const out = { ok: false, errors: [], warnings: [], lines: [], brokerOp: 'none', brokerLine: '', rowPatch: {}, legs: null, stop: 0 };
  const blocked = editBlocker(row, ctx);
  if (blocked) { out.errors.push(blocked); return out; }
  const cur = currentView(row);
  const broker = String(row.broker || 'dhan').toLowerCase();
  const B = broker === 'angelone' ? 'ANGEL ONE' : broker.toUpperCase();
  const ltp = num(ctx.ltp) || num(row.liveLtp);
  const err = (m) => out.errors.push(m);
  const patch = out.rowPatch;

  // ---- the stop --------------------------------------------------------------
  const stop = has(changes.slPrice) ? tick(changes.slPrice) : cur.stop;
  if (!(stop > 0)) err('Enter a stop-loss price.');
  else if (ltp > 0 && stop >= ltp) err('The stop (' + inr(stop) + ') must be below the current price (' + inr(ltp) + ') - a stop at or above it fires the moment it is placed.');
  // A TYPING ERROR IS NOT A STOP (2026-09-23, found in the dialog: "1650" +
  // "1600" typed into one field became a target of 1,65,01,600). A stop more
  // than 80% under the price protects nothing; a target over 5x the price
  // never fills. Both are almost always a slip of the keyboard.
  else if (ltp > 0 && has(changes.slPrice) && stop < ltp * 0.2) err('The stop (' + inr(stop) + ') is more than 80% below the current price (' + inr(ltp) + ') - check for a typing error.');
  const stopChanged = Math.abs(stop - cur.stop) >= 0.01;

  // ---- the shape: one target, or T1 + T2 -------------------------------------
  let split = cur.split;
  if (changes.split === true || changes.split === false) split = changes.split;
  if (cur.t1Booked && split !== cur.split) err('T1 has already booked, so the position can no longer be split differently. You can still change the stop, T2 and trailing.');
  if (cur.t1Booked && (has(changes.t1Price) || has(changes.t1Qty))) err('T1 has already booked - only the runner (stop, T2, trailing) can be changed now.');
  if (!cur.brokerTarget && split && !cur.split) err('This position\'s broker order is a stop only (its target is a trailing start level), so T1/T2 cannot be added here.');

  let t1 = 0, t1QtyPct = 0, t2 = 0, target = 0;
  if (split) {
    t1 = has(changes.t1Price) ? tick(changes.t1Price) : (cur.split ? cur.t1 : 0);
    t1QtyPct = has(changes.t1Qty) ? num(changes.t1Qty) : (cur.split ? cur.t1QtyPct : 50);
    t2 = has(changes.t2Price) ? tick(changes.t2Price) : (cur.split ? cur.t2 : cur.target);
    target = t2;
    if (!cur.t1Booked) {
      if (!(t1 > 0)) err('Enter the T1 price.');
      if (!(t1QtyPct >= 1 && t1QtyPct <= 99)) err('T1 must book between 1% and 99% of the position.');
    }
    if (!(t2 > 0) && !(cur.split && cur.runnerNoTarget)) err('Enter the T2 price.');
    if (t2 > 0 && t1 > 0 && !cur.t1Booked && !(t2 > t1)) err('T2 (' + inr(t2) + ') must be above T1 (' + inr(t1) + ').');
  } else {
    target = has(changes.targetPrice) ? tick(changes.targetPrice) : (cur.split ? cur.t2 : cur.target);
    if (cur.brokerTarget && !(target > 0)) err('Enter the target price.');
  }
  // every target the broker carries must sit above the stop (an OCO with its
  // stop above its target is nonsense). Whether it must ALSO sit above the
  // market depends on how the edit reaches the broker - decided further down.
  const brokerTargets = [];
  if (split) { if (!cur.t1Booked && t1 > 0) brokerTargets.push(['T1', t1]); if (t2 > 0) brokerTargets.push(['T2', t2]); }
  else if (cur.brokerTarget && target > 0) brokerTargets.push(['Target', target]);
  brokerTargets.forEach(([name, px]) => {
    if (stop > 0 && px <= stop) err(name + ' (' + inr(px) + ') must be above the stop (' + inr(stop) + ').');
  });
  const typed = [['T1', changes.t1Price], ['T2', changes.t2Price], [cur.brokerTarget ? 'Target' : 'Trailing start', changes.targetPrice]];
  typed.forEach(([name, v]) => {
    if (has(v) && ltp > 0 && tick(v) > ltp * 5) err(name + ' (' + inr(tick(v)) + ') is more than 5 times the current price (' + inr(ltp) + ') - check for a typing error.');
  });

  // ---- quantities: never more than the row, never more than the broker holds
  const base = cur.t1Booked ? cur.remaining : cur.qty;
  const held = has(ctx.heldQty) ? Math.floor(num(ctx.heldQty)) : null;
  const effQty = held !== null && held > 0 && held < base ? held : base;
  if (held !== null && held <= 0) err('The broker shows no holding for this stock - there is nothing to protect.');
  let legs = null;
  if (split && !cur.t1Booked) {
    const book = Math.floor(effQty * t1QtyPct / 100), runner = effQty - book;
    if (effQty > 0 && (book < 1 || runner < 1)) err(t1QtyPct + '% of ' + effQty + ' shares leaves an empty leg - choose a split that books at least 1 and keeps at least 1.');
    legs = [{ role: 't1', qty: book, target: t1 }, { role: 'runner', qty: runner, target: t2 }];
  } else if (split) {
    legs = [{ role: 'runner', qty: effQty, target: t2 }];
  } else {
    legs = [{ role: 'single', qty: effQty, target: cur.brokerTarget ? target : 0 }];
  }
  out.legs = legs; out.stop = stop;
  const sizedToHeld = effQty !== base;
  const legsResized = split && !cur.t1Booked && cur.split && (legs[0].qty !== cur.legA || legs[1].qty !== cur.legB);

  // ---- software rules: trailing, move-to-cost, move-to-T1 ---------------------
  const t = changes.trail || {};
  const trailNext = {
    enabled: has(t.enabled) ? !!t.enabled : cur.trail.enabled,
    mode: has(t.mode) ? String(t.mode) : cur.trail.mode,
    pct: has(t.pct) ? num(t.pct) : cur.trail.pct,
    indicator: has(t.indicator) ? String(t.indicator) : cur.trail.indicator,
    timeframe: has(t.timeframe) ? (String(t.timeframe).toUpperCase() === '1W' ? '1W' : '1D') : cur.trail.timeframe,
    stepMovePct: has(t.stepMovePct) ? num(t.stepMovePct) : cur.trail.stepMovePct,
    startMode: has(t.startMode) ? (String(t.startMode) === 'rr' ? 'rr' : 'pct') : cur.trail.startMode,
    startVal: has(t.startVal) ? num(t.startVal) : cur.trail.startVal,
  };
  if (trailNext.enabled) {
    if (!TRAIL_MODES.includes(trailNext.mode)) err('Choose a trailing type (EMA, Peak or Step).');
    if (!(trailNext.pct > 0 && trailNext.pct <= 50)) err('The trailing % must be between 0 and 50.');
    if (trailNext.mode === 'ema' && trailNext.indicator && !EMA_INDICATORS.includes(trailNext.indicator)) err('Unknown trailing indicator ' + trailNext.indicator + '.');
    if (trailNext.stepMovePct < 0 || trailNext.startVal < 0) err('Trailing values cannot be negative.');
  }
  const costPct = has(changes.costPct) ? num(changes.costPct) : cur.costPct;
  const slToT1Pct = has(changes.slToT1Pct) ? num(changes.slToT1Pct) : cur.slToT1Pct;
  if (costPct < 0 || costPct >= 100) err('Move-to-cost must be between 0 (off) and 100%.');
  if (slToT1Pct < 0 || slToT1Pct >= 100) err('Move-to-T1 must be between 0 (off) and 100%.');

  if (out.errors.length) return out;

  // ---- what changes, in words ---------------------------------------------------
  const line = (s) => out.lines.push(s);
  if (stopChanged) line('Stop ' + inr(cur.stop) + ' → ' + inr(stop));
  if (split !== cur.split) line(split ? 'Book part at T1: off → on' : 'Book part at T1: on → off (one target)');
  const t1Changed = split && !cur.t1Booked && (Math.abs(t1 - cur.t1) >= 0.01 || !cur.split);
  const t1QtyChanged = split && !cur.t1Booked && (Math.abs(t1QtyPct - cur.t1QtyPct) >= 0.001 || !cur.split);
  const t2Changed = split && (Math.abs(t2 - (cur.split ? cur.t2 : cur.target)) >= 0.01);
  const targetChanged = !split && Math.abs(target - (cur.split ? cur.t2 : cur.target)) >= 0.01;
  if (t1Changed) line('T1 ' + (cur.split ? inr(cur.t1) : 'none') + ' → ' + inr(t1));
  if (t1QtyChanged) line('T1 books ' + (cur.split ? cur.t1QtyPct + '%' : 'none') + ' → ' + t1QtyPct + '% (' + legs[0].qty + ' of ' + effQty + ' shares)');
  if (t2Changed) line('T2 ' + inr(cur.split ? cur.t2 : cur.target) + ' → ' + (t2 > 0 ? inr(t2) : 'none (runner rides on the stop)'));
  if (targetChanged) line((cur.brokerTarget ? 'Target ' : 'Trailing start level ') + inr(cur.split ? cur.t2 : cur.target) + ' → ' + inr(target));
  if (sizedToHeld) line('Quantity ' + base + ' → ' + effQty + ' (what the broker holds)');
  const trailWord = (x) => (x.enabled ? trailName(x.mode) + ' ' + x.pct + '%' + (x.mode === 'step' && x.stepMovePct ? ' / lift ' + x.stepMovePct + '%' : '') + (x.mode === 'ema' && x.indicator ? ' of ' + x.indicator.toUpperCase() : '') : 'off');
  const trailChanged = trailNext.enabled !== cur.trail.enabled || (trailNext.enabled && (trailNext.mode !== cur.trail.mode
    || Math.abs(trailNext.pct - cur.trail.pct) > 1e-9 || trailNext.indicator !== cur.trail.indicator || trailNext.timeframe !== cur.trail.timeframe
    || Math.abs(trailNext.stepMovePct - cur.trail.stepMovePct) > 1e-9));
  const startChanged = trailNext.enabled && (trailNext.startMode !== cur.trail.startMode || Math.abs(trailNext.startVal - cur.trail.startVal) > 1e-9);
  if (trailChanged) line('Trailing ' + trailWord(cur.trail) + ' → ' + trailWord(trailNext));
  if (startChanged) line('Trailing starts ' + (cur.trail.startVal ? (cur.trail.startMode === 'rr' ? cur.trail.startVal + 'R' : '+' + cur.trail.startVal + '%') : 'at its default') + ' → '
    + (trailNext.startVal ? (trailNext.startMode === 'rr' ? trailNext.startVal + 'R' : '+' + trailNext.startVal + '%') : 'its default'));
  if (Math.abs(costPct - cur.costPct) > 1e-9) line('Move stop to cost at ' + (cur.costPct ? '+' + cur.costPct + '%' : 'off') + ' → ' + (costPct ? '+' + costPct + '%' : 'off'));
  if (Math.abs(slToT1Pct - cur.slToT1Pct) > 1e-9) line('Move stop to T1 at ' + (cur.slToT1Pct ? '+' + cur.slToT1Pct + '% past T1' : 'off') + ' → ' + (slToT1Pct ? '+' + slToT1Pct + '% past T1' : 'off'));
  if (!out.lines.length) { out.errors.push('Nothing has changed.'); return out; }

  // ---- how it reaches the broker ------------------------------------------------
  const shapeChanged = split !== cur.split;
  const targetsAtBroker = (split && (t1Changed || t2Changed)) || (!split && cur.brokerTarget && targetChanged);
  const legsChange = shapeChanged || legsResized || t1QtyChanged || sizedToHeld;
  if (legsChange || (targetsAtBroker && broker === 'dhan')) out.brokerOp = 'rebracket';
  else if (stopChanged || targetsAtBroker) out.brokerOp = 'modify';
  else out.brokerOp = 'none';

  // A TARGET AT OR BELOW THE MARKET SELLS THE MOMENT IT IS PLACED (2026-09-23).
  // A re-bracket places EVERY leg afresh, so every target must clear the
  // price. A modify restates the targets it does not change exactly as they
  // already stand - an untouched T1 the price has run past (IKS: T1 1823,
  // price 1850) must not block a stop change; only a target being SET is
  // judged against the market.
  if (ltp > 0 && out.brokerOp !== 'none') {
    const judged = out.brokerOp === 'rebracket' ? brokerTargets
      : brokerTargets.filter(([name]) => (name === 'T1' && t1Changed) || (name === 'T2' && t2Changed) || (name === 'Target' && targetChanged));
    judged.forEach(([name, px]) => {
      if (px <= ltp) out.errors.push(name + ' (' + inr(px) + ') is at or below the current price (' + inr(ltp) + ') - a target there sells immediately.'
        + (out.brokerOp === 'rebracket' && !((name === 'T1' && t1Changed) || (name === 'T2' && t2Changed) || (name === 'Target' && targetChanged))
          ? ' This change places the whole bracket again, so raise ' + name + ' above ' + inr(ltp) + (name === 'T1' ? ' or switch off "Book part at T1"' : '') + '.' : ''));
    });
    if (out.errors.length) { out.lines = []; out.brokerLine = ''; out.brokerOp = 'none'; return out; }
  }

  const legWords = legs.map(l => (l.role === 't1' ? 'T1 ' : l.role === 'runner' ? (split && !cur.t1Booked ? 'T2 ' : 'runner ') : '')
    + (l.target > 0 ? inr(l.target) : 'no target') + ' × ' + l.qty).join(' and ');
  if (out.brokerOp === 'none') out.brokerLine = 'Nothing changes at ' + B + ' - Stockkar applies these rules itself.';
  else if (out.brokerOp === 'modify') out.brokerLine = 'At ' + B + ': the standing order' + (split && !cur.t1Booked ? 's are' : ' is') + ' modified in place - stop ' + inr(stop)
    + (targetsAtBroker ? ', ' + legWords : '') + '. No new orders.';
  else out.brokerLine = 'At ' + B + ': new protection is placed first (' + legWords + ', stop ' + inr(stop) + '), then the old order'
    + (cur.split && !cur.t1Booked ? 's are' : ' is') + ' cancelled. If the old one will not cancel, the new one is taken back and nothing changes.';

  // ---- the row after the edit -------------------------------------------------------
  if (stopChanged) {
    patch.slPrice = stop;
    if (num(row.lastTrailSlPrice) > stop) patch.lastTrailSlPrice = stop;   // a restore places max(...) - never bring the old level back
    // a stop below cost withdraws the "stop sits at cost" promise the engine would otherwise re-assert
    if (stop < cur.entry - 0.01 && cur.costDone) { patch.mtmCostDone = false; patch.splitCostDone = false; }
    if (split && t1 > 0 && stop < t1 - 0.01 && cur.slT1Done) patch.mtmSlT1Done = false;
  }
  if (split) {
    // targets as % of entry: the one form computeMtmPlan, every modify and the
    // T1-booked check all read - so the broker legs, the engine and the table agree
    if (!cur.t1Booked) { patch.t1Pct = pctOf(t1, cur.entry); patch.t1Qty = t1QtyPct; }
    if (t2 > 0) patch.t2Pct = pctOf(t2, cur.entry);
    patch.targetMode = 'pct'; patch.t1RR = 0; patch.t2RR = 0;
    if (t2 > 0) patch.targetPrice = t2;
    if (!cur.t1Booked) { patch.splitLegAQty = legs[0].qty; patch.splitLegBQty = legs[1].qty; }
    else patch.splitLegBQty = legs[0].qty;
  } else {
    if (cur.split) { patch.t1Pct = 0; patch.t1Qty = 0; patch.t2Pct = 0; patch.t1RR = 0; patch.t2RR = 0; patch.slToT1Pct = 0; }
    if (targetChanged || cur.split) patch.targetPrice = target;
  }
  if (sizedToHeld) { patch.qty = cur.t1Booked ? num(row.qty) : effQty; patch.mtmRemainingQty = effQty; patch.qtyAdopted = { from: base, to: effQty, at: num(ctx.now) || Date.now(), by: 'edit' }; }
  if (trailChanged || startChanged) {
    patch.emaTrailingEnabled = trailNext.enabled;
    if (trailNext.enabled) {
      patch.trailMode = trailNext.mode;
      patch.emaTrailingPct = trailNext.pct;
      if (trailNext.mode === 'ema') { patch.emaTrailingIndicator = trailNext.indicator || cur.trail.indicator || 'ema20'; patch.emaTrailingTimeframe = trailNext.timeframe; }
      patch.stepMovePct = trailNext.mode === 'step' ? trailNext.stepMovePct : 0;
      patch.trailStartMode = trailNext.startVal > 0 ? trailNext.startMode : '';
      patch.trailStartPct = trailNext.startVal > 0 && trailNext.startMode === 'pct' ? trailNext.startVal : 0;
      patch.trailStartRR = trailNext.startVal > 0 && trailNext.startMode === 'rr' ? trailNext.startVal : 0;
      patch.emaTrailingTrigger = row.emaTrailingTrigger || 'afterTarget';
    }
    // a new start level, or trailing switched on, starts the trail afresh: it
    // arms again when price reaches the start (at once if it already has)
    if (startChanged || (trailNext.enabled && !cur.trail.enabled) || (trailNext.enabled && trailNext.mode !== cur.trail.mode)) {
      patch.trailArmed = false; patch.trailArmedAt = null; patch.emaTrailingArmedAt = null; patch.trailPeak = 0;
      patch.emaTrailingStatus = 'waiting-target';
    }
  }
  if (Math.abs(costPct - cur.costPct) > 1e-9) patch.costPct = costPct;
  if (Math.abs(slToT1Pct - cur.slToT1Pct) > 1e-9) patch.slToT1Pct = slToT1Pct;
  if (row.autoAdopted) patch.adoptSplitChecked = new Date(num(ctx.now) || Date.now()).toISOString();   // the owner's shape wins over the automatic conversion

  // ---- what the engine will do NEXT, said before it happens ----------------------------
  const lowered = stopChanged && stop < cur.stop;
  if (lowered && trailNext.enabled && cur.trail.armed && !(startChanged || trailNext.mode !== cur.trail.mode)) {
    out.warnings.push(trailName(trailNext.mode) + ' trailing is running on this position and never lowers a stop it has raised - on its next check it may lift the stop back up. Switch trailing off to keep ' + inr(stop) + '.');
  }
  const costTrigger = costPct > 0 ? cur.entry * (1 + costPct / 100) : 0;
  if (lowered && stop < cur.entry - 0.01 && costPct > 0 && ltp > 0 && ltp >= costTrigger) {
    out.warnings.push('Move-to-cost (+' + costPct + '%) is on and the price is above its trigger (' + inr(costTrigger) + '), so the next pass will move the stop back to cost (' + inr(cur.entry) + '). Set move-to-cost to 0 to keep ' + inr(stop) + '.');
  }
  if (!cur.brokerTarget && !split && targetChanged) out.warnings.push('This position\'s target is where trailing starts - it is not an order at the broker.');
  if (sizedToHeld) out.warnings.push('The broker holds ' + effQty + ' but this position tracked ' + base + ' - the new protection covers the ' + effQty + ' actually held.');

  out.ok = true;
  return out;
}

module.exports = { planPositionEdit, editableSnapshot, editBlocker, currentView, EMA_INDICATORS, TRAIL_MODES };
