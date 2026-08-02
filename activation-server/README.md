# Activation service

One key, one box. Read `docs/ACTIVATION.md` first — it explains why this may
only ever say "no" once, and why silence must always mean "yes".

## Deploy on Vercel (the plan)

The functions in `api/` are plain Node handlers with no dependencies. Vercel has
no durable disk, so the store must be Vercel KV / Upstash.

1. Create a Vercel project pointed at this directory.
2. Add a KV store (Storage → KV → connect). That sets `KV_REST_API_URL` and
   `KV_REST_API_TOKEN` automatically.
3. Add an env var `STOCKKAR_ACTIVATION_ADMIN_TOKEN` — a long random string.
   **Until it is set, the admin endpoints refuse everyone**, which is the safe
   default for a public URL. Generate one with:

   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

4. Deploy. Check `https://<project>.vercel.app/v1/health`.

`license.js` is required from the parent directory, so deploy from the repo
root with this folder as the project root — that way the service and the
customer boxes can never drift apart on what a valid key is.

## Deploy on a plain server (the alternative)

```bash
STOCKKAR_ACTIVATION_ADMIN_TOKEN=… node activation-server/server.js
```

Defaults to port 7900 and a JSON file at `activation-server/data/activations.json`.
Put it behind the same HTTPS the box already uses. **Back the file up** — losing
it means every customer can re-activate anywhere, which fails open rather than
locking anyone out, but it does discard the ledger.

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
service will verify against that instead of the baked production issuer. Unset
in production.
