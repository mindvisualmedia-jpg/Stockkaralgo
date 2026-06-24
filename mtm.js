'use strict';

// MTM (mark-to-market) rule engine for managed exits.
//
// Pure, broker-agnostic decision logic so it can be unit-tested without any
// network or broker state. The live monitor (server.js) feeds it an order-log
// entry plus the latest traded price and executes the returned actions.
//
// Rules (BUY positions), using the user's worked example
//   entry 100, initial SL 97  ->  risk = entry - initialSl = 3
//   "Move SL to Cost at %" costPct=3  -> when LTP >= 100 * (1+3/100)=103, set SL=100 (cost/entry)
//   "Target 1 R:R" t1RR=2, "Book % at T1" t1Qty=50 -> T1 = 100 + 2*3 = 106, sell 50% there
//   "Target 2 R:R" t2RR=3 -> T2 = 100 + 3*3 = 109, sell the remaining qty
//
// Each decision is guarded by a "done" flag persisted on the entry so it fires
// at most once. The caller is responsible for writing the returned `patch`
// (which includes the flags) back to the order log after the action succeeds.

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v) {
  return Math.round((Number(v) + Number.EPSILON) * 100) / 100;
}

// Compute the static plan (trigger prices and booked quantities) for an entry.
// Returned values are independent of LTP, so the UI/Order Log can show them.
function computeMtmPlan(entry) {
  const entryPrice = num(entry.entryPrice ?? entry.price);
  const initialSl = num(entry.slPrice);
  const qty = num(entry.qty);
  const costPct = num(entry.costPct);
  // Targets are now entered as a % above entry. t1RR/t2RR are kept only as a
  // fallback so algos saved before the %-switch keep computing the same prices.
  const t1Pct = num(entry.t1Pct);
  const t2Pct = num(entry.t2Pct);
  const t1RR = num(entry.t1RR);
  const t1Qty = num(entry.t1Qty); // percent of position to book at T1
  const t2RR = num(entry.t2RR);

  const risk = round2(entryPrice - initialSl); // per-share initial risk (BUY)
  const t1Price = t1Pct > 0
    ? round2(entryPrice * (1 + t1Pct / 100))
    : (t1RR > 0 && risk > 0 ? round2(entryPrice + t1RR * risk) : 0);
  const t2Price = t2Pct > 0
    ? round2(entryPrice * (1 + t2Pct / 100))
    : (t2RR > 0 && risk > 0 ? round2(entryPrice + t2RR * risk) : 0);
  const plan = {
    entryPrice,
    initialSl,
    qty,
    risk,
    costPct,
    costTriggerPrice: costPct > 0 ? round2(entryPrice * (1 + costPct / 100)) : 0,
    costSlPrice: entryPrice, // "cost" == entry price
    t1Pct,
    t1RR,
    t1Qty,
    t1Price,
    t1BookQty: 0,
    t2Pct,
    t2RR,
    t2Price,
  };

  // Whole shares only. floor so we never try to sell more than we hold.
  if (plan.t1Price > 0 && t1Qty > 0 && qty > 0) {
    plan.t1BookQty = Math.floor((qty * t1Qty) / 100);
  }
  return plan;
}

// Decide what (if anything) to do this tick given the latest traded price.
// Returns { actions: [...], patch: {...}, plan } where actions is an ordered
// list the caller executes. `patch` carries the updated done-flags and any
// derived fields to persist. An empty actions array means "hold".
function computeMtmActions(entry, ltp, opts) {
  opts = opts || {};
  const plan = computeMtmPlan(entry);
  const price = num(ltp);
  const actions = [];
  const patch = {};

  // Validity guards: BUY only, sane prices.
  const isBuy = String(entry.action || 'BUY').toUpperCase() === 'BUY';
  if (!isBuy || plan.entryPrice <= 0 || plan.risk <= 0 || price <= 0) {
    return { actions, patch, plan };
  }

  const costDone = !!entry.mtmCostDone;
  const t1Done = !!entry.mtmT1Done;
  const t2Done = !!entry.mtmT2Done;

  // Remaining open quantity (after any earlier T1 partial book).
  const remainingQty = entry.mtmRemainingQty != null
    ? num(entry.mtmRemainingQty)
    : plan.qty;

  if (t2Done || remainingQty <= 0) {
    return { actions, patch, plan };
  }

  // ---- T2: exit everything remaining. Highest priority once reached. ----
  if (plan.t2Price > 0 && price >= plan.t2Price) {
    actions.push({ type: 'BOOK_T2', qty: remainingQty, price: plan.t2Price, reason: 'T2 hit' });
    patch.mtmT2Done = true;
    patch.mtmRemainingQty = 0;
    if (!costDone) patch.mtmCostDone = true; // SL is moot after full exit
    return { actions, patch, plan };
  }

  // ---- T1: book the configured percentage, then ensure SL sits at cost. ----
  if (!t1Done && plan.t1Price > 0 && plan.t1Qty > 0 && price >= plan.t1Price) {
    if (plan.t1BookQty >= 1 && plan.t1BookQty < remainingQty) {
      actions.push({ type: 'BOOK_T1', qty: plan.t1BookQty, price: plan.t1Price, reason: 'T1 hit' });
      patch.mtmT1Done = true;
      patch.mtmRemainingQty = remainingQty - plan.t1BookQty;
      // Re-protect the remainder at cost (entry) and let it run to T2.
      if (!costDone) {
        actions.push({ type: 'MOVE_SL_TO_COST', newSl: plan.costSlPrice, reason: 'T1 -> SL to cost' });
        patch.mtmCostDone = true;
      }
      return { actions, patch, plan };
    }
    // Cannot split (e.g. qty 1, or rounds to 0): note it and fall through so
    // move-to-cost / T2 still manage the position. T1 stays "not done" so a
    // later larger position would still book; here we just record the skip.
    patch.mtmT1Skipped = true;
    patch.mtmT1SkipReason = plan.t1BookQty < 1
      ? 'T1 partial book skipped: qty too small to split'
      : 'T1 partial book skipped: would exceed remaining qty';
  }

  // ---- Move SL to Cost (standalone trigger, if not already done via T1). ----
  if (!costDone && plan.costPct > 0 && price >= plan.costTriggerPrice) {
    actions.push({ type: 'MOVE_SL_TO_COST', newSl: plan.costSlPrice, reason: 'Cost trigger hit' });
    patch.mtmCostDone = true;
  }

  return { actions, patch, plan };
}

