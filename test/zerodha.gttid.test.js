'use strict';
// test/zerodha.gttid.test.js — "Why Trailing gets failed or is it false notify?"
// (owner, 2026-09-16). The alert:
//
//   MODIFY_SL failed: stop modify budget spent (4 in the last hour) | last
//   broker answer (03:36 UTC, stop 1106): Zerodha GTT SL modify failed:
//   {"status":"error","message":"No changes detected. Modify the trigger
//    parameters before submitting.","error_type":"InputException"}
//
// It was a false alarm with a real bug underneath. Zerodha's own words settle
// the first half: "No changes detected" means the GTT ALREADY held 1106 - the
// stop was in place the whole time. The bug: the engine read the GTT id from
// the row's zerodhaGttId field (or the LAST "GTT:" token), while the non-split
// modify took the FIRST "GTT:" token from the orderId string. An adoption
// appends a second token, so after one the engine judged one GTT and modified
// another - rule 5 saw "drift" on the GTT it read, the modify hit the one it
// did not, Kite said no changes, four times an hour, then the budget alarm.
//
// Both halves are pinned here against the REAL executor and a fake Kite that
// refuses no-op modifies exactly as the live one does.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFakeKite } = require('./fake-brokers');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-gttid-'));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
fs.writeFileSync(path.join(dataDir, 'broker_tokens.json'), JSON.stringify({ brokers: {
  zerodha: { clientId: 'kiteapikey', clientSecret: 's', accessToken: 'kite-token', updatedAt: new Date().toISOString() },
} }));
Object.assign(process.env, {
  STOCKKAR_LICENCE_ENFORCE: '0',
  STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1',
  STOCKKAR_ENGINE: '1', STOCKKAR_ENGINE_SHADOW: '0', STOCKKAR_ENGINE_LEGACY_OFF: '1',
  STOCKKAR_KITE_API_HOST: '127.0.0.1', STOCKKAR_KITE_API_PROTO: 'http',
  STOCKKAR_TEST_MARKET_OPEN: '1', STOCKKAR_TELEGRAM_DISABLED: '1',
});

const kite = createFakeKite({ marketPrice: 1150 });
let S;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const rows = () => S.readOrderLog();
const rowOf = (id) => rows().find(r => r.id === id);
async function enginePass() { S.runEngineCutover(); await wait(900); }
const now = () => ({ time: new Date().toLocaleString(), recordedAt: new Date().toISOString() });
const exec = (row, action) => new Promise(res => S.engineExecuteAction(row, action, (err) => res(err || null), { liveIds: new Set() }));
const putsTo = (id) => kite.sent('PUT', '/gtt/triggers/').filter(r => r.path.endsWith('/' + id));

before(async () => {
  await new Promise(res => kite.listen(port => { process.env.STOCKKAR_KITE_API_PORT = String(port); res(); }));
  S = require('../server.js')._internals;
  assert.equal(S.KITE_API.hostname, '127.0.0.1');
  kite.holdSymbol('TCS', 5, 3100);       // a healthy anchor so the read-sanity gate trusts the snapshot
});
after(() => new Promise(r => kite.close(r)));

test('the id parser takes the LAST GTT token - an adoption appends, it does not replace', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const fn = new Function(src.match(/function parseZerodhaOrderIds[\s\S]*?\n}/)[0] + '; return parseZerodhaOrderIds;')();
  assert.equal(fn('ENTRY:ZE7 | GTT:111 | GTT:222').gttId, '222', 'the newest id is the one that stands');
  assert.equal(fn('ENTRY:ZE7 | GTT:111').gttId, '111');
  assert.equal(fn('ENTRY:ZE7 | GTT-T1:5 | GTT:9').gttId, '9', 'GTT-T1 is a different token');
  assert.equal(fn('ENTRY:ZE7').gttId, '');
});

