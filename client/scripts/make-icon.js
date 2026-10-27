// Rasterizes the Liro logo (same geometry as web/icon.svg) into PNG files without extra dependencies.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function png(size) {
  const s = size / 64;
  const ss = 4; // supersampling
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const color = (x, y) => {
    // rounded square r=14
    const r = 14;
    const cx = Math.min(Math.max(x, r), 64 - r), cy = Math.min(Math.max(y, r), 64 - r);
    if ((x - cx) ** 2 + (y - cy) ** 2 > r * r || x < 0 || y < 0 || x > 64 || y > 64) return null;
    if ((x - 46) ** 2 + (y - 20) ** 2 <= 36) return [0x42, 0x62, 0xff];
    if ((x >= 18 && x <= 26 && y >= 14 && y <= 50) || (x >= 18 && x <= 46 && y >= 42 && y <= 50)) return [0x1f, 0x1f, 0x2e];
    return [0xff, 0xd0, 0x2f];
  };
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < ss; i++) {
        for (let j = 0; j < ss; j++) {
          const c = color((x + (i + 0.5) / ss) / s, (y + (j + 0.5) / ss) / s);
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 1; }
        }
      }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? r / a : 0; raw[o + 1] = a ? g / a : 0; raw[o + 2] = a ? b / a : 0;
      raw[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const root = path.join(__dirname, '..');
fs.mkdirSync(path.join(root, 'build'), { recursive: true });
fs.writeFileSync(path.join(root, 'build', 'icon.png'), png(512));
fs.writeFileSync(path.join(root, '..', 'web', 'icon.png'), png(256));
console.log('icons written');
