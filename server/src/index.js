import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { WebSocketServer } from 'ws';
import { config, lanAddresses } from './config.js';
import { Store, validBoardId } from './store.js';
import { startUdpDiscovery, startMdns } from './discovery.js';
import { startDns } from './dns.js';
import { Stickers } from './stickers.js';
import { Fonts } from './fonts.js';
import { CustomShapes } from './shapes.js';
import { unfurl } from './unfurl.js';
import { Disk, collectMedia, collectBoards } from './maintenance.js';
import { streamBackup, extractTar, applyRestore, boardTree, tempDirFor } from './backup.js';
import { backupFileName } from '../../web/js/tar.js';
import { MEDIA_NAME_RE } from '../../web/js/ops.js';

const VERSION = '1.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ogv': 'video/ogg', '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska', '.m4v': 'video/mp4', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.opus': 'audio/opus',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
};

const mimeOf = (file) => MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';

const store = new Store(config.dataDir);
await store.init();
const stickers = new Stickers([config.stickersDir, config.bundledStickersDir]);
await stickers.init();
const fonts = new Fonts(config.fontsDir, config.bundledFontsDir);
await fonts.init();
const shapes = new CustomShapes(config.shapesDir, 'shapes');
await shapes.init();
const icons = new CustomShapes(config.iconsDir, 'icons');
await icons.init();
const disk = new Disk(config.dataDir, { warnGb: config.diskWarnGb, blockGb: config.diskBlockGb });
await disk.check();

function diskFullError() {
  return Object.assign(new Error('на сервере заканчивается место: добавлять новое нельзя, можно только редактировать'), { status: 507 });
}

// Stores a buffer as board media (<sha256>.<ext>) and returns its name.
async function saveMediaBuffer(board, buf, ext) {
  const name = `${crypto.createHash('sha256').update(buf).digest('hex')}.${ext}`;
  const target = store.mediaPath(board, name);
  if (!fs.existsSync(target)) {
    await fsp.mkdir(board.mediaDir, { recursive: true });
    const tmp = `${target}.${crypto.randomUUID()}.part`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, target);
  }
  return name;
}

// ---------------------------------------------------------------- helpers

function send(res, status, body, headers = {}) {
  const isJson = body !== undefined && typeof body !== 'string' && !Buffer.isBuffer(body);
  const data = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    ...headers,
  });
  res.end(data);
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid json'), { status: 400 });
  }
}

