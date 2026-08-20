# REPORT-PLAN — robust architecture for the reporting plane

Goal (owner, 2026-08-20): the Dashboard report must be 100% in sync with
(a) the order log, (b) the broker, and (c) each algo. Same discipline that
stabilised the trading engine: single writer, broker truth, machine-readable
facts, testability.

## Audit findings (2026-08-20, 3.14.2)

### Already sound — keep as-is
- **One math.** `computeDashReport(rows)` in index.html is the single source
  for the Order Log analytics band, the Dashboard page and the PDF report
  (2026-08-13 audit). `rowPnlValue`/`rowRealisedPnl` is the one P&L reader
  for both table cells and totals. These surfaces cannot disagree.
- **Honesty rules.** Blank ≠ zero (`Number('')` trap closed); `missingPnl`
  and `estimatedN` banners; split rows never derived from one leg's price;
  banked T1 counted once on the realised side; breakeven = scratch, win rate
  over every closed trade; rejected rows are not "taken".
- **Broker truth at close.** The engine writes `realisedPnl` from actual
  fills; `exitEstimated` marks exits with no visible fill and the report
  says so.

### Gaps — why "100% sync" is not yet guaranteed
- **G1 Text-parsed classification (log ↔ dashboard).** `logRowState` and
  `logOutcomeBucket` regex/substring-match the *display wording* of
  `status` / `describeLogResult()`. Any new status phrasing silently
  re-buckets rows. The engine has a formal state machine and a known exit
  cause at close time — but writes only free text to the row.
- **G2 No ledger reconciliation (dashboard ↔ broker).** Nothing ever
  compares report totals against the broker's tradebook. `realisedPnl` has
  ~20 scattered writer sites (per broker × per path), each with its own
  inferred/estimated formula. A wrong write is permanent and invisible.
  Also: P&L is gross — brokerage/charges are never included, so the
  broker's own P&L statement will always read lower (undisclosed).
- **G3 Algo identity by name (dashboard ↔ algo).** Aggregation keys on
  `screenerName` string. Rows carry `jobId`, the report ignores it: a
  renamed screener splits its history; two jobs on one screener merge.
- **G4 History silently shrinks.** `readOrderLog()` prunes terminal rows
  past 365 days / 1000 rows, and `/order-log/delete` removes closed rows.
  "All time" is really "what survived pruning and deletion", untraceably.
- **G5 Feature attribution text-coupling.** T1-booked detection matches
  `/T1 book/i` on `mtmStatus` text (same class as G1). Estimates are
  flagged (fine) but the trigger is wording, not a fact.
- **G6 Staleness undisclosed.** `unrealisedPnl` blankness is handled, but
  an off-hours LTP from 3 days ago renders identically to a live one.

## Architecture — 6 rules

**R1 — One close writer, machine-readable facts.** A single function
`closeRow(row, { exitKind, exitPrice, exitQty, realisedPnl, source, at })`
replaces every inline close patch. It stamps:
`exitKind ∈ {TARGET, T1, T2, SL, COST, TRAIL, MANUAL, EOD, FOREIGN, REJECTED}`,
`pnlSource ∈ {fill, estimate, derived}`, `closedAt`. Status text stays what
it is today — display only. (Mirror of the engine's "single writer" rule;
the 20 write sites become 20 calls into one function.)

**R2 — Report reads facts, not labels.** `logRowState`, `logOutcomeBucket`
and the T1/T2/trail attribution read `row.exitKind` / flags FIRST; the
existing text-regex path survives only as fallback for pre-R1 rows.
Reporting decouples from UI copy permanently.

**R3 — Stable algo identity.** Aggregate by `jobId` (fallback:
`screenerName` for old/manual rows); display name = the job's current
name. Rename-safe, duplicate-safe. "Each algo" becomes literally true.

**R4 — Ledger reconciliation (the sync observer for money).** An EOD pass
per broker: fetch the day's tradebook, compute per-symbol realised P&L from
actual fills (tags/leg-ids attribute them to rows — same identity plumbing
the engine already uses), compare against the day's closed rows. A delta
beyond tolerance → `pnlMismatch` flag on the row + a line in the daily
digest. This is the missing "verify the LEDGER, not just the orders".

