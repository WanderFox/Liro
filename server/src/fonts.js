// Fonts served to clients: bundled ones (server/fonts) plus fonts uploaded from clients (<data>/fonts).
// Family/style information is read from the font's own name and OS/2 tables.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const FONT_RE = /\.(ttf|otf|woff2?)$/i;

function readNames(buf) {
  // TrueType/OpenType table directory -> 'name' and 'OS/2' tables. WOFF/WOFF2 are compressed: use file name.
  const sig = buf.readUInt32BE(0);
  if (sig !== 0x00010000 && sig !== 0x4f54544f && sig !== 0x74727565) return null;
  const numTables = buf.readUInt16BE(4);
  const tables = {};
  for (let i = 0; i < numTables; i++) {
    const off = 12 + i * 16;
    tables[buf.toString('latin1', off, off + 4)] = { offset: buf.readUInt32BE(off + 8), length: buf.readUInt32BE(off + 12) };
  }
  const names = {};
  const nt = tables.name;
  if (nt) {
    const count = buf.readUInt16BE(nt.offset + 2);
    const strOff = nt.offset + buf.readUInt16BE(nt.offset + 4);
    for (let i = 0; i < count; i++) {
      const r = nt.offset + 6 + i * 12;
      const platform = buf.readUInt16BE(r), lang = buf.readUInt16BE(r + 4), id = buf.readUInt16BE(r + 6);
      const len = buf.readUInt16BE(r + 8), off = strOff + buf.readUInt16BE(r + 10);
      let str;
      if (platform === 3 || platform === 0) {
        const b = Buffer.from(buf.subarray(off, off + len));
        b.swap16();
        str = b.toString('utf16le');
      } else if (platform === 1 && lang === 0) {
        str = buf.toString('latin1', off, off + len);
      } else continue;
      // Prefer English (Windows 0x409) records.
      if (!(id in names) || lang === 0x409) names[id] = str;
    }
  }
  let weight = 400, italic = false;
  const variable = !!tables.fvar;
  const os2 = tables['OS/2'];
  if (os2) {
    weight = buf.readUInt16BE(os2.offset + 4);
    italic = (buf.readUInt16BE(os2.offset + 62) & 1) === 1;
  }
  return {
    family: names[16] || names[1] || '',
    style: names[17] || names[2] || '',
    license: `${names[13] || ''} ${names[14] || ''}`.trim(),
    weight: variable ? '100 900' : weight, italic,
  };
}

export function fontInfo(file) {
  try {
    const buf = fs.readFileSync(file);
    const info = readNames(buf);
    if (info && info.family) return info;
  } catch {}
  const base = path.basename(file).replace(FONT_RE, '');
  return { family: base.replace(/[-_](regular|bold|italic|light|medium|semibold|black|thin).*$/i, ''), style: '', license: '', weight: /bold/i.test(base) ? 700 : 400, italic: /italic/i.test(base) };
}

export class Fonts {
  constructor(userDir, bundledDir) {
    this.userDir = userDir;
    this.bundledDir = bundledDir;
    this.cache = null;
  }

  async init() {
    await fsp.mkdir(this.userDir, { recursive: true });
  }

  async list() {
    if (this.cache) return this.cache;
    const out = [];
    for (const [dir, source] of [[this.bundledDir, 'bundled'], [this.userDir, 'uploaded']]) {
      let files = [];
      try { files = (await fsp.readdir(dir)).filter((f) => FONT_RE.test(f)); } catch {}
      for (const f of files.sort()) {
        const info = fontInfo(path.join(dir, f));
        out.push({ family: info.family, weight: info.weight, italic: info.italic, url: `/fonts/${encodeURIComponent(f)}`, source });
      }
    }
    this.cache = out;
    return out;
  }

  resolve(file) {
    if (!/^[^/\\]+$/.test(file) || !FONT_RE.test(file)) return null;
    for (const dir of [this.userDir, this.bundledDir]) {
      const p = path.join(dir, file);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }

  async save(name, buf) {
    const safe = path.basename(name).replace(/[^\w.\- ()]+/g, '_');
    if (!FONT_RE.test(safe)) throw Object.assign(new Error('поддерживаются ttf, otf, woff, woff2'), { status: 400 });
    await fsp.writeFile(path.join(this.userDir, safe), buf);
    this.cache = null;
    return safe;
  }
}
