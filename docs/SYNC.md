# Order Log ↔ Broker Truth — Synchronisation Architecture

Status: **PROPOSED** (2026-08-13). Companion to ARCHITECTURE.md: the engine owns
one position's lifecycle; this layer owns the *set* — everything the broker
holds vs everything the log claims, continuously, with one vocabulary.

## Why (what the 2026-08-13 audit found)

Detection exists but is fragmented and inert:

| Finding | Consequence |
|---|---|
| ~20 per-broker reconcile passes, 5 hand-rolled id extractors | The same question answered differently per broker; drift is invisible until an incident (Angel `sells` shape, FYERS `orderBook`) |
| Audits report, never repair | `FEDFINA: broker holds 6 but the log manages 3` was detected and nothing happened |
| Twice-daily cadence | A 10:07 divergence surfaces at 15:35 — today's whole incident fit inside the window |
| Audits trust the read blindly | The broken FYERS parse made the morning audit report healthy positions as naked, at scale |
| Protection checked by existence, not quantity | ADVANCE with 2 of 4 shares covered read green |
| No canonical diff | "What diverges right now?" has no single answer anywhere |

## The Layers

```
L0 Adapters      broker APIs → ONE canonical snapshot        (exists; contract v2 below)
L1 Identity      row → { entry, legs[] } broker ids           (exists 5×; consolidate to ids.js)
L2 Engine        one position's state machine                 (exists)
L3 Reconciler    sync.js: reconcile(rows, snap) → Divergence[] (NEW — the missing layer)
L4 Policy        what may auto-repair, throttles, one-writer  (partial: rate cooldowns, attempt refunds)
L5 Reporting     row status + Telegram + daily digest         (exists; unify vocabulary)
```

## L0 — Snapshot contract v2

Current: `{ complete, protections, entries, heldQty, sells, openSells }`.
Changes:

```js
{
  complete: true,          // ALL reads succeeded; partial ⟹ the whole snapshot is refused
  at: '2026-08-13T10:07:00Z',
  protections: { id: { status, symbol, triggerPrice, qty } },   // unchanged
  entries:     { id: { status, fillPrice, filledQty } },        // unchanged
  sells:       { SYM: [{ qty, px }] },                          // E1 evidence (unchanged)
  openSells:   { SYM: qty },                                    // exits in flight (unchanged)
  held:        { SYM: { total, settled, unsettled } },          // NEW — splits heldQty
}
```

`held` splits what is one number today, because **settlement lag lies in both
directions**: a fresh CNC buy may be missing from holdings (under-report → a
naive reconciler closes a live position as phantom), and a sold CNC position
lingers in holdings until T+1 (over-report → a naive reconciler re-arms a stop
on shares already sold). `heldQty` stays as `total` for back-compat during
migration.

Broker mapping (per the 2026-08-13 adapter audit):

| Broker | settled | unsettled | Known defect to fix first |
|---|---|---|---|
| Dhan | `dpQty` | `t1Qty` | — |
| Zerodha | `quantity` (+ `mtf.quantity`) | `t1_quantity` | — |
| FYERS | `quantity` | `remainingQuantity - quantity` (validate vs live payload) | — |
| Angel | `quantity`/`realisedquantity` | **none today** | **holdings + positions are SUMMED (`+=`) where every other adapter takes `max` — a same-day buy double-counts. Verify against a live payload, then fix.** |

**Rule (paid for twice on 2026-08-13):** adapter fixtures are copied from live
`/debug/*` dumps, never written from documentation. A fixture invented from
docs is the guess, frozen — it certifies the bug (FYERS `gttOrders`, Upstash
`claim`).

## L1 — Identity: ids.js

One pure function, one consumer surface:

```js
rowIds(row) → { entry: 'id'|null, legs: [{ id, role: 't1'|'runner'|'single', qty }] }
```

