/**
 * Activation store — two drivers behind one async interface.
 *
 *   file     a JSON file with atomic writes. Any VPS. The default.
 *   upstash  Upstash / Vercel KV over its REST API. Serverless (Vercel), where
 *            there is no durable disk. Plain HTTPS + a bearer token, so this
 *            stays zero-dependency like the rest of Stockkar.
 *
 * The interface is async for both, so the core logic never knows or cares which
 * one it is talking to.
 *
 * Driver choice: STOCKKAR_ACTIVATION_STORE=file|upstash. When unset we pick
 * upstash if its credentials are present (that is the Vercel case), else file.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

const PREFIX = 'stk:act:';

// ---------------------------------------------------------------- file driver

function fileStore(file) {
  const dir = path.dirname(file);
  const readAll = () => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
  };
  // Atomic: write a sibling temp file, then rename over the target. A crash
  // mid-write leaves the previous ledger intact rather than a truncated one.
  const writeAll = (all) => {
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };

  // Serialise writes through a promise chain. Node is single-threaded, but two
  // overlapping requests could still interleave read-modify-write across an
  // await and lose a claim. Same single-writer discipline as order_log.json.
  let chain = Promise.resolve();
  const serial = (fn) => (chain = chain.then(fn, fn));

  return {
    driver: 'file',
    async get(keyId) { return readAll()[keyId] || null; },
    async put(keyId, rec) {
      return serial(() => { const all = readAll(); all[keyId] = rec; writeAll(all); return rec; });
    },
    async del(keyId) {
      return serial(() => { const all = readAll(); delete all[keyId]; writeAll(all); });
    },
    async list() {
      const all = readAll();
      return Object.keys(all).map(k => ({ keyId: k, ...all[k] }));
    },
    /**
     * Claim if unclaimed. Returns the winning record and whether we created it.
     * Runs inside the write chain so two simultaneous first-activations cannot
     * both believe they were first.
     */
    async claim(keyId, rec) {
      return serial(() => {
        const all = readAll();
        const existing = all[keyId];
        if (existing) return { record: existing, created: false };
        all[keyId] = rec; writeAll(all);
        return { record: rec, created: true };
      });
    },
  };
}

// ------------------------------------------------------------- upstash driver

function upstashStore(url, token) {
  const base = String(url).replace(/\/+$/, '');

  // Upstash's REST API takes the command as URL path segments; the body form
  // is used for values that must not be URL-encoded.
  const call = (segments, body) => new Promise((resolve, reject) => {
    const u = new URL(base + '/' + segments.map(encodeURIComponent).join('/'));
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search,
      method: payload ? 'POST' : 'GET',
      headers: Object.assign(
        { authorization: 'Bearer ' + token },
        payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      timeout: 8000,
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) return reject(new Error('upstash ' + res.statusCode + ': ' + data.slice(0, 200)));
        try { resolve(JSON.parse(data).result); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('upstash timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  const parse = (v) => { try { return v ? JSON.parse(v) : null; } catch { return null; } };

  return {
    driver: 'upstash',
    async get(keyId) { return parse(await call(['get', PREFIX + keyId])); },
    async put(keyId, rec) { await call(['set', PREFIX + keyId], JSON.stringify(rec)); return rec; },
    async del(keyId) { await call(['del', PREFIX + keyId]); },
    async list() {
      const keys = (await call(['keys', PREFIX + '*'])) || [];
      if (!keys.length) return [];
      const vals = await call(['mget', ...keys]);
      return keys.map((k, i) => {
        const rec = parse(vals[i]);
        return rec ? { keyId: k.slice(PREFIX.length), ...rec } : null;
      }).filter(Boolean);
    },
    /**
     * SET NX is atomic server-side, which makes the race impossible rather than
     * merely unlikely: exactly one concurrent activation can create the record.
     */
    async claim(keyId, rec) {
      const ok = await call(['set', PREFIX + keyId, 'NX'], JSON.stringify(rec));
      if (ok) return { record: rec, created: true };
      return { record: await this.get(keyId), created: false };
    },
  };
}

function createStore(env = process.env) {
  const want = String(env.STOCKKAR_ACTIVATION_STORE || '').toLowerCase();
  const url = env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (want === 'upstash' || (!want && url && token)) {
    if (!url || !token) throw new Error('Upstash store selected but UPSTASH_REDIS_REST_URL / _TOKEN are not set.');
    return upstashStore(url, token);
  }
  return fileStore(env.STOCKKAR_ACTIVATION_FILE || path.join(__dirname, 'data', 'activations.json'));
}

module.exports = { createStore, fileStore, upstashStore };
