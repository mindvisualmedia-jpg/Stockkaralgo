'use strict';
// ALERT STORM (2026-09-10). Owner's screenshot: "DHAN data is reliable again"
// at 6:27, 6:35, 6:43, 6:51 - every eight minutes, nothing changed at the
// broker. Owner: "it should never be continuous annoying."
//
// Cause: the read-sanity gate reset its suspect streak to zero when it released
// by persistence, so the next pass was suspect again; four passes later it
// released again and re-announced. Fixed as a held state machine
// (alerts.readGateStep). A duplicate filter in sendTelegram is the backstop.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { readGateStep, makeDeduper } = require('./alerts');
const { readLooksBroken } = require('./broker-policy');

const step = (prev, knownIds, seenIds) => readGateStep(prev, { knownIds, seenIds: new Set(seenIds), listNonEmpty: seenIds.length > 0, readLooksBroken });

test('INCIDENT (old rule, 3-pass release): one tracked stop, list empty forever -> the announcement never repeats', () => {
  // Reproduce the screenshot's cadence with a 3-pass release, then prove it
  // cannot happen with the held state: one 'suspect', one 'believed', silence.
  let st = { streak: 0, believed: false };
  const events = [];
  for (let pass = 0; pass < 200; pass++) {
    const r = readGateStep(st, { knownIds: ['F1'], seenIds: new Set(), listNonEmpty: false,
      readLooksBroken: (k, s, o) => (o.consecutiveSuspects >= 3 ? false : true) });   // the pre-3.22.4 hatch
    if (r.event) events.push(pass + ':' + r.event);
    st = { streak: r.streak, believed: r.believed };
  }
  assert.deepEqual(events, ['0:suspect', '3:believed'], 'two messages in 200 passes, not fifty');
  assert.equal(st.believed, true);
  assert.equal(st.streak, 3, 'the streak is HELD at the release count, never restarted');
});

test('current rule (empty list releases after 30 passes): suspect once, believed once, then silence; re-arms stay released', () => {
  let st = { streak: 0, believed: false };
  const events = [];
  const released = [];
  for (let pass = 0; pass < 120; pass++) {
    const r = step(st, ['F1'], []);
    if (r.event) events.push(pass + ':' + r.event);
    released.push(!r.suspect);
    st = { streak: r.streak, believed: r.believed };
  }
  assert.deepEqual(events, ['0:suspect', '30:believed']);
  assert.equal(released.slice(0, 30).every(x => x === false), true, 'gate holds for 30 passes');
  assert.equal(released.slice(30).every(x => x === true), true, 'and stays released afterwards - no flapping');
});

test('a real recovery (a tracked id seen again) announces ONCE and resets; a new outage starts a new episode', () => {
  let st = { streak: 31, believed: true };
  let r = step(st, ['F1'], ['F1', 'X9']);
  assert.equal(r.event, 'recovered');
  assert.deepEqual([r.suspect, r.streak, r.believed], [false, 0, false]);
  st = { streak: r.streak, believed: r.believed };
  r = step(st, ['F1'], ['F1']);
  assert.equal(r.event, '', 'a healthy pass says nothing');
  r = step(st, ['F1'], []);
  assert.equal(r.event, 'suspect', 'the next outage is a new episode');
});

test('recovery from a plain suspect episode (no persistence release) is also announced once', () => {
  const r = step({ streak: 2, believed: false }, ['F1'], ['F1']);
  assert.equal(r.event, 'recovered');
  assert.equal(step({ streak: 0, believed: false }, ['F1'], ['F1']).event, '', 'nothing to recover from');
});

test('a list WITH items but none of ours releases after 3 passes and then holds too', () => {
  let st = { streak: 0, believed: false };
  const events = [];
  for (let pass = 0; pass < 20; pass++) {
    const r = step(st, ['F1'], ['STRANGER']);
    if (r.event) events.push(pass + ':' + r.event);
    st = { streak: r.streak, believed: r.believed };
  }
  assert.deepEqual(events, ['0:suspect', '3:believed']);
});

test('nothing tracked -> never suspect, never an event', () => {
  const r = step({ streak: 0, believed: false }, [], []);
  assert.deepEqual([r.suspect, r.streak, r.event], [false, 0, '']);
});

// ---- the duplicate filter ----------------------------------------------------------

test('identical text inside 30 minutes is dropped; different text and text after the window go out', () => {
  const d = makeDeduper(30 * 60 * 1000);
  const T = 1_800_000_000_000;
  assert.equal(d.shouldSend('A', T), true);
  assert.equal(d.shouldSend('A', T + 8 * 60000), false, 'the 8-minute repeat');
  assert.equal(d.shouldSend('A', T + 16 * 60000), false);
  assert.equal(d.shouldSend('B', T + 1000), true, 'another message is untouched');
  assert.equal(d.shouldSend('A', T + 31 * 60000), true, 'after the window it may repeat once');
  assert.equal(d.shouldSend('A', T + 32 * 60000), false);
});

test('the filter is bounded: it prunes and never grows past its cap', () => {
  const d = makeDeduper(1000, 50);
  for (let i = 0; i < 500; i++) d.shouldSend('m' + i, 1_000_000 + i);
  assert.ok(d.size() <= 50);
});

// ---- wiring --------------------------------------------------------------------------

const src = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

test('the engine pass drives the gate through readGateStep and alerts only on its events', () => {
  assert.ok(src.includes("const _g = alerts.readGateStep(_gPrev, { knownIds, seenIds, listNonEmpty: seenIds.size > 0, readLooksBroken: brokerPolicy.readLooksBroken });"));
  assert.ok(src.includes("} else if (_g.event === 'believed') {"));
  assert.ok(src.includes("} else if (_g.event === 'recovered') {"));
  assert.ok(!src.includes("_engineReadSuspectStreak[brokerName] = 0;"), 'the streak reset that caused the loop is gone');
});

test('sendTelegram drops identical text inside 30 minutes', () => {
  assert.ok(src.includes("const _telegramDedupe = alerts.makeDeduper(30 * 60 * 1000);"));
  assert.ok(src.includes("if (!_telegramDedupe.shouldSend(text)) {"));
});
