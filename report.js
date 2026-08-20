'use strict';
// report.js — THE report math, extracted verbatim from index.html (REPORT-PLAN
// R6, slice 1). Every trading figure the user reads — the Order Log analytics
// band, the Dashboard page, the PDF report, the row P&L cells and status
// badges — derives from the functions in this file and nowhere else.
//
// Loaded two ways, deliberately:
//   browser: <script src="report.js"> in index.html (plain globals, before the
//            app script — index.html defines NONE of these itself)
//   node:    require('./report.js') in report.test.js / resultlabel.test.js,
//            so the money-math is pinned by the same suite as the engine.
// Pure by contract: rows in, numbers out. No DOM, no fetch, no Date.now()
// beyond what the moved code already did (none). If a rule changes here it
// changes for every surface at once — that is the point.

// ---- RESULT / STATUS wording (DISPLAY ONLY) --------------------------------
// Derived at render time from flags already on the row. The STORED exitType is
// never changed: isOpenOrderLogEntry (server AND here) decides "is this a live
// position?" by text-matching TARGET HIT / SL HIT / EXITED / CLOSED..., and 60+
// sites pattern-match those values. Renaming what we STORE would silently
// rewrite the meaning of "open" — the zombie-row class in GUARDRAILS. So we
// relabel only what the user reads.
//
// Why this exists: `EXITED` was a catch-all hiding three genuinely different
// outcomes — stopped at breakeven (mtmCostDone), stopped with trail profit
// locked (emaTrailingStatus trail-exit / armed), and T1-booked-then-runner-
// stopped (splitT1 + mtmT1Done).
function logExitIsSl(result) { return /SL HIT/i.test(result); }
function logExitIsTarget(result) { return /TARGET HIT/i.test(result); }

function describeLogResult(r) {
  const result = String(r.exitType || r.result || '');
  if (!result) return '';
  const est = r.exitEstimated ? ' ~' : '';                       // exit price was inferred, not a broker fill
  if (/REJECT/i.test(result)) {
    // "no fill" and "broker said no" are different diagnostics.
    return /expired|no fill/i.test(String(r.status || '')) ? 'Expired unfilled' : 'Rejected at entry';
  }
  if (/CANCEL/i.test(result)) return 'Cancelled';
  if (r.manualClose) return 'Closed manually' + est;
  if (/EOD/i.test(result)) return 'Closed at EOD' + est;
  const sl = logExitIsSl(result), tgt = logExitIsTarget(result);
  const costDone = !!(r.mtmCostDone || r.splitCostDone);
  const trailed = String(r.emaTrailingStatus || '') === 'trail-exit'
    || (!!r.emaTrailingEnabled && !!r.emaTrailingArmedAt);
  // Split T1/T2 first — the most specific shape.
  if (r.splitT1 && r.mtmT1Done) {
    if (tgt || r.mtmT2Done) return 'T1 & T2 booked' + est;
    if (sl || /EXITED/i.test(result)) return costDone ? 'T1 booked, T2 SL hit at cost' + est : 'T1 booked, T2 SL hit' + est;
  }
  if (sl || /EXITED/i.test(result)) {
    if (trailed) return 'Trailing SL hit' + est;                 // trail locked profit above cost
    if (costDone) return 'Closed at cost' + est;                 // breakeven after move-to-cost
    if (sl) return 'Closed with SL' + est;
    // Residual EXITED. The broker stores EXITED whenever the fills were mixed
    // or no fill price came back, so a genuine stop-out lands here and used to
    // read as a bare "Closed". Recover the reason from PRICE EVIDENCE — the
    // same rule engine.js reconstructClose uses (exit at/below the stop = SL).
    const exitPx = Number(r.exitPrice || 0);
    const slPx = Number(r.brokerSlPrice || r.slPrice || 0);
    const tgtPx = Number(r.targetPrice || 0);
    if (exitPx > 0 && slPx > 0 && exitPx <= slPx * 1.001) return 'Closed with SL' + est;
    if (exitPx > 0 && tgtPx > 0 && exitPx >= tgtPx * 0.999) return 'Closed at target' + est;
    // No usable prices: fall back to the P&L sign. A protected position's only
    // downside exit is its stop, so a loss here is an SL hit.
    const pnl = Number(r.realisedPnl ?? r.realizedPnl);
    if (Number.isFinite(pnl) && pnl < 0) return 'Closed with SL' + est;
    if (Number.isFinite(pnl) && pnl > 0) return 'Closed in profit' + est;
    return 'Closed' + est;                                       // truly nothing to go on
  }
  if (tgt) return 'Closed at target' + est;
  return result;                                                 // unknown shape: show broker truth verbatim
}