Replaces the five parallel extractors (engineShadowPosition's inline mapper,
paper's idsFromRow, assuranceProtectiveIds, the restore sweeps' rowGids/rowFids/
fyersRowGttIds, /debug/audit's copies). Per-broker field knowledge
(dhanForeverId, fyersGttT1Id, SLGTT: prefixes…) lives here and nowhere else.
This closes most of #13 for practical purposes.

## L3 — The Reconciler (sync.js)

```js
reconcile(rows, snap, opts) → { suspectRead, divergences: [...], stats }
```

Pure; no I/O; unit-tested with fixtures from real incidents (ARIS, V2RETAIL,
FEDFINA, FEDERALBNK, GAIL/YESBANK, NYKAA, TATASTEEL, GNA).

### Evidence hierarchy (strongest wins)

- **E1 — fills**: a traded SELL/BUY with qty+px. Overrides settlement lag.
- **E2 — order state by id**: live / fired / rejected / gone.
- **E3 — holdings/positions**: subject to T+1 lag in both directions.
- **E4 — absence from a list**: weakest. Only meaningful after the read-sanity
  gate AND the grace/strike discipline. Never sufficient for a destructive act.

### Gate 0 — read sanity (before everything)

`readLooksBroken(knownIds, seenIds)` (broker-policy.js): if not one known
protection id appears in the snapshot, the READ is suspect — return zero
divergences and flag `suspectRead`. All alerts suppressed for that broker; one
🟠 "read looks broken" alert per hour instead. (The engine got this on
2026-08-13 after cancelling four positions' live stops on a blind read; the
audits still lack it.)

### Gate 1 — grace / strike discipline

A divergence must persist across N consecutive snapshots (default 2; empty-list
reads count 4× slower, inheriting the engine's grace rules) before it is
reported, and longer before any repair. RMS decides async; endpoints are read
sequentially so a fire mid-sweep makes one snapshot internally inconsistent —
strike one is never acted on.

### The taxonomy (closed set)

Symbol-level checks compare the broker against the SUM of open rows per symbol
(two rows on one symbol is legal); id-level checks are per row.

| Code | Condition (after gates) | Evidence | Action policy |
|---|---|---|---|
| `ENTRY_DIVERGENCE` | row awaitingFill but broker shows fill / holding (or the reverse) | E1/E2 vs row | adopt the fill (entry-fill guard, exists) |
| `UNPROTECTED` | held.total > 0, zero live legs | E2+E3 | re-arm via existing throttled path |
| `UNDER_PROTECTED` | Σ live protection qty < held.total (rows exist) | E2+E3 | 🔴 alert — NEW; the ADVANCE/FEDFINA half-bracket class |
| `SURPLUS_PROTECTION` | Σ live protection qty > held.total | E2+E3 | ⚠ alert (NYKAA class); never auto-cancel a stop on a held symbol |
| `ORPHAN_TRIGGER` | live protection, held.total = 0, no open row | E2+E3 | auto-cancel behind `STOCKKAR_SYNC_AUTOCANCEL=1`, else 🔴 alert (FEDERALBNK class) |
| `PHANTOM_ROW` | row open; not held; covering E1 sell (or aged + no sells) | E1 (or aged E3) | auto-close from fills (exists as closeAbandonedRows/cross-day closes; becomes one rule) |
| `QTY_MISMATCH` | held.total ≠ Σ row qty, aged, no open exits | E3 | ⚠ alert + software exits sized to broker qty (PYRAMID class) |
| `STOP_DRIFT` | live trigger ≠ expected (brokerSlPrice; costMoved ⟹ ≥ entry) | E2 | re-assert via engine MODIFY_SL (exists) |
| `ID_UNKNOWN` | a row leg id in no list at all, grace expired | E4 | escalate to UNPROTECTED check; never "assume fine" |

Settlement rules bound to the taxonomy, not left to callers:
- A row whose entry filled **today** is never PHANTOM on E3 alone (buy-side lag).
- "Still held" never blocks a close when a covering E1 sell exists (sell-side
  lag — the engine's rule, inherited verbatim).
- Post-T1, a runner-sized protection against a T1-reduced holding is CORRECT,
  not surplus/orphan (leg roles come from ids.js).

### L4 — Policy

- **One writer per row.** Engine-owned brokers: the reconciler REPORTS on their
  rows, repairs nothing (the engine is the writer). Legacy-owned brokers: the
  reconciler may execute the allow-listed repairs. This keeps the cutover's
  single-writer invariant.
- **Auto-repair allow-list** (everything else alerts): PHANTOM_ROW close from
  fills; ORPHAN_TRIGGER cancel when holdings are ZERO (flag-gated, off by
  default). Chosen on 2026-08-13: cancelling anything on a held symbol is a
  judgement about money — surplus/under stay human decisions.
- Broker write cooldowns + attempt refunds on rate limits (exists, staging.5).
- Entries gated on the ability to protect (exists, 3.9.10).

### L5 — Reporting

- **Row**: divergence code + human reason persisted on the row (Order Log,
  modal, /debug/audit) — scrollback is not an artefact (staging.3 lesson).
- **Telegram**: 🔴 act-now (UNPROTECTED, UNDER_PROTECTED, ORPHAN_TRIGGER
  unfixed) · ⚠ decision (QTY_MISMATCH, SURPLUS) · ℹ self-healed (PHANTOM
  closed, drift re-asserted, false alarm cleared). Deduped per divergence:
  alert on first confirmation, alert on resolution, re-alert only on
  escalation — never every cycle (the shadow-file-explosion lesson).
- **Digest**: counts by code PLUS coverage — "compared N rows across M brokers;
  snapshots ok/failed/suspect". Zero divergences with zero snapshots must read
  as "measured nothing", never as "all clear" (the 2026-08-12 digest lesson).

## Lifecycle under this architecture (place → exit)

1. **Gate**: active broker · instrument allowed · price band · duplicate ·
   affordable · broker not rate-limited (all exist).
2. **Entry**: row born with intent (qty, SL, targets) + entry id. Writes never
   advance state.
3. **Fill**: next snapshot E1/E2 confirms → protection due → placed
   (broker-native OCO preferred; split = 2 OCO) → **verified live (E2)** →
   PROTECTED. Book-lies covered by the entry-fill guard.
4. **Manage**: cost-move / T1 / trail / refresh — every write records
   `pendingSl` intent; believed only when the next read shows it; legs chosen
   from live evidence (`legIds`), never from row memory.
5. **Exit**: E1 fills close the row with real prices; exit chaser re-fires
   stuck exits; restores place-first-cancel-after so a failure never strips
   protection.
6. **Continuously**: reconcile() every engine cadence (~2 min market hours) on
   the same snapshot the engine already fetched — zero extra broker calls.
   Morning/EOD audits become summaries of the live divergence set.

## Rollout

- **Phase 0** — contract v2: `held` split; Angel sum→max + unsettled (LIVE
  payload first: /debug/audit?broker=angelone with a same-day buy); contract
  validator test every adapter fixture must pass.
- **Phase 1** — ids.js; migrate all five extractors; fixture parity tests.
- **Phase 2** — sync.js pure + incident fixtures; wired READ-ONLY beside the
  existing audits (log + digest counts only). Runs on both engine and legacy
  brokers from day one — it reads the same snapshots.
- **Phase 3** — Telegram/row reporting switches to reconciler output; legacy
  audits retired after N days of verdict agreement (deleted, not gated).
- **Phase 4** — allow-listed auto-repairs behind flags, one at a time.
- **Phase 5** — per-broker legacy reconcile passes delete as each broker flips
  to the engine (existing cutover plan); sync.js is unchanged by flips.

Each phase ships to staging alone; nothing merges without an explicit merge.
