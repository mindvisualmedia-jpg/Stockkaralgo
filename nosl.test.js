'use strict';
// No-SL (target-only) rows: leg planning + the reconcile planner.
//
// Verbatim copies of server.js noSlTargetLegs and planNoSlRow. If these drift
// from server.js, update both.
//
// THE INCIDENT (2026-07-29): a No-SL algo with T1 & T2 set showed "SUPER ORDER"
// in the log while the broker had NOTHING - the two Forever target legs had
// failed silently (warnings dropped), the row got orderId 'N/A' (treated as
// DEAD by isOpenOrderLogEntry), and no reconcile watched No-SL rows at all, so
// nothing ever re-placed the legs. planNoSlRow is that missing watcher's brain.

const { test } = require('node:test');
const assert = require('node:assert');

function roundPrice(v) { return Math.round(Number(v) * 20) / 20; }

// ---- verbatim copy of server.js noSlTargetLegs ----
function noSlTargetLegs(order) {
  const entry = Number(order.entryPrice || 0);
  const qty = Math.floor(Number(order.qty || 0));
  if (!entry || qty <= 0) return [];
  const t1Pct = Number(order.t1Pct || 0), t2Pct = Number(order.t2Pct || 0), t1QtyPct = Number(order.t1Qty || 0);
  const t1Price = roundPrice(entry * (1 + t1Pct / 100));
  const t2Price = roundPrice(entry * (1 + t2Pct / 100));
  const t1BookQty = Math.floor(qty * t1QtyPct / 100);
  const t1Full = t1Pct > 0 && t1BookQty >= qty;
  const hasT1 = t1Pct > 0 && t1BookQty >= 1 && t1BookQty < qty;
  const hasT2 = t2Pct > 0;
  if (t1Full) return [{ qty, price: t1Price, tag: 'T1' }];
  if (hasT1 && hasT2) return [{ qty: t1BookQty, price: t1Price, tag: 'T1' }, { qty: qty - t1BookQty, price: t2Price, tag: 'T2' }];
  if (hasT2) return [{ qty, price: t2Price, tag: 'T2' }];
  if (hasT1) return [{ qty, price: t1Price, tag: 'T1' }];
  return [];
}

// ---- verbatim copy of server.js planNoSlRow ----
function planNoSlRow(row, ctx) {
  const legs = noSlTargetLegs(row);
  const qty = Math.floor(Number(row.qty || 0));
  const out = { cancelIds: [], place: [] };
  const soldQ = Number(ctx.sold?.q || 0), soldPx = Number(ctx.sold?.px || 0);
  if (qty > 0 && soldQ >= qty * 0.99) { out.close = { exitPrice: soldPx, soldQty: soldQ }; return out; }
  const t1 = legs.find(l => l.tag === 'T1'), t2 = legs.find(l => l.tag === 'T2');
  if (t1 && t2 && !row.mtmT1Done && soldQ >= t1.qty * 0.99) out.bookT1 = { qty: t1.qty };
  const ids = { T1: String(row.dhanTargetT1Id || ''), T2: String(row.dhanTargetT2Id || '') };
  const live = (tag) => !!ids[tag] && ctx.liveIds.has(ids[tag]);
  if (!ctx.held) {
    const st = String(ctx.entryStatus || '').toUpperCase();
    const dead = /REJECT|CANCEL|EXPIRE/.test(st) || (!st && !ctx.isToday);
    if (soldQ === 0 && dead) {
      out.reject = true;
      ['T1', 'T2'].forEach(tag => { if (live(tag)) out.cancelIds.push(ids[tag]); });
    }
    return out;
  }
  const t1Done = !!(row.mtmT1Done || out.bookT1 || (t1 && t2 && soldQ >= t1.qty * 0.99));
  legs.forEach(l => {
    if (l.tag === 'T1' && t1Done) return;
    if (!live(l.tag)) out.place.push(l);
  });
  return out;
}

// A typical No-SL row: 21 shares, entry 100, T1 +3% on 50% qty, T2 +6%.
const row = (over = {}) => ({ qty: 21, entryPrice: 100, t1Pct: 3, t1Qty: 50, t2Pct: 6,
  dhanTargetT1Id: '', dhanTargetT2Id: '', ...over });
const ctx = (over = {}) => ({ held: true, liveIds: new Set(), sold: { q: 0, px: 0 }, entryStatus: 'TRADED', isToday: true, ...over });

// ── leg planning ────────────────────────────────────────────────────────────

test('T1 & T2 configured -> TWO legs (this is what the user selected)', () => {
  const legs = noSlTargetLegs(row());
  assert.deepEqual(legs.map(l => l.tag), ['T1', 'T2']);
  assert.deepEqual(legs.map(l => l.qty), [10, 11]);        // 50% of 21 -> 10 + 11
  assert.deepEqual(legs.map(l => l.price), [103, 106]);
});

test('T1 at 100% qty -> single full-qty leg; T2-only -> single T2 leg', () => {
  assert.deepEqual(noSlTargetLegs(row({ t1Qty: 100 })).map(l => l.tag), ['T1']);
  assert.deepEqual(noSlTargetLegs(row({ t1Pct: 0, t1Qty: 0 })).map(l => l.tag), ['T2']);
});

// ── THE INCIDENT: broker empty, position held -> re-place BOTH legs ─────────

