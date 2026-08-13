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
    key: 'rate-limit',
    // MUST be matched BEFORE 'gtt-limit' (2026-08-13, SOUTHWEST). Our own
    // wrapper reads "GTT protection (SL+target) FAILED: Request limit
    // reached", so the old gtt-limit pattern matched "gtt ... limit" ACROSS
    // that wrapper and told the user the broker's GTT book was full — advice
    // whose action is "delete unused GTTs in the broker app", i.e. delete live
    // stops, while the truth was a passing throttle. A hint that sends someone
    // to REMOVE protection is worse than no hint at all.
    re: /request\s*limit\s*reached|rate\s*limit|too\s*many\s*requests?|breaching\s*rate|\b429\b/i,
    hint: 'The broker is throttling API calls right now - temporary, and nothing to do with this order. The app backs off and retries on its own; if it is still failing after a few minutes, place the stop manually.',
  },
  {
    key: 'gtt-limit',
    // ADJACENT wording only. `.*` let this span our own message text; a real
    // capacity message says "GTT limit", "maximum GTT", "max number of GTTs".
    re: /(?:gtt|trigger)s?\s*(?:count\s*)?(?:limit|maximum|max\s+count)|(?:maximum|max)\s+(?:number\s+of\s+)?(?:gtt|trigger)s?/i,
    hint: 'The broker’s GTT limit is full — delete unused GTTs in the broker app to free slots.',
  },
  {
    key: 'holdings-unavailable',
    re: /insufficient\s+holding|holding\s+not\s+available|no\s+holdings?\s+(?:found|available)|quantity\s+not\s+available.*(?:holding|demat)/i,
    hint: 'The broker says the shares are not (yet) in the demat — T+1 settlement lag or they were sold elsewhere. The app retries automatically.',
  },
  {
    // Angel One AB4036 (verified 2026-08-11, JUBLFOOD/SAGILITY): the exchange
    // requires a caution-consent popup for surveillance-flagged scrips, which
    // cannot exist over an API — so Angel BLOCKS such scrips from API orders
    // entirely. Not a credential, token or symbol problem; NO algo can trade
    // these on Angel One.
    key: 'angel-caution-block',
    re: /caution(?:ary)?\s*listing|AB4036/i,
    hint: 'Angel One does not allow API orders on stocks flagged under exchange surveillance (their error AB4036): the mandatory caution-consent popup cannot be shown through an API. The stock is skipped for today — you can still trade it manually in the Angel One app. Nothing is wrong with your token or setup.',
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
