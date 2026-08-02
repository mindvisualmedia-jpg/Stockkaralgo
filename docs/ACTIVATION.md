# Activation — one key, one box

A Stockkar licence key is a signed string. Signature checking is pure maths, so a
key that is genuine on one machine is genuine on every machine. That is good for
reliability (a customer's algo never stops because our servers are down) and bad
for revenue (one key pasted into a group chat is unlimited installs).

Activation closes that gap **without giving up the reliability**.

## The one-sentence contract

> The activation service may refuse a key **once**, at the moment it is first
> pasted on a new box. After a box is activated it never depends on the service
> again — not to trade, not to start, not to renew.

Everything below follows from that sentence.

## Threat model — say plainly what this does and does not stop

STOPS: a customer forwarding their key string to a friend. The friend's box is a
different install, the service sees the key already claimed, and the friend's
install refuses. This is the realistic case and it is the whole point.

DOES NOT STOP: someone copying the entire data directory (key + install id) to a
second box, or editing `license.js` on a machine they own. No client-side scheme
can stop either. Activation moves sharing from *trivial and invisible* to
*deliberate tampering that shows up in the ledger*, which is the right place to
stop for a product with a few hundred customers.

## Parts

| Part | Where it runs | Job |
|---|---|---|
| `activation-server/` | ONE server we own | Remembers which install claimed which key |
| `activation.js` | every customer box | Asks once, records the answer, never asks again |
| `license.js` | every customer box | Honours a recorded refusal |

The service is deliberately tiny. It holds no secrets belonging to customers, it
never issues features, and it cannot make a key *more* powerful — only refuse a
second claim. If it is deleted tomorrow, every already-activated customer keeps
trading and only new activations are affected.

## The install id

`install_id.json` in the data directory holds a random 16-byte hex string,
generated once. It is not derived from hardware, because hardware ids change
under virtualisation and would strand legitimate customers after a resize.

It is deliberately a SEPARATE file from `license.json` so that replacing a
licence key does not change the box's identity.

## The states

A box is always in exactly one activation state, stored in `license.json`:

- **`active`** — the service confirmed this install owns the key. Terminal and
  sticky: once here, we never downgrade on a later network failure.
- **`provisional`** — we could not reach the service (no URL configured, DNS
  down, firewall, timeout). **Full features.** We retry quietly, at most once a
  day. A customer must never be punished for our downtime or their firewall.
- **`refused`** — the service said this key is claimed by a DIFFERENT install.
  This is the only state that removes features, and only ever on an explicit
  answer from the service. Never on an error.

Note the asymmetry, which is the safety property: silence means yes, and only a
clear, signed-for "no" means no.

Replacing the licence key clears the activation block — a refusal is tied to the
key id that earned it (`activation.keyId`), so pasting a fresh key gives the box
a clean start rather than a permanent black mark.

## Wire protocol

`POST /v1/activate`

```json
{ "key": "STK1.…", "installId": "9f2c…", "meta": { "host": "ip-10-0-0-4", "version": "3.3.0" } }
```

The service verifies the Ed25519 signature itself, with the same `license.js`
the customer box uses, before recording anything. Junk cannot pollute the
ledger, and the verifier can never drift between the two sides.

Replies:

```json
{ "ok": true,  "state": "activated", "first": true }        // first claim
{ "ok": true,  "state": "activated", "first": false }       // same box again (idempotent)
{ "ok": false, "state": "claimed", "claimedAt": "2026-08-02T…" }   // different box
```

Any other reply, any status that is not 200, any timeout — the box stays
`provisional`. Only `state: "claimed"` produces a refusal.

`GET /v1/health` → `{ ok: true }`, for uptime checks.

## Admin

Bearer token in `STOCKKAR_ACTIVATION_ADMIN_TOKEN`, compared in constant time.

- `GET  /v1/admin/activations` — the ledger: key id, product, customer, install
  id, first seen, last seen, host. This is the customer telemetry we never had.
- `POST /v1/admin/release` `{ "keyId": "lic_…" }` — free the slot.

**Release is not optional.** Customers legitimately move servers — a rebuild, a
provider change, a restore from backup. Without a release button every such
migration is a support ticket with no resolution. With it, it is ten seconds.

## Configuration

On a customer box, `STOCKKAR_ACTIVATION_URL` points at the service. When unset,
activation is skipped entirely and every box stays `provisional` with full
features — which is exactly how the fleet behaves today, and is why this can be
shipped before the service is even deployed.

## What must never happen

1. Activation must never run on the request path of anything that trades.
2. A network failure must never reduce features.
3. The service must never be able to *grant* anything. It can only refuse a
   second claim of an already-signed key.
4. Legacy grace outranks activation: an existing user inside the grace window
   keeps their features regardless of activation state.
