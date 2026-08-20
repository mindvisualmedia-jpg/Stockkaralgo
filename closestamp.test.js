'use strict';
// closestamp.test.js — the ONE close writer at the write choke point
// (REPORT-PLAN R1, slice 2). Every order-log mutation funnels through
// writeOrderLog, so these tests drive the REAL server functions against a
// temp data dir and pin the stamping contract:
//   - a row closing during the process's lifetime gets exitKind + closedAt
//   - the seeding FIRST write backfills exitKind but NEVER invents closedAt
//     (a fake close time would corrupt the equity curve and retention aging)
//   - an existing exitKind is never overwritten
//   - a reopened row (T1-hit reopen paths) loses both stamps
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-stamp-'));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
process.env.STOCKKAR_DATA_DIR = dataDir;
process.env.STOCKKAR_TEST_INTERNALS = '1';
process.env.STOCKKAR_TELEGRAM_DISABLED = '1';

let S;
before(() => { S = require('./server.js')._internals; });

const row = (id, extra) => ({ id, broker: 'dhan', symbol: 'INFY', action: 'BUY', qty: 10,
  entryPrice: 100, price: 100, slPrice: 95, targetPrice: 110, orderId: 'E' + id,
  recordedAt: new Date().toISOString(), time: new Date().toLocaleString(), ...extra });

test('seeding first write: pre-existing closed rows get exitKind, NEVER a fake closedAt', () => {
  S.writeOrderLog([
    row('old1', { status: 'DHAN FOREVER SL HIT', exitType: 'SL HIT', exitPrice: 95, realisedPnl: -50 }),
    row('old2', { status: 'REJECTED (entry rejected)', exitType: 'REJECTED', orderId: 'N/A' }),
    row('live1', { status: 'DHAN ENTRY + FOREVER OCO' }),
  ]);
  const rows = S.readOrderLog();
  const old1 = rows.find(r => r.id === 'old1'), old2 = rows.find(r => r.id === 'old2');
  assert.equal(old1.exitKind, 'SL', 'historical close backfilled with its kind');
  assert.equal(old1.closedAt, undefined, 'no invented close time on a pre-existing row');
  assert.equal(old2.exitKind, 'REJECTED');
  assert.equal(old2.closedAt, undefined, 'rejected rows never get closedAt - they were never positions');
  assert.equal(rows.find(r => r.id === 'live1').exitKind, undefined, 'open rows are untouched');
});

test('a row that CLOSES during the process gets exitKind AND closedAt stamped once', () => {
  const t0 = new Date().toISOString();
  S.updateOrderLogRow('live1', r => ({ ...r, status: 'DHAN FOREVER TARGET HIT', exitType: 'TARGET HIT', exitPrice: 110, realisedPnl: 100 }));
  const r = S.readOrderLog().find(x => x.id === 'live1');
  assert.equal(r.exitKind, 'TARGET');
  assert.ok(r.closedAt && r.closedAt >= t0, 'closedAt stamped at the close write');
  // later writes never re-stamp: the close moment is recorded once
  const firstAt = r.closedAt;
  S.updateOrderLogRow('live1', x => ({ ...x, lastStatusCheckAt: new Date().toISOString() }));
  const r2 = S.readOrderLog().find(x => x.id === 'live1');
  assert.equal(r2.closedAt, firstAt);
  assert.equal(r2.exitKind, 'TARGET');
});

test('an existing exitKind is NEVER overwritten - close-time truth beats later wording', () => {
  // A cost-flag lands AFTER the close (late reconcile): the text path would
  // now say "Closed at cost", but the stamp keeps what was true at close.
  S.updateOrderLogRow('old1', r => ({ ...r, mtmCostDone: true }));
  assert.equal(S.readOrderLog().find(r => r.id === 'old1').exitKind, 'SL');
});

test('a REOPENED row loses both stamps; its eventual re-close stamps fresh', () => {
  S.mutateOrderLog(rows => [...rows,
    row('re1', { status: 'DHAN FOREVER TARGET HIT', exitType: 'TARGET HIT', exitPrice: 110, realisedPnl: 100, splitT1: true, mtmT1Done: true })]);
  let r = S.readOrderLog().find(x => x.id === 're1');
  assert.equal(r.exitKind, 'T1T2');
  assert.ok(r.closedAt, 'closed after seeding -> dated');
  // the T1-hit reopen shape: exitType cleared, position lives again
  S.updateOrderLogRow('re1', x => ({ ...x, exitType: undefined, result: undefined, exitPrice: undefined,
    realisedPnl: undefined, reopenedAt: new Date().toISOString(), status: 'DHAN FOREVER — T1 HIT, T2 RUNNING (reopened)' }));
  r = S.readOrderLog().find(x => x.id === 're1');
  assert.equal(r.exitKind, undefined, 'stale kind cleared - this trade has not ended');
  assert.equal(r.closedAt, undefined, 'stale close time cleared with it');
  // the runner finally stops at cost -> a FRESH stamp with the new truth
  S.updateOrderLogRow('re1', x => ({ ...x, exitType: 'SL HIT', exitPrice: 100, realisedPnl: 120, mtmCostDone: true }));
  r = S.readOrderLog().find(x => x.id === 're1');
  assert.equal(r.exitKind, 'COST', 'runner SL after cost-move: T1 booked, T2 SL hit at cost');
  assert.ok(r.closedAt);
});

test('paper/test log rows get kinds too, but testClosedAt already dates them - no double stamp', () => {
  S.writeTestOrderLog([row('t1', { testMode: true, status: 'TARGET HIT', exitType: 'TARGET HIT',
    exitPrice: 110, realisedPnl: 100, testClosedAt: '2026-08-19T10:00:00.000Z' })]);
  S.writeTestOrderLog(S.readTestOrderLog().map(r => ({ ...r, lastStatusCheckAt: new Date().toISOString() })));
  const r = S.readTestOrderLog().find(x => x.id === 't1');
  assert.equal(r.exitKind, 'TARGET');
  assert.equal(r.closedAt, undefined, 'testClosedAt is the date; closedAt not invented beside it');
});
