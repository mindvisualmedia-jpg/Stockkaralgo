'use strict';
// A REFUSED STOP MOVE STAYS VISIBLE (2026-09-12, STAR on Zerodha). The user
// saw only "MODIFY_SL failed: stop modify budget spent (4 in the last hour)"
// while Kite still showed the original stop - the 3.22.3 budget refusal had
// overwritten the broker's real answer on the row, so nobody could read WHY
// four modifies had failed. Now the row keeps every attempt with the broker's
// words, the refusal quotes the last one, the first failure of the day is
// announced, and the lifecycle panel lists the attempts.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('every stop modify (trail / drift / cost / resize) records its outcome on the row', () => {
  assert.ok(src.includes("const recordModify = (type, price, cb) => (err, res) => {"));
  assert.ok(src.includes("engineModifyHistory: [...(Array.isArray(rw.engineModifyHistory) ? rw.engineModifyHistory : []), rec].slice(-10)"));
  assert.ok(src.includes("recordModify('RESIZE_PROTECTION', stop, markPending(stop, false, false))"));
  assert.ok(src.includes("recordModify('MOVE_SL_TO_COST', cost, markPending(cost, true))"));
  assert.ok(src.includes("recordModify('MODIFY_SL:' + String(action.reason || ''), want, markPending(want, false, action.reason === 'sl-to-t1'))"));
});

test('the budget refusal quotes the last real broker answer instead of hiding it', () => {
  assert.ok(src.includes("const last = (Array.isArray(row.engineModifyHistory) ? row.engineModifyHistory : []).slice().reverse().find(h => h && h.error);"));
  assert.ok(src.includes("' | last broker answer ('"));
});

test('the first refused stop move of the day is announced with the broker\'s words; the budget refusal is not news', () => {
  assert.ok(src.includes("if (/^(MODIFY_SL|MOVE_SL_TO_COST|RESIZE_PROTECTION)$/.test(a.type) && !/modify budget spent/.test(String(err))) {"));
  assert.ok(src.includes("const ak = String(row.id) + '|STOP_MOVE_FAILED';"));
  assert.ok(src.includes(">= 24 * 60 * 60 * 1000) {"));
});

test('the lifecycle panel lists the stop moves, one per line', () => {
  assert.ok(html.includes("add('Stop moves', failed === moves.length ? 'fail' : (failed ? 'wait' : 'ok'),"));
  assert.ok(html.includes("white-space:pre-line"));
});
