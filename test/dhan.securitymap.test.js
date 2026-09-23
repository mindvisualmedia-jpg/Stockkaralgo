'use strict';
// test/dhan.securitymap.test.js — a row that knows its instrument needs no
// scrip master (2026-09-23).
//
// Dhan's scrip master is a 35 MB download (15 s that morning). Every stop
// re-arm, adoption, edit and EXIT sell loaded it first even when the row
// already carried its securityId, so a slow or unreachable CDN stalled - or
// failed outright - the placement of a stop for a position whose instrument was
// known. Found when seven order-placing tests stalled behind the download.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stockkar-secmap-'));
fs.writeFileSync(path.join(dataDir, 'order_log.json'), '[]');
Object.assign(process.env, { STOCKKAR_LICENCE_ENFORCE: '0', STOCKKAR_DATA_DIR: dataDir, STOCKKAR_TEST_INTERNALS: '1', STOCKKAR_TELEGRAM_DISABLED: '1' });
const S = require('../server.js')._internals;

test('a known security id answers at once - no download, no network', () => {
  let called = false, got;
  S.withDhanSecurityMap('28125', (err, map) => { called = true; got = [err, map]; });
  assert.equal(called, true, 'answered synchronously, before any I/O could happen');
  assert.deepEqual(got, [null, null]);
});

test('every order-placing Dhan path that knows the row\'s id skips the scrip master', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  // no regex: slice from the declaration to the first column-0 closing brace
  const body = (name) => {
    const i = src.indexOf('function ' + name + '(');
    if (i < 0) return '';
    const j = src.indexOf('\n}', i);
    return src.slice(i, j < 0 ? undefined : j + 2);
  };
  ['restoreDhanStop', 'placeDhanSplitLegsRow', 'dhanPlaceSell', 'dhanPlaceForeverSl'].forEach(fn => {
    const b = body(fn);
    assert.ok(b, fn + ' found');
    assert.ok(b.includes('withDhanSecurityMap('), fn + ' goes through withDhanSecurityMap');
    assert.ok(!b.includes('loadDhanSecurityMap(('), fn + ' never calls loadDhanSecurityMap directly');
  });
});
