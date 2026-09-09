/**
 * Vercel function: POST /api/claim  (rewritten from /v1/claim)
 *
 * Email activation: { email, installId, meta } -> a signed grant for this box.
 * Same core as the standalone server. Needs STOCKKAR_GRANT_PRIVATE_KEY.
 */
'use strict';

const { createStore } = require('../store');
const core = require('../core');

let store;

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    if (!store) store = createStore();
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const out = await core.claimByEmail(store, body);
    console.log('[CLAIM] ' + (out.body.state || 'error') + ' ' + String(body.email || '?').slice(0, 60) + ' ' + String(body.installId || '?').slice(0, 12));
    res.setHeader('cache-control', 'no-store');
    return res.status(out.status).json(out.body);
  } catch (e) {
    console.error('[CLAIM] ' + e.message);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
};
