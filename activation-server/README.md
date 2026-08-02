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
```

## Testing against a staging issuer

Set `STOCKKAR_ISSUER_PUBLIC_KEY` to a throwaway issuer's base64 SPKI key and the
service verifies against that instead of the baked production issuer. Unset in
production.
