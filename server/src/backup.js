// Backups: streaming .tar archives of boards (with media) and uploaded assets, and restoring them.
//
// Layout:  manifest.json
//          boards/<id>/board.json, boards/<id>/media/<file>
//          assets/fonts/<file>, assets/shapes/<file>, assets/icons/<file>, assets/stickers/<pack>/<file>
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { tarHeader, padding, tarEnd, parseHeader, safePath } from '../../web/js/tar.js';
import { validBoardId } from './store.js';

// Writes to an HTTP response, waiting for the socket to drain.
function writer(res) {
  return (chunk) => new Promise((resolve, reject) => {
    if (res.destroyed) return reject(new Error('client went away'));
    if (res.write(chunk)) resolve();
    else res.once('drain', resolve);
  });
}

async function writeEntry(write, entryPath, data) {
  const buf = typeof data === 'string' ? Buffer.from(data) : data;
  await write(tarHeader(entryPath, buf.length));
  await write(buf);
  await write(padding(buf.length));
}

async function writeFileEntry(write, entryPath, file) {
  const stat = await fsp.stat(file);
  await write(tarHeader(entryPath, stat.size, stat.mtimeMs));
  for await (const chunk of fs.createReadStream(file)) await write(chunk);
  await write(padding(stat.size));
}

async function filesOf(dir, filter = () => true) {
  try {
    return (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isFile() && !d.name.endsWith('.part') && filter(d.name)).map((d) => d.name);
  } catch {
    return [];
  }
}

// All boards reachable from `rootId` through nested-board tiles.
export function boardTree(store, rootId) {
  const out = [];
  const seen = new Set();
  const walk = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const b = store.get(id);
    if (!b) return;
    out.push(b);
    for (const el of b.elements.values()) if (el.type === 'board' && el.boardId) walk(el.boardId);
  };
  walk(rootId);
  return out;
}

/**
 * Streams a backup to `res`.
 * opts: { type: 'server'|'board', title, fileName, boards: Board[], assets: [{ prefix, dir, nested }], source }
 */
export async function streamBackup(res, opts) {
  res.writeHead(200, {
    'Content-Type': 'application/x-tar',
    'Content-Disposition': `attachment; filename="backup.tar"; filename*=UTF-8''${encodeURIComponent(opts.fileName)}`,
    'Cache-Control': 'no-store',
  });
  const write = writer(res);
  const assetCounts = {};
  const assetFiles = [];
  for (const a of opts.assets || []) {
    if (a.nested) {
      for (const pack of await fsp.readdir(a.dir, { withFileTypes: true }).catch(() => [])) {
        if (!pack.isDirectory()) continue;
        for (const f of await filesOf(path.join(a.dir, pack.name))) assetFiles.push({ entry: `${a.prefix}/${pack.name}/${f}`, file: path.join(a.dir, pack.name, f), kind: a.prefix });
      }
    } else {
      for (const f of await filesOf(a.dir, a.filter)) assetFiles.push({ entry: `${a.prefix}/${f}`, file: path.join(a.dir, f), kind: a.prefix });
    }
  }
  for (const f of assetFiles) assetCounts[f.kind.split('/').pop()] = (assetCounts[f.kind.split('/').pop()] || 0) + 1;
  const manifest = {
    liroBackup: 1,
    type: opts.type,
    title: opts.title,
    created: new Date().toISOString(),
    source: opts.source,
    boards: opts.boards.map((b) => ({ id: b.meta.id, name: b.meta.name, parentId: b.meta.parentId || null, elements: b.elements.size })),
    assets: assetCounts,
  };
  try {
    await writeEntry(write, 'manifest.json', JSON.stringify(manifest, null, 2));
    for (const b of opts.boards) {
      b.flush();
      const id = b.meta.id;
      await writeEntry(write, `boards/${id}/board.json`, JSON.stringify({ ...b.snapshot(), recent: [], orphans: {} }));
      for (const f of await filesOf(b.mediaDir)) await writeFileEntry(write, `boards/${id}/media/${f}`, path.join(b.mediaDir, f));
    }
    for (const f of assetFiles) await writeFileEntry(write, f.entry, f.file);
    await write(tarEnd());
    res.end();
  } catch (e) {
    res.destroy(e);
  }
}

