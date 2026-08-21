'use strict';
// ledgerclose.test.js — the EOD ledger close + rollup capture (REPORT-PLAN
// R4/R5, slice 4) against the REAL server functions on a temp data dir. The
// broker is injected via opts.snapshots (the same shape adapterSnapshotFor
// returns), so no transport is involved at all.
const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-ledger-'));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
process.env.STOCKKAR_DATA_DIR = dataDir;
process.env.STOCKKAR_TEST_INTERNALS = '1';
process.env.STOCKKAR_TELEGRAM_DISABLED = '1';

let S;
before(() => { S = require('./server.js')._internals; });

const nowIso = new Date().toISOString();
const closedRow = (id, sym, pnl, extra) => ({ id, broker: 'dhan', jobId: 'j1', screenerName: 'Alpha',
  symbol: sym, action: 'BUY', qty: 10, entryPrice: 100, price: 100, orderId: 'E' + id,
  exitType: 'SL HIT', exitPrice: 100 + pnl / 10, realisedPnl: pnl, closedAt: nowIso,
  recordedAt: nowIso, time: new Date().toLocaleString(), ...extra });

test('ledger close: a wrong P&L is flagged with the broker delta; clean and ambiguous rows are not', (t, done) => {
  S.writeOrderLog([
    closedRow('ok1', 'INFY', -50),                              // fills agree
    closedRow('bad1', 'TCS', -20),                              // fills say -50
    closedRow('est1', 'WIPRO', 25, { exitEstimated: true }),    // no fills: unverifiable
  ]);
  const snapshots = { dhan: { sells: {
    INFY: [{ qty: 10, px: 95 }],
    TCS: [{ qty: 10, px: 95 }],
  } } };
  S.runDailyLedgerClose({ force: true, snapshots }, (err, out) => {
    try {
      assert.ifError(err);
      const res = out.brokers.dhan;
      assert.equal(res.checked, 2);
      assert.equal(res.mismatches.length, 1);
      assert.equal(res.mismatches[0].symbol, 'TCS');
      const rows = S.readOrderLog();
      const bad = rows.find(r => r.id === 'bad1');
      assert.equal(bad.pnlMismatch.delta, 30, 'log claims Rs.30 more than the broker paid');
      assert.equal(bad.pnlMismatch.brokerPnl, -50);
      assert.ok(!rows.find(r => r.id === 'ok1').pnlMismatch, 'a clean row carries no flag');
      assert.ok(!rows.find(r => r.id === 'est1').pnlMismatch, 'unverifiable is disclosure, not accusation');
      done();
    } catch (e) { done(e); }
  });
});

test('a corrected row loses its flag on the next close', (t, done) => {
  S.updateOrderLogRow('bad1', r => ({ ...r, realisedPnl: -50, exitPrice: 95 }));   // reconcile fixed it
  const snapshots = { dhan: { sells: { INFY: [{ qty: 10, px: 95 }], TCS: [{ qty: 10, px: 95 }] } } };
  S.runDailyLedgerClose({ force: true, snapshots }, (err, out) => {
    try {
      assert.ifError(err);
      assert.equal(out.brokers.dhan.mismatches.length, 0);
      assert.ok(!S.readOrderLog().find(r => r.id === 'bad1').pnlMismatch, 're-verified clean -> flag cleared');
      done();
    } catch (e) { done(e); }
  });
});

test('rollups: captured on every close, and a day whose rows are DELETED keeps its last capture', () => {
  const store = S.readDailyRollups();
  const today = Object.keys(store).sort().pop();
  assert.ok(today, 'today was captured');
  const g = store[today].algos.find(a => a.key === 'job:j1');
  assert.equal(g.taken, 3);
  assert.equal(g.pnl, -75, '-50 -50 +25 as corrected');
  // every terminal row of the day is deleted (prune/user delete) -> the
  // rollup entry survives untouched: history stops shrinking (R5)
  S.writeOrderLog([]);
  const after = S.writeDailyRollups();
  assert.deepEqual(after[today], store[today], 'no rows for the day -> last capture is immutable');
});

test("Dhan 7-day sells: yesterday's fills never answer for today's rows", (t, done) => {
  // The Dhan snapshot deliberately spans 7 days (flip gate #16) so gap-day
  // closes stay broker-true - but the ledger compares closed-TODAY rows, so
  // an unfiltered multi-day fill list made the qty match fail as
  // 'unverifiable' whenever a symbol also traded earlier in the week.
  S.writeOrderLog([closedRow('d1', 'HDFC', -50)]);
  const snapshots = { dhan: { sells: { HDFC: [
    { qty: 10, px: 95, at: Date.now() },                 // today's real exit
    { qty: 10, px: 90, at: Date.now() - 86400000 },      // an earlier day's unrelated exit
  ] } } };
  S.runDailyLedgerClose({ force: true, snapshots }, (err, out) => {
    try {
      assert.ifError(err);
      const res = out.brokers.dhan;
      assert.equal(res.checked, 1, 'qty matched on TODAY-only fills - the stale fill was filtered');
      assert.equal(res.mismatches.length, 0);
      done();
    } catch (e) { done(e); }
  });
});