// ---- Structured row state (mirrors server isOpenOrderLogEntry ordering:
// structured flags first, text only as a fallback). One source of truth for
// both the Status filter and the status badge, so they never disagree. ----
const LOG_STATE_LABELS = {
  pending: 'Pending fill', partial: 'Partially filled', open: 'Open',
  'exit-pending': 'Exit pending', closed: 'Closed', rejected: 'Rejected',
};
// A row's realised P&L, with the derivation used by BOTH the table cell and
// the dashboard totals - so what you read in a row and what the totals add up
// can never disagree.
//
// A CLOSED row sometimes carries an exit price but a BLANK realisedPnl (some
// reconcile paths set the exit without the number). It then printed "-" and,
// worse, silently dropped out of the dashboard net while still counting as a
// trade. The numbers to state it are right there, so state it.
//
// Split rows are deliberately NOT derived: exitPrice is ONE leg's price while
// the position is two legs, so (exit - entry) x qty would be wrong. Those keep
// showing blank rather than a confident lie.
// A BREAKEVEN exit is not a win. Move-to-cost places a MARKET order at the
// trigger, so it lands a few rupees either side of entry and used to scatter
// into won/lost: with 37 of 69 trades at cost, the win rate read 77% when the
// decided trades were 23 won / 9 lost, and it moved every time another
// scratch closed. 'Closed at cost' is the app's own flag (mtmCostDone), so no
// invented tolerance is needed.
function rowOutcomeClass(r, pnl) {
  if (logOutcomeBucket(r) === 'Closed at cost') return 'scratch';
  if (!Number.isFinite(pnl) || pnl === 0) return 'scratch';
  return pnl > 0 ? 'won' : 'lost';
}
// Win rate over EVERY closed trade, scratches included in the denominator:
// "of the trades I took, how many made money". Counting a breakeven as a WIN
// was plainly wrong (it read 77% with 37 of 69 at cost). Excluding scratches
// from the denominator was also wrong here - it still read 77% while only 24
// of 69 trades actually made money. Scratches are a real outcome of a
// move-to-cost strategy, not a non-event, so they count.
function winRateOf(won, lost, scratched) {
  const total = won + lost + (Number(scratched) || 0);
  return total ? Math.round(won / total * 100) : null;
}
// The best CLOSE timestamp. recordedAt is the ENTRY time - using it to order
// the equity curve mixed entry and exit times, so the drawdown was computed
// over a scrambled sequence. Rows with no close stamp are excluded and counted.
function rowCloseTime(r) {
  return r.closedAt || r.testClosedAt || r.exitCorrectedAt || r.reconciledAt || '';
}
// One P&L reader everywhere. byScr and dashWinner used Number(r.realisedPnl),
// and Number('') === 0 IS finite - so a blank-but-derivable row counted as
// Rs.0 in the "By screener" table while the headline derived its real value.
// The table's own total row claimed to reconcile with the headline and could
// not.
function rowPnlValue(r) { const p = rowRealisedPnl(r); return p ? p.value : null; }