**R5 — Immutable daily rollups.** At EOD write `daily_rollup.json`
(append-only: date × jobId × broker → n, wins, losses, scratches, net,
buckets, charges if known). Long ranges and "All time" read
rollups + live rows, so pruning (G4) and row deletion stop rewriting
history. Free-tier row caps stay honest.

**R6 — Pure, tested report math.** Extract `rowRealisedPnl`,
`logRowState`, `logOutcomeBucket`, `winRateOf`, `computeDashReport` into
`report.js` — a dependency-free module loaded by index.html via
`<script src>` and by `node --test` directly (module.exports guard, same
pattern as engine.js). Golden-fixture tests pin the invariants:
- screener-table total ≡ headline net
- buckets sum ≡ closed count
- banked T1 counted exactly once
- blank ≠ zero, split rows never derived
- win-rate denominator = won+lost+scratched

Today the one-math lives in inline HTML JS with **zero tests** — the only
money-math in the product the harness cannot see.

## Build order (each slice independently shippable)

1. **Slice 1 — report.js extraction + golden tests.** No behaviour change;
   locks the current math before anything else touches it. (R6)
   **DONE 3.14.3-staging.1** — report.js (15 exports) + report.test.js;
   resultlabel.test.js requires the real module. Found in the process:
   `missingPnl` undercounts (Number('') === 0) — blank-pnl rows are excluded
   from totals but not disclosed by the banner; fix lands with slice 2.
2. **Slice 2 — closeRow writer + exitKind.** Engine + reconcile paths call
   it; readers prefer facts over text. (R1, R2, G5)
   **DONE 3.14.3-staging.2** — the writer lives at the WRITE CHOKE POINT
   (makeCloseStamper in writeOrderLog/writeTestOrderLog), so no close path
   can miss it: exitKind frozen at close time (never overwritten, cleared on
   reopen), closedAt stamped only for rows seen open in-process (seeding
   first write backfills kinds but never invents close times). Deviation
   from the plan, deliberate: pnlSource is a READER (derivePnlSource), not a
   stamp — a stored source would stay 'estimate' after a reconcile corrects
   the exit to a broker fill. Readers: logOutcomeBucket prefers the stamped
   kind (parity with the text path pinned over a full corpus); missingPnl
   now counts exactly the rows the figures dropped. Bonus bug found by the
   corpus test: 'EOD EXIT' matched no closing token anywhere, so paper EOD
   closes read as OPEN forever (slots held) — token added to
   isOpenOrderLogEntry + logRowState + the test contract.
3. **Slice 3 — jobId attribution.** (R3)
   **DONE 3.14.3-staging.3** — algoGroupKey: jobId first, screenerName only
   for rows without one (manual / pre-jobId history; those older auto rows
   stay name-grouped — honest, disclosed here). Display name: the schedule's
   current name (dashReportOpts from window._algoJobs) else the newest row's
   own name. Rename-safe + duplicate-safe pinned in report.test.js.
4. **Slice 4 — EOD ledger reconciliation + daily rollups + staleness
   stamp.** (R4, R5, G6)
   **DONE 3.14.3-staging.4** — runDailyLedgerClose (15:45–17:00 IST,
   per-broker latch beside the EOD price match): recomputes each closed-today
   symbol's P&L from the broker's ACTUAL SELL fills (ledgerCheck — fills
   qty must equal rows qty to compare; ambiguity → `unverifiable`, never a
   flag) → pnlMismatch stamped/cleared on rows, red Telegram on deltas,
   dashboard card discloses the count. Rollups: computeDailyRollups over
   terminal rows, captured daily to data/daily_rollup.json (atomic write);
   a day keeps its last capture once its rows leave the log — pruning and
   deletion stop rewriting history. Client: /order-log/rollups + archived
   merge on Dashboard/PDF (headline, win rate, buckets, per-algo table;
   drawdown and winner stay live-rows-only — aggregates can't be
   re-sequenced). Unrealised card shows "as of HH:MM", "(stale)" when the
   measurement is from a previous day. /debug/ledger runs it on demand.
   v1 scope notes: rollup groups key on algo only (no broker dimension) so
   archived merges one-to-one with live lines; deleting a day's LAST
   terminal rows preserves that day via its rollup (R5's promise — deleted
   trades stay in "All time").

Out of scope, recorded: net-of-charges P&L needs the broker's charges API
per trade (Dhan has one; others vary) — park until the gross ledger
reconciles clean, then charges become one more rollup column.
