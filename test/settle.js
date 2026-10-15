'use strict';
// test/settle.js - wait for the server's broker work to FINISH, not for a
// fixed time (2026-10-15).
//
// The fake-broker tests drove an engine pass with
//   S.runEngineCutover(); await wait(700);
// and under the full suite's load that was not always enough: the pass ended
// just after the sleep and the test read a half-written row (three tests
// flaked on 15 Oct). Dhan writes alone are paced 400 ms apart
// (DHAN_ORDER_GAP_MS), so a pass with two of them was already at the edge.
//
// WHY COUNTING WORKS. Every async step of the server's broker work is one of
// two things: an HTTP(S) request to a (fake) broker, or a short global
// setTimeout (Dhan's order pacing, rate-limit retries, order-book re-reads).
// Each step starts the next one INSIDE its own callback - server.js, engine.js
// and brokers/* use no promises, nextTick or setImmediate on these paths. A
// request is released on its 'close', which Node emits after the reply's
// 'end' handlers have run (checked on Node 24, keep-alive agent), so a step
// chained from a reply is already counted when the one before it is let go.
// "Nothing open and nothing scheduled" is therefore exactly "done".
//
// Test-side only: production code is untouched. Require this module BEFORE the
// work starts (top of the file); timers and requests made earlier are not seen.
const http = require('http');
const https = require('https');

const ORIG = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
// Longer timers are not a pass's work (the longest pause in one is the 6 s
// Dhan rate-limit retry); boot-time warmers and the like must not hold a test.
const SHORT_MS = 10000;
let open = 0;
const waiters = [];
const timerRelease = new WeakMap();

function check() {
  // Two turns: anything a released callback queued with setImmediate runs first.
  setImmediate(() => setImmediate(() => { if (open === 0) waiters.splice(0).forEach(fn => fn()); }));
}
function hold() {
  open++;
  let held = true;
  return () => { if (!held) return; held = false; open--; if (open === 0) check(); };
}

for (const mod of [http, https]) {
  for (const name of ['request', 'get']) {
    const orig = mod[name];
    if (orig.__settle) continue;
    mod[name] = Object.assign(function (...args) {
      const req = orig.apply(this, args);
      req.once('close', hold());
      return req;
    }, { __settle: true });
  }
}

if (!global.setTimeout.__settle) {
  global.setTimeout = Object.assign(function (fn, ms, ...args) {
    if (typeof fn !== 'function' || Number(ms || 0) > SHORT_MS) return ORIG.setTimeout(fn, ms, ...args);
    const release = hold();
    const t = ORIG.setTimeout(function (...a) { try { return fn.apply(this, a); } finally { release(); } }, ms, ...args);
    timerRelease.set(t, release);
    return t;
  }, { __settle: true });
  global.clearTimeout = function (t) {
    const release = t && timerRelease.get(t);
    if (release) { timerRelease.delete(t); release(); }
    return ORIG.clearTimeout(t);
  };
}

// Resolves once no broker request is open and no short timer is pending.
function settled(timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const done = () => { ORIG.clearTimeout(guard); resolve(); };
    const guard = ORIG.setTimeout(() => {
      const i = waiters.indexOf(done);
      if (i >= 0) waiters.splice(i, 1);
      reject(new Error('server work did not settle within ' + timeoutMs + ' ms (' + open + ' request(s)/timer(s) still open)'));
    }, timeoutMs);
    waiters.push(done);
    check();
  });
}

// One engine pass, start to finish: snapshot, every action, any adoption.
async function enginePass(S) {
  S.runEngineCutover();
  await settled();
}

// A plain sleep the counter never sees (for tests that wait on purpose).
const sleep = (ms) => new Promise(r => ORIG.setTimeout(r, ms));

module.exports = { settled, enginePass, sleep, openCount: () => open };