function rowRealisedPnl(r) {
  // '' must mean ABSENT, not zero. Number('') === 0 and 0 is finite, so a
  // blank read as a real "Rs.0" - the same coercion trap that made blank rows
  // count as zeroes in the dashboard averages instead of being excluded.
  const raw = r.realisedPnl ?? r.realizedPnl;
  const stored = (raw === '' || raw === null || raw === undefined) ? NaN : Number(raw);
  if (Number.isFinite(stored)) return { value: stored, derived: false };
  if (!r.exitType || r.splitT1) return null;
  if (/REJECT|CANCEL/i.test(String(r.exitType))) return null;   // never a position
  const ep = Number(r.entryPrice ?? r.price), xp = Number(r.exitPrice), q = Number(r.qty);
  if (!Number.isFinite(ep) || !Number.isFinite(xp) || !(xp > 0) || !(q > 0)) return null;
  return { value: Math.round((xp - ep) * q * 100) / 100, derived: true };
}

function logRowState(r) {
  const s = String(r.status || '').toUpperCase();
  const res = String(r.exitType || r.result || '').toUpperCase();
  if (['ERROR', 'SKIPPED', 'N/A'].includes(String(r.orderId || '').toUpperCase())) return 'rejected';
  // EOD EXIT added 2026-08-20 (found by the report.test corpus): the paper
  // EOD close writes exitType 'EOD EXIT' and no other token, so those rows
  // read as OPEN forever - occupying test-mode slots and never bucketing.
  // Mirrored in server isOpenOrderLogEntry; live brokers never write it.
  if (r.manualClose || /TARGET HIT|SL HIT|EXITED|CLOSED|EOD EXIT/.test(s + ' ' + res)) return 'closed';
  if (/REJECT|CANCEL|FAIL|INVALID|SECURITY ID NOT FOUND/.test(s + ' ' + res)) return 'rejected';
  if (r.exitPending || /EXIT PENDING/.test(s)) return 'exit-pending';
  if (r.awaitingFill) return /PARTIALLY FILLED/.test(s) ? 'partial' : 'pending';
  return 'open';
}
function logRowStateLabel(r) { return LOG_STATE_LABELS[logRowState(r)] || 'Open'; }
// A row is "terminal" (safe to delete) when it holds no live broker position.
function logRowTerminal(r) { const st = logRowState(r); return st === 'closed' || st === 'rejected'; }

// ---- Machine-readable close facts (REPORT-PLAN R1/R2, slice 2) -------------
// exitKind is stamped ONCE by the server's close writer at the moment a row
// becomes terminal, using deriveExitKind below - i.e. frozen with today's
// wording rules. From then on the bucket comes from the FACT, so a future
// change to describeLogResult's phrasing can never re-bucket history. The
// text path survives only for rows that closed before the stamp existed.
const EXIT_KIND_BUCKETS = {
  REJECTED: 'Rejected', COST: 'Closed at cost', TRAIL: 'SL hit', SL: 'SL hit',
  T1T2: 'Target hit', TARGET: 'Target hit', MANUAL: 'Closed', EOD: 'Closed', CLOSED: 'Closed',
};
// Derives the kind from the same wording the text bucket reads, so a stamped
// row buckets IDENTICALLY to an unstamped one (report.test.js pins the parity
// over a full corpus). Order mirrors describeLogResult's decision tree.
function deriveExitKind(r) {
  const st = logRowState(r);
  if (st === 'rejected') return 'REJECTED';
  if (st !== 'closed') return '';
  if (r.manualClose) return 'MANUAL';
  const lbl = String(describeLogResult(r) || '').toLowerCase();
  if (lbl.includes('eod')) return 'EOD';
  if (lbl.includes('at cost')) return 'COST';
  if (lbl.includes('trailing')) return 'TRAIL';
  if (lbl.includes('sl')) return 'SL';
  if (lbl.includes('t1 & t2')) return 'T1T2';
  if (lbl.includes('target')) return 'TARGET';
  return 'CLOSED';
}
// Where a row's P&L number comes from RIGHT NOW. Deliberately a reader, not a
// stamp: an estimated exit that a later reconcile corrects to a broker fill
// must start reading 'fill' - a stored source would stay stale ('estimate')
// exactly when the truth improved.
function derivePnlSource(r) {
  const p = rowRealisedPnl(r);
  if (!p) return 'none';
  if (r.exitEstimated && !r.exitCorrectedAt) return 'estimate';
  return p.derived ? 'derived' : 'fill';
}

