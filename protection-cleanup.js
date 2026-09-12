'use strict';
/**
 * EXTRA TRIGGERS AT THE BROKER — which ones can be cancelled, and which must
 * never be. Pure decisions, no I/O (the caller reads the broker and does the
 * cancelling).
 *
 * The problem this exists for (2026-09-12, day 6 of the same audit line):
 * the 2026-09-09 empty-list incident re-armed brackets BESIDE the standing
 * ones on a dozen Dhan symbols. The daily audit has said "cancel the extra
 * trigger(s) at the broker" every day since — ~20 cancels by hand in the
 * broker's app, so nobody did it, and as each position closed its duplicates
 * turned into standing triggers for shares that no longer exist (KIRLOSIND,
 * CCL).
 *
 * Engine rule 5c cancels this automatically for an OPEN row whose own legs
 * cover what is held — the case where ownership is provable. This module is
 * for everything 5c cannot reach: closed rows, hand-placed lots, orphans. It
 * NEVER acts on its own: the caller shows the plan and the owner confirms.
 *
 * THE SAFETY RULES, in order of authority:
 *   1. An id an OPEN row names is never cancelled. That is the stop the engine
 *      manages; only the engine retires it.
 *   2. Protection is never REDUCED. What survives must cover every share held,
 *      and among equal choices the set with the highest stop wins.
 *   3. Arithmetic needs numbers. A trigger whose quantity the broker did not
 *      report makes the whole symbol unjudgeable — skipped, reported, untouched.
 *   4. Nothing is "extra" unless the symbol is genuinely over-covered (or
 *      nothing at all is held). One stop on one holding is never surplus, even
 *      when no row of ours owns it: that is the owner's own stop.
 */

const MAX_SUBSET_ITEMS = 12;          // 4096 combinations; beyond that, greedy
const DEFAULT_MAX_CANCEL = 40;        // one confirmed run, not a mass purge

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

function normSym(s) {
  return String(s || '').replace(/^(NSE|BSE):/i, '').replace(/-(EQ|BE|BZ|SM|ST)$/i, '').replace(/\s/g, '').toUpperCase();
}

/** Best keep-set: covers `held`, includes every forced id, fewest triggers,
 *  then the highest stop. Returns null when nothing covers the holding. */
function chooseKeep(forced, optional, held) {
  const forcedQty = forced.reduce((s, t) => s + num(t.qty), 0);
  const minTrig = set => (set.length ? Math.min(...set.map(t => num(t.trigger))) : 0);
  const better = (a, b) => !b || a.set.length < b.set.length
    || (a.set.length === b.set.length && minTrig(a.set) > minTrig(b.set));
  if (forcedQty >= held) return forced.slice();

  if (optional.length <= MAX_SUBSET_ITEMS) {
    let best = null;
    for (let mask = 0; mask < (1 << optional.length); mask++) {
      const pick = optional.filter((_, i) => mask & (1 << i));
      const set = forced.concat(pick);
      if (set.reduce((s, t) => s + num(t.qty), 0) < held) continue;
      const cand = { set };
      if (better(cand, best)) best = cand;
    }
    return best ? best.set : null;
  }
  // Too many to enumerate: take the most protective first until covered.
  const sorted = optional.slice().sort((a, b) => num(b.trigger) - num(a.trigger) || num(b.qty) - num(a.qty));
  const set = forced.slice();
  let sum = forcedQty;
  for (const t of sorted) { if (sum >= held) break; set.push(t); sum += num(t.qty); }
  return sum >= held ? set : null;
}

/**
 * @param {object} input
 *   live      [{ id, symbol, qty, trigger }] — LIVE triggers only
 *   heldQty   { SYM: shares }                — the broker's holdings
 *   ownedIds  Set|Array of ids named by OPEN rows of this broker
 *   maxCancel cap for one run (default 40)
 * @returns {{ symbols: Array, cancelCount: number, skipped: Array }}
 */
