# Stockkar — Evidence Rules, Engine Flow, Guardrails & Self-Heal

Status: reference document. Updated 2026-07-06 after the Monday live findings.
Companion to ARCHITECTURE.md (migration log). Applies to Dhan AND Zerodha.

---

## 1. THE ROOT CAUSE — what is actually triggering these issues

Every incident this week reduces to ONE mistake, made in different places:

> **Treating the ABSENCE of broker data as EVIDENCE of a state change,
> when it is actually LAG in the broker's API surfaces.**

The broker is not one database. It is several surfaces with DIFFERENT freshness:

| Surface | Freshness | Trap |
|---|---|---|
| Order book (`/v2/orders`, `/orders`) | near-instant, TODAY-only | yesterday's fills invisible |
| Forever/GTT list | LAGS a just-placed order; DROPS completed ones; can glitch empty/404 | absence ≠ rejected/filled |
| Positions (`netQty`) | intraday, can lag a fresh fill by minutes | fresh buy may not show |
| Holdings | **T+1 settlement** | today's & yesterday's buys sit in t1Qty or missing |
| HTTP 200 on a write | **not evidence at all** — RMS validates async | "accepted" ≠ "exists" |

Monday's three incidents, mapped:

| Incident | The absence that was mis-read |
|---|---|
| #1 MTM SL→cost FAILED + phantom P&L on a PENDING entry | app row existed → treated as a filled position (app intent mistaken for broker state) |
| #2 False UNPROTECTED on a protected position | just-placed Forever absent from a lagging/glitched list → read as "rejected" |
| #3 **False CLOSE** (TARGET HIT on a 1-minute-old position) | Forever absent (list lag) + symbol "not held" (T+1 lag) → read as "exited", exit price FABRICATED at target |

Why did this all surface on Monday? Because the v2.58–2.59 safety features were
validated against EXISTING positions (SAMHI, INDOAMIN — days old, state settled).
Monday was the first session they met JUST-PLACED positions, where every broker
surface lags simultaneously. Fresh-position lag was the untested regime.

---

## 2. THE EVIDENCE RULES (now enforced everywhere)

The fix is a formal evidence hierarchy. No state change without the required grade.

- **E1 — A FILL** (order book: TRADED/COMPLETE with qty+price).
  The ONLY proof of an entry or an exit.
- **E2 — PRESENCE in the protection list** (own order id, live, with trigger/qty).
  The only proof that protection exists / an SL modify landed.
- **E3 — HELD** (holdings ∪ positions ∪ t1/unsettled buckets).
  Proof of ownership. A fresh buy may lag → "held" is trustworthy, "not held" is weak for fresh positions.
- **E4 — ABSENCE from a list**. WEAK. Only meaningful when ALL of:
  (a) the list is NON-EMPTY (an empty list may be a glitch),
  (b) the position is old enough that placement lag is excluded,
  (c) the absence PERSISTS across a grace window.
- **E5 — HTTP 200 on a write**: worthless. Every write is re-verified via E1/E2.

**Direction rules** (long positions):
- A stop is NEVER moved down to match an expectation; a higher broker stop is ADOPTED.
- A ✓ (cost moved / trail) is a PROMISE — audited against E2, not against possibly-stale row fields.
- False alarms must never be permanent: every flag has an un-flag path on positive evidence.
- A false CLOSE is the worst failure → closing errs toward staying OPEN; a false OPEN self-corrects, a false CLOSE drops tracking of live money.

---

## 3. THE ENGINE FLOW WITH GUARDRAILS

