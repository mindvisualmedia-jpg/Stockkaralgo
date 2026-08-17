'use strict';

/**
 * ids.js — ONE place that knows how a row names its broker orders.
 *
 * Before this, the same question had five answers that drifted:
 *   engineShadowPosition() · assuranceProtectiveIds() · paper's idsFromRow ·
 *   rowGids/rowFids/fyersRowGttIds/zerodhaRowGttIds/angelRowRuleIds in the
 *   restore sweep and verify passes · inline copies in /debug/*.
 *
 * Drift between them is not theoretical. 2026-08-13: the engine correctly named
 * the ONE surviving leg in MOVE_SL_TO_COST while the executor re-derived both
 * legs from row fields and modified a cancelled one, failing the whole action;
 * and paper had no Angel branch, so an Angel test row silently read Dhan fields.
 *
 * ============================ FAITHFULNESS RULE ============================
 * legs()/entryId here are a BYTE-FAITHFUL port of engineShadowPosition's id
 * derivation (server.js). Not a better one - the same one. ids.test.js runs a
 * verbatim copy of the engine's derivation against every fixture and asserts
 * identical output, so consolidating cannot move engine behaviour by accident.
 *
 * Known quirks are preserved DELIBERATELY, each marked QUIRK below. Changing
 * one is a separate, deliberate change with its own test and its own commit -
 * never a side effect of consolidation.
 * ==========================================================================
 *
 * Pure: a function of the row. No I/O, no clock.
 */

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const clean = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** The engine's exact token set and regex. Do not extend: adding a token can
 *  change which id a row resolves to (e.g. listing T1GTT before GTT stops
 *  "T1GTT:9388" from also matching GTT). */
const ENGINE_ID_RE = /(ENTRY|FOREVER-T1|FOREVER|GTT-T1|SLGTT|SLRULE|GTT):([^|\s]+)/gi;

/** Extra tokens no engine path reads, harvested only for `all` (cleanup
 *  paths that must recognise an id before cancelling it). */
const EXTRA_ID_RE = /(T1GTT|TARGET):([^|\s]+)/gi;

function parseWith(re, orderId) {
  const out = {};
  const rx = new RegExp(re.source, re.flags);
  let m;
  while ((m = rx.exec(String(orderId || '')))) out[m[1].toUpperCase()] = m[2].trim();
  return out;
}

/**
 * @returns {{ broker, entry, t1, runner,
 *             legs: Array<{id, role:'t1'|'runner'|'single', qty:number}>,
 *             all: string[] }}
 */
function rowIds(row) {
  const r = row || {};
  const broker = String(r.broker || 'dhan').toLowerCase();
  const fids = parseWith(ENGINE_ID_RE, r.orderId);

  const t1Id = broker === 'zerodha' ? (r.zerodhaGttT1Id || fids['GTT-T1'] || '')
    : broker === 'fyers' ? (r.fyersGttT1Id || fids['GTT-T1'] || '')
    // QUIRK: Angel legA reads the FIELD only - no string fallback - so an Angel
    // split row carrying ids only in orderId has no t1 leg. Preserved.
    : broker === 'angelone' ? (r.angelOneGttT1Id || '')
    : (r.dhanForeverT1Id || fids['FOREVER-T1'] || '');

  const runId = broker === 'zerodha' ? (r.zerodhaGttId || fids['GTT'] || '')
    : broker === 'fyers' ? (r.fyersGttId || fids['GTT'] || '')
    // mtmRemainderSlOrderId wins: after a remainder re-arm the old rule id is stale.
    : broker === 'angelone' ? (r.mtmRemainderSlOrderId || r.angelOneSlRuleId || fids['SLGTT'] || fids['SLRULE'] || '')
    : (r.dhanForeverId || fids['FOREVER'] || '');

  const legs = [];
  // QUIRK: the T1 leg is listed whenever the row is split and has a legA id -
  // INCLUDING after T1 books, when legA is terminal at the broker. The engine
  // relies on seeing it (rule 1 reads t1Leg.status to detect the booking), and
  // writers must therefore filter by LIVE evidence rather than by this list.
  // Preserved exactly.
  if (r.splitT1 && t1Id) legs.push({ id: t1Id, role: 't1', qty: num(r.splitLegAQty) });
  if (runId) {
    legs.push({
      id: runId,
      role: r.splitT1 ? 'runner' : 'single',
      // QUIRK: no mtmRemainingQty fallback - a split runner reads splitLegBQty
      // only, and 0 when that is absent. Preserved.
      qty: num(r.splitT1 ? r.splitLegBQty : r.qty),
    });
  }

  const entry = r.dhanEntryOrderId || r.zerodhaEntryOrderId || r.fyersEntryOrderId
    || r.angelOneEntryOrderId || fids['ENTRY'] || '';

  // Superset: every protective id this row has ever named, terminal ones
  // included. NEW surface - no engine path reads it.
  const extras = parseWith(EXTRA_ID_RE, r.orderId);
  const all = [...new Set([
    t1Id, runId,
    r.dhanForeverId, r.dhanForeverT1Id, r.zerodhaGttId, r.zerodhaGttT1Id,
    r.fyersGttId, r.fyersGttT1Id, r.angelOneSlRuleId, r.angelOneGttT1Id, r.mtmRemainderSlOrderId,
    fids['FOREVER'], fids['FOREVER-T1'], fids['GTT'], fids['GTT-T1'], fids['SLGTT'], fids['SLRULE'],
    extras['T1GTT'],
    // No-SL target legs (engine TARGETS_ONLY, 2026-08-17): owned ids, so a
    // standing target trigger is never reported as an orphan of its own row.
    r.dhanTargetT1Id, r.dhanTargetT2Id, r.zerodhaTargetT1Id, r.zerodhaTargetT2Id, r.angelTargetT1Id, r.angelTargetT2Id,
  ].map(clean).filter(Boolean))];

  return { broker, entry: clean(entry), t1: clean(t1Id), runner: clean(runId), legs, all };
}

/** Ids a snapshot must be able to see for these rows to be judged at all —
 *  the input to the read-sanity gate (broker-policy.readLooksBroken). */
function knownProtectionIds(rows) {
  const out = [];
  (Array.isArray(rows) ? rows : []).forEach(r => rowIds(r).all.forEach(id => out.push(id)));
  return [...new Set(out)];
}

module.exports = { rowIds, knownProtectionIds };
