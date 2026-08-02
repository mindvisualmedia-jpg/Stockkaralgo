# Editions, Licensing & Install Registry — Architecture

One repo, one branch, one update stream. Paying changes what is UNLOCKED,
never which code you run. Status of each phase lives at the bottom.

---

## 1. Source plugins (the product seam)

Everything downstream of "give me today's stock rows" is shared — server,
engine, brokers, MTM, UI. The ONLY thing an edition changes is where those
rows come from.

```
sources/
├── stockkar.js   built-in + saved screeners + watchlists (today's code, extracted)
└── gsheet.js     published Google Sheet CSV -> the same rows shape
```

Contract (both modules export the same three functions):

```js
exports.id = 'gsheet';
exports.label = 'Google Sheet';
// list what the user can pick from (for stockkar: screeners; for gsheet:
// their saved sheet URLs)
exports.listSources = (ctx, cb) => cb(null, [{ ref, name, count? }]);
// resolve one pick into rows the algo pipeline already eats
exports.fetchStocks = (ref, ctx, cb) => cb(null, [{ symbol, exchange? }]);
```

- `stockkar.js` is an EXTRACTION of the current screener plumbing, not a
  rewrite — `buildAlgoCandidates`, scans, scheduling, order flow untouched.
- `gsheet.js` v1: user pastes a **published-to-web CSV URL** (File → Share →
  Publish to web → CSV). First column (or a `symbol` header) = NSE symbol.
  Blank/invalid symbols reported per-row, never silently dropped. Sheet is
  re-fetched on every scheduled scan, so editing the sheet edits the algo.
- v2 (later, same contract): optional columns `sl_pct`, `target_pct`, `qty`
  override the algo's defaults per row.

The Screener page gets a third tab — **Google Sheet** — rendered only when
the box's entitlement includes `gsheet`. The algo wizard's source step lists
whatever sources the entitlement allows.

## 2. Entitlements & the three products

| Product         | Entitlement          | How the box gets it                  |
|-----------------|----------------------|--------------------------------------|
| Stockkar Algo   | `stockkar` (default) | no license needed — today's behaviour|
| Stockkar + Sheet| `stockkar,gsheet`    | license key adds `gsheet`            |
| Sheet-only      | `gsheet`             | license key GRANTS gsheet and SUPPRESSES stockkar |

- **No license file = exactly today's product.** Existing users notice
  nothing. That is the compatibility contract.
- Sheet-only is NOT a separate build: the key carries
  `features:['gsheet'], suppress:['stockkar']`. The server tells the UI what
  to render (Stockkar screener tabs hidden) AND refuses `stockkar`-source
  scans server-side — a real gate, not hidden buttons.
- New Sheet-only customers follow the SAME setup link and cloud template as
  everyone else; the setup wizard gains a "License key (optional)" field.
  Paste the key during setup → the box comes up as a Sheet-only product.

## 3. License keys (offline, zero new infrastructure)

Format: `STK1.<base64url(payload)>.<base64url(HMAC-SHA256(payload, SECRET))>`

```json
{ "v": 1, "id": "lic_8f3a", "to": "Ramesh K",
  "features": ["gsheet"], "suppress": [],
  "bind": { "type": "dhanClientId", "value": "1100xxxx" },
  "iat": "2026-08-02", "exp": "2027-08-01" }
```

- **Verify offline** in `license.js` (node:crypto only): signature, expiry,
  binding. No network call, works on every self-hosted box.
- **Binding** stops key-sharing: v1 binds to the broker client-id (checked
  when a broker is connected; a box with no broker yet gets a grace pass and
  re-checks on connect). `bind.type:'none'` supported for trials.
- **Expiry** enables subscriptions. 7 days before expiry the daily assurance
  digest starts warning; on expiry the feature locks, nothing else breaks,
  the key can be replaced in Settings without a restart.
- Stored as `DATA_DIR/license.json` — survives updates exactly like tokens.
- Settings → **License**: paste box, live status chip (valid / expires N
  days / bound to X / invalid-why).
- Revocation later = swap the offline check for a license API call. The KEY
  FORMAT DOES NOT CHANGE, so nothing shipped today breaks.

**Why Ed25519 and not HMAC** (the one real crypto decision): HMAC needs the
same secret on the signer and the verifier — and customer boxes run the
verifier, so an HMAC secret would ship to every box and anyone could mint
keys. Ed25519 splits the pair: the PRIVATE key exists only on the admin
side; the repo carries just the PUBLIC verify key, which can't sign
anything. node:crypto does Ed25519 sign/verify with zero dependencies.

