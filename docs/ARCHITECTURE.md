# Stockkar Position Engine — Target Architecture & Migration Plan

Status: **Phase 2 in progress** (engine + Dhan adapter + shadow mode built, validating on staging)
Last updated: 2026-07-04

## Why (the incidents that forced this)

| Incident | Root cause |
|---|---|
| Crash loop (`planExitOps`) | Test Mode is a parallel implementation; live-only paths untested |
| SAMHI stuck open after T1+T2 | Exit detection watched order lists; completed Forevers vanish from Dhan's list |
| T1/SL→cost not ticking live | Vanished leg treated as unknown; no broker-truth reasoning |
| INDOAMIN phantom protection (T2T) | **Trust-on-write**: 200+orderId recorded as "protected", RMS rejected async |
| Max Open daily over-trade | Two sources of truth (log rows vs broker holdings) drifting on multi-day holds |
| Every fix shipped twice (Dhan, then Zerodha) | No broker abstraction; per-broker copy-paste reconciles |

**One rule fixes the class:** _a write never advances state — only broker-read
evidence does. "Protected" means "seen live at the broker", never "we sent it"._

## Components

- **`engine.js`** — pure position state machine. All rules exist ONCE here:
  entry fill → protection due → protection VERIFIED live → T1 book (incl. the
  "runner alive ⟹ T1 hit target" broker-truth rule) → SL→cost (pre-T1 both
  legs, post-T1 runner) → verify-after-modify (stale-stop alerts) → close
  reconstruction from fills (split-aware) → UNPROTECTED detection with grace.
  No I/O; a function of `(position, snapshot, now)`.
- **`engine.test.js`** — regression suite; every past incident is a test.
- **`brokers/dhan.js`** — Dhan adapter: `getSnapshot()` = one sweep of
  forever list + order book + holdings + positions, normalized. `complete:false`
  on any fetch error ⟹ the engine does nothing (fail-safe).
- **`brokers/zerodha.js`** *(next)* — same contract from GTT list + orders +
  holdings + positions. The engine is untouched.
- **Paper adapter** *(later)* — Test Mode feeds the SAME engine a simulated
  snapshot: live and test can no longer diverge.

## States

```
ENTRY_PENDING → ENTRY_DEAD
      ↓ (fill seen at broker)
PROTECTION_PENDING → PROTECTED ⇄ (t1Booked, costMoved, pendingSl verified)
      ↓ grace            ↓ vanished while held (grace)      ↓ flat at broker
  UNPROTECTED ←──────────┘                               CLOSED
      └→ CLOSED (manual exit) / PROTECTED (protection live again)
```

Every transition requires snapshot evidence. Incomplete snapshot ⟹ no change,
no actions, ever.

## Migration flow (strangler pattern)

1. **DONE** — engine + tests + Dhan adapter.
2. **DONE** — Zerodha adapter (same engine, `brokers/zerodha.js`) + adapter
   normalizer tests (`brokers/brokers.test.js`).
3. **NOW — shadow mode, BOTH brokers** (`STOCKKAR_ENGINE_SHADOW=1`, staging):
   the engine runs read-only beside the existing reconciles every 2 min and
   logs what it WOULD do (`[ENGINE-SHADOW][broker]` lines in pm2 logs). No
   writes, no orders, no alerts. Validate across live sessions.
4. **Cutover** (`STOCKKAR_ENGINE=1`, staging → main): engine becomes the
   writer; old per-broker reconciles retired. Executor pattern: engine emits
   actions (`PLACE_PROTECTION`, `MOVE_SL_TO_COST`), the adapter executes them,
   and the result is only believed when a later snapshot shows it (`pendingSl`).
