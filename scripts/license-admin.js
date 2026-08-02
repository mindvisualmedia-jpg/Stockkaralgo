#!/usr/bin/env node
'use strict';

/* Licence issuing tool - runs on YOUR machine only, never on a customer box.
 *
 *   node scripts/license-admin.js                 open the one-form panel (127.0.0.1:7899)
 *   node scripts/license-admin.js --show-public-key
 *   node scripts/license-admin.js --issue --to "Ramesh K" --features gsheet \
 *        [--suppress stockkar] [--bind-broker 1100XXXX] [--months 12]
 *
 * On first run it generates an Ed25519 keypair in ~/.stockkar-licensing/
 * (override with STOCKKAR_LICENSE_HOME). The PRIVATE key must never leave that
 * folder - back it up once. Publish the PUBLIC key by setting it as
 * STOCKKAR_LICENSE_PUBKEY on boxes, or pasting it into license.js at release.
 *
 * Every issued key is appended to ledger.json: who, what, when, expiry. That
 * ledger is your customer list until the registry exists.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const HOME = process.env.STOCKKAR_LICENSE_HOME || path.join(os.homedir(), '.stockkar-licensing');
const PRIV_FILE = path.join(HOME, 'issuer-private.pem');
const PUB_FILE = path.join(HOME, 'issuer-public.b64');
const LEDGER = path.join(HOME, 'ledger.json');
const PORT = Number(process.env.STOCKKAR_LICENSE_ADMIN_PORT || 7899);
const KNOWN_FEATURES = ['stockkar', 'gsheet'];

function ensureKeys() {
  fs.mkdirSync(HOME, { recursive: true });
  if (!fs.existsSync(PRIV_FILE)) {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    fs.writeFileSync(PRIV_FILE, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
    fs.writeFileSync(PUB_FILE, publicKey.export({ format: 'der', type: 'spki' }).toString('base64'));
    console.log('Generated a NEW issuer keypair in ' + HOME);
    console.log('BACK UP ' + PRIV_FILE + ' - without it you cannot issue future keys.\n');
  }
  return {
    priv: crypto.createPrivateKey(fs.readFileSync(PRIV_FILE, 'utf8')),
    pubB64: fs.readFileSync(PUB_FILE, 'utf8').trim(),
  };
}

const b64url = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function addMonths(months) {
  const d = new Date();
  d.setMonth(d.getMonth() + Number(months || 12));
  return d.toISOString().slice(0, 10);
}

function issue({ to, features, suppress, bindType, bindValue, months, note }, keys) {
  const clean = (arr) => [...new Set((arr || []).map(s => String(s).trim()).filter(f => KNOWN_FEATURES.includes(f)))];
  const feats = clean(features);
  if (!to || !String(to).trim()) throw new Error('Customer name is required');
  if (!feats.length) throw new Error('Pick at least one feature (' + KNOWN_FEATURES.join(', ') + ')');

  const payload = {
    v: 1,
    id: 'lic_' + crypto.randomBytes(4).toString('hex'),
    to: String(to).trim(),
    features: feats,
    suppress: clean(suppress),
    bind: bindValue ? { type: bindType || 'brokerClientId', value: String(bindValue).trim() } : { type: 'none' },
    iat: new Date().toISOString().slice(0, 10),
    exp: addMonths(months),
  };
  const seg = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.sign(null, Buffer.from(seg, 'utf8'), keys.priv);
  const key = 'STK1.' + seg + '.' + b64url(sig);

  let ledger = [];
  try { ledger = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch {}
  if (!Array.isArray(ledger)) ledger = [];
  ledger.push({ ...payload, note: note || '', issuedAt: new Date().toISOString(), key });
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2), { mode: 0o600 });

  return { key, payload };
}

// ---------------- CLI ----------------
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const keys = ensureKeys();

if (argv.includes('--show-public-key')) {
  console.log('\nIssuer public key (SPKI base64) - publish this, it cannot sign anything:\n');
  console.log(keys.pubB64 + '\n');
  console.log('On a box:  STOCKKAR_LICENSE_PUBKEY=' + keys.pubB64.slice(0, 24) + '...\n');
  process.exit(0);
}

if (argv.includes('--issue')) {
  try {
    const { key, payload } = issue({
      to: arg('to'),
      features: String(arg('features', 'gsheet')).split(','),
      suppress: String(arg('suppress', '')).split(',').filter(Boolean),
      bindType: arg('bind-type', 'brokerClientId'),
      bindValue: arg('bind-broker'),
      months: arg('months', 12),
      note: arg('note', ''),
    }, keys);
    console.log('\n' + payload.to + '  ' + payload.features.join('+')
      + (payload.suppress.length ? '  (suppress ' + payload.suppress.join(',') + ')' : '')
      + '  expires ' + payload.exp + '\n');
    console.log(key + '\n');
    console.log('Logged to ' + LEDGER);
  } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
  process.exit(0);
}

// ---------------- one-form panel ----------------
const PAGE = `<!doctype html><meta charset="utf-8"><title>Stockkar licence issuer</title>
<style>
 body{font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;background:#0d1420;color:#e8eef6;margin:0;padding:32px}
 .card{max-width:640px;margin:0 auto;background:#131d2c;border:1px solid #22314a;border-radius:14px;padding:26px 28px}
 h1{font-size:19px;margin:0 0 4px} .sub{color:#8ba0bb;font-size:13px;margin-bottom:22px}
 label{display:block;font-size:12.5px;color:#9db2cc;margin:14px 0 5px}
 input[type=text],input[type=number],select{width:100%;box-sizing:border-box;background:#0d1420;border:1px solid #2a3b57;color:#e8eef6;border-radius:9px;padding:10px 12px;font-size:14px}
 .row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
 .chk{display:flex;gap:16px;margin-top:6px} .chk label{display:flex;align-items:center;gap:7px;margin:0;color:#e8eef6;font-size:14px}
 button{margin-top:20px;width:100%;background:#00a86b;border:0;color:#fff;font-weight:700;font-size:15px;padding:12px;border-radius:10px;cursor:pointer}
 #out{display:none;margin-top:20px;background:#0d1420;border:1px solid #2a3b57;border-radius:10px;padding:14px}
 code{word-break:break-all;font-size:12.5px;color:#7fe3b8;display:block;margin-bottom:10px}
 .copy{background:#22314a;margin-top:0} .err{color:#ff8b8b;margin-top:12px}
 .hint{color:#8ba0bb;font-size:12px;margin-top:6px}
</style>
<div class="card">
 <h1>Issue a Stockkar licence</h1>
 <div class="sub">Keys are signed offline. Nothing here touches a customer box.</div>
 <label>Customer name</label><input id="to" type="text" placeholder="Ramesh K" autofocus>
 <label>Features</label>
 <div class="chk">
   <label><input type="checkbox" id="f_gsheet" checked> Google Sheet</label>
   <label><input type="checkbox" id="sup_stockkar"> Sheet-only (hide Stockkar screeners)</label>
 </div>
 <div class="row">
  <div><label>Bind to broker client-id</label><input id="bind" type="text" placeholder="optional, stops sharing"></div>
  <div><label>Valid for (months)</label><input id="months" type="number" value="12" min="1" max="60"></div>
 </div>
 <label>Note (ledger only)</label><input id="note" type="text" placeholder="paid via UPI 2 Aug">
 <button onclick="go()">Generate key</button>
 <div id="err" class="err"></div>
 <div id="out"><code id="key"></code><button class="copy" onclick="cp()">Copy key</button><div class="hint" id="meta"></div></div>
</div>
<script>
async function go(){
 document.getElementById('err').textContent='';
 const body={to:document.getElementById('to').value,
   features:[document.getElementById('f_gsheet').checked?'gsheet':''].filter(Boolean),
   suppress:document.getElementById('sup_stockkar').checked?['stockkar']:[],
   bindValue:document.getElementById('bind').value,months:document.getElementById('months').value,
   note:document.getElementById('note').value};
 const r=await fetch('/issue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const j=await r.json();
 if(!j.ok){document.getElementById('err').textContent=j.error;return;}
 document.getElementById('key').textContent=j.key;
 document.getElementById('meta').textContent=j.payload.to+' · '+j.payload.features.join('+')+(j.payload.suppress.length?' · sheet-only':'')+' · expires '+j.payload.exp+' · '+j.payload.id;
 document.getElementById('out').style.display='block';
}
function cp(){navigator.clipboard.writeText(document.getElementById('key').textContent);}
</script>`;

http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (req.method === 'POST' && req.url === '/issue') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      try {
        const out = issue(JSON.parse(body || '{}'), keys);
        res.end(JSON.stringify({ ok: true, ...out }));
      } catch (e) { res.end(JSON.stringify({ ok: false, error: e.message })); }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
// 127.0.0.1 only: this process can mint licences, so it must never be reachable
// from the network.
}).listen(PORT, '127.0.0.1', () => {
  console.log('\nLicence issuer:  http://127.0.0.1:' + PORT);
  console.log('Keys + ledger:   ' + HOME);
  console.log('Public key:      node scripts/license-admin.js --show-public-key\n');
});