function logOutcomeBucket(r) {
  const st = logRowState(r);
  if (st === 'rejected') return 'Rejected';
  if (st !== 'closed') return '';
  // FACT FIRST: a stamped kind is the close-time truth, immune to wording
  // changes. (State still wins above: a reopened row with a stale stamp must
  // not bucket at all, and rejected stays Rejected.)
  if (r.exitKind && EXIT_KIND_BUCKETS[r.exitKind]) return EXIT_KIND_BUCKETS[r.exitKind];
  // Plain substring matching on describeLogResult's real wording. No regex
  // escapes here on purpose: an earlier version had a stray control character
  // in a \b boundary and silently bucketed every stop-out as "Closed".
  const lbl = String(describeLogResult(r) || '').toLowerCase();
  if (lbl.includes('at cost')) return 'Closed at cost';
  if (lbl.includes('sl')) return 'SL hit';
  if (lbl.includes('t1 booked') && !lbl.includes('t2 booked')) return 'T1 booked';
  if (lbl.includes('target') || lbl.includes('booked')) return 'Target hit';
  return 'Closed';
}

// Top screener by realised P&L over the chosen period.
function dashWinner(rows) {
  const by = {};
  rows.forEach(r => {
    const k = String(r.screenerName || '').trim();
    if (!k) return;
    const st = logRowState(r);
    by[k] = by[k] || { name: k, taken: 0, rejected: 0, closed: 0, c: 0, wins: 0, losses: 0, pnl: 0, target: 0, sl: 0, other: 0, open: 0 };
    const d = by[k];
    // A REJECTED row never reached the broker — no stock was bought, so it is
    // not a "stock taken". Counting it made the card fail to add up.
    if (st === 'rejected') { d.rejected++; return; }
    d.taken++;
    if (st === 'closed') {
      d.closed++;
      const v = rowPnlValue(r);
      if (v !== null) {
        d.c++; d.pnl += v;                    // c = PRICED closed, the win-rate base
        const cls = rowOutcomeClass(r, v);
        if (cls === 'won') d.wins++; else if (cls === 'lost') d.losses++;
      }
      const b = logOutcomeBucket(r);
      if (b === 'SL hit') d.sl++;
      else if (b === 'Target hit' || b === 'T1 booked') d.target++;
      else d.other++;
    } else {
      d.open++;                       // open, pending, partial, exit-pending
      if (r.splitT1 && r.mtmT1Done) d.pnl += Number(r.splitT1Pnl) || 0;   // banked = realised
    }
  });
  const list = Object.values(by).filter(d => d.c > 0).sort((a, b) => b.pnl - a.pnl);
  return list.length && list[0].pnl > 0 ? list[0] : null;
}

