#!/usr/bin/env node
'use strict';

/* Licence issuing tool - runs on YOUR machine only, never on a customer box.
 *
 *   node scripts/license-admin.js                  one-form panel (127.0.0.1:7899)
 *   node scripts/license-admin.js --show-public-key
 *   node scripts/license-admin.js --issue --product gsheet_only --to "Ramesh K" \
 *        [--email r@x.com] [--whatsapp 9876543210] [--bind-broker 1100XXXX] [--months 12|lifetime]
 *   node scripts/license-admin.js --issue --product both --bulk 25   (25 unassigned keys)
 *
 * Keys are SIGNED OFFLINE and carry their own proof - there is no sync. You
 * send the string, the customer pastes it, their box verifies the signature
 * against the public key baked into the app. No network anywhere.
 *
 * First run generates an Ed25519 keypair in ~/.stockkar-licensing/ (override
 * with STOCKKAR_LICENSE_HOME). The PRIVATE key must never leave that folder.
 * Every key issued is appended to ledger.json - name, email, whatsapp, product,
 * expiry - which is your customer list until a registry exists.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { PRODUCTS } = require('../license');

const HOME = process.env.STOCKKAR_LICENSE_HOME || path.join(os.homedir(), '.stockkar-licensing');
const PRIV_FILE = path.join(HOME, 'issuer-private.pem');
const PUB_FILE = path.join(HOME, 'issuer-public.b64');
const LEDGER = path.join(HOME, 'ledger.json');
const PORT = Number(process.env.STOCKKAR_LICENSE_ADMIN_PORT || 7899);

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

// Lifetime keys carry NO exp field at all - license.js only enforces expiry
// when one is present, so an absent exp means "never expires". Returns null so
// the caller omits the field rather than encoding a sentinel date.
function expiryFor(months) {
  if (String(months).toLowerCase() === 'lifetime' || Number(months) === 0) return null;
  const d = new Date();
  d.setMonth(d.getMonth() + (Number(months) > 0 ? Number(months) : 12));
  return d.toISOString().slice(0, 10);
}

function readLedger() {
  try { const l = JSON.parse(fs.readFileSync(LEDGER, 'utf8')); return Array.isArray(l) ? l : []; }
  catch { return []; }
}
function appendLedger(rows) {
  const all = readLedger().concat(rows);
  fs.writeFileSync(LEDGER, JSON.stringify(all, null, 2), { mode: 0o600 });
  return all.length;
}

/**
 * Mint ONE key. Contact details are recorded in the LEDGER only - they are
 * deliberately kept out of the signed payload so a customer's phone number and
 * email are not embedded in a string that gets forwarded around.
 */
function issueOne({ product, to, bindType, bindValue, months }, keys) {
  const spec = PRODUCTS[product];
  if (!spec) throw new Error('Unknown product "' + product + '" (use ' + Object.keys(PRODUCTS).join(', ') + ')');

  const payload = {
    v: 1,
    id: 'lic_' + crypto.randomBytes(4).toString('hex'),
    to: String(to || '').trim() || 'Unassigned',
    product,                                   // signed, so records can't drift
    features: spec.features,
    suppress: spec.suppress,
    bind: bindValue ? { type: bindType || 'brokerClientId', value: String(bindValue).trim() } : { type: 'none' },
    iat: new Date().toISOString().slice(0, 10),
  };
  const exp = expiryFor(months);
  if (exp) payload.exp = exp;                  // absent exp == lifetime
  const seg = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.sign(null, Buffer.from(seg, 'utf8'), keys.priv);
  return { key: 'STK1.' + seg + '.' + b64url(sig), payload };
}

/** Mint one or many, and record them. Returns [{key, payload, email, whatsapp}] */
function issue(opts, keys) {
  const count = Math.max(1, Math.min(500, Number(opts.count || 1)));
  const people = Array.isArray(opts.people) && opts.people.length ? opts.people : null;
  if (!people && !String(opts.to || '').trim() && count === 1) throw new Error('Customer name is required');

  const list = people || Array.from({ length: count }, () => ({
    to: opts.to, email: opts.email, whatsapp: opts.whatsapp,
  }));

  const issuedAt = new Date().toISOString();
  const out = list.map(person => {
    const { key, payload } = issueOne({
      product: opts.product, to: person.to || opts.to,
      bindType: opts.bindType, bindValue: person.bind || opts.bindValue, months: opts.months,
    }, keys);
    return {
      key, payload,
      email: String(person.email || opts.email || '').trim(),
      whatsapp: String(person.whatsapp || opts.whatsapp || '').trim(),
    };
  });

  appendLedger(out.map(r => ({
    id: r.payload.id, to: r.payload.to, email: r.email, whatsapp: r.whatsapp,
    product: r.payload.product, productLabel: PRODUCTS[r.payload.product].label,
    features: r.payload.features, suppress: r.payload.suppress,
    bind: r.payload.bind, iat: r.payload.iat, exp: r.payload.exp || null, lifetime: !r.payload.exp,
    note: String(opts.note || '').trim(), issuedAt, key: r.key,
  })));
  return out;
}

