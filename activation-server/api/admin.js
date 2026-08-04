/**
 * Vercel function: /api/admin  — the ledger and the release button.
 *
 *   GET  /api/admin?action=activations
 *   POST /api/admin   { "action": "release", "keyId": "lic_…" }
 *
 * Both need:  Authorization: Bearer $STOCKKAR_ACTIVATION_ADMIN_TOKEN
 *
 * Vercel gives every deployment a public URL, so an unset token must mean
 * "admin disabled", never "admin open". core.adminOk() enforces that.
 */
'use strict';

const { createStore } = require('../store');
const core = require('../core');

let store;

module.exports = async (req, res) => {
  const token = process.env.STOCKKAR_ACTIVATION_ADMIN_TOKEN || '';
  if (!core.adminOk(req.headers.authorization, token)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  try {
    if (!store) store = createStore();
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String((req.query && req.query.action) || body.action || 'activations');

    res.setHeader('cache-control', 'no-store');

    if (action === 'activations') {
      const out = await core.listActivations(store);
      return res.status(out.status).json(out.body);
    }
    if (action === 'release') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
      const out = await core.release(store, body.keyId);
      console.log('[ACTIVATE] released ' + body.keyId);
      return res.status(out.status).json(out.body);
    }
    return res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    console.error('[ACTIVATE] ' + e.message);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
};
