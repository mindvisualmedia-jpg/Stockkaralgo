'use strict';
// EXTRA TRIGGERS AT THE BROKER (2026-09-12). The owner's post-restart audit,
// day 6 of the same nine lines:
//
//   Dhan: 5 open
//   Standing trigger with NO position: KIRLOSIND, CCL, KIRLOSIND
//   ZFCVINDIA: 3 live triggers cover 18 share(s) but only 9 held
//   EXICOM:    3 live triggers cover 141 share(s) but only 47 held
//   ...
//
// The duplicates came from the 2026-09-09 empty-list incident (fixed in
// 3.22.4); nothing ever cleaned up the ones already standing, because the
// audit could only ever REPORT them. This suite pins the planner that decides
// what may be cancelled - the four safety rules in protection-cleanup.js - and
// the two routes that let the owner apply it.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { planCleanup } = require('./protection-cleanup');

const T = (id, symbol, qty, trigger) => ({ id, symbol, qty, trigger });
const plan = (live, heldQty, ownedIds, over) => planCleanup({ live, heldQty, ownedIds: ownedIds || [], ...over });
const symOf = (p, s) => p.symbols.find(x => x.symbol === s);
const ids = list => list.map(t => t.id).sort();

// ---- the incident, symbol by symbol -------------------------------------------
test('INCIDENT ZFCVINDIA: a whole bracket (9) standing beside a split pair (4+5) on 9 held -> keep the fewest that cover, cancel the rest', () => {
  const p = plan([T('A', 'ZFCVINDIA', 9, 100), T('B', 'ZFCVINDIA', 4, 100), T('C', 'ZFCVINDIA', 5, 100)], { ZFCVINDIA: 9 });
  const s = symOf(p, 'ZFCVINDIA');
  assert.deepEqual(ids(s.keep), ['A'], 'one trigger covers all 9');
  assert.deepEqual(ids(s.cancel), ['B', 'C']);
  assert.equal(p.cancelCount, 2);
  assert.match(s.cancel[0].why, /9 share\(s\) held, but the triggers here cover 18/);
});

test('INCIDENT EXICOM: 3 triggers covering 141 on 47 held -> 47 stays covered, two go', () => {
  const p = plan([T('A', 'EXICOM', 47, 250), T('B', 'EXICOM', 47, 250), T('C', 'EXICOM', 47, 250)], { EXICOM: 47 });
  const s = symOf(p, 'EXICOM');
  assert.equal(s.keep.length, 1);
  assert.equal(s.cancel.length, 2);
  assert.ok(s.keep[0].qty >= 47, 'what survives covers every share held');
});

test('INCIDENT KIRLOSIND / CCL: nothing held at all -> every unowned trigger goes, whatever its size', () => {
  const p = plan([T('23132609041684', 'KIRLOSIND', 12, 700), T('23132608111254', 'KIRLOSIND', 12, 700), T('22132608241278', 'CCL', 30, 600)], { PNB: 87 });
  assert.equal(p.cancelCount, 3);
  assert.match(symOf(p, 'CCL').cancel[0].why, /no shares of CCL are held/);
  assert.equal(symOf(p, 'KIRLOSIND').keep.length, 0);
});

// ---- rule 1: an OPEN row's stop is untouchable ---------------------------------
test('RULE 1: an id an OPEN row names is NEVER cancelled - even when the symbol is over-covered', () => {
  const p = plan([T('MINE', 'IFCI', 102, 55), T('OLD', 'IFCI', 102, 55)], { IFCI: 102 }, ['MINE']);
  const s = symOf(p, 'IFCI');
  assert.deepEqual(ids(s.keep), ['MINE']);
  assert.deepEqual(ids(s.cancel), ['OLD']);
  assert.match(s.cancel[0].why, /own stop already covers all 102/);
});

test('RULE 1 holds even when the owned trigger is the SMALLER cover: it is kept and topped up, never cancelled', () => {
  const p = plan([T('MINE', 'APEX', 20, 90), T('OLD', 'APEX', 39, 88), T('OLDER', 'APEX', 39, 85)], { APEX: 39 }, ['MINE']);
  const s = symOf(p, 'APEX');
  assert.ok(ids(s.keep).includes('MINE'), 'the managed stop survives');
  assert.ok(s.keep.reduce((a, t) => a + t.qty, 0) >= 39, 'the kept set still covers all 39');
  assert.ok(!ids(s.cancel).includes('MINE'));
});

