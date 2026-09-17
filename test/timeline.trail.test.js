'use strict';
// test/timeline.trail.test.js — the STAR case (2026-09-17): "in step trail why
// is it shown EMA trail?" and "make it easier for users".
//
// The position timeline is inline JS in index.html, so this pins the SOURCE:
// the trail row is named by its mode and states the rule, the start, the peak
// and the next step; the Exit row shows the close time; a row that can never
// book T1 says so instead of "Pending"; an old "No changes detected" entry
// reads as the confirmation it is; and the server hands the engine its price
// rounding so the engine asks for the price that will be sent.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

test('every inline script in index.html still parses', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  assert.ok(scripts.length >= 1);
  scripts.forEach((s, i) => { new vm.Script(s, { filename: 'index.html#script' + i }); });
});

test('the trail row is named by its mode, not always "EMA trail"', () => {
  assert.ok(html.includes("const label = mode === 'step' ? 'Step trail' : mode === 'peak' ? 'Peak trail' : 'EMA trail';"));
  assert.ok(!/add\('EMA trail',/.test(html), 'no hard-coded EMA label remains');
});

test('the step rule is spelled out in words, with the start, the peak and the next step', () => {
  assert.ok(html.includes("'Rule: for every full ' + stepP + '% the price rises above entry, the stop lifts ' + moveP + '% of entry above the original stop'"));
  assert.ok(html.includes("'Started ' + at(r.emaTrailingArmedAt)"));
  assert.ok(html.includes("'Highest price seen ' + px(r.trailPeak)"));
  assert.ok(html.includes("'Next step at ' + px(r2(entryPx * (1 + nextGain / 100)))"));
  // the UI ladder rounds like the server, so the stop it predicts is the stop that is sent
  assert.ok(html.includes("const tick = function(v) { return v >= 1000 ? Math.round(v) : Math.round(v * 10) / 10; };"));
});

test('the Exit row shows the close time, not the last status check', () => {
  assert.ok(html.includes("at(r.closedAt || r.lastStatusCheckAt)"));
});

test('a row that can never book T1 says so instead of Pending', () => {
  assert.ok(html.includes("const t1BookQty = Math.floor(n(r.qty) * n(r.t1Qty) / 100);"));
  assert.ok(html.includes("'Not applicable: ' + n(r.t1Qty) + '% of ' + n(r.qty) + ' shares is 0"));
});

test('an old "No changes detected" stop move reads as a confirmation', () => {
  assert.ok(html.includes("const noop = function(m) { return /no\\s+changes\\s+detected/i.test(String(m && m.error || '')); };"));
  assert.ok(html.includes("' \\u2014 already at this level (the broker confirmed it)'"));
});

test('the server hands the engine its price rounding', () => {
  assert.ok(server.includes('roundStop: roundPrice });'));
});
