// Sticker packs: every sub-folder of a stickers directory is a pack of image files.
// Optional <pack>/pack.json: { "name": "Display name", "license": "...", "source": "..." }.
// Packs are looked up in the user directory (LIRO_STICKERS, default <data>/stickers) and in the
// packs bundled with the server (server/stickers); a user pack with the same id wins.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const IMAGE_RE = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const SAFE_RE = /^[^/\\]+$/;

export class Stickers {
  constructor(dirs) {
    this.dirs = dirs;
  }

  async init() {
    const userDir = this.dirs[0];
    await fsp.mkdir(userDir, { recursive: true });
    const readme = path.join(userDir, 'README.txt');
    if (!fs.existsSync(readme)) {
      await fsp.writeFile(readme, [
        'Стикер-паки Liro.',
        'Каждая папка здесь — отдельный пак: положите в неё картинки (png, svg, webp, gif, jpg).',
        'Название пака можно задать в файле pack.json: {"name": "Мои стикеры"}.',
        'Новые паки появляются у клиентов при следующем открытии панели «Стикеры».',
        '',
      ].join('\n'));
    }
  }

  async list() {
    const packs = new Map();
    for (const dir of [...this.dirs].reverse()) {
      let ids = [];
      try { ids = await fsp.readdir(dir, { withFileTypes: true }); } catch { continue; }
      for (const d of ids) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        const packDir = path.join(dir, d.name);
        let meta = {};
        try { meta = JSON.parse(await fsp.readFile(path.join(packDir, 'pack.json'), 'utf8')); } catch {}
        const files = (await fsp.readdir(packDir)).filter((f) => IMAGE_RE.test(f)).sort();
        if (!files.length) continue;
        packs.set(d.name, {
          id: d.name,
          name: String(meta.name || d.name),
          license: meta.license || '',
          source: meta.source || '',
          items: files.map((f) => ({ name: f.replace(IMAGE_RE, '').replace(/[-_]+/g, ' '), url: `/stickers/${encodeURIComponent(d.name)}/${encodeURIComponent(f)}` })),
        });
      }
    }
    return [...packs.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }

  // Absolute path of a sticker file, or null.
  resolve(pack, file) {
    if (!SAFE_RE.test(pack) || !SAFE_RE.test(file) || !IMAGE_RE.test(file) || pack.startsWith('.')) return null;
    for (const dir of this.dirs) {
      const p = path.join(dir, pack, file);
      if (fs.existsSync(p)) return p;
    }
    return null;
  }
}