test('nothing held, but an OPEN row owns a trigger: that one is left to the engine', () => {
  const p = plan([T('MINE', 'CCL', 30, 600), T('OLD', 'CCL', 30, 600)], {}, ['MINE']);
  const s = symOf(p, 'CCL');
  assert.deepEqual(ids(s.cancel), ['OLD']);
  assert.deepEqual(ids(s.keep), ['MINE']);
  assert.match(s.note, /open position still owns/);
});

// ---- rule 2: protection is never reduced --------------------------------------
test('RULE 2: among equal-size choices the HIGHEST stop is kept', () => {
  const p = plan([T('LOW', 'WELENT', 13, 40), T('HIGH', 'WELENT', 13, 46), T('MID', 'WELENT', 13, 43)], { WELENT: 13 });
  const s = symOf(p, 'WELENT');
  assert.deepEqual(ids(s.keep), ['HIGH'], 'the most protective stop survives');
  assert.deepEqual(ids(s.cancel), ['LOW', 'MID']);
});

test('RULE 2: the kept set always covers every share held', () => {
  const p = plan([T('A', 'RAMCOIND', 46, 300), T('B', 'RAMCOIND', 23, 305), T('C', 'RAMCOIND', 23, 304)], { RAMCOIND: 46 });
  const s = symOf(p, 'RAMCOIND');
  assert.ok(s.keep.reduce((a, t) => a + t.qty, 0) >= 46);
  assert.equal(s.keep.length + s.cancel.length, 3);
});

test('triggers that do not cover the holding are left ALONE - cancelling any would go backwards', () => {
  // 3 x 5 = 15 standing against 17 held: under-protected, not over-covered.
  // That is the audit's naked/under-protected business, never this feature's.
  const p = plan([T('A', 'PSPPROJECT', 5, 200), T('B', 'PSPPROJECT', 5, 200), T('C', 'PSPPROJECT', 5, 200)], { PSPPROJECT: 17 });
  assert.equal(p.cancelCount, 0);
  assert.equal(p.symbols.length, 0);
});

// ---- rule 3: arithmetic needs numbers ------------------------------------------
test('RULE 3: a trigger with no quantity makes the whole symbol unjudgeable - nothing is proposed', () => {
  const p = plan([T('A', 'ASAHIINDIA', 8, 700), T('B', 'ASAHIINDIA', 0, 700), T('C', 'ASAHIINDIA', 8, 700)], { ASAHIINDIA: 8 });
  assert.equal(p.cancelCount, 0);
  assert.match(p.skipped[0].reason, /did not report a quantity/);
});

test('but with NOTHING held, a missing quantity is irrelevant: the SELL is wrong at any size', () => {
  const p = plan([T('A', 'CCL', 0, 600)], {});
  assert.equal(p.cancelCount, 1);
});

// ---- rule 4: nothing is "extra" unless it really is ----------------------------
test('RULE 4: one stop on one holding is never surplus, even when no row of ours owns it', () => {
  const p = plan([T('USER', 'SWIGGY', 50, 400)], { SWIGGY: 50 });
  assert.equal(p.cancelCount, 0);
  assert.equal(p.symbols.length, 0);
});

test('RULE 4: a bracket whose legs ADD UP to the holding is not surplus (a normal split position)', () => {
  const p = plan([T('T1', 'BLACKBUCK', 10, 300), T('RUN', 'BLACKBUCK', 11, 300)], { BLACKBUCK: 21 });
  assert.equal(p.cancelCount, 0);
});

test('INCIDENT BLACKBUCK: two brackets on 21 held (42 covered) IS surplus', () => {
  const p = plan([T('NEW', 'BLACKBUCK', 21, 300), T('OLD', 'BLACKBUCK', 21, 295)], { BLACKBUCK: 21 });
  assert.equal(p.cancelCount, 1);
  assert.deepEqual(ids(symOf(p, 'BLACKBUCK').keep), ['NEW'], 'the higher stop stays');
});

test('a holding with more shares than every trigger covers is untouched (user bought more)', () => {
  const p = plan([T('A', 'GSFC', 10, 100), T('B', 'GSFC', 10, 100)], { GSFC: 40 });
  assert.equal(p.cancelCount, 0);
});

