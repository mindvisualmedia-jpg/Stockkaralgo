# Zerodha Pre-Cutover Audit — 2026-08-07

First full execution of the D-checklist (CUTOVER-INVENTORY.md). Method: two
independent code sweeps (every close path; entry/protection/modify/restore/
executor/adapter surface), findings ranked, P0s fixed same day.

Owner context: Zerodha has traded well in practice (GTT, SL-to-cost, trailing
all functioning). Consistent with the audit: the core paths ARE fill-evidenced.
The findings below were LATENT — they needed a specific bad day (an exit order
rejecting after a trigger; a reconcile catching an unfilled exit limit), the
same way FYERS's leg1 bug and Dhan's TATASTEEL sat dormant until they didn't.

## Close-path verdicts (before → after)

| Site | Was | Now |
|---|---|---|
| Z1a entry rejected | fill-evidenced | unchanged |
| Z1b GTT leg COMPLETE | fill-evidenced | + zerodhaFillGuard (held/sells veto) |
| Z1b' exit order REJECTED after trigger | **closed the row, cancelled its GTT as "orphan", could halt the job — on a position still held** | UNPROTECTED latch: row stays open, restore re-arms, Telegram once; orphan-cancel now fires for ENTRY rejects only |
| Z1c price fallback | **closed on a triggered GTT's UNFILLED limit price (the Zerodha TATASTEEL); `\|\| sells[0]` let a pre-entry sell close a new row** | exit-price lookup accepts FILLS only; stale-sell fallback removed; close guarded |
| Z2 split reconcile | fill-evidenced (resolveSplitExit) | unchanged |
| Z3 GTT-gone close | holdings-guarded | unchanged |
| Z3b no-fill estimated | guarded + reversible | unchanged |
| Z4 verify pass | flag-only | unchanged |

## Other P0s fixed today

- **Restore candidacy** was the thinnest of the four brokers — no held gate,
  no id match, no read-suspect sanity, no min-age. Now at full parity with
  FYERS/Angel (syms ∪ ids, zerodhaReadSuspect, PROTECTION_RESTORE_MIN_AGE_MS).
- **restoreZerodhaStop** placed without cancelling the old GTT (the stacking
  class). Now cancel-before-replace across zerodhaGttId/T1/parsed ids.
- **modifyZerodhaGttStopLoss** wrote full entry.qty after T1 (the wrong-qty
  class). Now runner-true (mtmRemainingQty / splitLegBQty when mtmT1Done).
- **No last-line duplicate guard** — hasOpenZerodhaOrder added and wired into
  both entry paths + /holdings/adopt.
- **Kite error envelope** — a body-level `status:'error'` at HTTP 200 unwrapped
  to undefined and read as an empty list (contract clause 1 violation; the
  liveness probe inherited it). Adapter now fails the snapshot; fixtures pin it.
- **/debug/zerodha** added (raw payloads vs adapter normalization — the audit
  evidence surface, parity with fyers/angelone).

## Open items — the Zerodha FLIP GATES

1. **No-SL Zerodha rows are UNOWNED** (audit's biggest structural find): the
   No-SL reconcile filters broker==='dhan'; verify/restore exclude rows without
   a GTT id / slPrice. A Zerodha No-SL row's target legs get no verification,
   no restore, no orphan-cancel, no fill-close. Options at port time: extend
   reconcileNoSlDhanTargets (planNoSlRow is already pure) or block No-SL for
   Zerodha in the wizard until owned. MUST resolve before flip.
2. **#14 SME symbol mapping** (existing gate).
3. **getSnapshot fixtures**: gttState is covered (6 fixtures) but there is no
   full-snapshot normalization fixture (orders/holdings/positions/sells).
4. Executor: place/cancel actions absent by design (entry lifecycle stays
   legacy in v1) — matches Dhan; not a gap vs the current cutover scope.
5. Token base chain uses updatedAt||savedAt (no renewedAt) — cosmetic, login
   updates updatedAt; no action.

## Contract clauses (D3) — status

1 error envelopes: **fixed today** · 2 trigger≠fill: adapter was already
correct per-leg; legacy Z1b'/Z1c fixed today · 3 fixtures: gttState yes,
snapshot no (gate 3) · 4 holdings ∪ positions: yes (incl. t1_quantity + MTF)
· 5 complete:false on error: yes.

D6 (shadow soak with digest) pending #40; D7 (flip) blocked on gates above.