test('INCIDENT: after an adoption the modify goes to the GTT the engine READS, not the one first named in the string', async () => {
  kite.holdSymbol('INFY', 10, 1150);
  const anchor = kite.seedGtt('TCS', 3000, 3300, 5);
  const OLD = kite.seedGtt('INFY', 1106, 1300, 10);   // already at 1106 - the one the string names first
  const NEW = kite.seedGtt('INFY', 1080, 1300, 10);   // the adopted GTT the engine reads - stale at 1080
  S.writeOrderLog([
    { id: 'anchor', broker: 'zerodha', symbol: 'TCS', action: 'BUY', qty: 5, entryPrice: 3100, price: 3100, slPrice: 3000, targetPrice: 3300, exchange: 'NSE', segment: 'CNC',
      orderId: 'ENTRY:ZE9 | GTT:' + anchor, zerodhaEntryOrderId: 'ZE9', zerodhaGttId: anchor, status: 'ZERODHA ENTRY + GTT OCO', liveLtp: 3100, engineState: 'PROTECTED', ...now() },
    // the adopt shape: field = NEW, string carries OLD then NEW; the row believes its stop is 1106
    { id: 'zx', broker: 'zerodha', symbol: 'INFY', action: 'BUY', qty: 10, entryPrice: 1000, price: 1000, slPrice: 1106, brokerSlPrice: 1106, targetPrice: 1300, exchange: 'NSE', segment: 'CNC',
      orderId: 'ENTRY:ZE7 | GTT:' + OLD + ' | GTT:' + NEW, zerodhaEntryOrderId: 'ZE7', zerodhaGttId: NEW, status: 'ZERODHA ENTRY + GTT OCO', liveLtp: 1150, engineState: 'PROTECTED', ...now() },
  ]);
  await enginePass();

  // rule 5 saw the stop it READS (NEW, 1080) below the row's 1106 and re-asserted it
  const toNew = putsTo(NEW), toOld = putsTo(OLD);
  assert.equal(toOld.length, 0, 'the GTT first named in the string was never touched: ' + JSON.stringify(toOld.map(r => r.path)));
  assert.ok(toNew.length >= 1, 'the modify went to the GTT the engine reads');
  assert.equal(JSON.parse(toNew[0].body.condition).trigger_values[0], 1106);
  assert.equal(kite.gtt(NEW).condition.trigger_values[0], 1106, 'and that GTT now really holds 1106');
  const r = rowOf('zx');
  assert.ok(!r.engineActionError, 'no failure recorded: ' + r.engineActionError);
  const last = (r.engineModifyHistory || []).slice(-1)[0];
  assert.ok(last && last.ok, 'the attempt is recorded as a success: ' + JSON.stringify(last));
});

test('FALSE ALARM: a modify the broker answers "No changes detected" is a CONFIRMATION - verified at once, no error, no re-ask', async () => {
  kite.holdSymbol('WIPRO', 10, 300);
  const G = kite.seedGtt('WIPRO', 250, 350, 10);
  S.writeOrderLog([...rows(), { id: 'zw', broker: 'zerodha', symbol: 'WIPRO', action: 'BUY', qty: 10, entryPrice: 240, price: 240, slPrice: 250, brokerSlPrice: 250, targetPrice: 350, exchange: 'NSE', segment: 'CNC',
    orderId: 'ENTRY:ZE8 | GTT:' + G, zerodhaEntryOrderId: 'ZE8', zerodhaGttId: G, status: 'ZERODHA ENTRY + GTT OCO', liveLtp: 300, engineState: 'PROTECTED', ...now() }]);

  // a real move first, so the fake holds OUR payload for the stop
  const e1 = await exec(rowOf('zw'), { type: 'MODIFY_SL', price: 260, legIds: [G], reason: 'reassert-drift' });
  assert.equal(e1, null, 'first modify accepted: ' + e1);
  assert.equal(kite.gtt(G).condition.trigger_values[0], 260);
  assert.ok(rowOf('zw').enginePendingSl, 'a normal modify waits for verification');

  // the SAME move again - exactly what the loop did - now answered by Kite with the live wording
  const before = kite.sent('PUT', '/gtt/triggers/').length;
  const e2 = await exec(rowOf('zw'), { type: 'MODIFY_SL', price: 260, legIds: [G], reason: 'reassert-drift' });
  const dump = kite.sent('PUT', '/gtt/triggers/').map(r => r.path.split('/').pop() + ' -> ' + JSON.parse(r.body.condition).trigger_values.join('/'));
  assert.equal(kite.sent('PUT', '/gtt/triggers/').length, before + 1, 'the request was made; PUTs seen: ' + JSON.stringify(dump));
  const answered = kite.sent('PUT', '/gtt/triggers/').slice(-1)[0];
  assert.ok(answered, 'and it was the no-op');
  assert.equal(e2, null, 'the broker\'s no-op refusal is NOT reported as a failure: ' + e2);

  const r = rowOf('zw');
  assert.equal(r.slPrice, 260, 'the stop is believed at 260');
  assert.equal(r.brokerSlPrice, 260);
  assert.equal(r.enginePendingSl, null, 'nothing left pending - the broker already confirmed it');
  assert.ok(r.slVerifiedAt, 'verified now, not after a grace');
  assert.ok(!r.engineActionError, 'no error on the row: ' + r.engineActionError);
  const last = (r.engineModifyHistory || []).slice(-1)[0];
  assert.equal(last.ok, true);
  assert.match(String(last.note || ''), /already at this level/);
});

test('the hint, if the words ever reach a human, says it is not a failure', () => {
  const { withHint } = require('../broker-reasons');
  const h = withHint('Zerodha GTT SL modify failed: {"status":"error","message":"No changes detected. Modify the trigger parameters before submitting.","error_type":"InputException"}');
  assert.match(h, /not a failure/);
  assert.match(h, /ALREADY at that level/);
});
