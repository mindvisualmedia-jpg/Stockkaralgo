'use strict';
// Generates the PWA icons with no dependencies: Node's zlib gives us deflate,
// which is all a PNG really needs. Re-run after changing the mark:
//   node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets', 'icons');

// ---- minimal PNG writer -----------------------------------------------------
const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;   // 8-bit RGBA
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;                                          // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- the mark: dark rounded square, green "SK" -------------------------------
// 5x7 bitmaps, scaled up at draw time — enough for two letters and it keeps the
// generator dependency-free.
const GLYPH = {
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
};
const BG = [0x10, 0x18, 0x20];      // --btn-ink (light-mode primary)
const FG = [0x00, 0xe6, 0x76];      // --green

function draw(size, maskable) {
  const buf = Buffer.alloc(size * size * 4);
  // A maskable icon may be cropped to a circle, so it keeps a safe margin and
  // fills the whole canvas; the normal icon gets rounded corners instead.
  const r = maskable ? 0 : Math.round(size * 0.22);
  const put = (x, y, c, a) => {
    const i = (y * size + x) * 4;
    buf[i] = c[0]; buf[i + 1] = c[1]; buf[i + 2] = c[2]; buf[i + 3] = a;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let inside = true;
      if (r > 0) {
        const cx = x < r ? r : (x >= size - r ? size - r - 1 : x);
        const cy = y < r ? r : (y >= size - r ? size - r - 1 : y);
        inside = (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
      }
      put(x, y, BG, inside ? 255 : 0);
    }
  }
  // "SK" centred; maskable keeps it smaller so a circular crop cannot clip it.
  const cell = Math.floor(size / (maskable ? 22 : 16));
  const textW = (5 + 1 + 5) * cell, textH = 7 * cell;
  let ox = Math.round((size - textW) / 2), oy = Math.round((size - textH) / 2);
  ['S', 'K'].forEach((ch, gi) => {
    GLYPH[ch].forEach((row, ry) => {
      for (let rx = 0; rx < row.length; rx++) {
        if (row[rx] !== '1') continue;
        const px = ox + (gi * 6 + rx) * cell, py = oy + ry * cell;
        for (let dy = 0; dy < cell; dy++) for (let dx = 0; dx < cell; dx++) {
          const X = px + dx, Y = py + dy;
          if (X >= 0 && Y >= 0 && X < size && Y < size) put(X, Y, FG, 255);
        }
      }
    });
  });
  return png(size, size, buf);
}

fs.mkdirSync(OUT, { recursive: true });
const files = [
  ['icon-192.png', draw(192, false)],
  ['icon-512.png', draw(512, false)],
  ['icon-maskable-512.png', draw(512, true)],
];
files.forEach(([name, data]) => {
  fs.writeFileSync(path.join(OUT, name), data);
  console.log('wrote', path.join('assets', 'icons', name), data.length + ' bytes');
});