async function sendFile(req, res, file, { cache = 'no-cache' } = {}) {
  let stat;
  try {
    stat = await fsp.stat(file);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    return send(res, 404, 'not found');
  }
  const headers = {
    'Content-Type': mimeOf(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': cache,
    'Last-Modified': stat.mtime.toUTCString(),
  };
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
    start = Math.max(0, start);
    end = Math.min(end, stat.size - 1);
    if (start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
      return res.end();
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return pipeline(fs.createReadStream(file, { start, end }), res).catch(() => {});
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  return pipeline(fs.createReadStream(file), res).catch(() => {});
}

// Streams an upload to disk while hashing it; the file name must be <sha256>.<ext>.
async function receiveMedia(req, board, name) {
  const target = store.mediaPath(board, name);
  if (fs.existsSync(target)) {
    req.resume();
    return { name, size: (await fsp.stat(target)).size, existed: true };
  }
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > config.maxUploadBytes) throw Object.assign(new Error('file too large'), { status: 413 });
  await fsp.mkdir(board.mediaDir, { recursive: true });
  const tmp = `${target}.${crypto.randomUUID()}.part`;
  const hash = crypto.createHash('sha256');
  let size = 0;
  const out = fs.createWriteStream(tmp);
  try {
    await pipeline(
      req,
      async function* (source) {
        for await (const chunk of source) {
          size += chunk.length;
          if (size > config.maxUploadBytes) throw Object.assign(new Error('file too large'), { status: 413 });
          hash.update(chunk);
          yield chunk;
        }
      },
      out,
    );
    const digest = hash.digest('hex');
    if (!name.startsWith(digest)) throw Object.assign(new Error('hash mismatch'), { status: 400 });
    await fsp.rename(tmp, target);
    return { name, size };
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw e;
  }
}

// ---------------------------------------------------------------- realtime rooms

const rooms = new Map(); // boardId -> Set<ws>
const COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6', '#9a6324', '#469990', '#800000'];

function room(boardId) {
  if (!rooms.has(boardId)) rooms.set(boardId, new Set());
  return rooms.get(boardId);
}

function broadcast(boardId, msg, except) {
  const set = rooms.get(boardId);
  if (!set) return;
  const data = JSON.stringify(msg);
  for (const ws of set) if (ws !== except && ws.readyState === 1) ws.send(data);
}

function peersOf(boardId) {
  return [...(rooms.get(boardId) || [])].map((ws) => ws.peer);
}

function applyAndBroadcast(board, ops, by, origin) {
  const { results, applied } = board.applyOps(ops, by, { noAdd: disk.full });
  if (applied.length) broadcast(board.meta.id, { t: 'ops', ops: applied }, origin);
  return results;
}

// ---------------------------------------------------------------- HTTP API

async function api(req, res, parts, url) {
  // parts: ['api', ...]
  const [, resource, id, sub, name] = parts;
  const method = req.method;

  if (resource === 'info' && method === 'GET') {
    return send(res, 200, {
      liro: 1, version: VERSION, name: config.name, serverId: store.info.serverId, disk: disk.state,
      hostname: config.hostname, port: config.port, addresses: lanAddresses().map((a) => a.address),
    });
  }

  if (resource === 'stickers' && method === 'GET') return send(res, 200, await stickers.list());
  // ---------------------------------------------------------------- backups
  const assetDirs = [
    { prefix: 'assets/fonts', dir: config.fontsDir },
    { prefix: 'assets/shapes', dir: config.shapesDir },
    { prefix: 'assets/icons', dir: config.iconsDir },
    { prefix: 'assets/stickers', dir: config.stickersDir, nested: true },
  ];
  const source = { name: config.name, serverId: store.info.serverId };
  if (resource === 'backup' && method === 'GET') {
    return streamBackup(res, {
      type: 'server', title: config.name, fileName: backupFileName('server', config.name),
      boards: [...store.boards.values()], assets: assetDirs, source,
    });
  }
  if (resource === 'restore' && method === 'POST') {
    const replace = url.searchParams.get('replace') === '1';
    const tmp = tempDirFor(config.dataDir);
    try {
      const manifest = await extractTar(req, tmp, config.maxUploadBytes * 8);
      const summary = await applyRestore(tmp, store, { fonts: config.fontsDir, shapes: config.shapesDir, icons: config.iconsDir, stickers: config.stickersDir }, {
        replace,
        hooks: {
          // Clients of a replaced board reconnect and receive the restored state.
          beforeReplace: async (boardId) => { for (const ws of rooms.get(boardId) || []) ws.close(4010, 'board restored'); },
        },
      });
      fonts.cache = null;
      for (const ws of wss.clients) if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'shapes' }));
      console.log(`[backup] restored "${manifest.title}" (${manifest.type}): ${JSON.stringify(summary)}`);
      return send(res, 200, { manifest, summary });
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }

  if (resource === 'fonts' && !id && method === 'GET') return send(res, 200, await fonts.list());
  // Uploaded SVG assets: custom shapes and nested-board icons.
  const svgStore = resource === 'shapes' ? shapes : resource === 'icons' ? icons : null;
  if (svgStore && !id && method === 'GET') return send(res, 200, await svgStore.list());
  if (svgStore && id && (method === 'PUT' || method === 'POST')) {
    if (disk.full) throw diskFullError();
    const file = await svgStore.save(id, await readBody(req, 5 * 1024 * 1024));
    // Every connected client refreshes its library.
    const msg = JSON.stringify({ t: resource });
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
    return send(res, 201, { file, list: await svgStore.list() });
  }
  if (svgStore && id && method === 'DELETE') {
    await svgStore.remove(id);
    const msg = JSON.stringify({ t: resource });
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
    return send(res, 200, { ok: true });
  }

  if (resource !== 'boards') return send(res, 404, { error: 'not found' });

  if (!id) {
    if (method === 'GET') return send(res, 200, store.list());
    if (method === 'POST') {
      const body = await readJson(req);
      const board = await store.create(body);
      return send(res, 201, board.summary());
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  if (!validBoardId(id)) return send(res, 400, { error: 'bad board id' });
  const board = store.get(id);
  if (!board) return send(res, 404, { error: 'board not found' });

  if (!sub) {
    if (method === 'GET') return send(res, 200, board.snapshot());
    if (method === 'PATCH') {
      const body = await readJson(req);
      await store.rename(id, body.name);
      broadcast(id, { t: 'meta', meta: board.meta });
      return send(res, 200, board.summary());
    }
    if (method === 'DELETE') {
      broadcast(id, { t: 'deleted' });
      for (const ws of rooms.get(id) || []) ws.close(4004, 'board deleted');
      await store.remove(id);
      return send(res, 200, { ok: true });
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  if (sub === 'backup' && method === 'GET') {
    const tree = boardTree(store, id);
    return streamBackup(res, {
      type: 'board', title: board.meta.name, fileName: backupFileName('board', board.meta.name),
      boards: tree, assets: [{ prefix: 'assets/fonts', dir: config.fontsDir }], source: { name: config.name, serverId: store.info.serverId },
    });
  }

  if (sub === 'ops' && method === 'POST') {
    const body = await readJson(req);
    const results = applyAndBroadcast(board, body.ops, String(body.by || 'http'), null);
    return send(res, 200, { results, seq: board.seq });
  }

  if (sub === 'unfurl' && method === 'POST') {
    if (disk.full) throw diskFullError();
    const body = await readJson(req);
    try {
      return send(res, 200, await unfurl(String(body.url || ''), (buf, ext) => saveMediaBuffer(board, buf, ext)));
    } catch (e) {
      return send(res, e.status || 502, { error: `не удалось получить превью: ${e.message}` });
    }
  }

  if (sub === 'media-check' && method === 'POST') {
    const body = await readJson(req);
    const names = Array.isArray(body.names) ? body.names : [];
    return send(res, 200, { missing: names.filter((n) => !MEDIA_NAME_RE.test(n) || !store.hasMedia(board, n)) });
  }

  if (sub === 'media' && name) {
    if (!MEDIA_NAME_RE.test(name)) return send(res, 400, { error: 'bad media name' });
    if (method === 'GET' || method === 'HEAD') {
      return sendFile(req, res, store.mediaPath(board, name), { cache: 'public, max-age=31536000, immutable' });
    }
    if (method === 'PUT' || method === 'POST') {
      if (disk.full && !store.hasMedia(board, name)) throw diskFullError();
      const result = await receiveMedia(req, board, name);
      return send(res, 201, result);
    }
  }

  return send(res, 404, { error: 'not found' });
}

async function handle(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  if (req.method === 'OPTIONS') return send(res, 204, '');

  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (parts[0] === 'api') return await api(req, res, parts, url);
    if ((parts[0] === 'shapes' || parts[0] === 'icons') && parts.length === 2) {
      const file = (parts[0] === 'shapes' ? shapes : icons).resolve(parts[1]);
      return file ? await sendFile(req, res, file) : send(res, 404, 'not found');
    }
    if (parts[0] === 'fonts' && parts.length === 2) {
      const file = fonts.resolve(parts[1]);
      return file ? await sendFile(req, res, file, { cache: 'public, max-age=86400' }) : send(res, 404, 'not found');
    }
    if (parts[0] === 'stickers' && parts.length === 3) {
      const file = stickers.resolve(parts[1], parts[2]);
      return file ? await sendFile(req, res, file, { cache: 'public, max-age=86400' }) : send(res, 404, 'not found');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
    const rel = parts.length ? parts.join('/') : 'index.html';
    const file = path.resolve(config.webDir, rel);
    if (!file.startsWith(config.webDir + path.sep)) return send(res, 403, 'forbidden');
    return await sendFile(req, res, file);
  } catch (e) {
    if (!res.headersSent) send(res, e.status || 500, { error: e.message });
    else res.destroy();
    if (!e.status) console.error('[http]', e);
  }
}

// ---------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const boardId = url.searchParams.get('board');
  const board = validBoardId(boardId) && store.get(boardId);
  if (!board) {
    ws.close(4004, 'board not found');
    return;
  }
  const cid = (url.searchParams.get('cid') || crypto.randomUUID()).slice(0, 64);
  const name = (url.searchParams.get('name') || 'Гость').slice(0, 60);
  const color = COLORS[parseInt(crypto.createHash('md5').update(cid).digest('hex').slice(0, 6), 16) % COLORS.length];
  ws.peer = { cid, name, color };
  ws.isAlive = true;

  const members = room(boardId);
  members.add(ws);
  ws.send(JSON.stringify({ t: 'state', ...board.snapshot(), peers: peersOf(boardId).filter((p) => p.cid !== cid), you: ws.peer, disk: disk.state }));
  broadcast(boardId, { t: 'peer-join', peer: ws.peer }, ws);

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch { return; }
    const current = store.get(boardId);
    if (!current) return;
    if (msg.t === 'ops') {
      const results = applyAndBroadcast(current, msg.ops, cid, ws);
      ws.send(JSON.stringify({ t: 'ack', results, seq: current.seq, req: msg.req }));
    } else if (msg.t === 'cursor') {
      broadcast(boardId, { t: 'cursor', cid, name, color, x: Number(msg.x) || 0, y: Number(msg.y) || 0 }, ws);
    } else if (msg.t === 'select') {
      broadcast(boardId, { t: 'select', cid, ids: Array.isArray(msg.ids) ? msg.ids.slice(0, 500) : [] }, ws);
    } else if (msg.t === 'ping') {
      ws.send(JSON.stringify({ t: 'pong' }));
    }
  });
  ws.on('close', () => {
    members.delete(ws);
    if (!members.size) rooms.delete(boardId);
    broadcast(boardId, { t: 'peer-leave', cid });
  });
  ws.on('error', () => {});
});

