# Stockkar Stability Plan — the honest audit and the architecture that ends the incidents

*Written 2026-08-18 (staging 3.12.4, main 3.12.0), on the evidence of the July–August incidents and the 2026-08-18 test day. This is the owner's reference: what is actually fragile, why, and the sequence that fixes it. Status lines are updated as work lands.*

---

## 1. The audit: what actually breaks, and why

Every incident of the last six weeks, classified by **root cause**, not by symptom. Five causes explain all of them.

| # | Root cause | Incidents it produced | Status today |
|---|---|---|---|
| **A** | **Two writers on one row.** Legacy passes and the engine (or two legacy passes) both write lifecycle state for the same position, from different evidence. | Angel status refresher closing engine rows from *any* symbol sell (18 Aug); GENUSPOWER x3 double-management; the 5 hidden legacy writers found on 17 Aug; every "row says X, broker says Y" report | Engine is the single lifecycle writer on engine boxes (`engineOwnsRow`); legacy passes *gated*, not deleted — the gate is one forgotten `if` away from a new incident (that is exactly what 18 Aug was). |
| **B** | **Software doing what the broker should do.** Software T1 booking, software targets, cancel-first sequences that leave the position naked when a later step fails. | GNFC (cancel OCO → remainder stop → market SELL rejected → 9 shares naked, no target, price 4% past it, new stop id never recorded); the whole HEALTHX/exit-chase family | Software T1/T2 OFF for live rows, all brokers (3.12.4). Remaining software exits are the three engine safety actions, all cancel-first + evidence-verified. `checkAngelOneSoftwareTargets` still runs for old single-leg Angel rows on main. |
| **C** | **Untested runtime paths in a 17k-line monolith.** `node --check` and the boot probe cannot see a branch that only runs when a row is UNPROTECTED at 10:32 on a Tuesday. | `mtm is not defined` (killed every Dhan/FYERS engine pass for a whole morning, silently); `sells.reduce is not a function` (Angel, 24h unmanaged); `fetchDhanTradeHistory` nested-scope crash loop | `npm run lint` (no-undef) is now a push blocker; per-row isolation in the engine pass. **The executor and the legacy passes still have zero unit coverage** — they are exercised only by live money. |
| **D** | **Adapter shape drift.** Each broker's read is parsed in one place now (adapters), but writes are still N scattered functions in server.js with hand-built payloads. | FYERS GTT stacking (list under `orderBook`, numeric statuses); Angel `{open,filled}` vs array; Dhan market SELL sent `price: ""` (GNFC, likely the "Incorrect request") | Reads: fixture-pinned from live payload dumps (good). Writes: no payload tests at all. |
| **E** | **Symbol-level attribution.** Holdings, fills and open sells are per symbol; rows are per lot. | GENUSPOWER x3 P&L booked 3× (capped 18 Aug); manual+algo blends; the FYERS "which leg fired" tell | Mitigated (VWAP × row qty; quantity tells). Real fix = per-order tags at the broker (Dhan `correlationId`, Kite `tag`, FYERS `orderTag`, Angel `ordertag`). |

Not root causes but recurring **operational** friction: broker tokens (Zerodha daily, FYERS no auto-renew, Angel 403/rate limits), Dhan egress IP churn, GTT/Forever count limits, MTF eligibility unknown until placement.

**The verdict:** the engine architecture is right and is now feature-complete; every incident this week was legacy code still touching engine rows, or software still doing broker work. Stability is not more features — it is **removing the second writer, moving the last software exits to the broker, and testing the wiring the way the engine core is tested.**

---

## 2. The architecture (target state — most of it exists; the rest is deletion and tests)

