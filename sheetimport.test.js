'use strict';
// CUSTOMER LIST FROM A FILE (2026-09-12). Owner: "can we import with excel
// sheet". An .xlsx straight out of Excel, or a .csv, becomes the same plain
// lines the console's paste box sends - so there is ONE parser for identities,
// products and dates, and a spreadsheet needs no particular column order.
//
// The .xlsx here is built byte by byte (a real zip with a shared-string table
// and a deflated sheet), because a fixture nobody can regenerate is a guess.

const { test } = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sheet = require('./activation-server/sheet.js');
const core = require('./activation-server/core.js');
const grant = require('./activation-server/grant.js');
const { fileStore } = require('./activation-server/store.js');
const crypto = require('crypto');

// ---- a real .xlsx, made here --------------------------------------------------------

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return (buf) => { let c = -1; for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
})();

function zip(entries, { deflate = true } = {}) {
  const locals = [], central = [];
  let offset = 0;
  entries.forEach(([name, text]) => {
    const raw = Buffer.from(text, 'utf8');
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0;
    const nameBuf = Buffer.from(name, 'utf8');
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(CRC(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(CRC(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  });
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

/** rows: array of arrays. Strings go through the shared-string table, like Excel's own. */
function xlsx(rows, opts) {
  const strings = [];
  const idx = (v) => { const i = strings.indexOf(v); if (i >= 0) return i; strings.push(v); return strings.length - 1; };
  const col = (n) => String.fromCharCode(65 + n);
  const body = rows.map((cells, r) => '<row r="' + (r + 1) + '">' + cells.map((v, c) => {
    if (v === '' || v === null || v === undefined) return '';
    const ref = col(c) + (r + 1);
    return /^-?\d+(\.\d+)?$/.test(String(v))
      ? '<c r="' + ref + '"><v>' + v + '</v></c>'
      : '<c r="' + ref + '" t="s"><v>' + idx(String(v)) + '</v></c>';
  }).join('') + '</row>').join('');
  const sheetXml = '<?xml version="1.0"?><worksheet><sheetData>' + body + '</sheetData></worksheet>';
  const ssXml = '<?xml version="1.0"?><sst count="' + strings.length + '">'
    + strings.map(s => '<si><t>' + s.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</t></si>').join('') + '</sst>';
  return zip([['[Content_Types].xml', '<Types/>'], ['xl/sharedStrings.xml', ssXml], ['xl/worksheets/sheet1.xml', sheetXml]], opts);
}

// ---- reading ------------------------------------------------------------------------

test('an .xlsx becomes one line per row, in the sheet\'s own order', () => {
  const buf = xlsx([
    ['Mobile', 'Name', 'Plan', 'Expiry'],
    ['9876543210', 'Ramesh K', 'stockkar', 'lifetime'],
    ['', '', '', ''],
    ['priya@example.com', 'Priya S', 'both', '2027-03-31'],
  ]);
  assert.equal(sheet.linesFromFile('customers.xlsx', buf),
    ['Mobile, Name, Plan, Expiry', '9876543210, Ramesh K, stockkar, lifetime', 'priya@example.com, Priya S, both, 2027-03-31'].join('\n'));
});

test('numbers, gaps, inline strings and escaped text all survive', () => {
  const buf = xlsx([['Sonu & Co', '', '9000011111', 'gsheet']]);
  assert.equal(sheet.linesFromFile('x.xlsx', buf), 'Sonu & Co, 9000011111, gsheet');
  // a stored (undeflated) zip, which some exporters produce
  assert.equal(sheet.linesFromFile('x.xlsx', xlsx([['9876543210', 'A']], { deflate: false })), '9876543210, A');
  // inline strings instead of the shared table
  const inline = zip([['xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>9876543210</t></is></c>'
    + '<c r="B1" t="inlineStr"><is><t>Ra</t><t>mesh</t></is></c></row></sheetData></worksheet>']]);
  assert.equal(sheet.linesFromFile('i.xlsx', inline), '9876543210, Ramesh');
});

test('a file that is not a spreadsheet says so plainly', () => {
  assert.throws(() => sheet.linesFromFile('x.xlsx', Buffer.from('PK not really a zip')), /not a zip file|no worksheet/);
  assert.throws(() => sheet.linesFromFile('x.xlsx', zip([['docProps/app.xml', '<x/>']])), /no worksheet/);
});

test('a CSV - commas or tabs, quoted fields, a BOM, CRLF - reads the same way', () => {
  const csv = '﻿mobile,name,plan,expiry\r\n9876543210,"Kumar, Ramesh",stockkar,lifetime\r\n\r\npriya@example.com,Priya,both,2027-03-31\r\n';
  assert.equal(sheet.linesFromFile('list.csv', Buffer.from(csv, 'utf8')),
    ['mobile, name, plan, expiry', '9876543210, Kumar, Ramesh, stockkar, lifetime', 'priya@example.com, Priya, both, 2027-03-31'].join('\n'));
  const tsv = 'mobile\tname\n9876543210\tRamesh K\n';
  assert.equal(sheet.linesFromFile('list.tsv', Buffer.from(tsv, 'utf8')), ['mobile, name', '9876543210, Ramesh K'].join('\n'));
});

test('column letters decide position, so a sheet with gaps keeps its shape', () => {
  assert.equal(sheet.columnOf('A'), 1);
  assert.equal(sheet.columnOf('Z'), 26);
  assert.equal(sheet.columnOf('AB12'), 28);
  const gapped = zip([['xl/worksheets/sheet1.xml',
    '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>9876543210</t></is></c>'
    + '<c r="D1" t="inlineStr"><is><t>lifetime</t></is></c></row></sheetData></worksheet>']]);
  assert.equal(sheet.linesFromFile('g.xlsx', gapped), '9876543210, lifetime');
});

// ---- end to end ---------------------------------------------------------------------

const store = () => fileStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'stk-sheet-')), 'a.json'));
const { privateKey } = crypto.generateKeyPairSync('ed25519');
const opts = { privateKey };

test('IMPORT: an Excel export with a header row becomes customers, and the header is ignored', async () => {
  const s = store();
  const buf = xlsx([
    ['Mobile number', 'Customer name', 'Product', 'Valid till'],
    ['9876543210', 'Ramesh K', 'stockkar', 'lifetime'],
    ['98765 43211', 'Priya S', 'both', '31-03-2027'],
    ['sonu@example.com', 'Sonu', 'gsheet', 'lifetime'],
  ]);
  const r = await core.importCustomers(s, null, '', { name: 'customers.xlsx', data: buf.toString('base64') });
  assert.equal(r.body.ok, true);
  assert.deepEqual([r.body.added, r.body.updated, r.body.skipped], [3, 0, 0], 'the header row is not a customer and not a failure');
  const list = await core.listCustomers(s);
  assert.equal(list.body.count, 3);
  const ramesh = list.body.customers.find(c => c.mobile === '+919876543210');
  assert.equal(ramesh.name, 'Ramesh K');
  assert.equal(ramesh.exp, '');
  const priya = list.body.customers.find(c => c.mobile === '+919876543211');
  assert.equal(priya.exp, '2027-03-31', 'DD-MM-YYYY from the sheet');
  assert.deepEqual(priya.features, ['stockkar', 'gsheet']);
  // and the imported number activates a box
  const claim = await core.claimByIdentity(s, { identity: '9876543210', installId: 'a'.repeat(32) }, opts);
  assert.equal(claim.body.state, 'activated');
});

test('IMPORT: a CSV re-import updates instead of duplicating, and a bad row is reported', async () => {
  const s = store();
  await core.importCustomers(s, null, '', { name: 'a.csv', data: Buffer.from('9876543210,Ramesh K,stockkar,lifetime\n').toString('base64') });
  const again = await core.importCustomers(s, null, '', { name: 'b.csv', data: Buffer.from('mobile,name\n9876543210,Ramesh Kumar,2027-06-30\n9999,Broken Row\n').toString('base64') });
  assert.deepEqual([again.body.added, again.body.updated], [0, 1]);
  const cust = (await core.resolveCustomer(s, '9876543210')).cust;
  assert.equal(cust.name, 'Ramesh Kumar');
  assert.equal(cust.exp, '2027-06-30');
  assert.equal((await core.listCustomers(s)).body.count, 1, 'one customer, not two');
});

test('IMPORT: an unreadable file is refused with a readable reason, and nothing is written', async () => {
  const s = store();
  const r = await core.importCustomers(s, null, '', { name: 'broken.xlsx', data: Buffer.from('PKrubbish').toString('base64') });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /could not read broken\.xlsx/);
  assert.match(r.body.error, /Save it as CSV/);
  assert.equal((await core.listCustomers(s)).body.count, 0);
  const empty = await core.importCustomers(s, null, '', { name: 'empty.csv', data: '' });
  assert.equal(empty.status, 400);
});

test('IMPORT: a file and pasted lines can arrive together', async () => {
  const s = store();
  const r = await core.importCustomers(s, null, '9000000001, Typed In, stockkar, lifetime',
    { name: 'c.csv', data: Buffer.from('9000000002,From File,both,lifetime\n').toString('base64') });
  assert.deepEqual([r.body.added, r.body.skipped], [2, 0]);
  assert.ok((await core.resolveCustomer(s, '9000000001')));
  assert.ok((await core.resolveCustomer(s, '9000000002')));
});

test('the console sends the file to the server; the server owns the parsing', () => {
  const html = fs.readFileSync(path.join(__dirname, 'activation-server', 'console.html'), 'utf8');
  assert.ok(html.includes('id="custFile"'));
  assert.ok(html.includes("accept=\".xlsx,.xls,.csv,.tsv,.txt\""));
  assert.ok(html.includes("api('/v1/admin/customers-import', { text, file: custFile })"));
  assert.ok(html.includes('readAsDataURL'), 'the bytes go up as base64, not parsed in the browser');
  const admin = fs.readFileSync(path.join(__dirname, 'activation-server', 'api', 'admin.js'), 'utf8');
  assert.ok(admin.includes('core.importCustomers(store, body.rows, body.text, body.file)'));
});
