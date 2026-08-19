'use strict';
// test/orderlog.concurrency.test.js - the ORDER-LOG WRITER CONTRACT.
// Every mutation must be a synchronous read->transform->write (no async gap),
// so two writers can interleave without either losing the other's fields.
// Node is single-threaded: a synchronous RMW cannot be interrupted; a whole-log
// snapshot carried across an await/callback CAN (2026-08-19 trace found three).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-conc-'));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
Object.assign(process.env, { STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1', STOCKKAR_ENGINE: '0', STOCKKAR_TELEGRAM_DISABLED: '1' });
const S = require('../server.js')._internals;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

test('two writers interleaving on different rows: NEITHER loses a field (per-row atomic RMW)', async () => {
  S.writeOrderLog([{ id: 'A', symbol: 'AAA', broker: 'dhan', qty: 1, status: 'open' }, { id: 'B', symbol: 'BBB', broker: 'dhan', qty: 1, status: 'open' }]);
  // writer 1: a slow "pass" that reads, waits on a fake broker, then patches row A
  const w1 = (async () => { await wait(50); S.updateOrderLogRow('A', r => ({ ...r, slPrice: 100 })); })();
  // writer 2 (the engine): patches row B in the middle of writer 1's wait
  await wait(10); S.updateOrderLogRow('B', r => ({ ...r, engineState: 'PROTECTED', slPrice: 200 }));
  await w1;
  const log = S.readOrderLog();
  assert.equal(log.find(r => r.id === 'A').slPrice, 100);
  assert.equal(log.find(r => r.id === 'B').slPrice, 200, 'the engine write on B survived writer 1');
  assert.equal(log.find(r => r.id === 'B').engineState, 'PROTECTED');
});

test('the CLOBBER pattern is demonstrably wrong (documents why the three writers were converted)', async () => {
  S.writeOrderLog([{ id: 'A', symbol: 'AAA', qty: 1 }, { id: 'B', symbol: 'BBB', qty: 1 }]);
  // the old shape: snapshot first, write the snapshot back later
  const snapshot = S.readOrderLog();
  await wait(10);
  S.updateOrderLogRow('B', r => ({ ...r, engineState: 'PROTECTED' }));   // engine writes meanwhile
  S.writeOrderLog(snapshot.map(r => r.id === 'A' ? { ...r, slPrice: 100 } : r));   // stale snapshot pushed back
  assert.equal(S.readOrderLog().find(r => r.id === 'B').engineState, undefined, 'engine write on B was CLOBBERED - this is the bug the trace removed');
});

test('CONTRACT: no function in server.js carries a whole-log snapshot into an updateEntry/write helper', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // the exact shape the trace found: a `let nextRows = read...()` captured by a later writer
  assert.ok(!/let nextRows = read(Order|Test)?Log\(\)|let nextRows = readFn\(\)/.test(src), 'a stale whole-log snapshot writer exists again');
  // and every updateEntry helper must go through a fresh read
  const helpers = src.match(/const updateEntry = \(id, patch\) => \{[\s\S]{0,400}?\};/g) || [];
  helpers.forEach(h => assert.ok(/updateOrderLogRow\(|readFn\(\)/.test(h), 'updateEntry must re-read the live log: ' + h.slice(0, 80)));
});