/** "Name, email, whatsapp" per line -> people[] (email/whatsapp optional). */
function parsePeople(text) {
  return String(text || '').split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const [to, email, whatsapp] = line.split(/\s*[,;\t]\s*/);
    return { to: (to || '').trim(), email: (email || '').trim(), whatsapp: (whatsapp || '').trim() };
  }).filter(p => p.to);
}

const csvCell = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
const toCsv = rows => ['name,email,whatsapp,product,expires,licence_id,key']
  .concat(rows.map(r => [r.payload.to, r.email, r.whatsapp, PRODUCTS[r.payload.product].label,
    r.payload.exp || 'lifetime', r.payload.id, r.key].map(csvCell).join(','))).join('\n');

// ---------------- CLI ----------------
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : dflt; };
const keys = ensureKeys();

if (argv.includes('--show-public-key')) {
  console.log('\nIssuer public key (SPKI base64) - publish this, it cannot sign anything:\n');
  console.log(keys.pubB64 + '\n');
  process.exit(0);
}

if (argv.includes('--issue')) {
  try {
    const rows = issue({
      product: arg('product', 'gsheet_only'),
      to: arg('to'), email: arg('email'), whatsapp: arg('whatsapp'),
      bindType: arg('bind-type', 'brokerClientId'), bindValue: arg('bind-broker'),
      months: arg('months', 12), note: arg('note', ''), count: arg('bulk', 1),
    }, keys);
    console.log('');
    rows.forEach(r => console.log(r.payload.to + '  ' + PRODUCTS[r.payload.product].label
      + '  ' + (r.payload.exp ? 'expires ' + r.payload.exp : 'LIFETIME') + '  ' + r.payload.id + '\n' + r.key + '\n'));
    console.log(rows.length + ' key(s) logged to ' + LEDGER);
  } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
  process.exit(0);
}

// ---------------- one-form panel ----------------
const PRODUCT_RADIOS = Object.entries(PRODUCTS).map(([id, spec], i) =>
  `<label class="prod"><input type="radio" name="product" value="${id}"${i === 0 ? ' checked' : ''}><span>${spec.label}</span></label>`).join('');

