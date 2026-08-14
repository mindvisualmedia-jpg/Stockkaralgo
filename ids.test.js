'use strict';
// ids.test.js — DIFFERENTIAL suite: ids.js must return exactly what the engine
// already computes. This file exists so that consolidating five id extractors
// into one cannot move engine behaviour by accident.
//
// ENGINE_REFERENCE below is a VERBATIM copy of the id/leg derivation inside
// engineShadowPosition() (server.js). Same idiom as maxopen.test.js and
// fyersdup.test.js: server.js cannot be required (it starts a server), so the
// rule under test is duplicated and pinned. If server.js changes and this copy
// is not updated, the fixtures below diverge and the suite fails - which is the
// alarm we want.

const { test } = require('node:test');
const assert = require('node:assert');
const { rowIds, knownProtectionIds } = require('./ids');

// ---- verbatim from engineShadowPosition (server.js) -------------------------
function ENGINE_REFERENCE(row) {
  const broker = String(row.broker || 'dhan').toLowerCase();
  const legs = [];
  const fids = {};
  const re = /(ENTRY|FOREVER-T1|FOREVER|GTT-T1|SLGTT|SLRULE|GTT):([^|\s]+)/gi; let m;
  while ((m = re.exec(String(row.orderId || '')))) fids[m[1].toUpperCase()] = m[2].trim();
  const t1Id = broker === 'zerodha' ? (row.zerodhaGttT1Id || fids['GTT-T1'] || '')
    : broker === 'fyers' ? (row.fyersGttT1Id || fids['GTT-T1'] || '')
    : broker === 'angelone' ? (row.angelOneGttT1Id || '')
    : (row.dhanForeverT1Id || fids['FOREVER-T1'] || '');
  const runId = broker === 'zerodha' ? (row.zerodhaGttId || fids['GTT'] || '')
    : broker === 'fyers' ? (row.fyersGttId || fids['GTT'] || '')
    : broker === 'angelone' ? (row.mtmRemainderSlOrderId || row.angelOneSlRuleId || fids['SLGTT'] || fids['SLRULE'] || '')
    : (row.dhanForeverId || fids['FOREVER'] || '');
  if (row.splitT1 && t1Id) legs.push({ id: t1Id, role: 't1', qty: Number(row.splitLegAQty || 0) });
  if (runId) legs.push({ id: runId, role: row.splitT1 ? 'runner' : 'single', qty: Number(row.splitT1 ? row.splitLegBQty : row.qty) || 0 });
  const entryId = row.dhanEntryOrderId || row.zerodhaEntryOrderId || row.fyersEntryOrderId
    || row.angelOneEntryOrderId || fids['ENTRY'] || '';
  return { entryId, legs };
}

