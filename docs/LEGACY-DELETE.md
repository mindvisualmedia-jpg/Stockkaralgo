# LEGACY-DELETE — the full legacy-writer retirement (2026-08-21)

Owner's call: delete ALL legacy lifecycle writers in one release, validate on
staging in the next live session, then merge. Dhan's verifier went first
(3.14.3-staging.5, evidence in that commit); this completes the retirement.

Ground truth that makes this safe: since 3.14.0 every default box runs the
engine as the single lifecycle writer. Every function below is either never
scheduled on a default box (`LEGACY_LIFECYCLE_WRITERS_ON` = false everywhere
except opt-out boxes) or row-gated to skip engine-owned rows (which on Dhan/
Zerodha/FYERS/Angel is every lifecycle row class: OCO, split, No-SL,
protection-failed, closed-12h). Deleting them changes NOTHING at runtime on a
default box; what it removes is (a) the dormant second writer that a gate bug
could wake (the ARIS/FEDFINA class), (b) the `STOCKKAR_ENGINE=0` trap that
would leave positions with no writer at all, and (c) ~2,800 lines of the most
dangerous kind of code to maintain.

## Deleted (audited caller-by-caller before the cut)

Per-broker passes (scheduled only via `!engineOwns` / `!ENGINE_LEGACY_OFF`
task pushes in refreshBrokerOrderLogStatuses, which go with them):
- verifyZerodhaGttProtection, verifyFyersGttProtection,
  verifyAngelGttProtection (+ verifyProtectionUnflagPass, their un-flag
  wrapper; sweepRowArtifacts keeps its timer)
- refreshDhanForeverOrderLogStatus, refreshDhanForeverSplitOrderLogStatus,
  closeCompletedDhanForevers
- refreshZerodhaSplitOrderLogStatus, closeCompletedZerodhaGtts,
  zerodhaGttProtects (only users: two deleted passes)
- refreshFyersSplitOrderLogStatus
- reconcileAngelSplitOcos, checkAngelSlBackstop
- reconcileNoSlDhanTargets, reconcileNoSlZerodhaTargets
- PROTECTION_RECHECK_GRACE_MS / PROTECTION_EMPTYLIST_GRACE_MS (all three
  remaining users were the deleted verifiers)

Cross-broker writers (never scheduled on a default box):
- checkMtmRules + runMtmPass + executeMtmExit (mtmLiveExitEnabled stays: engine rule-8 gate)
  (+ mtmCheckInFlight/mtmLastCheckAt)
- checkDailyEmaTrailing + emaTrailingExitAtMarket (only caller)
- checkEmaTrailingTargetTriggers
- checkAndRestoreBrokerStops (+ restoreStopsLastAt/InFlight) — the SWEEP only;
  restoreBrokerStop and the per-broker restore*Stop placement helpers are the
  ENGINE's REARM implementation and stay
- chaseStuckExits — the sweep only; chaseListOpenSells/chaseHeldQty are used
  by the engine's CHASE_EXIT executor (16129/16141) and stay
- checkSplitMoveToCost + moveSplitLegBTo + checkSplitSlToT1
- checkDriftedStops + DRIFT_AUTOFIX

Env hardening:
- ENGINE_MODE and ENGINE_LEGACY_OFF are now constants (true). With the legacy
  writers gone, `STOCKKAR_ENGINE=0` would have meant NO writer at all — the
  opt-out is retired and logged loudly if the env var is still set.
- LEGACY_LIFECYCLE_WRITERS_ON deleted with its schedule lines.

## Audit catches (why the slow pass mattered)
- verifyAngelGttProtection was missing from the first inventory.
- chaseListOpenSells/chaseHeldQty looked legacy but are engine executor deps.
- placeAngelOneMarketExit is shared: checkAngelOneSoftwareTargets (stays,
  self-retiring) still calls it — function stays.
- fetchZerodhaHeldSymbols / fetchFyersHeldSymbols / fetchDhanForeverList /
  zerodhaCancelGtt / patchOrderLogEntry / protectFilledEntry: all shared with
  live paths (protect-after-fill, engine cancel map, retry endpoint) — stay.
- Retry-stop-loss endpoint called three legacy sweeps directly. On engine
  boxes those calls were already no-ops (row-gated). It now clears the
  counters and nudges runEngineCutover() — the engine re-arms/re-places at
  once instead of on the next 2-min tick. Feature improved, not lost.

## Stays legacy BY DESIGN (untouched)
Entry placement + scan paths, protect-after-fill (placeProtectionForFilled*),
cancelOrphanedDhanForevers + morning orphan audit, closeAbandonedRows janitor,
base status refreshers (refreshDhan/Zerodha/Fyers/AngelOne/UpstoxOrderLogStatus
— display + row-gated), relabelAngelProtectionRows,
checkAngelOneSoftwareTargets (self-retiring single-leg server), paper pass,
reopenFalselyClosedPositions, sweepRowArtifacts, engine shadow machinery
(dormant validation, later sweep).

## Rollback
`git revert` of this release. There is no env-var rollback anymore — that is
the point.