```
        scan/screener ──► ENTRY PLACEMENT (the only legacy-shaped code that stays)
                              │  entry order + protection request, tagged with algoId+rowId
                              ▼
   ┌───────────────────── ORDER LOG (rows) ─────────────────────┐   single writer per row
   │  one row = one lot; ids of ITS broker orders; engineState  │   (mutateOrderLog queue)
   └────────────────────────────────────────────────────────────┘
                              ▲ patch                 │ read
                              │                       ▼
                     ┌── ENGINE (engine.js, pure) ◄── SNAPSHOT (adapter getSnapshot: complete|not)
                     │   position × evidence → {state, patch, actions, alerts}
                     │   states: ENTRY_PENDING ENTRY_DEAD PROTECTION_PENDING PROTECTED
                     │           UNPROTECTED EXIT_PENDING TARGETS_ONLY CLOSED
                     ▼
              EXECUTOR (server.js) ──► ADAPTER WRITES (per broker, payload builders are pure)
              one branch per action        placeProtection / modifySl / cancel / marketSell / placeTargetLeg
              never advances state;        every payload built by a testable function
              a write is only believed
              when a later snapshot shows it
                              │
              OBSERVERS (write nothing): sync.js reconcile → /debug/sync, day digest, morning audit,
              token preflight, EOD price match, Telegram alerts
```

**The seven rules** (each one is a July/August incident written as a law):

1. **One owner per row.** The engine owns every live row from the moment its entry fills. No legacy pass may write lifecycle fields (`exitType`, `slPrice`, `mtm*`, `status` of an open row) on a row the engine owns. Enforced by `engineOwnsRow` today; enforced by *deletion* of the legacy pass once retired.
2. **Broker holds the exit.** Stops and targets are broker legs — split OCO when the book is partial, one OCO at the full-exit price otherwise, No-SL = target legs. Software never sells except the three safety actions (breached-stop market exit, stuck-exit chase, stop-not-firing backstop), all cancel-first, all evidence-verified afterwards.
3. **A write never advances state.** Every action is a request; only the next snapshot confirms it (`enginePendingSl`, PROTECTION_PENDING, EXIT_PENDING). Missing evidence = wait, never a destructive verdict (the GNA rule: a missing holdings map is *unknown*, not "not held").
4. **Irreversible steps last, partial progress persisted.** Place-first-cancel-after on every restore; sell before cancelling protection; any id we created is written to the row even if a later step fails.
5. **Adapters are the only broker code.** One `getSnapshot` per broker (reads) and one small write surface per broker (payload builders pure + fixture-tested; the transport thin). No hand-built payload anywhere else.
6. **Everything that can crash is isolated and loud.** One row can never take down a pass; a pass that errors alerts (Telegram, once per hour per broker) — a silent crash produced no divergences and no alerts on 18 Aug and looked *clean*.
7. **Nothing ships untested where it runs.** `node --test` + `mtm.test.js` + boot + `npm run lint` + the executor harness (§3.1) on every push; staging soak before merge; per-broker fixture seams (`_fetch`) so a live payload becomes a test the same day.

---

## 3. The program — sequenced, each phase with an exit criterion

### Phase 0 — this week: stop the bleeding (mostly done)
- [x] Engine feature-complete (trailing, protect-after-fill, EXIT_PENDING/chase, reopen, orphan cancel, TARGETS_ONLY, rule 8, digest) — staging.5→.13
- [x] Crash isolation + `npm run lint` push blocker (3.12.1)
- [x] Legacy status refreshers yield on engine rows (3.12.2); P&L cap on duplicate rows (3.12.3)
- [x] Software T1/T2 OFF for live rows, all brokers; Dhan market-sell payload fixed (3.12.4)
- [ ] **Merge 3.12.4 to main** — customers are on 3.12.0 which carries the crash bug (inert with engine off) and software T1 (active!)
- [ ] Engine pass error → Telegram alert (rule 6); Zerodha/Angel token hygiene nudges in the digest
- **Exit:** 3 consecutive staging sessions with day digest 🟢, `/debug/sync` no new confirmed reds, `[ENGINE]` reviewed.

