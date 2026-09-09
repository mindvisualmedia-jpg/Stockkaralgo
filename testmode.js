'use strict';
// TEST MODE (paper) rows: how they are worded and how they are kept honest.
//
// 2026-09-09 audit ("test mode has taken more trades but the algo shows 2 of
// 3"). Two things were true at once:
//   1. paper rows were written with the LIVE status text ("DHAN ENTRY +
//      FOREVER OCO", "DHAN ENTRY PENDING - awaiting fill"), so a test log read
//      like real broker orders;
//   2. the wizard's "Record Test Run" button wrote rows with no jobId and no
//      duplicate guard, so a double click recorded the same three stocks twice
//      and none of the six ever counted against any algo's slots.
// Everything here is pure so it can be tested without a server.

const BROKER_WORD = /^(DHAN|ZERODHA|UPSTOX|ANGEL ONE|ANGELONE|ANGEL|FYERS)\b/;

function brokerWord(broker) {
  return String(broker || 'dhan').toUpperCase();
}

// A live status ("DHAN ENTRY + FOREVER OCO") reworded for a paper row
// ("DHAN TEST ENTRY + FOREVER OCO"). The broker name stays - the user picked
// that broker's order shape and the simulator mirrors it - but TEST sits
// right after it so the row can never be read as a real order. Adds no
// closing token, so isOpenOrderLogEntry still treats the row as open.
function paperStatusText(broker, liveText) {
  const text = String(liveText || '').trim();
  if (/\bTEST\b/.test(text)) return text;                       // already worded
  if (BROKER_WORD.test(text)) return text.replace(BROKER_WORD, '$1 TEST');
  return brokerWord(broker) + ' TEST ' + (text || 'ENTRY');
}

// The status of a row recorded by hand from the wizard (Record Test Run).
function manualTestStatus(broker) {
  return brokerWord(broker) + ' TEST ENTRY (manual test run) - no broker order';
}
const LEGACY_MANUAL_STATUS = 'TEST MODE - NO ORDER PLACED';

function isTestRow(row) {
  return !!(row && (row.testMode || row.source === 'test'));
}

function normSym(s) {
  return String(s || '').replace('NSE:', '').replace(/\s/g, '').toUpperCase();
}

// Rows recorded by hand carry no jobId. Never a second OPEN test row for the
// same symbol at the same broker: the second click, or a stock the scheduled
// algo already holds on paper, is skipped and named back to the caller.
function dedupeManualTestRows(incoming, existing, isOpen) {
  const open = new Set();
  (existing || []).forEach(e => { if (isTestRow(e) && isOpen(e)) open.add(brokerWord(e.broker) + ':' + normSym(e.symbol)); });
  const rows = [], skipped = [];
  (incoming || []).forEach(r => {
    const key = brokerWord(r.broker) + ':' + normSym(r.symbol);
    if (!normSym(r.symbol)) { rows.push(r); return; }
    if (open.has(key)) { skipped.push({ symbol: normSym(r.symbol), reason: 'already open in the test log' }); return; }
    open.add(key);
    rows.push(r);
  });
  return { rows, skipped };
}

// Open rows in the same log that are NOT this job's, named by who wrote them,
// so the slot dialog can show why the log holds more than the count. Manual
// rows have no jobId; other algos' rows carry theirs.
function otherOpenRows(rows, jobId, isOpen, jobName) {
  const out = [];
  const seen = new Set();
  (rows || []).forEach(e => {
    if (!isOpen(e)) return;
    if (String(e.jobId || '') === String(jobId || '')) return;
    const sym = normSym(e.symbol);
    if (!sym) return;
    const by = e.jobId ? ('algo ' + ((jobName && jobName(e.jobId)) || e.jobId)) : (isTestRow(e) ? 'manual test run' : 'manual order');
    const key = sym + '|' + by;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ symbol: sym, by });
  });
  return out;
}

module.exports = { paperStatusText, manualTestStatus, LEGACY_MANUAL_STATUS, isTestRow, dedupeManualTestRows, otherOpenRows, normSym };