```
                      [scan] ── gates: T2T series | cooldown | held/broker-held |
                         │          Max Open (E3, per-algo, incl. unsettled)
                         ▼
                  ENTRY_PENDING  ←— row exists, position DOES NOT
   guards: NOTHING manages it — no MTM, no P&L, no SL-restore, no cost-move
   (4 legacy tasks violated this → all guarded, staging.2)
                         │  E1 entry fill (PART_TRADED ≠ final; cancel-after-partial
                         │  → protect the FILLED qty, never mark rejected)
                         ▼
                 PROTECTION_PENDING ←— protection SENT (E5), not believed
   guards: only E2 (own id live) advances; rejected+held → grace → UNPROTECTED
   (grace 3 min; 12 min if the list came back EMPTY — weak evidence)
                         │ E2
                         ▼
       ┌──────────── PROTECTED ────────────────────────────────┐
       │  every pass, from ONE snapshot:                       │
       │  • T1 book: E2 traded_target OR (t1 absent+runner     │
       │    live — shared SL logic)                            │
       │  • SL→cost / trail modify: E5 send → pendingSl →      │
       │    E2 confirms trigger → only then ✓                  │
       │  • drift: broker trigger BELOW expected → re-assert;  │
       │    ABOVE → adopt (never lower)                        │
       │  • expiring GTT (<30d) → refresh                      │
       └──────┬─────────────────────────┬──────────────────────┘
              │ no live legs            │ no live legs + HELD
              │ + NOT held              ▼ (grace, empty-list-aware)
              │                    UNPROTECTED ── REARM (capped) ──► PROTECTION_PENDING
              │                         │  un-flag self-heal: own id live (E2) → back
              ▼                         ▼
   E1 SELL fill? ──yes──► CLOSED (split-aware, cross-day t1Pnl added)
        │no
   fresh (<12h) OR list empty? ──yes──► STAY OPEN (lag, not exit)
        │no
   persist across 8-min grace ──then──► CLOSED (estimated, flagged ~)
                                            │
                          reopen self-heal: E2/E3 shows still live → RE-OPENED
```

Invariant sweep (daily + boot): impossible states (T2 w/o T1, cost-tick on
UNPROTECTED, split+trailing, leg-qty mismatch, P&L-while-open) are flagged —
if any code path writes a lie, the digest names it.

---

## 4. ISSUE LEDGER — every incident, its guard, its self-heal, its test