// Disk space: re-check every 30 s and tell connected clients when the level changes.
const diskTimer = setInterval(async () => {
  const before = disk.state.level;
  const state = await disk.check();
  if (state.level !== before) {
    console.log(`[disk] free space ${(state.free / 1024 ** 3).toFixed(1)} GB: ${state.level}`);
    const msg = JSON.stringify({ t: 'disk', disk: state });
    for (const ws of wss.clients) if (ws.readyState === 1) ws.send(msg);
  }
}, 30000);

// Unused media cleanup: hourly (first pass a minute after start).
const graceMs = config.mediaGraceHours * 3600 * 1000;
const runGc = async () => {
  try {
    const boards = await collectBoards(store, graceMs);
    if (boards) console.log(`[gc] removed ${boards} unused nested board(s)`);
    const files = await collectMedia(store, graceMs);
    if (files) console.log(`[gc] removed ${files} unused media file(s)`);
  } catch (e) {
    console.error('[gc]', e);
  }
};
const gcStart = setTimeout(runGc, 60 * 1000);
const gcTimer = setInterval(runGc, 3600 * 1000);

const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20000);

function onUpgrade(req, socket, head) {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
}

// ---------------------------------------------------------------- start

const servers = [];
for (const port of [config.port, ...config.extraPorts]) {
  const server = http.createServer(handle);
  server.on('upgrade', onUpgrade);
  server.requestTimeout = 0; // large media uploads
  server.on('error', (e) => console.error(`[http] cannot listen on :${port}: ${e.message}`));
  server.listen(port, config.host, () => console.log(`[http] listening on http://${config.host}:${port}`));
  servers.push(server);
}

const stoppers = [];
if (config.udpDiscovery) stoppers.push(startUdpDiscovery(config, store.info));
if (config.mdns) stoppers.push(startMdns(config, store.info));
if (config.dns) stoppers.push(startDns(config));

console.log(`[liro] "${config.name}" — open http://${config.hostname}:${config.port} or ${
  lanAddresses().map((a) => `http://${a.address}:${config.port}`).join(', ')}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  console.log('[liro] shutting down…');
  clearInterval(heartbeat);
  for (const stop of stoppers) try { stop(); } catch {}
  clearInterval(diskTimer);
  clearInterval(gcTimer);
  clearTimeout(gcStart);
  for (const ws of wss.clients) ws.close(1001, 'server shutdown');
  await store.flushAll();
  for (const s of servers) s.close();
  setTimeout(() => process.exit(0), 300).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
