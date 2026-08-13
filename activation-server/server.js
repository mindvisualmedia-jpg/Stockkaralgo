/**
 * Activation service — standalone Node front end. Zero dependencies.
 *
 *   node activation-server/server.js
 *
 * Env:
 *   STOCKKAR_ACTIVATION_PORT           default 7900 (wins over PORT)
 *   PORT                               fallback only — often already set on a box
 *   STOCKKAR_ACTIVATION_ADMIN_TOKEN    required for /v1/admin/* (unset = admin off)
 *   STOCKKAR_ACTIVATION_STORE          file | upstash  (see store.js)
 *   STOCKKAR_ACTIVATION_FILE           file driver path
 *
 * On Vercel use activation-server/api/*.js instead; both call the same core.
 */
'use strict';

const http = require('http');
const { createStore } = require('./store');
const core = require('./core');

// PORT is a name every process on a box tends to carry. On a machine already
// running the trading app, `PORT=7777` was exported in the shell and this
// service silently inherited it, then died on EADDRINUSE against the app it is
// meant to licence (2026-08-13). A dedicated name wins; PORT stays as the
// fallback because some hosts set it as the contract.
const PORT = Number(process.env.STOCKKAR_ACTIVATION_PORT || process.env.PORT || 7900);
const ADMIN_TOKEN = process.env.STOCKKAR_ACTIVATION_ADMIN_TOKEN || '';
const store = createStore();

// A crude per-IP limiter. Activation is a once-per-install event, so anything
// hammering it is either broken or hostile; either way we slow it down.
const hits = new Map();
const RATE_MAX = 60, RATE_WINDOW = 60_000;
function rateLimited(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW) { hits.set(ip, { start: now, n: 1 }); return false; }
  rec.n++;
  if (hits.size > 5000) hits.clear();     // bounded memory; a blunt but safe reset
  return rec.n > RATE_MAX;
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readBody(req, cb) {
  let data = '';
  let tooBig = false;
  req.on('data', (c) => {
    data += c;
    if (data.length > 8192 && !tooBig) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return cb(new Error('body too large'));
    try { cb(null, data ? JSON.parse(data) : {}); } catch (e) { cb(e); }
  });
  req.on('error', (e) => cb(e));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

  try {
    if (url.pathname === '/v1/health') return send(res, 200, { ok: true, driver: store.driver });

    if (url.pathname === '/v1/activate' && req.method === 'POST') {
      if (rateLimited(ip)) return send(res, 429, { ok: false, error: 'slow down' });
      return readBody(req, async (err, body) => {
        if (err) return send(res, 400, { ok: false, error: 'bad request body' });
        const out = await core.activate(store, body);
        // One line per activation; this is the fleet visibility we never had.
        console.log('[ACTIVATE] ' + (out.body.state || 'error') + ' ' + (body && body.installId || '?').slice(0, 12) + ' ' + ip);
        return send(res, out.status, out.body);
      });
    }

    if (url.pathname.startsWith('/v1/admin/')) {
      if (!core.adminOk(req.headers.authorization, ADMIN_TOKEN)) {
        return send(res, 401, { ok: false, error: 'unauthorized' });
      }
      if (url.pathname === '/v1/admin/activations' && req.method === 'GET') {
        const out = await core.listActivations(store);
        return send(res, out.status, out.body);
      }
      if (url.pathname === '/v1/admin/release' && req.method === 'POST') {
        return readBody(req, async (err, body) => {
          if (err) return send(res, 400, { ok: false, error: 'bad request body' });
          const out = await core.release(store, body && body.keyId);
          console.log('[ACTIVATE] released ' + (body && body.keyId));
          return send(res, out.status, out.body);
        });
      }
    }

    return send(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    console.error('[ACTIVATE] ' + e.message);
    return send(res, 500, { ok: false, error: 'server error' });
  }
});

if (require.main === module) {
  // A licensing service that cannot start must say why in one line. The raw
  // EADDRINUSE stack sends people reading node internals instead of moving a
  // port.
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error('Activation service cannot start: port ' + PORT + ' is already in use.');
      console.error('Set STOCKKAR_ACTIVATION_PORT to a free port (default 7900), e.g. STOCKKAR_ACTIVATION_PORT=7901 node server.js');
      if (Number(process.env.PORT) === PORT) {
        console.error('NOTE: this port came from PORT=' + process.env.PORT + ' in the environment, not from a default.');
      }
      process.exit(1);
    }
    console.error('Activation service error: ' + (err && err.message));
    process.exit(1);
  });
  server.listen(PORT, () => {
    console.log('Activation service on :' + PORT + '  store=' + store.driver
      + (ADMIN_TOKEN ? '' : '  (admin DISABLED - set STOCKKAR_ACTIVATION_ADMIN_TOKEN)'));
  });
}

module.exports = { server, store };
