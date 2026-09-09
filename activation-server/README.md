# Activation service

One key, one box. Read `docs/ACTIVATION.md` first — it explains why this may
only ever say "no" once, and why silence must always mean "yes".

**This folder is self-contained on purpose.** It imports nothing from the parent
directory, so Vercel can deploy it with `activation-server` as the Root
Directory. Deploying from the repo root instead would publish `index.html` and
`server.js` — the whole trading app — as public static files. Do not do that.

The cost of self-containment is `verify.js`, a copy of the licence verifier.
`activation.test.js` asserts the copy and `license.js` agree on every key shape
and ship the same issuer key, so drift fails the build rather than silently
rejecting real customers.

## Deploy on Vercel

1. **New Project** → import this repository.
2. Set **Root Directory** to `activation-server`. This is the important step.
3. Framework Preset: **Other**. No build command, no output directory.
4. **Storage → KV → Create** and connect it to the project. That sets
   `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you. Vercel functions have no
   durable disk, so without KV the ledger would vanish between requests.
5. **Settings → Environment Variables**, add `STOCKKAR_ACTIVATION_ADMIN_TOKEN`:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

   Until it is set, the admin endpoints refuse everyone. That is the correct
   default for a public URL — never "open".
6. **Deploy**, then check:

   ```bash
   curl https://<project>.vercel.app/v1/health
   ```

   Expect `{"ok":true,"driver":"upstash"}`. If `driver` says `file`, KV is not
   connected — the ledger will be lost on every cold start. Fix that before
   pointing any customer at it.

## Deploy on a plain server instead

```bash
STOCKKAR_ACTIVATION_ADMIN_TOKEN=… node activation-server/server.js
```

Port 7900, ledger at `activation-server/data/activations.json`. Put it behind
HTTPS and back the file up.

Set `STOCKKAR_ACTIVATION_PORT` to move it. Prefer that over `PORT`: on a box
that already runs the trading app, `PORT` is usually already exported (7777)
and this service would inherit it and fail to bind.

## Point the fleet at it

On each customer box:

```bash
STOCKKAR_ACTIVATION_URL=https://<project>.vercel.app/v1/activate
```

Leave it unset and nothing calls anything — the box stays provisional with full
features. That is why the client can ship before the service exists.

## Admin

```bash
# who has activated what
curl -H "Authorization: Bearer $TOKEN" https://<host>/v1/admin/activations

# a customer moved servers — free the slot
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"keyId":"lic_124811eb"}' https://<host>/v1/admin/release

# take a licence away / give it back (the box learns at its next daily check)
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"keyId":"lic_124811eb","reason":"payment failed"}' https://<host>/v1/admin/revoke
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"keyId":"lic_124811eb"}' https://<host>/v1/admin/unrevoke
```

Or skip curl entirely: **`https://<host>/console`** is the licence console — the
full ledger with ACTIVE / REVOKED status and one-click Revoke / Unrevoke /
Release buttons. It is a static page; paste the same admin token once (every
API call it makes carries the Bearer header, so an unset token still means
admin is off).

## Email activation (2026-09-10)

Customers no longer paste a key. They type the email they registered with, and
the service signs a **grant** for that box - the same `STK1` format a key has,
bound to the box's install id, verified offline by `license.js` from then on.

1. Generate the grant key pair once (`node -e` with `crypto.generateKeyPairSync('ed25519')`)
   and set **`STOCKKAR_GRANT_PRIVATE_KEY`** (PEM, or one-line base64 PKCS8 DER) on
   the service. Its PUBLIC half is baked into `license.js` and `verify.js`
   (`BAKED_GRANT_PUBLIC_KEY`; `emailgrant.test.js` keeps the two equal). The
   offline issuer key never goes near the service.
2. Load the customer list in `/console` (one per line: `email, name, product,
   expiry[, addons]`), or with the API:

```bash
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"rows":[{"email":"ramesh@example.com","name":"Ramesh K","product":"stockkar_only","exp":"lifetime"}]}' \
  https://<host>/v1/admin/customers-import
curl -H "Authorization: Bearer $TOKEN" https://<host>/v1/admin/customers
```

`product` = `stockkar_only` | `both` | `gsheet_only`; `exp` = `YYYY-MM-DD` or
`lifetime`. An update row changes only what it states.

3. The box calls `POST /v1/claim` `{ email, installId, meta }` and gets
   `{ ok, state: 'activated', grant }`, or `state: 'unknown-email' | 'claimed' |
   'revoked'`. First box wins; the email's id is `eml_<hash>` and **Release /
   Revoke** work on it exactly like a key's `lic_` id.
4. The box's daily `/v1/activate` check carries a fresh grant whenever the
   customer's plan or expiry changed, so renewals need no new key.

Without `STOCKKAR_GRANT_PRIVATE_KEY` the claim route answers 500 and nothing is
recorded; pasted keys keep working regardless.

## Testing against a staging issuer

Set `STOCKKAR_ISSUER_PUBLIC_KEY` to a throwaway issuer's base64 SPKI key and the
service verifies against that instead of the baked production issuer. Unset in
production.
