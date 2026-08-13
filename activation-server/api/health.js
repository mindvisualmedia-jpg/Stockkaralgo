/**
 * Vercel function: GET /api/health  (rewritten from /v1/health)
 *
 * The one check that must work BEFORE any customer is pointed at this service:
 * is the ledger durable? Vercel functions have no disk, so a `file` driver here
 * means every cold start forgets who owns which key - and a licence that
 * forgets its claims enforces nothing.
 *
 * This existed only in server.js (the standalone path) until 2026-08-13, so the
 * documented Vercel verification step 404'd and the deploy could not be checked
 * at all.
 *
 * Deliberately says nothing else: no counts, no ids, no token state. It is a
 * public URL.
 */
'use strict';

const { createStore } = require('../store');

let store;   // created once per warm instance, reused across invocations

module.exports = async (req, res) => {
  res.setHeader('cache-control', 'no-store');
  try {
    if (!store) store = createStore();
    return res.status(200).json({ ok: true, driver: store.driver });
  } catch (e) {
    // A store that cannot even be constructed (Upstash selected, no
    // credentials) must be loud here rather than at the first activation.
    console.error('[HEALTH] ' + e.message);
    return res.status(500).json({ ok: false, error: 'store unavailable' });
  }
};