test('THE INCIDENT: no ids, nothing live, held -> auto-restore places both legs', () => {
  const p = planNoSlRow(row(), ctx());
  assert.deepEqual(p.place.map(l => l.tag), ['T1', 'T2']);
  assert.ok(!p.close && !p.reject);
});

test('one leg live, one missing -> only the missing leg is re-placed', () => {
  const p = planNoSlRow(row({ dhanTargetT1Id: 'F1' }), ctx({ liveIds: new Set(['F1']) }));
  assert.deepEqual(p.place.map(l => l.tag), ['T2']);
});

test('both legs live -> nothing to do', () => {
  const p = planNoSlRow(row({ dhanTargetT1Id: 'F1', dhanTargetT2Id: 'F2' }), ctx({ liveIds: new Set(['F1', 'F2']) }));
  assert.equal(p.place.length, 0);
  assert.ok(!p.close && !p.reject && !p.bookT1);
});

// ── safety: never place a SELL trigger on nothing held ──────────────────────

test('NOT held (entry still pending today) -> never place, never reject', () => {
  const p = planNoSlRow(row(), ctx({ held: false, entryStatus: 'PENDING' }));
  assert.equal(p.place.length, 0);
  assert.ok(!p.reject);
});

test('entry dead + not held + nothing sold -> reject AND cancel live orphan legs', () => {
  const p = planNoSlRow(row({ dhanTargetT1Id: 'F1', dhanTargetT2Id: 'F2' }),
    ctx({ held: false, entryStatus: 'REJECTED', liveIds: new Set(['F1', 'F2']) }));
  assert.equal(p.reject, true);
  assert.deepEqual(p.cancelIds, ['F1', 'F2']);
  assert.equal(p.place.length, 0);
});

test('entry vanished across the day boundary + not held -> reject (day-order died)', () => {
  const p = planNoSlRow(row(), ctx({ held: false, entryStatus: '', isToday: false }));
  assert.equal(p.reject, true);
});

// ── exits from broker fills ─────────────────────────────────────────────────

test('fills cover the position -> close at the weighted price', () => {
  const p = planNoSlRow(row(), ctx({ sold: { q: 21, px: 104.57 } }));
  assert.deepEqual(p.close, { exitPrice: 104.57, soldQty: 21 });
});

test('T1 qty sold, T2 running -> book T1; T1 leg is NOT re-placed, missing T2 is', () => {
  const p = planNoSlRow(row(), ctx({ sold: { q: 10, px: 103 } }));
  assert.deepEqual(p.bookT1, { qty: 10 });
  assert.deepEqual(p.place.map(l => l.tag), ['T2']);
});

test('mtmT1Done already set -> T1 leg never re-placed', () => {
  const p = planNoSlRow(row({ mtmT1Done: true }), ctx());
  assert.deepEqual(p.place.map(l => l.tag), ['T2']);
});

// ── Finding #14 damage repair: pre-fix rows (orderId N/A, no noSl flag) ─────
// verbatim copy of server.js isDamagedNoSlRow
function isDamagedNoSlRow(r, jobsById) {
  if (String(r.broker || 'dhan').toLowerCase() !== 'dhan') return false;
  if (r.testMode || r.source === 'test' || r.noSl) return false;
  if (String(r.orderId || '').toUpperCase() !== 'N/A') return false;
  if (r.exitType || r.result) return false;
  if (/not enabled|turned off/i.test(String(r.status || ''))) return false;
  const job = jobsById[String(r.jobId || '')];
  return !!(job && String(job.config && job.config.slMethod) === 'none');
}
const JOBS = { 'job-nosl': { config: { slMethod: 'none' } }, 'job-sl': { config: { slMethod: 'pct' } } };
const damaged = (over = {}) => ({ broker: 'dhan', orderId: 'N/A', jobId: 'job-nosl', status: 'SUPER ORDER', qty: 21, ...over });

test("THE USER'S ROWS: yesterday's N/A rows from a No-SL job are recovered", () => {
  assert.equal(isDamagedNoSlRow(damaged(), JOBS), true);
});

test('repair is evidence-based: an N/A row from a NORMAL-SL job is never touched', () => {
  assert.equal(isDamagedNoSlRow(damaged({ jobId: 'job-sl' }), JOBS), false);
  assert.equal(isDamagedNoSlRow(damaged({ jobId: 'deleted-job' }), JOBS), false, 'unknown job -> cannot prove -> leave alone');
});

test('gate-blocked rows ("not enabled") never placed anything -> left alone', () => {
  assert.equal(isDamagedNoSlRow(damaged({ status: 'No-SL live orders are not enabled yet. ...' }), JOBS), false);
  assert.equal(isDamagedNoSlRow(damaged({ status: 'No-SL live orders are turned off. ...' }), JOBS), false);
});

test('already-exited, test-mode, and already-repaired rows are skipped', () => {
  assert.equal(isDamagedNoSlRow(damaged({ exitType: 'TARGET HIT' }), JOBS), false);
  assert.equal(isDamagedNoSlRow(damaged({ testMode: true }), JOBS), false);
  assert.equal(isDamagedNoSlRow(damaged({ noSl: true }), JOBS), false);
  assert.equal(isDamagedNoSlRow(damaged({ orderId: 'ENTRY:123' }), JOBS), false, 'a row with real ids is not damaged');
});
