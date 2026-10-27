import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyOp, sanitizeOp, uid } from '../../web/js/ops.js';

const RECENT_OPS = 20000;
const SAVE_DELAY = 800;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validBoardId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

class Board {
  constructor(dir, data) {
    this.dir = dir;
    this.meta = data.meta;
    this.seq = data.seq || 0;
    this.elements = new Map((data.elements || []).map((el) => [el.id, el]));
    // opId -> seq, so that ops resent after a reconnect or offline replay are not applied twice.
    this.recent = new Map(data.recent || []);
    // Media files no longer referenced by any element: name -> time they became unused.
    this.orphans = data.orphans || {};
    this.saveTimer = null;
    this.replayJournal();
  }

  get journalFile() {
    return path.join(this.dir, 'ops.log');
  }

  // Ops are appended to ops.log as soon as they are applied, so a crash between snapshots loses nothing.
  replayJournal() {
    let text = '';
    try { text = fs.readFileSync(this.journalFile, 'utf8'); } catch { return; }
    let n = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let op;
      try { op = JSON.parse(line); } catch { continue; } // torn last line after a crash
      if (!op.seq || op.seq <= this.seq) continue;
      applyOp(this.elements, op);
      this.seq = op.seq;
      if (op.opId) this.recent.set(op.opId, op.seq);
      n += 1;
    }
    if (n) {
      console.log(`[store] board ${this.meta.id}: recovered ${n} op(s) from journal`);
      this.save();
    }
  }

  get mediaDir() {
    return path.join(this.dir, 'media');
  }

  snapshot() {
    return { meta: this.meta, seq: this.seq, elements: [...this.elements.values()] };
  }

  summary() {
    return { ...this.meta, seq: this.seq, elementCount: this.elements.size };
  }

  // Applies a batch of untrusted ops. Returns { results, applied } where applied ops carry seq.
  // With `noAdd` (server disk nearly full) new elements are refused; existing ones can still be edited.
  applyOps(rawOps, by, { noAdd = false } = {}) {
    const results = [];
    const applied = [];
    for (const raw of Array.isArray(rawOps) ? rawOps : []) {
      const op = sanitizeOp(raw);
      if (!op) {
        results.push({ opId: raw && raw.opId, error: 'invalid' });
        continue;
      }
      if (noAdd && op.k === 'add' && !this.elements.has(op.el.id) && !this.recent.has(op.opId)) {
        results.push({ opId: op.opId, error: 'disk-full' });
        continue;
      }
      if (this.recent.has(op.opId)) {
        results.push({ opId: op.opId, seq: this.recent.get(op.opId), dup: true });
        continue;
      }
      const changed = applyOp(this.elements, op);
      this.seq += 1;
      this.recent.set(op.opId, this.seq);
      if (this.recent.size > RECENT_OPS) this.recent.delete(this.recent.keys().next().value);
      const stamped = { ...op, seq: this.seq, by };
      results.push({ opId: op.opId, seq: this.seq, noop: !changed || undefined });
      applied.push(stamped);
    }
    if (applied.length) {
      this.meta.updatedAt = Date.now();
      fs.appendFileSync(this.journalFile, `${applied.map((op) => JSON.stringify(op)).join('\n')}\n`);
      this.scheduleSave();
    }
    return { results, applied };
  }

  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, SAVE_DELAY);
  }

  // Synchronous on purpose: snapshot + journal truncation must not interleave with newly applied ops.
  save() {
    try {
      const file = path.join(this.dir, 'board.json');
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...this.snapshot(), recent: [...this.recent], orphans: this.orphans }));
      fs.renameSync(tmp, file);
      fs.writeFileSync(this.journalFile, '');
    } catch (e) {
      console.error(`[store] failed to save board ${this.meta.id}:`, e);
    }
  }

  flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.save();
    }
  }
}

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.boardsDir = path.join(dataDir, 'boards');
    this.boards = new Map();
  }

  async init() {
    await fsp.mkdir(this.boardsDir, { recursive: true });
    const infoFile = path.join(this.dataDir, 'server.json');
    try {
      this.info = JSON.parse(await fsp.readFile(infoFile, 'utf8'));
    } catch {
      this.info = { serverId: crypto.randomUUID(), createdAt: Date.now() };
      await writeAtomic(infoFile, JSON.stringify(this.info, null, 2));
    }
    for (const id of await fsp.readdir(this.boardsDir)) {
      if (!validBoardId(id)) continue;
      try {
        await this.loadBoard(id);
      } catch (e) {
        console.error(`[store] skipping unreadable board ${id}: ${e.message}`);
      }
    }
    console.log(`[store] ${this.boards.size} board(s) loaded from ${this.dataDir}`);
  }

  // Top-level boards only: nested boards (parentId) are reached through their parent board.
  // (Re)loads a board from its folder (used at start and after restoring a backup).
  async loadBoard(id) {
    const dir = path.join(this.boardsDir, id);
    const data = JSON.parse(await fsp.readFile(path.join(dir, 'board.json'), 'utf8'));
    const board = new Board(dir, data);
    this.boards.set(id, board);
    return board;
  }

  list() {
    return [...this.boards.values()].filter((b) => !b.meta.parentId).map((b) => b.summary()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id) {
    return this.boards.get(id) || null;
  }

  async create({ name, id, elements, parentId } = {}) {
    const boardId = id && validBoardId(id) && !this.boards.has(id) ? id : uid('b');
    const dir = path.join(this.boardsDir, boardId);
    await fsp.mkdir(path.join(dir, 'media'), { recursive: true });
    const now = Date.now();
    const meta = { id: boardId, name: String(name || 'Новая доска').slice(0, 200), createdAt: now, updatedAt: now };
    if (parentId && validBoardId(parentId)) meta.parentId = parentId;
    const board = new Board(dir, { meta, elements: [] });
    if (Array.isArray(elements)) board.applyOps(elements.map((el) => ({ k: 'add', el })), 'import');
    this.boards.set(boardId, board);
    board.save();
    return board;
  }

  async rename(id, name) {
    const board = this.get(id);
    if (!board) return null;
    board.meta.name = String(name || '').slice(0, 200) || board.meta.name;
    board.meta.updatedAt = Date.now();
    board.save();
    return board;
  }

  async remove(id) {
    const board = this.get(id);
    if (!board) return false;
    this.boards.delete(id);
    clearTimeout(board.saveTimer);
    await fsp.rm(board.dir, { recursive: true, force: true });
    return true;
  }

  mediaPath(board, name) {
    return path.join(board.mediaDir, name);
  }

  hasMedia(board, name) {
    return fs.existsSync(this.mediaPath(board, name));
  }

  flushAll() {
    for (const b of this.boards.values()) b.flush();
  }
}
