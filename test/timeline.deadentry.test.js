'use strict';
// test/timeline.deadentry.test.js - the position timeline of a buy that never
// filled (2026-10-15, FLUOROCHEM on Dhan, a No-SL algo).
//
// The row read as four failures: "Entry order - Failed: orphaned protection
// cancelled to avoid a naked short" (our cleanup, stamped at the time we noticed),
// "Protection - Not placed" (the T1 target WAS placed with the buy, then
// cancelled), "Book T1 - Pending" (it never could) and "Exit - Failed REJECTED"
// (there was no exit). Runs the REAL rowLogSteps from index.html.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function fnSource(name) {
  const i = html.indexOf('\nfunction ' + name + '(');
  assert.ok(i >= 0, name + ' is defined in index.html');
  return html.slice(i + 1, html.indexOf('\n}', i + 1) + 2);
}
const ctx = { window: { _algoJobs: [] }, Date, Number, String, Math, Array, Object, JSON, isNaN };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'report.js'), 'utf8'), ctx);
vm.runInContext(fnSource('rowLogSteps'), ctx);
const steps = (r) => ctx.rowLogSteps(r);
const byName = (st) => Object.fromEntries(st.map(s => [s.name, s]));

// The row exactly as the owner pasted it (written by 3.30.x, before the fix).
const FLUOROCHEM = {
  id: 'ord-1791949572854-0595b2', broker: 'dhan', symbol: 'FLUOROCHEM', action: 'BUY', qty: 10, noSl: true,
  entryPrice: 4551, price: 4551, slPrice: 0, targetPrice: 4842, t1Pct: 6.4, t1Qty: 50, t2Pct: 10,
  screenerName: 'RETAILER TRAP', entryCriteria: 'EMA50 within 3% + Big Player Score 65-100 + Price 100-5000 · RSI 51.64 at entry',
  orderId: 'ENTRY:32126101453302 | TGT-T1:32132610141385', dhanEntryOrderId: '32126101453302',
  status: 'DHAN ENTRY DEAD - no position, protection cancelled', exitType: 'REJECTED', dhanProtection: 'forever-cancelled',
  rejectionReason: 'orphaned protection cancelled to avoid a naked short',
  recordedAt: '2026-10-14T03:46:12.000Z', lastStatusCheckAt: '2026-10-14T08:29:22.532Z',
};

test('FLUOROCHEM as pasted: one honest failure - the buy never filled - and nothing pending or "failed" after it', () => {
  const s = steps(FLUOROCHEM);
  const n = byName(s);
  assert.equal(n['Entry order'].state, 'fail');
  assert.match(n['Entry order'].detail, /^Not filled — DHAN closed buy order 32126101453302 \(rejected, cancelled or expired\)\./);
  assert.match(n['Entry order'].detail, /Stockkar has no record of DHAN’s reason for it; DHAN’s order history shows it\./);
  assert.ok(!/orphaned/.test(n['Entry order'].detail), 'our cleanup is not the reason the buy died');
  assert.ok(!/Stockkar saw it/.test(n['Entry order'].detail), 'no engine event on the row as pasted: no guessed time (lastStatusCheckAt is only the latest visit)');
  assert.equal(n['Target orders'].when, '');
  assert.equal(n['Entry order'].when, new Date(FLUOROCHEM.recordedAt).toLocaleString(), 'stamped when the order was PLACED');
  assert.equal(n['Target orders'].state, 'skip');
  assert.match(n['Target orders'].detail, /placed together with the buy .* cancelled when the buy died/);
  assert.ok(!n['Protection'], 'a No-SL row names its target orders, and never claims "not placed"');
  assert.ok(!n['Book T1'] && !n['Book T2'] && !n['Stop to cost'], 'no T1/T2/cost step can follow a buy that never filled');
  assert.deepEqual([n['Exit'].state, n['Exit'].detail], ['skip', 'No position was ever opened, so there was nothing to exit.']);
  assert.ok(!s.some(x => x.state === 'wait'), 'nothing reads Pending');
  assert.equal(s.filter(x => x.state === 'fail').length, 1, 'exactly one failure: the buy');
});

test('"Stockkar saw it at" is the engine\'s ENTRY_DEAD event, never the latest re-visit', () => {
  const r = { ...FLUOROCHEM, events: [
    { at: '2026-10-14T03:47:05.000Z', s: 'TARGETS_ONLY>ENTRY_DEAD', a: ['CANCEL_ORPHAN_PROTECTION:entry-dead'] },
    { at: '2026-10-14T08:29:22.532Z', s: 'ENTRY_DEAD>ENTRY_DEAD', a: ['CANCEL_ORPHAN_PROTECTION:entry-dead-protection-standing'] }] };
  const n = byName(steps(r));
  const seen = new Date('2026-10-14T03:47:05.000Z').toLocaleString();
  assert.ok(n['Entry order'].detail.endsWith(' Stockkar saw it at ' + seen + '.'), n['Entry order'].detail);
  assert.equal(n['Target orders'].when, seen);
});

test('a row written after the fix names the broker\'s verdict and reason', () => {
  const n = byName(steps({ ...FLUOROCHEM, status: 'DHAN ENTRY REJECTED - no position, protection cancelled',
    entryBrokerStatus: 'REJECTED', entryBrokerReason: 'RMS:Margin Exceeds,Cash Available:1000.00,Margin Required:45510.00', entryBrokerAt: '2026-10-14 09:16:13' }));
  assert.match(n['Entry order'].detail, /^Not filled — DHAN rejected buy order 32126101453302: RMS:Margin Exceeds,Cash Available:1000\.00,Margin Required:45510\.00 \(/);
  assert.ok(!/no record of/.test(n['Entry order'].detail));
});

test('the older engine close ("entry rejected/cancelled/expired") is read as unknown, not as "rejected"', () => {
  const n = byName(steps({ id: 'y', broker: 'dhan', symbol: 'WIPRO', qty: 10, entryPrice: 250, slPrice: 240, targetPrice: 270,
    orderId: 'ENTRY:E77', dhanEntryOrderId: 'E77', exitType: 'REJECTED', result: 'REJECTED',
    status: 'REJECTED (entry rejected/cancelled/expired — no position, nothing at the broker) [engine]',
    recordedAt: '2026-10-14T04:00:00Z', lastStatusCheckAt: '2026-10-14T04:05:00Z' }));
  assert.match(n['Entry order'].detail, /^Not filled — DHAN closed buy order E77 \(rejected, cancelled or expired\)\. Stockkar has no record of DHAN’s reason/);
  assert.equal(n['Protection'].detail, 'Not placed — the entry never filled, so there was no position to protect.', 'protect-after-fill placed nothing');
});

test('a placement refusal (no order id at all) keeps showing the broker\'s refusal as before', () => {
  const n = byName(steps({ id: 'x', broker: 'dhan', symbol: 'ABC', qty: 5, entryPrice: 100, slPrice: 95, targetPrice: 110,
    orderId: 'ERROR', status: 'FAILED', exitType: 'REJECTED', rejectionReason: 'Dhan entry order failed: Invalid quantity', recordedAt: '2026-10-14T04:00:00Z' }));
  assert.equal(n['Entry order'].detail, 'Dhan entry order failed: Invalid quantity');
  assert.equal(n['Protection'].detail, 'Not placed — the entry never filled, so there was no position to protect.');
  assert.equal(n['Exit'].state, 'skip');
});