// True if the entry has any MTM rule configured (cheap filter for the monitor).
function hasMtmRules(entry) {
  return num(entry.costPct) > 0 || num(entry.t1Pct) > 0 || num(entry.t2Pct) > 0 || num(entry.t1RR) > 0 || num(entry.t2RR) > 0;
}

// Translate a BOOK_T1 / BOOK_T2 action into the ordered list of broker calls
// needed to execute it while keeping the remainder protected. Pure and
// broker-specific so the sequence can be unit-tested without any live I/O.
//
// The monitor sets the broker target = T2 at entry, so a gap straight to T2 is
// handled broker-side (BOOK_T2 before T1 is "delegate"). After T1:
//   - Dhan: super order is gone; remainder sits on a plain SL-M -> software exits at T2.
//   - Zerodha: GTT was reshaped to (remainder, SL=cost, target=T2) -> broker OCO owns T2.
//
// Op vocabulary (executed by server.js): cancelDhanSuper, dhanSell, dhanSlm,
// cancelDhanOrder, zerodhaSell, zerodhaGttRemainder, delegateBrokerTarget.
function planExitOps(broker, action, entry, plan) {
  broker = String(broker || 'dhan').toLowerCase();
  const t1Done = !!entry.mtmT1Done;
  const costSl = plan.costSlPrice;          // == entry price
  const t2 = plan.t2Price;

  if (action.type === 'BOOK_T1') {
    const bookQty = action.qty;
    const remaining = (entry.mtmRemainingQty != null ? num(entry.mtmRemainingQty) : plan.qty) - bookQty;
    if (broker === 'dhan') {
      // Protect the remainder (Forever Order SL at cost - persists overnight for
      // positional holds) BEFORE booking, so a failure after the cancel can't
      // leave the whole position naked. A Forever-protected hold cancels its
      // Forever OCO (not a Super Order); after that both paths are identical.
      const foreverId = entry.dhanForeverId || (String(entry.orderId || '').match(/FOREVER:([^|\s]+)/i) || [])[1] || '';
      const cancelOp = entry.dhanProtection === 'forever'
        ? { op: 'cancelDhanForever', orderId: foreverId }
        : { op: 'cancelDhanSuper', orderId: entry.orderId };
      return [
        cancelOp,
        { op: 'dhanForeverSl', qty: remaining, trigger: costSl },
        { op: 'dhanSell', qty: bookQty },
      ];
    }
    if (broker === 'zerodha') {
      return [
        { op: 'zerodhaSell', qty: bookQty },
        { op: 'zerodhaGttRemainder', qty: remaining, sl: costSl, target: t2 },
      ];
    }
    if (broker === 'angelone') {
      // Angel has no broker target leg; software owns targets. Book partial,
      // then shrink the SL GTT rule to the remainder at cost.
      return [
        { op: 'angelSell', qty: bookQty },
        { op: 'angelGttRemainder', qty: remaining, sl: costSl },
      ];
    }
    return [];
  }

  if (action.type === 'BOOK_T2') {
    // Angel One has no broker target leg, so software always exits the remainder
    // (selling and cancelling its SL GTT) whether or not T1 fired.
    if (broker === 'angelone') return [{ op: 'angelExit', qty: action.qty }];

    // Before T1 the broker target leg (== T2) owns the exit; don't double-sell.
    if (!t1Done) return [{ op: 'delegateBrokerTarget' }];
    if (broker === 'dhan') {
      return [
        { op: 'cancelDhanForever', orderId: entry.mtmRemainderSlOrderId },
        { op: 'dhanSell', qty: action.qty },
      ];
    }
    if (broker === 'zerodha') {
      // Remainder GTT (SL=cost, target=T2) already exits broker-side.
      return [{ op: 'delegateBrokerTarget' }];
    }
    return [];
  }

  return [];
}

module.exports = { computeMtmPlan, computeMtmActions, hasMtmRules, planExitOps };