## 4. Admin panel — "very simple key generation"

`node scripts/license-admin.js` on YOUR machine:

- Opens `http://127.0.0.1:7899` with one form: name, features (checkboxes),
  bind type+value, expiry (default +1 year) → **Generate** → key shown with
  a copy button. WhatsApp it to the customer.
- Every issued key is appended to a local ledger (`license-ledger.json` next
  to the private key): who, what, when, expiry — your customer list starts
  here for free.
- The private key is generated on first run and stays in that folder. Back
  it up once (losing it means future keys need a new public key shipped in
  an update; old keys keep verifying).
- Later, the SAME module deploys as a Vercel function behind a password when
  you want to issue keys from your phone — ledger moves to the same place
  the install registry (below) lives.

## 5. Install registry — "we don't see our users"

Today: users take the setup link + CloudFormation/Oracle template, and you
learn nothing — not even how many boxes exist or what version they run.

**Heartbeat, privacy-safe by design.** Each box POSTs once a day (and once
on boot) to a tiny endpoint on your existing Vercel deployment:

```json
{ "installId": "ins_a1b2c3",        // random, generated once, stored in DATA_DIR
  "version": "3.0.1",
  "features": ["stockkar"],          // entitlement names only
  "licenseId": "lic_8f3a|null",     // which customer, if licensed
  "brokers": ["dhan"],               // names only, never tokens/ids
  "counts": { "openPositions": 7, "algosActive": 2 } }
```

- NEVER sent: tokens, client-ids, symbols, prices, P&L, sheet URLs. The
  payload is small enough to print in the docs — that transparency is the
  policy.
- Opt-out honoured: `STOCKKAR_TELEMETRY=0`.
- Storage: the Vercel function appends to a private Google Sheet via a Sheets
  webhook (fits your stack; zero new database). Columns: installId, version,
  features, licenseId, brokers, counts, lastSeen. **Your user list IS a
  sheet** — filter by version to see who's stuck on an old release, by
  licenseId to see who activated, by lastSeen to see churn.
- License activation also pings once → "paid customer went live" appears the
  moment they paste the key.

**Simplifying setup itself**: the wizard + templates already carry most of
the weight; the two cheap wins are (a) the license field in setup, and
(b) the heartbeat telling YOU when a new install completes — so onboarding
help becomes proactive ("saw your box come up, token not connected yet —
need a hand?") instead of waiting for a support message.

## 6. Reaching the ~200 existing installs

They are reachable through the one channel we control: updates.

- The heartbeat (section 5) inventories every box that updates - install id,
  version, brokers, counts - with zero user action.
- Identity comes from a ONE-TIME in-app registration card shown after the
  update: name, email, WhatsApp -> POSTed to the registry, linked to the
  installId. An external form can't make that linkage; the in-app card can.
  Dismissible, never nags more than once per install.
- Coverage = users who update, so the release pairs with an announcement in
  whatever channel exists. The registry then shows update adoption daily.

## 7. Identity vs access (email login + PIN)

Non-negotiable constraint: OPENING THE BOX AT 9:14 MUST NEVER DEPEND ON OUR
INFRASTRUCTURE. So identity and access are split:

- Identity (once): email + password against the central registry (scrypt
  hashes stored centrally, never on the box). Creates the user directory;
  licenses and installIds link to a person; password reset becomes a
  support tool.
- Access (daily): the existing PIN app-lock, fully offline. After first
  login the box caches a signed session (N-day validity), so even re-auth
  survives an outage. A registry outage can never lock a trader out.

## 8. Build order (each phase ships alone, staging-first)

1. **Sources extraction** — `sources/stockkar.js` wrapping today's code, no
   behaviour change (parity-tested); `sources/gsheet.js` + CSV parsing +
   Sheet tab behind a dev flag.
2. **license.js + Settings → License** — Ed25519 verify, entitlement
   resolution, server-side scan gating, suppress support. `make-license.js`
   CLI (the admin panel's engine).
3. **Admin panel** — local web form + ledger.
4. **Heartbeat + registry** — box side (daily POST, opt-out) + Vercel
   function + Google Sheet store.
5. **Registration card + identity** — one-time in-app card for existing
   users; email+password registration; cached-session login; PIN stays the
   daily gate.
6. **Sheet-only polish** — setup-wizard license field, nav suppression QA,
   docs & pricing page.

Phase status: none started — this document is the contract.