// ---- the cap -------------------------------------------------------------------
test('one run is capped, and the cap trims WHOLE symbols - never half a symbol\'s plan', () => {
  const live = [];
  for (let i = 0; i < 10; i++) live.push(T('x' + i + 'a', 'SYM' + i, 5, 50), T('x' + i + 'b', 'SYM' + i, 5, 49), T('x' + i + 'c', 'SYM' + i, 5, 48));
  const p = plan(live, Object.fromEntries(Array.from({ length: 10 }, (_, i) => ['SYM' + i, 5])), [], { maxCancel: 9 });
  assert.ok(p.cancelCount <= 9);
  p.symbols.forEach(s => assert.equal(s.cancel.length, 2, 'each included symbol is complete'));
  assert.ok(p.skipped.some(s => /limit for one run/.test(s.reason)));
});

test('never throws on junk input', () => {
  [undefined, null, {}, { live: null, heldQty: null }].forEach(i => {
    const p = planCleanup(i);
    assert.equal(p.cancelCount, 0);
    assert.ok(Array.isArray(p.symbols));
  });
  assert.equal(planCleanup({ live: [T('', 'X', 1, 1), T('B', '', 1, 1)], heldQty: {} }).cancelCount, 0, 'ids and symbols are required');
});

test('symbol suffixes and exchange prefixes match the holdings map', () => {
  const p = plan([T('A', 'NSE:IFCI-EQ', 102, 55), T('B', 'IFCI', 102, 55)], { 'NSE:IFCI-EQ': 102 });
  assert.equal(p.cancelCount, 1, 'both spellings are the same stock');
});

// ---- the wiring -----------------------------------------------------------------
const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

test('the routes exist, and ownership is read from OPEN rows only', () => {
  assert.ok(src.includes("if (parsedUrl.pathname === '/protection/extra' && req.method === 'GET') {"));
  assert.ok(src.includes("if (parsedUrl.pathname === '/protection/extra/cancel' && req.method === 'POST') {"));
  assert.ok(src.includes("&& !e.testMode && e.source !== 'test' && isOpenOrderLogEntry(e))\r\n    .forEach(e => rowIdsOf(e).all.forEach(id => owned.add(String(id))));")
    || src.includes("&& !e.testMode && e.source !== 'test' && isOpenOrderLogEntry(e))\n    .forEach(e => rowIdsOf(e).all.forEach(id => owned.add(String(id))));"));
  assert.ok(src.includes('const EXTRA_CLEANUP_FILE'), 'an irreversible act leaves a record');
});

test('apply REBUILDS the plan and cancels only what is still extra', () => {
  assert.ok(src.includes('const todo = [...want].filter(id => allowed.has(id));'));
  assert.ok(src.includes('const stale = [...want].filter(id => !allowed.has(id));'));
  assert.ok(src.includes("error: 'Those triggers are no longer extra at the broker - nothing was cancelled.'"));
});

test('the audit now points at the cleanup instead of asking for twenty manual cancels', () => {
  assert.ok(src.includes('Cancel it in Order Log → Holdings → Extra triggers.'));
  assert.ok(src.includes('Stockkar keeps the stop that covers your shares'));
});

test('the dashboard shows the plan and asks before cancelling', () => {
  assert.ok(html.includes('id="extra-trig"'));
  assert.ok(html.includes('async function loadExtraTriggers()'));
  assert.ok(html.includes("if (!confirm('Cancel ' + ids.length + ' extra trigger(s) at '"));
  assert.ok(html.includes("await api('/protection/extra/cancel', { broker, ids })"), 'api() takes the body as an object');
  // the button's onclick is HTML-attribute safe: a raw JSON string would close
  // the double-quoted attribute and the button would silently do nothing
  // the button's onclick must be HTML-attribute safe: a raw JSON string
  // closes the double-quoted attribute and the button silently does nothing
  assert.ok(html.includes('onclick="applyExtraTriggers(&quot;'), 'the broker name is HTML-escaped into the attribute');
  assert.ok(!/onclick="applyExtraTriggers\(' \+ JSON\.stringify/.test(html), 'the raw-JSON form that broke the button is gone');
});
