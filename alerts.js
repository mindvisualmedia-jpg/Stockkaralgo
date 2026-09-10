'use strict';
// Alert hygiene (2026-09-10, "continuous alerts coming").
//
// Two pure pieces, both born from the same screenshot: a box announcing "DHAN
// data is reliable again" every eight minutes, with nothing at the broker
// having changed.
//
//   readGateStep  - the read-sanity gate as a state machine. The old code
//                   reset its suspect streak to zero the moment the gate
//                   released by PERSISTENCE, so the very next pass was suspect
//                   again, the streak climbed, released again, and re-alerted -
//                   forever, every (threshold + 1) passes. A release by
//                   persistence now HOLDS: nothing is announced again until a
//                   tracked id is actually seen (a real recovery), which is the
//                   only event worth a message.
//
//   makeDeduper   - the last line of defence in sendTelegram: the SAME text
//                   inside the window is dropped. A loop that slips past every
//                   per-site throttle can still only reach the user once per
//                   window. Messages that differ (another symbol, another
//                   number) are never touched.

/**
 * @param {{streak:number, believed:boolean}} prev   the broker's gate state before this pass
 * @param {{knownIds:string[], seenIds:Set<string>|string[], listNonEmpty:boolean, readLooksBroken:Function}} o
 * @returns {{suspect:boolean, streak:number, believed:boolean, event:''|'suspect'|'believed'|'recovered'}}
 */
function readGateStep(prev, o) {
  const p = { streak: Number(prev && prev.streak) || 0, believed: !!(prev && prev.believed) };
  const known = [...new Set((o.knownIds || []).filter(Boolean).map(String))];
  const seen = o.seenIds instanceof Set ? o.seenIds : new Set((o.seenIds || []).map(String));
  const matched = known.some(id => seen.has(id));
  const suspect = !!o.readLooksBroken(known, seen, { listNonEmpty: !!o.listNonEmpty, consecutiveSuspects: p.streak });
  if (suspect) {
    // Still doubting the read. The first suspect pass of an episode is the
    // one to mention; every later pass is the same fact.
    return { suspect: true, streak: p.streak + 1, believed: false, event: p.streak === 0 && !p.believed ? 'suspect' : '' };
  }
  if (!known.length || matched) {
    // A real read: nothing tracked (nothing to doubt) or a tracked id is
    // visible. Leaving an episode - suspect or believed - is a recovery.
    return { suspect: false, streak: 0, believed: false, event: (p.streak > 0 || p.believed) ? 'recovered' : '' };
  }
  // 0/N known, released by persistence. HOLD the streak so the next pass
  // stays released (readLooksBroken keeps answering false at this count)
  // instead of restarting the count and re-announcing. Announced ONCE.
  return { suspect: false, streak: p.streak, believed: true, event: p.believed ? '' : 'believed' };
}

/**
 * A duplicate filter for outgoing alerts: identical text within `windowMs` is
 * dropped. Bounded memory (the map is pruned as it grows).
 * @returns {{shouldSend:(text:string, now?:number)=>boolean, size:()=>number}}
 */
function makeDeduper(windowMs = 30 * 60 * 1000, maxEntries = 500) {
  const seen = new Map();   // text -> last sent at
  return {
    shouldSend(text, now) {
      const t = Number(now) || Date.now();
      const key = String(text || '');
      const last = seen.get(key);
      if (last !== undefined && t - last < windowMs) return false;
      seen.set(key, t);
      if (seen.size > maxEntries) {
        for (const [k, at] of seen) { if (t - at >= windowMs) seen.delete(k); }
        if (seen.size > maxEntries) seen.delete(seen.keys().next().value);
      }
      return true;
    },
    size() { return seen.size; },
  };
}

module.exports = { readGateStep, makeDeduper };
