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
| _pending_ | Monday session: shadow decisions vs live reconciles, both brokers | paste `[ENGINE-SHADOW]` lines here |
| _pending_ | ENABLE cutover on staging box (STOCKKAR_ENGINE=1) | requires ≥3 clean shadow sessions |

## Validation gate for each cutover (money-critical)

- Shadow logs across ≥3 live sessions with open positions show no
  wrong decision (false close, false UNPROTECTED, missed exit).
- Engine regression suite green.
- Cutover flag defaults OFF on `main`; ON on staging first; per-box opt-in
  before it becomes default.