| # | Incident (date) | Guard now | Self-heal now | Test |
|---|---|---|---|---|
| 1 | SAMHI stuck open after T1+T2 (7/2) | broker-truth close via fills | — (close now detected) | SAMHI Rs.5.13 exact |
| 2 | INDOAMIN phantom protection, T2T (7/3) | verify: own-id live required; T2T entry gate | UNPROTECTED flag + restore/REARM | INDOAMIN tests |
| 3 | False "SL moved ✓" (7/3) | verify-after-modify (pendingSl); promise rule (cost ⟹ expect entry) | drift auto-fix 5-min re-assert | corrupted-field test |
| 4 | T2 ✓ before T1 (7/4) | engine can't produce it; invariant sweep | daily digest flags any source | invariant tests |
| 5 | Silent trail failure (risk) | E2 trigger check daily + 5-min drift | auto re-assert, capped, verified | drift tests |
| 6 | MTM on unfilled entry (7/6 #1) | ENTRY_PENDING manages nothing; 4 legacy tasks guarded | stale P&L/badge auto-cleared | ENTRY_PENDING+trigger test |
| 7 | False UNPROTECTED (7/6 #2) | empty list = weak evidence (12-min grace) | **un-flag pass: boot+30s, 3-min, any hour** | 3 empty-list tests |
| 8 | **False CLOSE, fabricated P&L (7/6 #3)** | close needs E1 fill; no-fill close needs >12h age + non-empty list + 8-min grace | **reopen pass: boot+45s, 4-min, any hour** | 3 fresh-lag tests |
| 9 | Naked short risks (orphans, duplicates, over-qty) | integrity pass 5-min (cancel orphan/duplicate, shrink qty) | automatic, capped, alerted | fixture tests |
| 10 | Corrupt order log = amnesia | atomic writes | .bak auto-recovery | — |

## 5. SELF-HEAL MATRIX (what heals, how fast, when)

| Wrong state | Healer | First run after deploy/boot | Cadence | Hours |
|---|---|---|---|---|
| False UNPROTECTED flag | un-flag pass | ~30 s | 3 min | ANY |
| False CLOSED (estimated) | reopen pass | ~45 s | 4 min | ANY |
| Phantom P&L / stale badge on unfilled | live-P&L pass | ~60 s | 1 min | market |
| Stop at wrong price | drift auto-fix / engine rule | ≤5 min | 5 min | market |
| Stop missing (held, unprotected) | restore / REARM | ≤2 min | 2 min | market |
| Duplicate / orphaned / oversized protection | integrity pass | ≤5 min | 5 min | market |
| Crash loop | self-heal git-pull | immediate | — | any |
| Corrupt order log | .bak fallback | on read | — | any |
| Anything else wrong | 8:45 / 9:00 / 15:35 / boot digests + invariants | daily | daily | IST |

## 6. Why "nothing self-healed" on Monday

The box ran **staging.1 all session**. Findings #6/#7/#8 were discovered ON
staging.1 and their guards+healers were built the same day in staging.2–.5 —
which were not deployed while the incidents were visible. The self-heal you
didn't see **did not exist yet on the running box**. After deploying
staging.5, the flagged row un-flags in ~30 s and the falsely-closed rows
re-open in ~45 s. That is the test of this document.

## 6b. Finding #4 — the ZOMBIE-ROW mechanism (why heals "didn't run", staging.6)

`isOpenOrderLogEntry` decided open/closed by PARSING STATUS TEXT (any REJECT/
FAIL/CANCEL word ⇒ closed). Two writers leaked trigger words into `status`:
the UNPROTECTED flag text ("Forever rejected...") and runMtmPass, which
APPENDED its notes ("| MTM SL->cost FAILED...") into `status`. Those rows
became **zombies**: treated as closed ⇒ excluded from EVERY reconcile and
self-heal ⇒ "nothing is self healing". Worst case: a contaminated
awaiting-fill row was excluded from the fill-watcher — had it filled, NO
protection would have been placed.

This is architecture problem #2 (free-text status instead of a state
machine) biting in production, and the strongest argument for cutover: the
engine's `engineState` field cannot be contaminated by wording.

Fixes (staging.6):
- **Structured state wins over text**: `protectionUnverified` / `awaitingFill`
  / `reopenedAt` (without an exitType) ⇒ OPEN, regardless of status wording.
- runMtmPass notes go to `mtmStatus` ONLY — never appended into `status`.
- Flag texts no longer contain trigger words ("no live stop" not "rejected").
- `sweepRowArtifacts` janitor (boot+30s, 3-min, ANY hour, no broker calls):
  strips leaked "| MTM ..." fragments, rewords old flags, clears stale
  fail-badges/phantom P&L on unfilled rows — so contaminated rows rejoin the
  reconciles and the un-flag/reopen heals can finally reach them.
- Updates page: a `-staging` build no longer shows main's version as an
  "update" (it read as a downgrade prompt).

## 6c. Finding #5 — RESOLVED: the week's true root cause (staging.7/.8)

`GET /v2/forever/all` returned NOTHING on a real account holding active
Forevers (while PUT by the same ids worked) — every list-based feature ran
blind for days, hidden by a silent 404→[] mapping. Confirmed live:
`[VERIFY][dhan] list=0` on every pass, then after the resilient reader:
`list=37 active=21` with the rows' own ids, and all five false UNPROTECTED
flags un-flagged themselves (🟢 RE-VERIFIED) within minutes.

Permanent rules extracted:
- ONE shared reader per broker surface, with a fallback path, pin-on-success,
  and loud logs — never N copies of a hardcoded fetch.
- NEVER map 404→empty silently where absence is treated as evidence.
- An empty list is believed only when two independent reads agree.
- Diagnostics (/debug/protection, [VERIFY] lines) stay in permanently:
  the next surface quirk gets diagnosed with data, not guesses.

## 6d. Finding #6 — STOP FIRED but EXIT OPEN mislabeled as UNPROTECTED (staging.2, 2026-07-08)

RICOAUTO / GARUDA showed "DHAN ⚠ UNPROTECTED — add manual stop", but on the
broker the stop had actually **fired**. Confirmed with data via `/debug/close`:
`foreverEntries: [{ status: "TRIGGERED", legName: "STOP_LOSS_LEG" }]`,
`foreverActive: []`, `held: true`, `sells: []` — i.e. the Forever SL leg
TRIGGERED, the resulting market SELL was still OPEN (illiquid / lower-circuit,
no buyers), and the position was still held below its stop.

Root cause: TRIGGERED forevers are (correctly) excluded from `activeIds`
(terminal), so `protectedNow=false`. The position is HELD and has no completed
SELL, so it fell straight into the UNPROTECTED path. But the stop DID its job —
telling the user to "add a manual stop" is wrong (a second stop won't fill any
better), and any re-arm would place a duplicate SELL under a position already
exiting.

Fix (`verifyDhanForeverProtection`): before flagging UNPROTECTED, detect
**own Forever leg TRIGGERED + an OPEN/PENDING SELL for the symbol** →
set `exitPending`, status `DHAN — STOP FIRED, EXIT PENDING (order open,
waiting to fill)`, alert once (🟠), and do NOT flag / re-arm. `exitPending`
rows are excluded from `checkAndRestoreBrokerStops` (no duplicate stop). Badge
self-clears when the SELL fills (close detection books it) or the row
re-protects. New `/debug/close` fields: `exitPending`, `openSells[]`.

**Day-boundary behavior (traced 2026-07-08):** a triggered Forever places a
DAY-validity order. Three outcomes are all handled:
- *Fills today* → close-detection books it CLOSED at the real fill price.
- *Still open today* → stays `exitPending` (correct — exit in progress).
- *Unfilled at EOD* → the DAY order is cancelled overnight; next session there
  is no open SELL, so the row is genuinely naked. The verify pass CLEARS the
  stale `exitPending` and lets it re-enter the normal UNPROTECTED → restore/
  re-arm flow (a fresh Forever both re-protects and, priced below market,
  serves as the exit). Without the clear, `exitPending` would have blocked the
  next-day re-arm — that was a gap in the first cut, fixed here.

## 7. Operating procedure from here

1. **Deploy staging.5** → watch the two self-heals fire (🟢 Telegrams).
2. **Feature freeze on the legacy path** — only evidence-rule fixes from here.
   All three Monday bugs were in legacy nets; the engine structurally prevented
   #6 and recovers #7, and its #8 flaw was fixed before it ever ran live.
3. **Validation gate unchanged**: shadow lines + digests across ≥3 clean
   sessions → cut Dhan over → Zerodha → retire the legacy nets this document
   spends most of its length guarding.
4. Every new failure gets: root cause in §1's terms → guard → self-heal →
   regression test → row in §4. No fix ships without all four.

## 6e. Finding #7 — MTF routed to Super Order + forever-blind restore = DOUBLE stop (staging.9, 2026-07-16)

First live MTF trade on Dhan surfaced a duplicate-protection incident, caught
by the user reading the badge: `SUPER ORDER | SL RESTORED @517.9` on one row,
AND a Forever OCO visible at Dhan for the same stock.

Chain: (1) the Forever-vs-Super dispatch gated on `segment === 'CNC'`, so the
MTF entry (an OVERNIGHT product) took the day-oriented Super Order path;
(2) the SL-restore pass verifies protection ONLY against the Forever list —
a Super Order's stop lives inside its own legs, invisible to that list — so
the held MTF position read as naked and a Forever stop was armed NEXT TO the
live super bracket. Two protections on one position: whichever fires first
exits it, the survivor later fires into nothing (naked SELL). Never seen
before because every overnight product (CNC) already used Forever — MTF was
the first overnight product to reach the Super Order path.

Fixes:
- Dispatch: `useForever` now covers CNC **and MTF** (overnight products get
  the overnight-persistent protection); only INTRADAY keeps the Super Order.
- Restore guard: dhan restore candidates must be forever-protected rows (or
  forever-missing recovery rows). "No Forever for the symbol" is NOT naked-
  evidence for a Super Order row — the pass can no longer blind-arm there.

Manual recovery for an already-doubled position: cancel the Super Order's
pending SL/target legs at Dhan, keep the restored Forever (the app manages
the row as a forever row after the restore). Verify via /debug/close: exactly
one active id for the symbol.

Rule extracted: any pass that treats "absent from list X" as "unprotected"
must first prove the row's protection LIVES in list X.

## 6f. Finding #8 — protection placed on ACCEPTANCE, log said "executed" while Dhan said 0/38 PENDING (2026-07-21)

Five CNC LIMIT entries at 10:03; three filled, Eris Lifesciences stuck at
1/6 PART_TRADED, Nahar Poly Films at 0/38 PENDING — yet the Order Log showed
all five as `DHAN ENTRY + 2x FOREVER OCO (T1/T2 split)` with live Forever ids.
The user caught it comparing the Dhan Pending Orders tab against the log.

Chain: the protect-after-fill machinery existed and its watcher was correct
(waits on PENDING, waits on PART_TRADED, sizes to the filled qty) — but it was
behind `STOCKKAR_PROTECT_AFTER_FILL === '1'`, OFF by default. Production
therefore ran the legacy path: entry POST returns HTTP 200 (E5 evidence —
worthless) and the Forever OCOs were placed immediately. Result: 38 shares of
protective SELL against a position of ZERO shares (orphan if the DAY entry
expires; the row is a phantom open position that eats a Max Open Positions
slot and blocks re-entry), and a 6-share stop against 1 held share.

Fixes (2.61.4-staging.5):
- `PROTECT_AFTER_FILL` default FLIPPED: on unless `STOCKKAR_PROTECT_AFTER_FILL=0`
  (kill-switch inverted). FYERS already ran fill-first unconditionally.
- ORDER LOG = BROKER TRUTH while an entry works: the watchers now write the
  live order-book state into the row — `ENTRY PENDING at broker — 0/38 filled,
  protection on fill` / `ENTRY PARTIALLY FILLED — 1/6 at broker…` — wording
  chosen so isOpenOrderLogEntry keeps the row OPEN (protectfill.test.js pins
  this: a closed-token there would hide pending money from every safety pass).
- Cross-day resolution ported from FYERS to the Dhan + Zerodha watchers: both
  order books are TODAY-only, so a pending entry from an earlier day would have
  sat `awaitingFill` forever. Holdings now decide (held -> protect now; not
  held -> entry expired, row closed honestly).
- Latent crash fixed: the FYERS watcher's cross-day branch called `istKeyOf`,
  which only existed inside the test-sim closure — ReferenceError on first
  cross-day FYERS row. Shared module-level `istKeyOfIso` now serves all three.

Rule extracted: order ACCEPTANCE is E5 evidence. Nothing that implies a
position exists (protection, status text, P&L, open-position counting) may
act before FILL evidence (E1) — and the Order Log must quote the broker's
pending/partial state verbatim rather than describing our own intent.

## 6g. Finding #9 — retention pruned OPEN positions; the ledger forgot live money (2026-07-23)

A swing algo showed OPEN 6/10 while Dhan held 10 of its positions. The 4
oldest rows had recordedAt past the 30-day retention cutoff, and
pruneOrderLog dropped rows by AGE ALONE on every read/write — open or not.
The algo was created long before, so its earliest fills aged out while still
live at the broker.

Blast radius of a pruned open row: the open-position cap under-counts (could
have bought to 14 against a cap of 10); algoHeldPositionCount can't attribute
the held symbol (attribution reads the same log), so the broker-truth
backstop is blind too; EMA trailing / T1-T2 / move-to-cost / close-detection
all stop for that position (they iterate log rows). The position stays
protected by its Forever at the broker, but Stockkar no longer manages or
counts it. Only the same-symbol re-buy guard (broker-held check) survived.

Fixes (2.61.5-staging.2):
- OPEN rows are NEVER pruned — not by age, not by the row cap (the cap trims
  terminal rows only; retention.test.js pins both).
- Terminal rows age out from when they CLOSED (closedAt/testClosedAt, falling
  back to recordedAt) — previously a 4-month hold that exited today had its
  exit row deleted the same instant it closed.
- Default retention raised 30 -> 90 days (still env-tunable via
  STOCKKAR_ORDER_LOG_RETENTION_DAYS; row cap unchanged at 1000 terminal).

NOT retroactive: rows already pruned are gone from order_log.json and .bak.
Positions lost this way remain broker-protected but unmanaged until their
rows are reconstructed or they exit at the broker.

Rule extracted: the order log is the POSITION LEDGER, not a display cache.
Nothing may delete a row that still represents money at the broker — every
prune/trim path must partition open-vs-terminal first and touch only terminal.