function planCleanup(input) {
  // A null/garbage argument must produce an EMPTY plan, never an exception: the
  // caller is a route that has just read a broker, and a throw there would
  // read to the owner as "the cleanup is broken" on a day it is needed.
  const inp = (input && typeof input === 'object') ? input : {};
  const live = Array.isArray(inp.live) ? inp.live : [];
  const heldRaw = (inp.heldQty && typeof inp.heldQty === 'object') ? inp.heldQty : {};
  const held = {};
  Object.keys(heldRaw).forEach(k => { held[normSym(k)] = num(heldRaw[k]); });
  const ownedSet = inp.ownedIds instanceof Set ? inp.ownedIds
    : new Set((Array.isArray(inp.ownedIds) ? inp.ownedIds : []).map(String));
  const maxCancel = num(inp.maxCancel) > 0 ? num(inp.maxCancel) : DEFAULT_MAX_CANCEL;

  const bySym = {};
  live.forEach(t => {
    const sym = normSym(t.symbol);
    if (!sym || !String(t.id || '').trim()) return;
    (bySym[sym] = bySym[sym] || []).push({ id: String(t.id), symbol: sym, qty: num(t.qty), trigger: num(t.trigger) });
  });

  const symbols = [], skipped = [];
  let cancelCount = 0;

  Object.keys(bySym).sort().forEach(sym => {
    const all = bySym[sym];
    const h = num(held[sym]);
    const owned = all.filter(t => ownedSet.has(t.id));
    const unowned = all.filter(t => !ownedSet.has(t.id));

    // RULE 4: nothing held at all -> every unowned trigger sells shares that do
    // not exist. This is the only case that ignores quantities: a SELL for a
    // position you do not have is wrong at any size.
    if (h <= 0) {
      if (!unowned.length) return;
      const cancel = unowned.map(t => ({ ...t, why: 'no shares of ' + sym + ' are held — this would sell shares you do not have' }));
      symbols.push({ symbol: sym, held: 0, keep: owned, cancel,
        note: owned.length ? 'An open position still owns ' + owned.length + ' trigger(s) here; those are left alone.' : '' });
      cancelCount += cancel.length;
      return;
    }

    // RULE 3: unjudgeable without quantities.
    if (all.some(t => !(t.qty > 0))) {
      skipped.push({ symbol: sym, held: h, triggers: all.length,
        reason: 'the broker did not report a quantity for every trigger on this stock, so Stockkar cannot tell which are extra' });
      return;
    }

    // RULE 4: not over-covered -> nothing is extra.
    const total = all.reduce((s, t) => s + t.qty, 0);
    if (total <= h || all.length < 2) return;

    // Over-covered, so the full set covers `held` and a keep-set always exists.
    // The guard stays as a belt: a plan that cannot prove coverage proposes
    // nothing rather than guessing.
    const keep = chooseKeep(owned, unowned, h);
    if (!keep) {
      skipped.push({ symbol: sym, held: h, triggers: all.length,
        reason: 'the triggers here do not cover all ' + h + ' share(s), so nothing was proposed for cancelling' });
      return;
    }
    const keepIds = new Set(keep.map(t => t.id));
    const ownedCovers = owned.reduce((s, t) => s + t.qty, 0) >= h && owned.length > 0;
    const why = ownedCovers
      ? 'this position’s own stop already covers all ' + h + ' share(s) held'
      : h + ' share(s) held, but the triggers here cover ' + total + ' — this one is a duplicate';
    const cancel = all.filter(t => !keepIds.has(t.id)).map(t => ({ ...t, why }));
    if (!cancel.length) return;
    symbols.push({ symbol: sym, held: h, keep, cancel,
      note: ownedCovers ? 'The stop Stockkar manages for this position is kept.' : 'The most protective cover for all ' + h + ' share(s) is kept.' });
    cancelCount += cancel.length;
  });

  // The cap trims whole symbols from the end, never half a symbol's plan: a
  // partly-applied symbol is the state this module exists to remove.
  if (cancelCount > maxCancel) {
    let running = 0;
    const fit = [];
    symbols.forEach(s => {
      if (running + s.cancel.length <= maxCancel) { fit.push(s); running += s.cancel.length; }
      else skipped.push({ symbol: s.symbol, held: s.held, triggers: s.keep.length + s.cancel.length,
        reason: 'over the ' + maxCancel + '-trigger limit for one run — run the cleanup again to include it' });
    });
    return { symbols: fit, cancelCount: running, skipped };
  }
  return { symbols, cancelCount, skipped };
}

module.exports = { planCleanup, chooseKeep, normSym, DEFAULT_MAX_CANCEL, MAX_SUBSET_ITEMS };