// THE single source for every trading figure (2026-08-13 audit). The Order Log
// analytics band, the Dashboard page and the PDF report all consume this one
// object; none keeps its own copy of any rule. Before this the PDF maintained
// a duplicate of the band's math, held equal only by a comment.
function computeDashReport(rows) {
  const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
  const closed = rows.filter(r => logRowState(r) === 'closed');
  const priced = closed.map(r => ({ r, v: rowPnlValue(r) })).filter(x => x.v !== null);
  const pnls = priced.map(x => x.v);
  const closedNet = pnls.reduce((a, b) => a + b, 0);
  const wins = priced.filter(x => rowOutcomeClass(x.r, x.v) === 'won').map(x => x.v);
  const losses = priced.filter(x => rowOutcomeClass(x.r, x.v) === 'lost').map(x => x.v);
  // BROKER TRUTH (owner decision 2026-08-13):
  //  - an exit-pending row still HOLDS its position (the stop fired, the
  //    SELL is working), so its live P&L belongs in the open aggregates
  //  - banked T1 on an open split is REALISED money (the leg filled). The
  //    server folds it into unrealisedPnl, so it moves to the Realised side
  //    and is subtracted here - counted once, on the side the broker put it.
  const bankedOf = r => (r.splitT1 && r.mtmT1Done) ? (num(r.splitT1Pnl) || 0) : 0;
  const openRows = rows.filter(r => { const s = logRowState(r); return s === 'open' || s === 'exit-pending'; });
  const bankedOpen = openRows.reduce((a, r) => a + bankedOf(r), 0);
  const bankedOpenN = openRows.filter(r => bankedOf(r)).length;
  const unreal = openRows.reduce((a, r) => a + (num(r.unrealisedPnl) || 0), 0) - bankedOpen;
  // "-" must mean NO DATA. Summing (missing || 0) and printing the sum claims
  // a Rs.0 nobody measured - the Running Algos cards already refused to; now
  // every surface shares this flag.
  const hasUnreal = openRows.some(r => {
    const u = r.unrealisedPnl;
    return !(u === '' || u === null || u === undefined) && Number.isFinite(Number(u));
  });
  const estimatedN = closed.filter(r => r.exitEstimated && !r.exitCorrectedAt).length;
  // Feature attribution - ESTIMATES from the row's own recorded levels, and
  // every card says so. "Is this feature paying for itself", not exact rupees.
  let costSaved = 0, costN = 0, trailGained = 0, trailN = 0, t1Profit = 0, t1N = 0, t2Profit = 0, t2N = 0;
  let missingPnl = 0, t1EstN = 0, t2EstN = 0;
  const net = closedNet + bankedOpen;   // realised = closed trades + banked T1 legs
  closed.forEach(r => {
    const qty = num(r.qty) || 0, entry = num(r.entryPrice ?? r.price), sl = num(r.slPrice ?? r.sl);
    const exit = num(r.exitPrice), tgt = num(r.targetPrice ?? r.target);
    // Counts exactly the closed rows the figures above DROPPED (rowPnlValue
    // null). The old predicate checked the STORED field via num(), and
    // Number('') === 0 - so blank-pnl rows were excluded from every total yet
    // never disclosed by the banner (the slice-1 known gap, fixed slice 2).
    if (rowPnlValue(r) === null) missingPnl++;
    // LOSS SAVED - only when the trade actually ENDED at cost; crediting any
    // exit at/above entry also credited target hits and overstated it.
    const slOrig = num(r.slPriceOriginal) ?? sl;
    if (logOutcomeBucket(r) === 'Closed at cost' && qty > 0 && entry && slOrig && slOrig < entry) { costSaved += (entry - slOrig) * qty; costN++; }
    if (r.emaTrailingArmedAt && qty > 0 && exit && tgt && exit > tgt) { trailGained += (exit - tgt) * qty; trailN++; }
    const t1Pct = num(r.t1Pct) || 0, t2Pct = num(r.t2Pct) || 0;
    const t1QtyPct = num(r.t1Qty) || 0;
    const t1Qty = t1QtyPct > 0 ? Math.floor(qty * t1QtyPct / 100) : qty;
    // ACTUALS FIRST: splitT1Pnl is the booked FILL ((fillPx-entry) x legA),
    // and a closed row's own P&L is broker truth. The configured-% estimate
    // survives only for rows that predate recording, counted separately so
    // the card can say how many are estimates.
    const t1Booked = r.mtmT1Done || /T1 book/i.test(String(r.mtmStatus || ''));
    const t1Actual = (r.splitT1 && r.mtmT1Done) ? num(r.splitT1Pnl) : null;
    if (t1Booked && t1Actual !== null) { t1Profit += t1Actual; t1N++; }
    else if (t1Booked && entry && t1Pct > 0 && t1Qty > 0) { t1Profit += entry * (t1Pct / 100) * t1Qty; t1N++; t1EstN++; }
    if (r.mtmT2Done || /T2 exit/i.test(String(r.mtmStatus || ''))) {
      const vRow = rowPnlValue(r);
      if (vRow !== null) { t2Profit += vRow - (t1Actual || 0); t2N++; }   // actual runner P&L
      else if (entry && t2Pct > 0) {
        const rest = Math.max(0, qty - (r.mtmT1Done ? t1Qty : 0));
        if (rest > 0) { t2Profit += entry * (t2Pct / 100) * rest; t2N++; t2EstN++; }
      }
    }
  });
  openRows.forEach(r => { const b = bankedOf(r); if (b) { t1Profit += b; t1N++; } });
  const dated = closed.map(r => ({ t: rowCloseTime(r), v: rowPnlValue(r) }))
    .filter(x => x.t && x.v !== null).sort((a, b) => new Date(a.t) - new Date(b.t));
  const undated = pnls.length - dated.length;
  let run = 0, peak = 0, dd = 0;
  dated.forEach(x => { run += x.v; if (run > peak) peak = run; if (peak - run > dd) dd = peak - run; });
  const buckets = {};
  rows.forEach(r => { const b = logOutcomeBucket(r); if (b) buckets[b] = (buckets[b] || 0) + 1; });
  // per screener, same rules as the on-screen table (rejected rows not "taken")
  const byScr = {};
  let takenTotal = 0;
  rows.forEach(r => {
    const k = String(r.screenerName || 'Unknown');
    const st = logRowState(r);
    const v = rowPnlValue(r);
    byScr[k] = byScr[k] || { name: k, n: 0, w: 0, l: 0, c: 0, pnl: 0 };
    if (st === 'rejected') return;
    byScr[k].n++; takenTotal++;
    if (st === 'closed' && v !== null) {
      byScr[k].c++; byScr[k].pnl += v;
      const cls = rowOutcomeClass(r, v);
      if (cls === 'won') byScr[k].w++; else if (cls === 'lost') byScr[k].l++;
    } else if (st === 'open' || st === 'exit-pending') {
      byScr[k].pnl += bankedOf(r);   // banked T1 reconciles the table with the headline
    }
  });
  const screeners = Object.values(byScr).filter(d => d.n > 0).sort((a, b) => b.pnl - a.pnl);
  return { total: rows.length, closed: pnls.length, net, unreal, hasUnreal, openN: openRows.length,
    bankedOpen, bankedOpenN, t1EstN, t2EstN,
    wins: wins.length, losses: losses.length, flat: pnls.length - wins.length - losses.length,
    wr: winRateOf(wins.length, losses.length, pnls.length - wins.length - losses.length),
    expectancy: pnls.length ? closedNet / pnls.length : null,   // per CLOSED trade, banked excluded
    dd, hasDd: dated.length > 0, undated, estimatedN, missingPnl,
    costSaved, costN, trailGained, trailN, t1Profit, t1N, t2Profit, t2N,
    buckets, screeners, takenTotal, winner: dashWinner(rows) };
}

// Node (tests) only; a plain <script> tag has no module object.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    LOG_STATE_LABELS, logExitIsSl, logExitIsTarget, describeLogResult,
    logRowState, logRowStateLabel, logRowTerminal, logOutcomeBucket,
    rowOutcomeClass, winRateOf, rowCloseTime, rowPnlValue, rowRealisedPnl,
    dashWinner, computeDashReport,
    EXIT_KIND_BUCKETS, deriveExitKind, derivePnlSource,
  };
}