### Phase 1 — next 2 weeks: test the wiring like the core
- [ ] **Executor harness** — a fake broker (in-memory protections/orders/holdings that answers place/modify/cancel/sell) so every `engineExecuteAction` branch and every restore path runs in `node --test`. This is the single largest gap; it would have caught `mtm`, `sells.reduce`, `price:""`.
- [ ] **Adapter write surface** — move each broker's payload builders into `brokers/<b>.js` as pure functions (`buildMarketSell`, `buildProtection`, `buildModifySl`, `buildCancel`, `buildTargetLeg`) with fixture tests copied from proven-live requests; server.js keeps only transport. Start with the four market-sell/cancel paths (they are the safety exits).
- [ ] **Order tags** at placement (`correlationId`/`tag`/`orderTag`/`ordertag` = rowId) and adapters surface them → per-lot attribution, retiring limitation L5.
- **Exit:** every executor branch has a test; every broker write payload has a fixture test; suite green.

### Phase 2 — flip main
- [ ] `STOCKKAR_ENGINE=1` on main after Phase 0 exit + Phase 1 harness (rollback = env var, no cleanup)
- [ ] `STOCKKAR_ENGINE_ENTRIES=1` after the protect-after-fill replay suite passes against a live day's payloads
- **Exit:** 3 clean sessions on main; then customers.

### Phase 3 — delete, don't gate
- [ ] Per broker, after 3 clean engine sessions on that broker: **delete** its legacy lifecycle passes (status-refresh close paths, split reconciles, verify passes, restore candidacy, MTM pass, Angel software targets once no single-leg row remains). Thousands of lines gone = thousands of runtime paths that can no longer be undefined.
- [ ] Split server.js along the seams that already exist (adapters, executor, observers, entry placement, HTTP handlers) — extraction only, no behaviour change, one module per commit.
- [ ] One config schema shared by client and server (the two-validator R:R bug was a duplication bug).
- **Exit:** `engineOwnsRow` has nothing left to gate; server.js < 8k lines; no lifecycle code outside engine + executor.

### Phase 4 — the last known limitations
- [ ] Angel `held` sums-vs-max (needs one live payload with a same-day Angel buy)
- [ ] Dhan MTF eligibility at selection (security-master flag)
- [ ] Multi-position per symbol first-class (with tags from Phase 1)

---

## 4. Per-broker: what to watch, what is proven, what is not

| Broker | Proven live (engine) | Known sharp edges | Still to prove |
|---|---|---|---|
| **Dhan** | split OCO T1→cost→SL close; single OCO; cost move; re-arm; TARGETS_ONLY (placement) | Forever list path flaps (`/forever/all` vs `/orders`); TRADED/TRIGGERED ≠ filled; egress IP whitelist; MTF eligibility unknown until placement; Forever count limits | manual-cancel re-arm on a fresh row; target hit; TARGETS_ONLY leg re-place; breached-stop market exit |
| **Zerodha** | (no live engine evidence — token dead on test day) | daily token; GTT 1-yr expiry (rule 6 refresh); `last_price` validation on SL→cost; SME/T2T series gate | *everything* — one clean day |
| **FYERS** | pre-T1 cost move; SL HIT close; re-arm + attempt cap | GTT list under `orderBook`, numeric statuses; GTT count limit (entry refused when full); no token auto-renew; "which leg fired" not reported | target hit (the V2RETAIL tell); gap-down → exit-at-market |
| **Angel** | OCO single + split; cost move both legs verified; SL close; rate 8 armed | ruleList status filter (400 on broad filter); cancel needs id+symboltoken+exchange; 403/rate limits; `held` sums holdings+positions (unverified) | single-leg→OCO migration on a real legacy row; rule 8 firing; a target hit |

---

## 5. Operating discipline (the part no code can replace)

- **One active broker per user** in the app; the owner's staging box is the only multi-broker box.
- **Every morning:** token preflight 08:45 (act on it), morning audit 09:00, `/debug/sync` baseline. **Every evening:** the day digest — 🔴 gets read the same day.
- **Every push:** tests + mtm + boot + lint; staging first; merge only on the word "merge"; release notes minimal.
- **Every incident:** raw payload first, then fix, then a fixture that pins it (see docs/GUARDRAILS.md). Never fix from a guess.
- **Kill switches stay** — every feature keeps its env switch until its legacy twin is deleted.