// ---- fixtures: every shape a live row actually takes ------------------------
const FIXTURES = [
  { name: 'dhan single, fields',
    row: { broker: 'dhan', qty: 4, dhanEntryOrderId: 'E1', dhanForeverId: 'F1' } },
  { name: 'dhan split, fields',
    row: { broker: 'dhan', qty: 4, splitT1: true, splitLegAQty: 2, splitLegBQty: 2,
           dhanForeverT1Id: 'FT1', dhanForeverId: 'FR', dhanEntryOrderId: 'E1' } },
  { name: 'dhan split, ids ONLY in the orderId string',
    row: { broker: 'dhan', qty: 4, splitT1: true, splitLegAQty: 2, splitLegBQty: 2,
           orderId: 'ENTRY:E9 | FOREVER-T1:FT9 | FOREVER:FR9' } },
  { name: 'zerodha split, string ids',
    row: { broker: 'zerodha', qty: 2, splitT1: true, splitLegAQty: 1, splitLegBQty: 1,
           orderId: 'ENTRY:Z1 | GTT-T1:ZT1 | GTT:ZR1' } },
  { name: 'fyers split (the V2RETAIL shape)',
    row: { broker: 'fyers', qty: 2, splitT1: true, splitLegAQty: 1, splitLegBQty: 1,
           orderId: 'ENTRY:26081300093343 | GTT-T1:26081300000636 | GTT:26081300000637' } },
  { name: 'fyers split AFTER T1 booked (legA terminal, still listed)',
    row: { broker: 'fyers', qty: 2, splitT1: true, mtmT1Done: true, splitLegAQty: 1, splitLegBQty: 1,
           fyersGttT1Id: '636', fyersGttId: '637' } },
  { name: 'angel single rule',
    row: { broker: 'angelone', qty: 2, angelOneSlRuleId: '9388376', angelOneEntryOrderId: 'AE1' } },
  { name: 'angel remainder re-arm (mtmRemainderSlOrderId wins)',
    row: { broker: 'angelone', qty: 2, angelOneSlRuleId: 'OLD', mtmRemainderSlOrderId: 'NEW' } },
  { name: 'angel split (field legA + SLGTT string)',
    row: { broker: 'angelone', qty: 2, splitT1: true, splitLegAQty: 1, splitLegBQty: 1,
           angelOneGttT1Id: 'A_T1', orderId: 'ENTRY:AE2 | T1GTT:A_T1 | SLGTT:A_SL' } },
  { name: 'angel split with ids ONLY in the string (the preserved quirk)',
    row: { broker: 'angelone', qty: 2, splitT1: true, splitLegAQty: 1, splitLegBQty: 1,
           orderId: 'ENTRY:AE3 | T1GTT:A_T1b | SLGTT:A_SLb' } },
  { name: 'no broker field at all -> dhan default',
    row: { qty: 1, orderId: 'ENTRY:D0 | FOREVER:F0' } },
  { name: 'split flagged but legA id missing',
    row: { broker: 'fyers', qty: 2, splitT1: true, splitLegBQty: 2, fyersGttId: 'ONLY_RUNNER' } },
  { name: 'nothing at all',
    row: { broker: 'zerodha' } },
  { name: 'split quantities absent -> qty 0, not NaN',
    row: { broker: 'dhan', splitT1: true, dhanForeverT1Id: 'a', dhanForeverId: 'b' } },
];

test('ids.rowIds matches the engine derivation on every row shape', () => {
  FIXTURES.forEach(({ name, row }) => {
    const mine = rowIds(row);
    const engine = ENGINE_REFERENCE(row);
    assert.deepEqual(mine.legs, engine.legs, 'legs differ: ' + name);
    assert.equal(mine.entry, engine.entryId, 'entry differs: ' + name);
  });
});

test('the T1 leg is still listed after T1 books (writers must filter by LIVE evidence)', () => {
  const r = FIXTURES.find(f => f.name.includes('AFTER T1 booked')).row;
  const legs = rowIds(r).legs;
  assert.equal(legs.length, 2, 'the engine needs legA present to detect the booking');
  assert.deepEqual(legs.map(l => l.role), ['t1', 'runner']);
});

test('an Angel split row with ids only in the string has NO t1 leg (quirk, preserved)', () => {
  const r = FIXTURES.find(f => f.name.includes('ONLY in the string (the preserved')).row;
  // The row IS split, so the surviving leg keeps the 'runner' role - it is the
  // T1 leg that is absent, not the split-ness.
  assert.deepEqual(rowIds(r).legs.map(l => l.role), ['runner'],
    'angel legA reads the field only; changing this is a deliberate change, not a refactor');
  assert.equal(rowIds(r).t1, '', 'no legA id resolved from the string');
});

test('all[] is a SUPERSET including terminal and string-only ids', () => {
  const all = rowIds({ broker: 'angelone', splitT1: true, angelOneGttT1Id: 'A1',
    angelOneSlRuleId: 'A2', mtmRemainderSlOrderId: 'A3', orderId: 'ENTRY:E | T1GTT:A1 | SLGTT:A2' }).all;
  ['A1', 'A2', 'A3'].forEach(id => assert.ok(all.includes(id), 'missing ' + id));
  assert.ok(!all.includes('E'), 'the entry id is not a protective id');
});

test('knownProtectionIds feeds the read-sanity gate across many rows', () => {
  const ids = knownProtectionIds([
    { broker: 'fyers', orderId: 'ENTRY:E1 | GTT-T1:636 | GTT:637' },
    { broker: 'fyers', orderId: 'ENTRY:E2 | GTT-T1:638 | GTT:639' },
    { broker: 'dhan', dhanForeverId: 'F1' },
  ]);
  assert.deepEqual(ids.sort(), ['636', '637', '638', '639', 'F1'].sort());
});

test('quantities are numbers, never NaN', () => {
  FIXTURES.forEach(({ name, row }) => {
    rowIds(row).legs.forEach(l => assert.ok(Number.isFinite(l.qty), 'NaN qty in: ' + name));
  });
});
