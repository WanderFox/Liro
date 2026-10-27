// Uploaded SVG assets: custom shapes (<data>/shapes) and nested-board icons (<data>/icons).
// Every client lists them; a placed shape/icon copies the SVG into the board's media so it works offline.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const NAME_RE = /^[\w\- ().а-яё]+\.svg$/i;

// Removes active content from an SVG: scripts, event handlers, foreign objects and external references.
export function sanitizeSvg(text) {
  let s = String(text);
  if (!/<svg[\s>]/i.test(s)) throw Object.assign(new Error('это не SVG'), { status: 400 });
  s = s.replace(/<\?xml[^>]*>/gi, '').replace(/<!DOCTYPE[^>]*>/gi, '');
  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, '').replace(/<script[^>]*\/>/gi, '');
  s = s.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, '');
  s = s.replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  s = s.replace(/\s(xlink:)?href\s*=\s*("|')\s*(?!#|data:image\/)[^"']*\2/gi, '');
  s = s.replace(/javascript:/gi, '');
  return s.trim();
}

export class CustomShapes {
  constructor(dir, route = 'shapes') {
    this.dir = dir;
    this.route = route;
  }

  async init() {
    await fsp.mkdir(this.dir, { recursive: true });
  }

  async list() {
    let files = [];
    try { files = (await fsp.readdir(this.dir)).filter((f) => f.toLowerCase().endsWith('.svg')); } catch {}
    const out = [];
    for (const f of files.sort((a, b) => a.localeCompare(b))) {
      const stat = await fsp.stat(path.join(this.dir, f));
      out.push({ id: f, name: f.replace(/\.svg$/i, '').replace(/[-_]+/g, ' '), url: `/${this.route}/${encodeURIComponent(f)}`, mtime: stat.mtimeMs });
    }
    return out;
  }

  resolve(file) {
    if (!/^[^/\\]+$/.test(file) || !file.toLowerCase().endsWith('.svg')) return null;
    const p = path.join(this.dir, file);
    return fs.existsSync(p) ? p : null;
  }

  async save(name, buf) {
    let file = path.basename(String(name)).replace(/[^\w\- ().а-яё]+/gi, '_');
    if (!file.toLowerCase().endsWith('.svg')) file += '.svg';
    if (!NAME_RE.test(file)) throw Object.assign(new Error('недопустимое имя файла'), { status: 400 });
    await fsp.writeFile(path.join(this.dir, file), sanitizeSvg(buf.toString('utf8')));
    return file;
  }

  async remove(file) {
    const p = this.resolve(file);
    if (p) await fsp.rm(p, { force: true });
  }
}