const PAGE = `<!doctype html><meta charset="utf-8"><title>Stockkar licence issuer</title>
<style>
 body{font:15px/1.55 -apple-system,Segoe UI,Roboto,sans-serif;background:#0d1420;color:#e8eef6;margin:0;padding:30px}
 .card{max-width:680px;margin:0 auto;background:#131d2c;border:1px solid #22314a;border-radius:14px;padding:26px 28px}
 h1{font-size:19px;margin:0 0 4px} .sub{color:#8ba0bb;font-size:13px;margin-bottom:20px}
 label{display:block;font-size:12.5px;color:#9db2cc;margin:14px 0 5px}
 input[type=text],input[type=number],textarea{width:100%;box-sizing:border-box;background:#0d1420;border:1px solid #2a3b57;color:#e8eef6;border-radius:9px;padding:10px 12px;font-size:14px;font-family:inherit}
 textarea{min-height:96px;resize:vertical}
 .row{display:grid;grid-template-columns:1fr 1fr;gap:14px}
 .row3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px}
 .prods{display:flex;flex-direction:column;gap:8px;margin-top:6px}
 .prod{display:flex;align-items:center;gap:9px;margin:0;color:#e8eef6;font-size:14px;background:#0d1420;border:1px solid #2a3b57;border-radius:9px;padding:10px 12px;cursor:pointer}
 .prod:has(input:checked){border-color:#00a86b;background:#0e2a20}
 .tabs{display:flex;gap:8px;margin:18px 0 4px}
 .tab{flex:1;text-align:center;padding:9px;border:1px solid #2a3b57;border-radius:9px;cursor:pointer;font-size:13.5px;color:#9db2cc}
 .tab.on{border-color:#00a86b;color:#e8eef6;background:#0e2a20}
 button{margin-top:20px;width:100%;background:#00a86b;border:0;color:#fff;font-weight:700;font-size:15px;padding:12px;border-radius:10px;cursor:pointer}
 button.sec{background:#22314a;margin-top:10px}
 #out{display:none;margin-top:20px;background:#0d1420;border:1px solid #2a3b57;border-radius:10px;padding:14px}
 code{word-break:break-all;font-size:12.5px;color:#7fe3b8;display:block;margin-bottom:8px}
 .meta{color:#8ba0bb;font-size:12px;margin-bottom:14px}
 .err{color:#ff8b8b;margin-top:12px} .hint{color:#8ba0bb;font-size:12px;margin-top:6px}
 table{width:100%;border-collapse:collapse;font-size:12.5px} td{padding:5px 4px;border-bottom:1px solid #22314a;vertical-align:top}
</style>
<div class="card">
 <h1>Issue a Stockkar licence</h1>
 <div class="sub">Signed offline. Send the key by WhatsApp; the customer pastes it in Settings.</div>

 <label>Product</label>
 <div class="prods">${PRODUCT_RADIOS}</div>

 <div class="tabs">
   <div class="tab on" id="tab-one" onclick="mode('one')">One customer</div>
   <div class="tab" id="tab-bulk" onclick="mode('bulk')">Bulk</div>
 </div>

 <div id="pane-one">
   <label>Customer name</label><input id="to" type="text" placeholder="Ramesh K">
   <div class="row">
     <div><label>Email</label><input id="email" type="text" placeholder="ramesh@gmail.com"></div>
     <div><label>WhatsApp</label><input id="whatsapp" type="text" placeholder="9876543210"></div>
   </div>
 </div>

 <div id="pane-bulk" style="display:none">
   <label>One customer per line &mdash; name, email, whatsapp</label>
   <textarea id="people" placeholder="Ramesh K, ramesh@gmail.com, 9876543210&#10;Priya S, priya@gmail.com, 9812345678"></textarea>
   <div class="hint">Leave empty and set a quantity below to pre-generate unassigned keys.</div>
   <label>Or quantity of unassigned keys</label><input id="count" type="number" value="0" min="0" max="500">
 </div>

 <div class="row3">
  <div><label>Bind to broker client-id</label><input id="bind" type="text" placeholder="optional"></div>
  <div><label>Valid (months)</label><input id="months" type="number" value="12" min="1" max="60">
    <label class="prod" style="margin-top:8px;padding:8px 10px"><input type="checkbox" id="lifetime" onchange="document.getElementById('months').disabled=this.checked"><span>Lifetime</span></label></div>
  <div><label>Note (ledger)</label><input id="note" type="text" placeholder="paid UPI"></div>
 </div>

 <button onclick="go()">Generate</button>
 <div id="err" class="err"></div>
 <div id="out"><div id="single"></div><div id="bulkout"></div>
   <button class="sec" onclick="cp()">Copy all</button></div>
</div>
<script>
let MODE='one';
function mode(m){MODE=m;
 document.getElementById('tab-one').classList.toggle('on',m==='one');
 document.getElementById('tab-bulk').classList.toggle('on',m==='bulk');
 document.getElementById('pane-one').style.display=m==='one'?'block':'none';
 document.getElementById('pane-bulk').style.display=m==='bulk'?'block':'none';}
let LAST='';
async function go(){
 document.getElementById('err').textContent='';
 const body={product:document.querySelector('input[name=product]:checked').value,
  bindValue:document.getElementById('bind').value,
  months:document.getElementById('lifetime').checked?'lifetime':document.getElementById('months').value,
  note:document.getElementById('note').value};
 if(MODE==='one'){body.to=document.getElementById('to').value;body.email=document.getElementById('email').value;
  body.whatsapp=document.getElementById('whatsapp').value;}
 else{body.peopleText=document.getElementById('people').value;body.count=document.getElementById('count').value;}
 const r=await fetch('/issue',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 const j=await r.json();
 if(!j.ok){document.getElementById('err').textContent=j.error;return;}
 const one=document.getElementById('single'),many=document.getElementById('bulkout');
 one.innerHTML='';many.innerHTML='';
 if(j.rows.length===1){const r0=j.rows[0];
  one.innerHTML='<code>'+r0.key+'</code><div class="meta">'+r0.payload.to+' · '+j.productLabel+' · '+(r0.payload.exp?'expires '+r0.payload.exp:'LIFETIME')+' · '+r0.payload.id+'</div>';
  LAST=r0.key;}
 else{many.innerHTML='<div class="meta">'+j.rows.length+' keys · '+j.productLabel+'</div><table>'+
   j.rows.map(x=>'<tr><td>'+(x.payload.to||'')+'<br><span style="color:#8ba0bb">'+(x.email||'')+' '+(x.whatsapp||'')+'</span></td><td><code style="margin:0">'+x.key+'</code></td></tr>').join('')+'</table>';
  LAST=j.csv;}
 document.getElementById('out').style.display='block';
}
function cp(){navigator.clipboard.writeText(LAST);}
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
        const o = JSON.parse(body || '{}');
        const people = parsePeople(o.peopleText);
        const rows = issue({ ...o, people, count: people.length ? people.length : (Number(o.count) || 1) }, keys);
        res.end(JSON.stringify({ ok: true, rows, csv: toCsv(rows), productLabel: PRODUCTS[rows[0].payload.product].label }));
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
