'use strict';
// emacross.js — the EMA crossover entry filter's decision logic.
//
// The filter answers ONE question: did the FAST EMA cross above the SLOW EMA
// within the last N trading days? It is a DAILY (end-of-day) signal, so every
// value it reasons about must be a SETTLED daily close.
//
// Why this is a module: the decision is what actually buys a stock, so it is
// kept pure (data in -> boolean out) and unit-tested. server.js owns the I/O
// (fetching EMAs after the close and writing the snapshot history).
//
// History shape, per symbol, oldest -> newest:
//   [{ date: '2026-07-13', eod: true, e20: 470.1, e50: 466.2, ... }, ...]
// Snapshots are written ONCE PER TRADING DAY AFTER THE CLOSE and tagged
// { eod: true }. Anything without that flag is a legacy intraday reading (taken
// mid-session off an unfinished candle, so it could still move) and is IGNORED.

function normSym(s) {
  return String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
}

// Settled EOD closes we hold for a symbol, oldest -> newest, that carry BOTH
// EMAs the filter needs. Sorted by date so file order can never mislead us.
function eodCloses(symbol, hist, fast, slow) {
  return ((hist && hist[normSym(symbol)]) || [])
    .filter(d => d && d.eod
      && Number.isFinite(Number(d['e' + fast]))
      && Number.isFinite(Number(d['e' + slow])))
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// How many usable EOD closes exist (drives the "warming up (x/y)" note).
function emaCrossHistoryDays(symbol, hist, fast, slow) {
  if (fast === undefined) return ((hist && hist[normSym(symbol)]) || []).filter(d => d && d.eod).length;
  return eodCloses(symbol, hist, fast, slow).length;
}

// True when fast crossed above slow within the last `days` TRADING days:
//   - the most recent close has fast >= slow  (it is bullish NOW), and
//   - a close inside the window had fast < slow (so the flip happened in it).
// `days` counts CLOSES, not calendar days, so weekends/holidays cannot silently
// shrink the window. Detecting N transitions needs N+1 closes; with fewer we
// return false rather than guess (a missing "before" close is not evidence).
function detectEmaCrossover(symbol, hist, fast, slow, days) {
  const n = Math.max(1, Number(days) || 3);
  const all = eodCloses(symbol, hist, fast, slow);
  if (all.length < 2) return false;
  const win = all.slice(-(n + 1));
  const latest = win[win.length - 1];
  if (!(Number(latest['e' + fast]) >= Number(latest['e' + slow]))) return false;
  return win.some(d => Number(d['e' + fast]) < Number(d['e' + slow]));
}

module.exports = { detectEmaCrossover, emaCrossHistoryDays, eodCloses, normSym };
