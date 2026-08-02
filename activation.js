/**
 * Activation client — runs on the customer's box.
 *
 * Asks our service, once, whether this install may claim this key. Records the
 * answer and then gets out of the way forever.
 *
 * THE SAFETY RULE, which every branch below obeys:
 *
 *   Silence means yes. Only an explicit "claimed" from the service can reduce
 *   what a customer gets. A timeout, a DNS failure, a firewall, a 500, an
 *   unparseable reply, our own service being deleted — all of these leave the
 *   box PROVISIONAL, which has full features.
 *
 * Nothing here is on the path of anything that trades. It is called after a key
 * is pasted and from a slow background retry, never from order handling.
 *
 * See docs/ACTIVATION.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

const RETRY_AFTER_MS = 24 * 60 * 60 * 1000;   // a provisional box retries daily
const TIMEOUT_MS = 6000;

/**
 * This box's identity. A random value, generated once, in its OWN file so that
 * replacing a licence key does not change who the box is.
 *
 * Deliberately NOT derived from hardware: MAC addresses and machine ids change
 * when a VPS is resized or restored, which would strand paying customers.
 */
function installId(dir) {
  const file = path.join(dir, 'install_id.json');
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (cur && /^[a-f0-9]{32}$/.test(String(cur.installId))) return cur.installId;
  } catch { /* missing or corrupt - make a new one */ }
  const id = crypto.randomBytes(16).toString('hex');
  try {
    fs.writeFileSync(file, JSON.stringify({ installId: id, createdAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  } catch { /* read-only disk: still usable this run, just not remembered */ }
  return id;
}

function readLicenseFile(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'license.json'), 'utf8')) || {}; } catch { return {}; }
}

function writeActivation(dir, activation) {
  const file = path.join(dir, 'license.json');
  try {
    const cur = readLicenseFile(dir);
    fs.writeFileSync(file, JSON.stringify({ ...cur, activation }, null, 2), { mode: 0o600 });
  } catch { /* never let a disk problem break the caller */ }
  return activation;
}

function postJson(url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad activation url')); }
    const mod = u.protocol === 'http:' ? http : https;
    const payload = JSON.stringify(body);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(new Error('unreadable reply')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

/**
 * Ask the service about this key, if we need to.
 *
 * @param {object} o
 * @param {string} o.dir      data directory (holds license.json, install_id.json)
 * @param {string} o.key      the raw licence key
 * @param {string} o.keyId    licence id from the verified payload
 * @param {string} [o.url]    service endpoint; default STOCKKAR_ACTIVATION_URL
 * @param {boolean} [o.force] retry even if we asked recently
 * @returns {Promise<{state:string, reason?:string, changed:boolean}>}
 */
async function ensureActivated(o = {}) {
  const dir = o.dir || '.';
  const url = o.url || process.env.STOCKKAR_ACTIVATION_URL || '';
  const key = String(o.key || '');
  const keyId = String(o.keyId || '');
  const stored = readLicenseFile(dir);
  const cur = stored.activation || {};
  const now = o.now instanceof Date ? o.now : new Date();

  // No key, or no service configured: nothing to do. An unconfigured fleet
  // behaves exactly as it does today - full features, no calls, no records.
  if (!key || !url) return { state: cur.state || 'provisional', reason: 'not-configured', changed: false };

  // A refusal belongs to the key that earned it. Pasting a different key is a
  // clean slate, not a permanent black mark on the box.
  if (cur.keyId && keyId && cur.keyId !== keyId) {
    return await ask();
  }

  // Already ours. The contract says an activated box never depends on the
  // service again, so we do not even ask.
  if (cur.state === 'active') return { state: 'active', reason: 'already', changed: false };

  if (!o.force && cur.lastTry) {
    const since = now.getTime() - Date.parse(cur.lastTry);
    if (Number.isFinite(since) && since >= 0 && since < RETRY_AFTER_MS) {
      return { state: cur.state || 'provisional', reason: 'backoff', changed: false };
    }
  }

  return await ask();

  async function ask() {
    const id = installId(dir);
    const base = { installId: id, keyId, lastTry: now.toISOString() };
    let res;
    try {
      res = await postJson(url, {
        key,
        installId: id,
        meta: { host: (require('os').hostname() || '').slice(0, 80), version: o.version || '' },
      }, o.timeoutMs || TIMEOUT_MS);
    } catch (e) {
      // Could not reach us. Full features; try again tomorrow.
      writeActivation(dir, { ...base, state: cur.state === 'active' ? 'active' : 'provisional', error: String(e.message || e).slice(0, 120) });
      return { state: 'provisional', reason: 'unreachable', changed: false };
    }

    const b = res.body || {};

    if (res.status === 200 && b.ok && b.state === 'activated') {
      writeActivation(dir, { ...base, state: 'active', activatedAt: now.toISOString(), first: !!b.first });
      return { state: 'active', reason: b.first ? 'claimed-first' : 'confirmed', changed: cur.state !== 'active' };
    }

    if (res.status === 200 && b.state === 'claimed') {
      // The one branch that takes something away.
      writeActivation(dir, { ...base, state: 'refused', claimedAt: b.claimedAt || null });
      return { state: 'refused', reason: 'claimed-elsewhere', changed: cur.state !== 'refused' };
    }

    // Anything else - a 400, a 500, a reply we do not understand - is OUR
    // problem, not the customer's. Stay provisional.
    writeActivation(dir, { ...base, state: cur.state === 'active' ? 'active' : 'provisional', error: 'unexpected reply ' + res.status });
    return { state: 'provisional', reason: 'unexpected', changed: false };
  }
}

/** Forget the activation record - used when a different key is pasted. */
function clearActivation(dir) {
  try {
    const cur = readLicenseFile(dir);
    delete cur.activation;
    fs.writeFileSync(path.join(dir, 'license.json'), JSON.stringify(cur, null, 2), { mode: 0o600 });
  } catch { /* best effort */ }
}

module.exports = { ensureActivated, installId, clearActivation, RETRY_AFTER_MS };
