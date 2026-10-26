'use strict';
// backup.js - the box's data folder as ONE file, and back again (2026-10-26).
//
// WHY. Every customer runs Stockkar on their own cloud server. When that
// account expires (AWS free tier, October 2026) the server stops, and with it
// the only copy of their algos, positions, history, broker logins and licence.
// Owner: "nobody will click download" - so the box sends this file to the
// customer's own Telegram every evening (server.js runTelegramBackup), and a
// new server takes it back in one upload (Settings -> Restore from backup).
//
// WHAT. Every file in the data folder, as it is - broker logins, Telegram and
// the licence included (owner, 2026-10-26: "everything broker telegram etc
// moves"; the licence follows install_id.json). Left behind are only the
// things that belong to the old SERVER: its App Lock and update PINs (the new
// server has its own, set a minute before the restore), support passes,
// crash / update / backup bookkeeping, debug samples and the re-downloadable
// Angel instrument cache.
//
// FORMAT. gzip(JSON): { kind, format: 1, createdAt, appVersion,
// files: [{ name, encoding: 'utf8' | 'base64', data }] }. Plain Node, no tar.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const KIND = 'stockkar-backup';
const FORMAT = 1;
const BOX_ONLY = new Set(['app_lock.json', 'update_pin.json', 'support_access.json', 'boot_loop.json',
  'update_status.json', 'backup_state.json', 'payload_samples.jsonl', 'angel_instruments.json']);
const isBoxOnly = (name) => BOX_ONLY.has(name) || /^pre-restore-.*\.json\.gz$/.test(name) || /\.tmp$/.test(name);
// A plain file name: no folders, so nothing can be written outside the data folder.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_UNPACKED = 300 * 1024 * 1024;   // a real backup is a few MB; anything that inflates past this is not one

function filesToKeep(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter(n => SAFE_NAME.test(n) && !isBoxOnly(n)).sort().filter(n => {
    try { return fs.statSync(path.join(dir, n)).isFile(); } catch { return false; }
  });
}

// The data folder -> one gzip buffer. Text files travel as text (they compress
// far better); anything that is not clean UTF-8 travels as base64.
function pack(dir, o = {}) {
  const files = filesToKeep(dir).map(name => {
    const buf = fs.readFileSync(path.join(dir, name));
    const text = buf.toString('utf8');
    const utf8 = Buffer.from(text, 'utf8').equals(buf);
    return { name, encoding: utf8 ? 'utf8' : 'base64', data: utf8 ? text : buf.toString('base64') };
  });
  const doc = { kind: KIND, format: FORMAT, createdAt: (o.now || new Date()).toISOString(), appVersion: String(o.appVersion || ''), files };
  return { buffer: zlib.gzipSync(Buffer.from(JSON.stringify(doc), 'utf8'), { level: 9 }), files: files.map(f => f.name), createdAt: doc.createdAt };
}

// A backup file -> its files. Throws an Error whose message is fit to show the
// customer when the file is not a Stockkar backup. (o.maxBytes: tests only.)
function unpack(buffer, o = {}) {
  let raw;
  try { raw = zlib.gunzipSync(buffer, { maxOutputLength: o.maxBytes || MAX_UNPACKED }); }
  catch (e) { throw new Error('This is not a Stockkar backup file - it could not be opened.'); }
  let doc;
  try { doc = JSON.parse(raw.toString('utf8')); } catch (e) { throw new Error('This is not a Stockkar backup file - its contents are unreadable.'); }
  if (!doc || doc.kind !== KIND) throw new Error('This is not a Stockkar backup file.');
  if (Number(doc.format) !== FORMAT) throw new Error('This backup was made by a newer Stockkar. Update this server (Settings -> Software Updates), then restore.');
  if (!Array.isArray(doc.files) || !doc.files.length) throw new Error('This backup holds no files.');
  const seen = new Set();
  const files = [];
  for (const f of doc.files) {
    const name = String((f && f.name) || '');
    if (!SAFE_NAME.test(name) || seen.has(name)) throw new Error('This backup has an unexpected file name (' + name.slice(0, 60) + ') - nothing was restored.');
    seen.add(name);
    if (isBoxOnly(name)) continue;                          // never ours to take, whoever packed it
    if (f.encoding !== 'utf8' && f.encoding !== 'base64') throw new Error('This backup has a file in an unknown form (' + name + ') - nothing was restored.');
    files.push({ name, data: f.encoding === 'base64' ? Buffer.from(String(f.data || ''), 'base64') : Buffer.from(String(f.data || ''), 'utf8') });
  }
  return { createdAt: String(doc.createdAt || ''), appVersion: String(doc.appVersion || ''), files };
}

// Write a backup into the data folder. What it replaces is kept first, as
// pre-restore-<time>.json.gz (never part of a later backup), then each file
// goes in whole (written aside, then renamed over the old one).
function restore(dir, unpacked, o = {}) {
  const stamp = (o.now || new Date()).toISOString().replace(/[:.]/g, '-');
  const keptAs = 'pre-restore-' + stamp + '.json.gz';
  fs.writeFileSync(path.join(dir, keptAs), pack(dir, o).buffer, { mode: 0o600 });
  for (const f of unpacked.files) {
    const target = path.join(dir, f.name);
    const tmp = target + '.restore.tmp';
    fs.writeFileSync(tmp, f.data, { mode: 0o600 });
    fs.renameSync(tmp, target);
  }
  return { restored: unpacked.files.length, keptAs };
}

module.exports = { pack, unpack, restore, isBoxOnly, KIND, FORMAT };