5. **Paper adapter for Test Mode** → delete the parallel paper implementation.
6. **Daily rituals**: 8:45 token preflight, 9:00 morning protection audit
   (every held position's protection live at expected SL), boot recovery pass.

## Migration log

| Date | Step | Evidence |
|---|---|---|
| 2026-07-04 | engine.js + 21 regression tests (all July incidents encoded) | suite green |
| 2026-07-04 | brokers/dhan.js getSnapshot (read-only) | — |
| 2026-07-04 | shadow mode wired (Dhan), STOCKKAR_ENGINE_SHADOW=1 | — |
| 2026-07-04 | brokers/zerodha.js + 10 normalizer fixture tests; shadow covers both brokers | suite green (34 total) |
| 2026-07-04 | cutover executor BUILT (STOCKKAR_ENGINE=1, default OFF): engine writes rows, executes MOVE_SL_TO_COST via the existing broker write fns, sets `enginePendingSl` (✓ only after a later snapshot verifies), replaces 7 legacy reconciles when ON. Scope v1 = post-entry lifecycle; entry, protect-after-fill and EMA trailing stay legacy | suite green (34) |
| 2026-07-04 | daily operational assurance built (default ON, kill switch STOCKKAR_DAILY_ASSURANCE=0): 08:45 token preflight, 09:00 protection audit (stop LIVE at EXPECTED price — catches silent trail failures + corporate-action GTT deletions), 15:35 EOD reconciliation digest, post-restart audit. Read-only + Telegram only | suite green (34) |
| 2026-07-04 | position INVARIANTS: engine can never emit T2-without-T1 (reconstructClose forces T2⟹T1); `invariantViolations()` detects impossible row states (T2-w/o-T1, split+trailing, leg-qty mismatch, cost-tick-on-UNPROTECTED, P&L-while-open) and the daily audits sweep every row for them | suite green (40) |
| 2026-07-04 | RE-ARM as engine actions: (5) MODIFY_SL re-asserts a DRIFTED stop (broker trigger ≠ expected, e.g. silently failed trail) with SL_DRIFT alert; UNPROTECTED+held emits REARM_PROTECTION (executor: restoreBrokerStop + attempt caps + 10-min cooldown + kill switch); (6) REFRESH_PROTECTION when a GTT is <30d from 1-yr expiry (adapter exposes expiresAt; modify resets clock, 1/day). All fixes verified by the next snapshot (pendingSl) | suite green (45) |
| 2026-07-04 | T2T entry gate: NSE series from Dhan scrip master (dhanSeriesCache); BE/BZ/BT/T skipped at scan selection (kill switch STOCKKAR_SKIP_T2T=0; fail-open, UNPROTECTED recheck backstops) | — |
| 2026-07-04 | single-writer rule: mutateOrderLog/updateOrderLogRow are the only sanctioned log mutations (atomic sync read-modify-write, no async gap) | — |
| 2026-07-04 | partial fills: protect-after-fill (Dhan+Zerodha) sizes protection to FILLED qty, corrects row qty, records broker-truth entry price, alerts on partial | — |
| 2026-07-04 | event history: executor appends capped per-row events (state changes/actions/alerts) for post-hoc reconstruction. Structured-ids migration deferred to legacy retirement | — |
| 2026-07-04 | adversarial loophole review; 4 fixed: L1 re-assert is now DIRECTION-AWARE (never lowers a stop; adopts a higher broker trigger into the row), L2 trigger-less live legs (triggered GTT) excluded from SL confirmation (no false-stale/modify loop), L3 cross-day split closes add the recorded T1 P&L (order books are today-only) in engine + both legacy close-detectors, L4 partial-fill-then-cancel now PROTECTS the filled shares instead of marking REJECTED (+ Dhan PART_TRADED no longer treated as final) | suite green (48) |
| 2026-07-04 | drift AUTO-FIX pre-cutover (checkDriftedStops, 5-min, kill switch STOCKKAR_DRIFT_AUTOFIX=0): live broker trigger vs expected SL; below -> re-assert via engineModifySl + Telegram (3/day cap, 10-min cooldown, next cycle re-verifies); above -> adopt broker truth (never lower). Yields to the engine when STOCKKAR_ENGINE=1 | suite green (48) |
| 2026-07-04 | protection-integrity batch (folded into the 5-min pass): (a) orphaned Zerodha GTT after a dead entry -> cancelled + row REJECTED (Dhan already had its own); (b) duplicate ATTRIBUTABLE protection (re-arm/restore race) -> historical extras cancelled, current kept; (c) protection qty > held qty (partial manual exit) -> single-leg rows resized to held, splits alert-only; adapters now expose protection qty. Plus ATOMIC order-log writes (tmp+rename, .bak read-fallback — a corrupt log no longer erases itself) | suite green (48) |
| 2026-07-06 | Monday live finding #1 (staging.1): four legacy tasks managed `awaitingFill` rows (MTM SL→cost on non-existent Forever, phantom live P&L, naked-stop restore risk, split cost-move) — all guarded + stale P&L/fail-badge self-heal (staging.2). Engine test: ENTRY_PENDING manages nothing even past the cost trigger | suite green (50) |
| 2026-07-06 | Monday live finding #2 (staging.1): FALSE UNPROTECTED on a genuinely protected position — (i) empty/glitched Forever/GTT list counted as evidence, (ii) once flagged, rows were excluded from re-check so a false flag was PERMANENT. Fixed both brokers + engine: empty list = weak evidence (4x grace: 12 min), UN-FLAG self-heal (row's own id live at broker ⟹ flag cleared + 🟢 re-verified alert), alert wording says "verify in app; auto-clears if active" (staging.3) | suite green (52) |
| _pending_ | Monday session: shadow decisions vs live reconciles, both brokers | paste `[ENGINE-SHADOW]` lines here |
| _pending_ | ENABLE cutover on staging box (STOCKKAR_ENGINE=1) | requires ≥3 clean shadow sessions |

## Known limitations (accepted, documented)

- **Symbol-level attribution (L5):** holdings and fills can't be split by lot.
  If the trader MANUALLY buys a stock the algo already holds (entry gates block
  the reverse), closes are delayed (conservative — never a false close) and a
  combined manual+algo full exit can blend fills into P&L. Fix requires lot
  tracking; revisit after cutover.
- **Dhan/Zerodha order books are today-only:** exits whose fills happened on
  earlier days close with `exitEstimated: true` (target/SL price assumed) when
  no recorded leg P&L exists.
- **Software features (trailing, cost-trigger watch) pause while the process is
  down**; broker-held OCOs keep protecting. Boot recovery audits on restart.

## Validation gate for each cutover (money-critical)

- Shadow logs across ≥3 live sessions with open positions show no
  wrong decision (false close, false UNPROTECTED, missed exit).
- Engine regression suite green.
- Cutover flag defaults OFF on `main`; ON on staging first; per-box opt-in
  before it becomes default.
