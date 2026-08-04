/**
 * Vercel function: POST /api/activate
 *
 * Same core as the standalone server. On Vercel there is no durable disk, so
 * the store must be Upstash / Vercel KV — set KV_REST_API_URL and
 * KV_REST_API_TOKEN (Vercel KV sets both for you when you attach the store).
 */
'use strict';

const { createStore } = require('../store');
const core = require('../core');

let store;   // created once per warm instance, reused across invocations

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });
  try {
    if (!store) store = createStore();
    // Vercel parses JSON bodies already; tolerate a raw string either way.
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const out = await core.activate(store, body);
    console.log('[ACTIVATE] ' + (out.body.state || 'error') + ' ' + String(body.installId || '?').slice(0, 12));
    res.setHeader('cache-control', 'no-store');
    return res.status(out.status).json(out.body);
  } catch (e) {
    console.error('[ACTIVATE] ' + e.message);
    return res.status(500).json({ ok: false, error: 'server error' });
  }
};
