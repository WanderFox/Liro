// Background housekeeping: free disk space monitoring and removal of media no longer used on a board.
//
// Media removed from a board (element deleted) is only marked with a timestamp; the file is deleted after
// the grace period (24 h by default), so undo within that time still finds it.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mediaOfElement } from '../../web/js/ops.js';

const GB = 1024 ** 3;

export class Disk {
  constructor(dir, { warnGb = 10, blockGb = 5 } = {}) {
    this.dir = dir;
    this.warn = warnGb * GB;
    this.block = blockGb * GB;
    this.state = { level: 'ok', free: null, total: null };
  }

  // level: 'ok' | 'low' (warn users) | 'full' (no new elements or uploads, editing only)
  async check() {
    try {
      const s = await fsp.statfs(this.dir);
      const free = s.bavail * s.bsize, total = s.blocks * s.bsize;
      const level = free < this.block ? 'full' : free < this.warn ? 'low' : 'ok';
      this.state = { level, free, total, warnBytes: this.warn, blockBytes: this.block };
    } catch {
      // statfs is unavailable on very old Node versions: never block.
    }
    return this.state;
  }

  get full() {
    return this.state.level === 'full';
  }
}

// One cleanup pass over every board. Returns the number of deleted files.
export async function collectMedia(store, graceMs, now = Date.now()) {
  let deleted = 0;
  for (const board of store.boards.values()) {
    const used = new Set();
    for (const el of board.elements.values()) for (const n of mediaOfElement(el)) used.add(n);
    let files = [];
    try { files = await fsp.readdir(board.mediaDir); } catch { continue; }
    let changed = false;
    const orphans = board.orphans;
    for (const name of files) {
      if (name.endsWith('.part')) continue;
      if (used.has(name)) {
        if (orphans[name]) { delete orphans[name]; changed = true; }
        continue;
      }
      if (!orphans[name]) {
        orphans[name] = now;
        changed = true;
      } else if (now - orphans[name] >= graceMs) {
        await fsp.rm(path.join(board.mediaDir, name), { force: true });
        delete orphans[name];
        changed = true;
        deleted += 1;
      }
    }
    for (const name of Object.keys(orphans)) {
      if (!files.includes(name)) { delete orphans[name]; changed = true; }
    }
    if (changed) board.scheduleSave();
  }
  return deleted;
}

// Nested boards whose link element was deleted from the parent (or whose parent is gone) are removed
// after the same grace period.
export async function collectBoards(store, graceMs, now = Date.now()) {
  const linked = new Set();
  for (const board of store.boards.values()) {
    for (const el of board.elements.values()) if (el.type === 'board' && el.boardId) linked.add(el.boardId);
  }
  let removed = 0;
  for (const board of [...store.boards.values()]) {
    if (!board.meta.parentId) continue;
    if (linked.has(board.meta.id)) {
      if (board.meta.orphanedAt) { delete board.meta.orphanedAt; board.scheduleSave(); }
      continue;
    }
    if (!board.meta.orphanedAt) {
      board.meta.orphanedAt = now;
      board.scheduleSave();
    } else if (now - board.meta.orphanedAt >= graceMs) {
      await store.remove(board.meta.id);
      removed += 1;
    }
  }
  return removed;
}

export function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else try { total += fs.statSync(p).size; } catch {}
    }
  };
  walk(dir);
  return total;
}
