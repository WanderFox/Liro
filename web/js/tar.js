// Minimal ustar (tar) support shared by the server (Node) and the client (browser/Electron).
// Liro backups are plain .tar archives: manifest.json first, then boards and assets.

const enc = new TextEncoder();
const dec = new TextDecoder();

function writeString(buf, off, len, str) {
  const b = enc.encode(str);
  buf.set(b.subarray(0, len), off);
}

function writeOctal(buf, off, len, num) {
  writeString(buf, off, len - 1, Math.floor(num).toString(8).padStart(len - 1, '0'));
}

// Splits a long path into ustar prefix (<=155 bytes) + name (<=100 bytes).
function splitName(path) {
  if (enc.encode(path).length <= 100) return ['', path];
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join('/'), name = parts.slice(i).join('/');
    if (enc.encode(prefix).length <= 155 && enc.encode(name).length <= 100) return [prefix, name];
  }
  throw new Error(`path too long for tar: ${path}`);
}

export function tarHeader(path, size, mtime = Date.now()) {
  const h = new Uint8Array(512);
  const [prefix, name] = splitName(path);
  writeString(h, 0, 100, name);
  writeOctal(h, 100, 8, 0o644);
  writeOctal(h, 108, 8, 0);
  writeOctal(h, 116, 8, 0);
  writeOctal(h, 124, 12, size);
  writeOctal(h, 136, 12, mtime / 1000);
  h.fill(32, 148, 156); // checksum placeholder (spaces)
  h[156] = 48; // '0' regular file
  writeString(h, 257, 6, 'ustar');
  writeString(h, 263, 2, '00');
  writeString(h, 345, 155, prefix);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  writeString(h, 148, 7, `${sum.toString(8).padStart(6, '0')}\0`);
  return h;
}

export const padding = (size) => new Uint8Array((512 - (size % 512)) % 512);
export const tarEnd = () => new Uint8Array(1024);

function readString(buf, off, len) {
  let end = off;
  while (end < off + len && buf[end] !== 0) end++;
  return dec.decode(buf.subarray(off, end));
}

// Parses one 512-byte header. Returns null for the end-of-archive (zero) block.
export function parseHeader(h) {
  if (h.every((b) => b === 0)) return null;
  const name = readString(h, 0, 100);
  const prefix = readString(h, 345, 155);
  const size = parseInt(readString(h, 124, 12).trim() || '0', 8);
  const type = String.fromCharCode(h[156] || 48);
  return { path: prefix ? `${prefix}/${name}` : name, size, type };
}

// Rejects absolute paths and "..": every entry must stay inside the archive root.
export function safePath(path) {
  const p = String(path).replace(/\\/g, '/');
  if (!p || p.startsWith('/') || /^[a-z]:/i.test(p)) return null;
  const parts = p.split('/').filter((x) => x && x !== '.');
  if (parts.some((x) => x === '..')) return null;
  return parts.join('/');
}

// Whole-archive parser for the browser: yields { path, data: Uint8Array } for regular files.
export function* parseTar(bytes) {
  let off = 0;
  while (off + 512 <= bytes.length) {
    const hdr = parseHeader(bytes.subarray(off, off + 512));
    if (!hdr) return;
    off += 512;
    const data = bytes.subarray(off, off + hdr.size);
    off += hdr.size + ((512 - (hdr.size % 512)) % 512);
    const path = safePath(hdr.path);
    if (path && (hdr.type === '0' || hdr.type === '\0')) yield { path, data };
  }
}

// Builds a tar Blob from entries [{ path, data: Blob|Uint8Array|string }] (client side).
export function buildTarBlob(entries) {
  const parts = [];
  for (const e of entries) {
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const size = data instanceof Blob ? data.size : data.length;
    parts.push(tarHeader(e.path, size, e.mtime), data, padding(size));
  }
  parts.push(tarEnd());
  return new Blob(parts, { type: 'application/x-tar' });
}

export function backupFileName(type, title, date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}`;
  const clean = String(title || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `Liro-${type}${clean ? `-${clean}` : ''}-${stamp}.tar`;
}
