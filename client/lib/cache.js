// On-disk cache of boards and their media:
//   <userData>/cache/<serverId>/<boardId>/board.json
//   <userData>/cache/<serverId>/<boardId>/media/<sha256>.<ext>
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const http = require('http');
const https = require('https');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MEDIA_NAME = /^[a-f0-9]{64}(\.[a-z0-9]{1,8})?$/;

class Cache {
  constructor(root) {
    this.root = root;
  }

  boardDir(serverId, boardId) {
    if (!SAFE_ID.test(serverId) || !SAFE_ID.test(boardId)) throw new Error('bad id');
    return path.join(this.root, serverId, boardId);
  }

  mediaFile(serverId, boardId, name) {
    if (!MEDIA_NAME.test(name)) throw new Error('bad media name');
    return path.join(this.boardDir(serverId, boardId), 'media', name);
  }

  async load(serverId, boardId) {
    try {
      return JSON.parse(await fsp.readFile(path.join(this.boardDir(serverId, boardId), 'board.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async save(serverId, boardId, data) {
    const dir = this.boardDir(serverId, boardId);
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'board.json');
    const tmp = `${file}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(data));
    await fsp.rename(tmp, file);
    return true;
  }

  async remove(serverId, boardId) {
    await fsp.rm(this.boardDir(serverId, boardId), { recursive: true, force: true });
    return true;
  }

  async list(serverId) {
    if (!SAFE_ID.test(serverId)) return [];
    const dir = path.join(this.root, serverId);
    let ids = [];
    try { ids = await fsp.readdir(dir); } catch { return []; }
    const out = [];
    for (const id of ids) {
      const data = await this.load(serverId, id).catch(() => null);
      if (!data || !data.meta) continue;
      out.push({
        meta: data.meta,
        elementCount: (data.elements || []).length,
        queueLength: (data.queue || []).filter((q) => q.offline).length,
        savedAt: data.savedAt,
      });
    }
    return out;
  }

  hasMedia(serverId, boardId, name) {
    try {
      return fs.existsSync(this.mediaFile(serverId, boardId, name));
    } catch {
      return false;
    }
  }

  async saveMedia(serverId, boardId, name, buffer) {
    const file = this.mediaFile(serverId, boardId, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) {
      const tmp = `${file}.${Date.now()}.part`;
      await fsp.writeFile(tmp, Buffer.from(buffer));
      await fsp.rename(tmp, file);
    }
    return true;
  }

  async downloadMedia(serverUrl, serverId, boardId, name) {
    const file = this.mediaFile(serverId, boardId, name);
    if (fs.existsSync(file)) return true;
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const res = await fetch(`${serverUrl}/api/boards/${boardId}/media/${name}`);
    if (!res.ok || !res.body) return false;
    const tmp = `${file}.${Date.now()}.part`;
    try {
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
      await fsp.rename(tmp, file);
      return true;
    } catch {
      await fsp.rm(tmp, { force: true });
      return false;
    }
  }

  // Streams a cached media file to a board on the server (PUT, hash-verified by the server).
  uploadMedia(serverUrl, targetBoardId, serverId, sourceBoardId, name) {
    let file;
    try { file = this.mediaFile(serverId, sourceBoardId, name); } catch { return Promise.resolve(false); }
    if (!fs.existsSync(file) || !SAFE_ID.test(targetBoardId)) return Promise.resolve(false);
    const url = new URL(`${serverUrl}/api/boards/${targetBoardId}/media/${name}`);
    const lib = url.protocol === 'https:' ? https : http;
    return new Promise((resolve) => {
      const req = lib.request(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(file).size },
      }, (res) => {
        res.resume();
        resolve(res.statusCode < 300);
      });
      req.on('error', () => resolve(false));
      fs.createReadStream(file).on('error', () => { req.destroy(); resolve(false); }).pipe(req);
    });
  }
}

// Locally added assets: <userData>/assets/<kind>/<name>.
const ASSET_KINDS = ['icons', 'shapes', 'fonts'];
const ASSET_NAME = /^[^/\\]{1,120}\.(svg|ttf|otf|woff2?)$/i;

class Assets {
  constructor(root) {
    this.root = root;
  }

  file(kind, name) {
    if (!ASSET_KINDS.includes(kind) || !ASSET_NAME.test(name) || name.startsWith('.')) throw new Error('bad asset');
    return path.join(this.root, kind, name);
  }

  async list(kind) {
    if (!ASSET_KINDS.includes(kind)) return [];
    try {
      return (await fsp.readdir(path.join(this.root, kind))).filter((n) => ASSET_NAME.test(n));
    } catch {
      return [];
    }
  }

  async save(kind, name, buffer) {
    const file = this.file(kind, name);
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, Buffer.from(buffer));
  }

  async read(kind, name) {
    try { return await fsp.readFile(this.file(kind, name)); } catch { return null; }
  }

  async remove(kind, name) {
    await fsp.rm(this.file(kind, name), { force: true });
  }
}

module.exports = { Cache, Assets, SAFE_ID, MEDIA_NAME };
