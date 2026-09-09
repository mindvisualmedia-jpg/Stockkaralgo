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
// REVOCATION (2026-08-21): an ACTIVE box re-confirms on this cadence instead
// of never. THE SAFETY RULE is unchanged - silence, errors and our own
// downtime never downgrade an active box; only an explicit 'revoked' (or
// 'claimed') answer can.
const RECHECK_ACTIVE_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 6000;

// FLEET DEFAULT (2026-08-24): the service address ships IN THE CODE. It used
// to live only in STOCKKAR_ACTIVATION_URL, but the updater restarts pm2 with
// an env whitelist that would silently wipe it - the same wipe that once
// stopped a live No-SL algo (see readRiskSettings in server.js). Baked in,
// every box knows where home is the moment it updates; the env var remains as
// an override, and 'off' disables calls entirely (dev / test / staging boxes).
const DEFAULT_ACTIVATION_URL = 'https://stockkaralgo-key.vercel.app/v1/activate';
function activationUrl(env = process.env) {
  const v = String(env.STOCKKAR_ACTIVATION_URL || '').trim();
  if (/^(off|0|none|disabled)$/i.test(v)) return '';
  return v || DEFAULT_ACTIVATION_URL;
}

/**
 * This box's identity. A random value, generated once, in its OWN file so that
 * replacing a licence key does not change who the box is.
 *
 * Deliberately NOT derived from hardware: MAC addresses and machine ids change
 * when a VPS is resized or restored, which would strand paying customers.
 */
// EMAIL ACTIVATION (2026-09-10): the claim endpoint sits beside the activate one.
function claimUrl(env = process.env) {
  const u = activationUrl(env);
  return u ? u.replace(/\/v1\/activate\/?$/, '/v1/claim') : '';
}

/**
 * Activate this box with a registered email. The service answers with a signed
 * grant (STK1 format, bound to this install id) that the caller stores as the
 * licence. Never writes anything itself; never throws - every failure is a state.
 * @returns {Promise<{state:string, grant?:string, first?:boolean, installId:string, error?:string, claimedAt?:string}>}
 */
async function claimByEmail(o = {}) {
  const dir = o.dir || '.';
  const id = installId(dir);
  const url = o.url !== undefined ? String(o.url) : claimUrl();
  const email = String(o.email || '').trim().toLowerCase();
  if (!url) return { state: 'not-configured', installId: id };
  if (!email) return { state: 'bad-email', installId: id };
  let res;
  try {
    res = await postJson(url, { email, installId: id, meta: { host: (require('os').hostname() || '').slice(0, 80), version: o.version || '' } }, o.timeoutMs || TIMEOUT_MS);
  } catch (e) {
    return { state: 'unreachable', installId: id, error: String(e.message || e).slice(0, 120) };
  }
  const b = res.body || {};
  if (res.status === 200 && b.ok && b.state === 'activated' && b.grant) return { state: 'activated', grant: String(b.grant), first: !!b.first, installId: id };
  if (res.status === 200 && ['unknown-email', 'claimed', 'revoked'].includes(b.state)) return { state: b.state, installId: id, claimedAt: b.claimedAt || null, error: String(b.reason || '').slice(0, 120) };
  return { state: 'unexpected', installId: id, error: ('unexpected reply ' + res.status + (b.error ? ' ' + b.error : '')).slice(0, 160) };
}

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
  // An explicitly passed url (even '') wins; otherwise env override, then the
  // baked default. Only 'off'-style env values yield no url at all now.
  const url = o.url !== undefined ? String(o.url) : activationUrl();
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

  // Already ours. An active box re-confirms once a day (revocation support,
  // 2026-08-21); between checks it does not ask, and a failed check can never
  // demote it - ask() preserves 'active' on every non-answer.
  if (cur.state === 'active' && !o.force) {
    const since = now.getTime() - (Date.parse(cur.lastTry || cur.activatedAt || '') || 0);
    if (Number.isFinite(since) && since >= 0 && since < RECHECK_ACTIVE_MS) {
      return { state: 'active', reason: 'already', changed: false };
    }
  }

  if (!o.force && cur.lastTry) {
    const since = now.getTime() - Date.parse(cur.lastTry);
    if (Number.isFinite(since) && since >= 0 && since < RETRY_AFTER_MS) {
      return { state: cur.state || 'provisional', reason: 'backoff', changed: false };
    }
  }

  return await ask();

  async function ask() {
    const id = installId(dir);
    // firstTryAt: when this box FIRST tried to reach the service - preserved
    // across retries. license.js uses it for the compulsory-activation rule
    // (never succeeded within the grace window -> entries pause).
    const base = { installId: id, keyId, lastTry: now.toISOString(), firstTryAt: cur.firstTryAt || now.toISOString() };
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
      // An email-activated box may receive a freshly signed grant with its daily
      // answer (plan / expiry changes). Passed up; the caller decides whether it verifies.
      return { state: 'active', reason: b.first ? 'claimed-first' : 'confirmed', changed: cur.state !== 'active', grant: typeof b.grant === 'string' ? b.grant : '' };
    }

    if (res.status === 200 && b.state === 'revoked') {
      // The issuer explicitly revoked this key. Recorded; entries stop, open
      // positions keep every exit path (license.js decides features, not us).
      writeActivation(dir, { ...base, state: 'revoked', revokedAt: b.revokedAt || now.toISOString(), revokedReason: String(b.reason || '').slice(0, 120) });
      return { state: 'revoked', reason: 'revoked-by-issuer', changed: cur.state !== 'revoked' };
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

module.exports = { ensureActivated, installId, clearActivation, activationUrl, DEFAULT_ACTIVATION_URL, RETRY_AFTER_MS, claimByEmail, claimUrl };
