# Cutover Inventory — every feature, accounted for

Rule (owner's directive, 2026-08-07): **no broker cuts over without a fresh
audit**, and nothing flips until every feature below has an explicit owner in
the new architecture. This file is the checklist; ARCHITECTURE.md is the why.

Derived from the live pass list (reconcileBrokerOrders tasks + all interval
timers), not from memory.

## A. Migrates INTO the engine (the per-broker position lifecycle)

Owner after cutover: engine decides, executor acts. Legacy pass deleted.

| # | Feature | Legacy owner today | Engine status |
|---|---|---|---|
| A1 | Entry fill detection + protect-after-fill | placeProtectionForFilled{Dhan,Zerodha,Fyers}Entries; Angel places protection synchronously | Engine ENTRY_PENDING states built; EXECUTOR PORT NEEDED for fyers/angel |
| A2 | Entry expiry / no-fill verdicts | awaiting-fill expiry paths | Guard DONE 2026-08-07: same-day terminal rejects now consult holdings via entryNoFillDecision (mtm.js, tested); cross-day was already guarded. Angel inverse gap (SL rule armed at entry that may never fill) -> Angel audit |
| A3 | Protection verification (UNPROTECTED detection, un-flag self-heal, exit-in-flight latch) | 4 verify passes (dhan forever / zerodha / fyers / angel) | Engine-native (claims vs held/sells + grace) |
| A4 | Exit/close detection incl. cross-day | refresh*OrderLogStatus, closeCompletedDhanForevers, closeCompletedZerodhaGtts, split reconciles | Engine case-2 (fill evidence only). Dhan retrofitted with dhanFillGuard; **Zerodha has NO fill guard yet** |
| A5 | T1/T2 split lifecycle (book, cost-move both/runner, combined close) | split reconciles + checkSplitMoveToCost + checkSplitSlToT1 | Engine split rules built + tested |
| A6 | SL restore (evidence-based re-arm) | checkAndRestoreBrokerStops | Engine UNPROTECTED -> re-arm action |
| A7 | Move SL to cost (single) | checkMtmRules | Engine MOVE_SL_TO_COST |
| A8 | EMA / peak trailing (incl. after-target arming) | checkDailyEmaTrailing, checkEmaTrailingTargetTriggers | Engine trail rules; EOD EMA snapshots (recordEodEmaSnapshots) stay as a DATA feed |
| A9 | No-SL flow (targets-only rows) | reconcileNoSlDhanTargets (+ zerodha/angel/fyers noSl paths) | **AUDIT ITEM: engineOwns gates the legacy pass off — confirm the engine actually owns noSl rows, else they orphan on flip** |
| A10 | Exit chaser (fired-but-stuck exits -> market) | chase pass (exitOrderType=market rows) | Should become an engine action (verify-after-fire) at port time |
| A11 | Orphaned protections | cancelOrphanedDhanForevers (row-linked only) | Engine snapshot sees all; **GAP today: protections with NO row (V2RETAIL) are nobody's job** |
| A12 | False-close recovery | reopenFalselyClosedPositions (estimated-only, 8h) + checkDriftedStops + sweepRowArtifacts | Engine makes the class impossible; recovery pass stays only as data-repair for pre-engine rows |
| A13 | Partial fills (protection qty = filled qty) | protect-after-fill logic | Engine rule exists (#12) |
| A14 | Adopted holdings rows (no jobId) | same rails as algo rows by construction | **AUDIT ITEM: engine position mapper must accept jobId-less rows** |

## B. Stays OUTSIDE the engine but consumes its snapshots (safety rituals)

Morning protection audit · token preflight · boot recovery / drift-fix ·
daily assurance (checkDailyAssurance) · liveness probes ("Connected" truth) ·
Holdings tab + adopt endpoint · /debug/{fyers,angelone,...} · shadow runner ·
cutover runner. These are consumers of adapter truth — unchanged by flips,
they get MORE reliable as adapters become the only readers.

## C. Untouched by cutover (platform — verify no hidden coupling, then leave alone)

Scheduler + trading windows/days · scan pipeline (screeners, entry filters,
capital/qty sizing, price bounds, sector/industry, fresh-qualified, reentry
cooldown) · held/duplicate guards + maxOpen slots + broker-truth cap · daily
screener refresh (8 AM) + sheet baskets (15-min) + saved filters + watchlist ·
one-broker enforcement + multibroker add-on · licensing/lifetime/activation ·
token renewals (dhan auto, angel refresh, fyers manual) + login popups ·
Telegram alerts · updates + popup · dashboard/report/PDF + win-rate rules ·
order log UI/CSV/repair scripts · app lock · entry/exit order-type config ·
unrealised P&L updater · paper mode (ALREADY the engine).

## D. The pre-cutover audit (per broker, the Angel audit generalized)

1. Walk every A-row against this broker's legacy code and the engine port.
2. Walk all fifteen incident classes in ARCHITECTURE.md against it.
3. Adapter contract clauses 1–5 proven with LIVE /debug evidence, not docs.
4. A fixture for every payload shape the adapter accepts.
5. Executor actions exist + tested for this broker (place / modify / cancel,
   every protection type it uses incl. splits and noSl).
6. Shadow soak: ≥3 trading days, divergence digest read daily, zero wrong
   divergences.
7. Flip on staging -> days clean -> flip main -> DELETE the legacy passes
   (the engineOwns-gated list is the deletion list).

## E. Work queue this inventory creates (ordered)

1. Entry-fill guard, all brokers (A2 — the GNA class; needed regardless of cutover)
2. Zerodha fill-evidence guard (A4) + full Zerodha audit (first D-audit)
3. Orphan-protection sweep + naked-holdings section in the morning audit (A11/B)
4. Shadow divergence digest (makes D6 real)
5. FYERS + Angel executor port (A1/A5 parity in the cutover runner)
6. #16 Dhan 7-day tradebook (cross-day sell evidence) -> Dhan D-audit -> flip
7. #14 Zerodha SME mapping -> Zerodha flip · Angel /debug validation -> Angel flip
8. #13 structured IDs (retires text-parsed ids as passes migrate)