// Extracts an uploaded tar stream into `dir` (entries are path-checked). Returns the parsed manifest.
export async function extractTar(stream, dir, limitBytes) {
  await fsp.mkdir(dir, { recursive: true });
  let buf = Buffer.alloc(0);
  let entry = null; // { fd, remaining, pad }
  let total = 0;
  const openEntry = (hdr) => {
    const rel = safePath(hdr.path);
    const regular = hdr.type === '0' || hdr.type === '\0';
    if (!rel || !regular) return { fd: null, remaining: hdr.size, pad: (512 - (hdr.size % 512)) % 512 };
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return { fd: fs.openSync(file, 'w'), remaining: hdr.size, pad: (512 - (hdr.size % 512)) % 512 };
  };
  let ended = false;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limitBytes) throw Object.assign(new Error('backup is too large'), { status: 413 });
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    let off = 0;
    while (!ended) {
      if (entry) {
        if (entry.remaining > 0) {
          const n = Math.min(entry.remaining, buf.length - off);
          if (n <= 0) break;
          if (entry.fd !== null) fs.writeSync(entry.fd, buf, off, n);
          entry.remaining -= n;
          off += n;
          if (entry.remaining > 0) break;
        }
        if (buf.length - off < entry.pad) break;
        off += entry.pad;
        if (entry.fd !== null) fs.closeSync(entry.fd);
        entry = null;
      }
      if (buf.length - off < 512) break;
      const hdr = parseHeader(buf.subarray(off, off + 512));
      off += 512;
      if (!hdr) { ended = true; break; }
      entry = openEntry(hdr);
    }
    buf = buf.subarray(off);
  }
  if (entry && entry.fd !== null) fs.closeSync(entry.fd);
  let manifest;
  try {
    manifest = JSON.parse(await fsp.readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw Object.assign(new Error('это не бэкап Liro (нет manifest.json)'), { status: 400 });
  }
  if (!manifest.liroBackup) throw Object.assign(new Error('это не бэкап Liro'), { status: 400 });
  return manifest;
}

async function moveOver(src, dst) {
  await fsp.rm(dst, { recursive: true, force: true });
  await fsp.mkdir(path.dirname(dst), { recursive: true });
  try {
    await fsp.rename(src, dst);
  } catch {
    await fsp.cp(src, dst, { recursive: true });
  }
}

/**
 * Applies an extracted backup. replace=true overwrites boards/assets with the same id/name;
 * otherwise existing ones are kept and only missing ones are added.
 * hooks.beforeReplace(id) is called before a live board is replaced (to disconnect its clients).
 */
export async function applyRestore(tmp, store, dirs, { replace, hooks = {} }) {
  const summary = { boards: { added: 0, replaced: 0, skipped: 0 }, assets: { added: 0, replaced: 0, skipped: 0 } };
  const boardsDir = path.join(tmp, 'boards');
  for (const d of await fsp.readdir(boardsDir, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || !validBoardId(d.name)) continue;
    const id = d.name;
    try { JSON.parse(await fsp.readFile(path.join(boardsDir, id, 'board.json'), 'utf8')); } catch { continue; }
    const exists = !!store.get(id);
    if (exists && !replace) { summary.boards.skipped += 1; continue; }
    if (exists) {
      if (hooks.beforeReplace) await hooks.beforeReplace(id);
      await store.remove(id);
    }
    await fsp.mkdir(path.join(boardsDir, id, 'media'), { recursive: true });
    await moveOver(path.join(boardsDir, id), path.join(store.boardsDir, id));
    await store.loadBoard(id);
    summary.boards[exists ? 'replaced' : 'added'] += 1;
  }
  const kinds = { fonts: dirs.fonts, shapes: dirs.shapes, icons: dirs.icons, stickers: dirs.stickers };
  for (const [kind, target] of Object.entries(kinds)) {
    const src = path.join(tmp, 'assets', kind);
    const walk = async (rel) => {
      for (const d of await fsp.readdir(path.join(src, rel), { withFileTypes: true }).catch(() => [])) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) { await walk(r); continue; }
        const dst = path.join(target, r);
        const exists = fs.existsSync(dst);
        if (exists && !replace) { summary.assets.skipped += 1; continue; }
        await fsp.mkdir(path.dirname(dst), { recursive: true });
        await fsp.copyFile(path.join(src, r), dst);
        summary.assets[exists ? 'replaced' : 'added'] += 1;
      }
    };
    await walk('');
  }
  return summary;
}

export const tempDirFor = (dataDir) => path.join(dataDir, `.restore-${crypto.randomUUID().slice(0, 8)}`);
