'use strict';
/**
 * Customer list from a FILE — .xlsx straight out of Excel, or .csv / .tsv /
 * .txt — turned into the same plain lines the console's paste box sends.
 *
 * Parsing happens HERE, on the server, not in the console's JavaScript: one
 * implementation, testable, identical on the standalone server and on Vercel,
 * and no browser-version surprises when someone drops a sheet in.
 *
 * Node builtins only (zlib, Buffer). An .xlsx is a zip of XML; we read the
 * central directory, inflate the sheet and the shared-string table, and pull
 * the cells out with the same tolerance a spreadsheet deserves - merged
 * headers, blank rows and stray columns all just become text.
 */

const zlib = require('zlib');

const MAX_ROWS = 5000;      // a customer list, not a database export

// ---- zip ---------------------------------------------------------------------

function readZip(buf) {
  const out = {};
  // End of central directory: scan back from the tail (the comment is rarely long).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && off + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const csize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    if (localOff + 30 <= buf.length) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      const data = buf.slice(start, start + csize);
      try {
        out[name] = method === 0 ? data : zlib.inflateRawSync(data);
      } catch { /* one unreadable member must not lose the rest */ }
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

// ---- xlsx --------------------------------------------------------------------

const unescapeXml = (s) => String(s)
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&amp;/g, '&');

/** The shared-string table: <si> entries, each possibly several <t> runs. */
function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const si = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = si.exec(xml))) {
    let text = '';
    const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let tm;
    while ((tm = t.exec(m[1]))) text += unescapeXml(tm[1]);
    out.push(text);
  }
  return out;
}

/** 'AB12' -> 27 (1-based column), so gaps in a row keep their shape. */
function columnOf(ref) {
  const letters = String(ref || '').replace(/[^A-Z]/gi, '').toUpperCase();
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/** One worksheet -> an array of rows, each an array of cell strings. */
function sheetRows(xml, strings) {
  const rows = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let r;
  while ((r = rowRe.exec(xml)) && rows.length < MAX_ROWS) {
    const cells = [];
    const cellRe = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let c;
    while ((c = cellRe.exec(r[1]))) {
      const attrs = c[1] || '';
      const body = c[2] || '';
      const type = (attrs.match(/\bt="([^"]+)"/) || [])[1] || 'n';
      const col = columnOf((attrs.match(/\br="([^"]+)"/) || [])[1]);
      let value = '';
      if (type === 'inlineStr') {
        const t = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        let tm;
        while ((tm = t.exec(body))) value += unescapeXml(tm[1]);
      } else {
        const v = (body.match(/<v\b[^>]*>([\s\S]*?)<\/v>/) || [])[1];
        if (v !== undefined) {
          value = type === 's' ? (strings[Number(v)] || '') : unescapeXml(v);
        }
      }
      if (col > 0) cells[col - 1] = value; else cells.push(value);
    }
    rows.push(Array.from(cells, v => (v === undefined ? '' : String(v).trim())));
  }
  return rows;
}

/** Every sheet in the workbook, in file order. */
function xlsxRows(buf) {
  const zip = readZip(buf);
  const strings = sharedStrings(zip['xl/sharedStrings.xml'] && zip['xl/sharedStrings.xml'].toString('utf8'));
  const names = Object.keys(zip).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
  if (!names.length) throw new Error('no worksheet in this file');
  const rows = [];
  names.forEach(n => sheetRows(zip[n].toString('utf8'), strings).forEach(row => rows.push(row)));
  return rows;
}

// ---- csv ---------------------------------------------------------------------

/** A CSV / TSV line-by-line, honouring quoted fields that contain the separator. */
function csvRows(text) {
  const src = String(text).replace(/^﻿/, '');
  const sep = (src.split('\t').length - 1) > (src.split(',').length - 1) ? '\t' : ',';
  const rows = [];
  let row = [], field = '', quoted = false;
  const endField = () => { row.push(field.trim()); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') { if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === sep) { endField(); continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { endRow(); continue; }
    field += ch;
  }
  if (field !== '' || row.length) endRow();
  return rows.slice(0, MAX_ROWS);
}

// ---- the one entry point ------------------------------------------------------

/**
 * A dropped file -> the plain lines the customer parser already understands.
 * Row order and column order are both irrelevant: each field is recognised by
 * its shape further down the line, so a header row simply produces a line with
 * no usable identity and is ignored.
 *
 * @param {string} name  the file name (decides xlsx vs text)
 * @param {Buffer} buf   its bytes
 * @returns {string} newline-separated lines
 */
function linesFromFile(name, buf) {
  const n = String(name || '').toLowerCase();
  const isZip = buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50;
  const rows = (/\.xlsx?$/.test(n) || isZip) ? xlsxRows(buf) : csvRows(buf.toString('utf8'));
  return rows
    .map(cells => cells.filter(v => String(v || '').trim() !== '').join(', '))
    .filter(line => line.trim() !== '')
    .join('\n');
}

module.exports = { linesFromFile, xlsxRows, csvRows, sharedStrings, sheetRows, readZip, columnOf, MAX_ROWS };
