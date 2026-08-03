/**
 * broker-reasons.js — translate raw broker rejections into the actual fix.
 *
 * Brokers reject protective SELLs with jargon ("EDIS auth pending",
 * "DDPI/POA not active", "RMS:Debit not allowed"). The user sees a failed stop
 * and has no idea the cause is a one-time account setting. The classic case is
 * DDPI: without it Dhan rejects EVERY sell the app places against holdings, so
 * every Forever/GTT is skipped and every position runs naked — and the user
 * reads that as "the algo is broken".
 *
 * classify(raw) returns { key, hint } for a recognised cause, else null. The
 * hint names the fix, not just the failure. withHint(raw) appends it to the
 * message wherever the raw text is already shown (status, Telegram, order log,
 * scan line) so every surface explains itself with one wiring.
 *
 * Patterns are deliberately conservative: a miss shows the raw broker text as
 * before (no worse than today); a wrong match would send someone to fix the
 * wrong setting.
 */
'use strict';

const RULES = [
  {
    key: 'ddpi',
    // DDPI / POA not active, eDIS / TPIN authorisation wording, and RMS
    // "debit not allowed" phrasings — all the same root cause: the broker may
    // not debit shares from the demat, so protective SELLs are refused.
    re: /ddpi|\bpoa\b|e-?dis|\btpin\b|debit\s+(?:transaction\s+)?not\s+allowed|not\s+authori[sz]ed?\s+to\s+(?:sell|debit)|demat\s+(?:debit\s+)?authori[sz]ation/i,
    hint: 'DDPI is not enabled on this account, so the broker rejects every SELL the app places to protect holdings — that is why the stop/target order was skipped. Enable it once (Dhan app → Profile → DDPI; Zerodha: Console → Account → Demat authorisation), then stops arm automatically.',
  },
  {
    key: 'gtt-limit',
    re: /gtt.*(?:limit|maximum|max\s+count)|(?:limit|maximum).*gtt/i,
    hint: 'The broker’s GTT limit is full — delete unused GTTs in the broker app to free slots.',
  },
  {
    key: 'holdings-unavailable',
    re: /insufficient\s+holding|holding\s+not\s+available|no\s+holdings?\s+(?:found|available)|quantity\s+not\s+available.*(?:holding|demat)/i,
    hint: 'The broker says the shares are not (yet) in the demat — T+1 settlement lag or they were sold elsewhere. The app retries automatically.',
  },
];

function classify(raw) {
  const text = String(raw || '');
  if (!text) return null;
  for (const r of RULES) if (r.re.test(text)) return { key: r.key, hint: r.hint };
  return null;
}

/** The raw message, with the actual fix appended when the cause is recognised. */
function withHint(raw) {
  const c = classify(raw);
  return c ? String(raw) + ' — ' + c.hint : String(raw == null ? '' : raw);
}

module.exports = { classify, withHint, RULES };
