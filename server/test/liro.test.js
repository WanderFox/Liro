// End-to-end tests: a real server process, real WebSockets, and the client sync engine (session.js)
// running in Node with an in-memory stand-in for the desktop cache.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 19190 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'liro-test-'));
let proc = null;

// ---------------------------------------------------------------- in-memory "desktop" bridge
const disk = new Map();
const mediaDisk = new Map();
globalThis.liroNative = {
  isNative: true,
  discover: async () => [],
  getSettings: async () => ({}),
  setSettings: async () => {},
  cache: {
    load: async (s, b) => (disk.has(`${s}/${b}`) ? structuredClone(disk.get(`${s}/${b}`)) : null),
    save: async (s, b, d) => { disk.set(`${s}/${b}`, structuredClone(d)); return true; },
    remove: async (s, b) => { disk.delete(`${s}/${b}`); return true; },
    list: async () => [],
  },
  media: {
    localUrl: (s, b, n) => (mediaDisk.has(`${s}/${b}/${n}`) ? `mem://${n}` : null),
    save: async (s, b, n, buf) => { mediaDisk.set(`${s}/${b}/${n}`, Buffer.from(buf)); return `mem://${n}`; },
    download: async () => null,
    upload: async (url, target, s, src, n) => {
      const data = mediaDisk.get(`${s}/${src}/${n}`);
      if (!data) return false;
      const res = await fetch(`${url}/api/boards/${target}/media/${n}`, { method: 'PUT', body: data });
      return res.ok;
    },
  },
};
// XMLHttpRequest is not available in Node; the session uses it only for online uploads.
const { BoardSession } = await import('../../web/js/session.js');
const { buildResponse } = await import('../src/dns.js');

function startServer() {
  return new Promise((resolve, reject) => {
    proc = spawn(process.execPath, [path.join(here, '..', 'src', 'index.js')], {
      env: { ...process.env, LIRO_PORT: String(PORT), LIRO_DATA: dataDir, LIRO_MDNS: '0', LIRO_BIND: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const onData = (d) => {
      out += d;
      if (out.includes('listening')) resolve();
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('exit', (code) => { if (!out.includes('listening')) reject(new Error(`server exited ${code}: ${out}`)); });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (!proc) return resolve();
    proc.once('exit', () => resolve());
    proc.kill('SIGTERM');
    if (process.platform === 'win32') setTimeout(() => resolve(), 1500); // no graceful SIGTERM on Windows
    proc = null;
  });
}

const api = async (p, opts = {}) => {
  const res = await fetch(`${BASE}${p}`, {
    ...opts,
    headers: opts.body && typeof opts.body === 'string' ? { 'Content-Type': 'application/json' } : opts.headers,
  });
  const ct = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, body: ct.includes('json') ? await res.json() : await res.arrayBuffer() };
};

const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('timeout');
};

before(startServer);
after(async () => {
  await stopServer();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('info and board CRUD', async () => {
  const info = await api('/api/info');
  assert.equal(info.body.liro, 1);
  assert.match(info.body.serverId, /^[0-9a-f-]{36}$/);
  const created = await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: 'CRUD' }) });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await api(`/api/boards/${id}`, { method: 'PATCH', body: JSON.stringify({ name: 'Renamed' }) })).body.name, 'Renamed');
  assert.ok((await api('/api/boards')).body.some((b) => b.id === id && b.name === 'Renamed'));
  assert.equal((await api(`/api/boards/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await api(`/api/boards/${id}`)).status, 404);
});

test('ops are applied once even when resent', async () => {
  const { body: b } = await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: 'Ops' }) });
  const ops = [
    { k: 'add', opId: 'o1', el: { id: 'e1', type: 'sticky', x: 0, y: 0, w: 100, h: 100, text: 'a' } },
    { k: 'upd', opId: 'o2', id: 'e1', set: { x: 50, text: 'b' } },
    { k: 'add', opId: 'o3', el: { id: 'bad', type: 'virus' } },
  ];
  const r1 = await api(`/api/boards/${b.id}/ops`, { method: 'POST', body: JSON.stringify({ ops }) });
  assert.equal(r1.body.results[2].error, 'invalid');
  const r2 = await api(`/api/boards/${b.id}/ops`, { method: 'POST', body: JSON.stringify({ ops: ops.slice(0, 2) }) });
  assert.ok(r2.body.results.every((r) => r.dup));
  const snap = (await api(`/api/boards/${b.id}`)).body;
  assert.equal(snap.elements.length, 1);
  assert.deepEqual([snap.elements[0].x, snap.elements[0].text], [50, 'b']);
  assert.equal(snap.seq, 2);
});

test('media upload is hash-verified and supports ranges', async () => {
  const { body: b } = await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: 'Media' }) });
  const data = crypto.randomBytes(100_000);
  const name = `${crypto.createHash('sha256').update(data).digest('hex')}.mp4`;
  const wrong = `${'0'.repeat(64)}.mp4`;
  assert.equal((await fetch(`${BASE}/api/boards/${b.id}/media/${wrong}`, { method: 'PUT', body: data })).status, 400);
  assert.equal((await fetch(`${BASE}/api/boards/${b.id}/media/${name}`, { method: 'PUT', body: data })).status, 201);
  const full = await fetch(`${BASE}/api/boards/${b.id}/media/${name}`);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(data));
  const part = await fetch(`${BASE}/api/boards/${b.id}/media/${name}`, { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(data.subarray(10, 20)));
  const check = await api(`/api/boards/${b.id}/media-check`, { method: 'POST', body: JSON.stringify({ names: [name, wrong] }) });
  assert.deepEqual(check.body.missing, [wrong]);
  assert.equal((await fetch(`${BASE}/api/boards/${b.id}/media/..%2F..%2Fserver.json`)).status, 400);
});

test('UDP discovery answers probes', async () => {
  const sock = dgram.createSocket('udp4');
  const reply = new Promise((resolve) => sock.on('message', (m) => resolve(JSON.parse(m.toString()))));
  await new Promise((r) => sock.bind(0, r));
  sock.send('LIRO_DISCOVER_V1', PORT, '127.0.0.1');
  const info = await Promise.race([reply, new Promise((_, rej) => setTimeout(() => rej(new Error('no reply')), 2000))]);
  sock.close();
  assert.equal(info.liro, 1);
  assert.equal(info.port, PORT);
});

test('DNS responder answers liro.loc', () => {
  const q = Buffer.from('abcd0100000100000000000004'.replace(/../g, (x) => x) , 'hex');
  const name = Buffer.concat([Buffer.from([4]), Buffer.from('liro'), Buffer.from([3]), Buffer.from('loc'), Buffer.from([0])]);
  const query = Buffer.concat([q.subarray(0, 12), name, Buffer.from([0, 1, 0, 1])]);
  const res = buildResponse(query, 'liro.loc', '192.168.1.50');
  assert.equal(res.readUInt16BE(6), 1); // one answer
  assert.deepEqual([...res.subarray(res.length - 4)], [192, 168, 1, 50]);
  const other = Buffer.concat([q.subarray(0, 12), Buffer.from([3]), Buffer.from('foo'), Buffer.from([3]), Buffer.from('loc'), Buffer.from([0, 0, 1, 0, 1])]);
  assert.equal(buildResponse(other, 'liro.loc', '1.2.3.4')[3] & 0x0f, 3); // NXDOMAIN
});

function session(board, info, name, cache) {
  const s = new BoardSession({
    server: { url: BASE, serverId: info.serverId, name: 'test' },
    boardId: board.id, meta: board, user: { cid: crypto.randomUUID(), name }, cacheEnabled: cache,
  });
  return s;
}

test('realtime: two clients see each other\'s changes, concurrent edits converge', async () => {
  const info = (await api('/api/info')).body;
  const { body: b } = await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: 'RT' }) });
  const a = session(b, info, 'A', false);
  const c = session(b, info, 'C', false);
  await a.open();
  await c.open();
  await until(() => a.status === 'online' && c.status === 'online');
  a.apply([{ k: 'add', el: { id: 's1', type: 'sticky', x: 0, y: 0, w: 10, h: 10, text: 'hi' } }]);
  await until(() => c.elements.get('s1'));
  // Concurrent updates of the same field: both clients must end with the server's value.
  a.apply([{ k: 'upd', id: 's1', set: { x: 111 } }]);
  c.apply([{ k: 'upd', id: 's1', set: { x: 222 } }]);
  await until(() => a.inflight.size === 0 && c.inflight.size === 0);
  await new Promise((r) => setTimeout(r, 200));
  const server = (await api(`/api/boards/${b.id}`)).body.elements.find((e) => e.id === 's1');
  assert.equal(a.elements.get('s1').x, server.x);
  assert.equal(c.elements.get('s1').x, server.x);
  a.close();
  c.close();
});

test('offline: cached board keeps working while the server is down and pushes changes later', async () => {
  const info = (await api('/api/info')).body;
  const { body: b } = await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: 'Offline' }) });
  const a = session(b, info, 'A', true);
  await a.open();
  await until(() => a.status === 'online');
  a.apply([{ k: 'add', el: { id: 'base', type: 'sticky', x: 0, y: 0, w: 10, h: 10, text: 'online' } }]);
  await until(() => a.inflight.size === 0);

  let decision = null;
  a.addEventListener('decision', (e) => { decision = e.detail; });

  await stopServer();
  await until(() => a.status === 'offline');
  assert.equal(a.canEdit, true, 'cached board stays editable offline');

  // Offline work: a new element with media, an edit, a deletion of nothing remote.
  const media = Buffer.from('fake image bytes');
  const mediaName = `${crypto.createHash('sha256').update(media).digest('hex')}.png`;
  await globalThis.liroNative.media.save(info.serverId, b.id, mediaName, media);
  a.apply([{ k: 'add', el: { id: 'img', type: 'image', x: 5, y: 5, w: 10, h: 10, src: mediaName } }]);
  for (let i = 0; i < 20; i++) a.apply([{ k: 'upd', id: 'base', set: { x: i } }]); // collapsed into one queued op
  a.apply([{ k: 'upd', id: 'base', set: { text: 'edited offline' } }]);
  assert.equal(a.offlineCount, 2, 'consecutive updates are collapsed');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(disk.get(`${info.serverId}/${b.id}`).queue.length, 2, 'queue is persisted to the cache');

  // A brand-new session (app restart while offline) restores the board from cache.
  a.close();
  const a2 = session(b, info, 'A', true);
  a2.addEventListener('decision', (e) => { decision = e.detail; });
  await startServer();
  await a2.open();
  assert.ok(a2.elements.get('base'), 'restored from cache');
  assert.equal(a2.elements.get('base').text, 'edited offline');
  await until(() => decision);
  assert.equal(decision.count, 2);
  assert.equal(a2.canEdit, false, 'editing is paused until the user decides');

  await a2.resolveDecision('push');
  await until(() => a2.inflight.size === 0);
  const snap = (await api(`/api/boards/${b.id}`)).body;
  const base = snap.elements.find((e) => e.id === 'base');
  assert.equal(base.text, 'edited offline');
  assert.equal(base.x, 19);
  assert.ok(snap.elements.find((e) => e.id === 'img'));
  const m = await fetch(`${BASE}/api/boards/${b.id}/media/${mediaName}`);
  assert.equal(m.status, 200, 'media created offline was uploaded');
  a2.close();
});

test('offline: discard restores server state, copy creates a new board', async () => {
  const info = (await api('/api/info')).body;
  const { body: b } = await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: 'Choice' }) });
  for (const choice of ['discard', 'copy']) {
    disk.clear();
    const a = session(b, info, 'A', true);
    let decision = null;
    a.addEventListener('decision', () => { decision = true; });
    await a.open();
    await until(() => a.status === 'online');
    await stopServer();
    await until(() => a.status === 'offline');
    a.apply([{ k: 'add', el: { id: `x-${choice}`, type: 'text', x: 0, y: 0, w: 10, h: 10, text: choice } }]);
    await startServer();
    a.retryNow();
    await until(() => decision, 15000);
    const created = await a.resolveDecision(choice);
    assert.equal(a.elements.has(`x-${choice}`), false);
    const snap = (await api(`/api/boards/${b.id}`)).body;
    assert.equal(snap.elements.some((e) => e.id === `x-${choice}`), false);
    if (choice === 'copy') {
      const copy = (await api(`/api/boards/${created.id}`)).body;
      assert.ok(copy.elements.some((e) => e.text === 'copy'));
      assert.match(copy.meta.name, /офлайн-копия/);
    }
    a.close();
  }
});

test('sticker packs are listed and served', async () => {
  const packs = (await api('/api/stickers')).body;
  const hal = packs.find((p) => p.id === 'halloween');
  assert.ok(hal && hal.items.length >= 20, 'bundled halloween pack');
  assert.equal(hal.name, 'Хеллоуин');
  const res = await fetch(`${BASE}${hal.items[0].url}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.equal((await fetch(`${BASE}/stickers/halloween/..%2F..%2Fsrc%2Findex.js`)).status, 404);
  // A folder dropped into the user stickers directory becomes a pack.
  const dir = path.join(dataDir, 'stickers', 'mine');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'dot.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><circle cx="1" cy="1" r="1"/></svg>');
  fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ name: 'Мои' }));
  const again = (await api('/api/stickers')).body;
  assert.ok(again.some((p) => p.name === 'Мои' && p.items.length === 1));
});

test('link preview metadata is parsed and images are stored as board media', async () => {
  const { parseMeta } = await import('../src/unfurl.js');
  const m = parseMeta(`<html><head><title>Fallback</title>
    <meta property="og:title" content="Тыквы &amp; призраки">
    <meta name="description" content="Описание">
    <meta property="og:image" content="/img/cover.png">
    <link rel="icon" href="favicon.svg"></head></html>`, 'https://example.com/a/b');
  assert.equal(m.title, 'Тыквы & призраки');
  assert.equal(m.description, 'Описание');
  assert.equal(m.image, 'https://example.com/img/cover.png');
  assert.equal(m.icon, 'https://example.com/a/favicon.svg');

  // Serve a page + image from a local HTTP server and unfurl it through Liro.
  const http = await import('node:http');
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
  const site = http.createServer((req, res) => {
    if (req.url === '/cover.png') { res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<meta property="og:title" content="Local page"><meta property="og:image" content="/cover.png">');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  const { body: b } = await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: 'Links' }) });
  const r = await api(`/api/boards/${b.id}/unfurl`, { method: 'POST', body: JSON.stringify({ url: `http://127.0.0.1:${site.address().port}/page` }) });
  site.close();
  assert.equal(r.body.title, 'Local page');
  assert.match(r.body.image, /^[a-f0-9]{64}\.png$/);
  assert.equal((await fetch(`${BASE}/api/boards/${b.id}/media/${r.body.image}`)).status, 200, 'preview image cached on the server');
  assert.equal((await api(`/api/boards/${b.id}/unfurl`, { method: 'POST', body: JSON.stringify({ url: 'javascript:alert(1)' }) })).status, 400);
});

test('nested boards are hidden from the list and keep their parent', async () => {
  const { body: parent } = await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: 'Parent' }) });
  const { body: child } = await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: 'Child', parentId: parent.id }) });
  const list = (await api('/api/boards')).body;
  assert.ok(list.some((b) => b.id === parent.id));
  assert.ok(!list.some((b) => b.id === child.id), 'child not in the global list');
  assert.equal((await api(`/api/boards/${child.id}`)).body.meta.parentId, parent.id);
  // A board created offline is uploaded later with the same id.
  const { body: pending } = await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: 'Pending', id: 'bOfflineCreated1' }) });
  assert.equal(pending.id, 'bOfflineCreated1');
});

test('custom SVG shapes are sanitized and fonts are listed', async () => {
  const evil = '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"><script>x()</script><a href="javascript:x()"><path d="M0 0h1v1z" onclick="y()"/></a></svg>';
  const put = await fetch(`${BASE}/api/shapes/evil.svg`, { method: 'PUT', body: evil });
  assert.equal(put.status, 201);
  const svg = await (await fetch(`${BASE}/shapes/evil.svg`)).text();
  assert.ok(!/script|onload|onclick|javascript:/i.test(svg), svg);
  assert.ok(svg.includes('<path'));
  assert.ok((await api('/api/shapes')).body.some((s) => s.id === 'evil.svg'));
  assert.equal((await fetch(`${BASE}/api/shapes/bad.svg`, { method: 'PUT', body: 'not svg' })).status, 400);
  const fonts = (await api('/api/fonts')).body;
  assert.ok(fonts.some((f) => f.family === 'Open Sans'));
  const font = await fetch(`${BASE}${fonts[0].url}`);
  assert.equal(font.status, 200);
});

test('unused media is marked and removed only after the grace period', async () => {
  const { Store } = await import('../src/store.js');
  const { collectMedia, collectBoards } = await import('../src/maintenance.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liro-gc-'));
  const store = new Store(dir);
  await store.init();
  const board = await store.create({ name: 'GC' });
  const keep = `${'a'.repeat(64)}.png`, drop = `${'b'.repeat(64)}.png`;
  fs.writeFileSync(path.join(board.mediaDir, keep), 'x');
  fs.writeFileSync(path.join(board.mediaDir, drop), 'y');
  board.applyOps([{ k: 'add', opId: 'g1', el: { id: 'img', type: 'image', x: 0, y: 0, w: 1, h: 1, src: keep } }], 't');
  const day = 24 * 3600 * 1000, t0 = Date.now();
  assert.equal(await collectMedia(store, day, t0), 0);
  assert.ok(board.orphans[drop] && !board.orphans[keep], 'unused file is only marked');
  assert.equal(await collectMedia(store, day, t0 + day - 1000), 0, 'still within the grace period');
  assert.equal(await collectMedia(store, day, t0 + day + 1000), 1);
  assert.ok(fs.existsSync(path.join(board.mediaDir, keep)) && !fs.existsSync(path.join(board.mediaDir, drop)));
  // Nested board without a tile on its parent goes away after the grace period too.
  const child = await store.create({ name: 'child', parentId: board.meta.id });
  await collectBoards(store, day, t0);
  assert.ok(store.get(child.meta.id).meta.orphanedAt);
  board.applyOps([{ k: 'add', opId: 'g2', el: { id: 'tile', type: 'board', boardId: child.meta.id, x: 0, y: 0, w: 1, h: 1 } }], 't');
  await collectBoards(store, day, t0 + 2 * day);
  assert.ok(store.get(child.meta.id), 'linked again: kept');
  board.applyOps([{ k: 'del', opId: 'g3', id: 'tile' }], 't');
  await collectBoards(store, day, t0 + 3 * day);
  await collectBoards(store, day, t0 + 5 * day);
  assert.equal(store.get(child.meta.id), null);
  store.flushAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a full disk blocks new elements but not edits', async () => {
  const { Store } = await import('../src/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liro-disk-'));
  const store = new Store(dir);
  await store.init();
  const board = await store.create({ name: 'Disk' });
  board.applyOps([{ k: 'add', opId: 'd1', el: { id: 's', type: 'sticky', x: 0, y: 0, w: 1, h: 1, text: 'a' } }], 't');
  const { results } = board.applyOps([
    { k: 'add', opId: 'd2', el: { id: 'n', type: 'sticky', x: 0, y: 0, w: 1, h: 1 } },
    { k: 'upd', opId: 'd3', id: 's', set: { text: 'b' } },
  ], 't', { noAdd: true });
  assert.equal(results[0].error, 'disk-full');
  assert.ok(!results[1].error);
  assert.equal(board.elements.get('s').text, 'b');
  assert.ok(!board.elements.has('n'));
  const { Disk } = await import('../src/maintenance.js');
  const d = new Disk(dir, { warnGb: 1e9, blockGb: 1e9 });
  assert.equal((await d.check()).level, 'full');
  store.flushAll();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('backup and restore: server and board archives', async () => {
  const { parseTar } = await import('../../web/js/tar.js');
  const { body: b } = await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: 'Бэкап' }) });
  const { body: child } = await api('/api/boards', { method: 'POST', body: JSON.stringify({ name: 'Вложенная', parentId: b.id }) });
  const media = crypto.randomBytes(3000);
  const mediaName = `${crypto.createHash('sha256').update(media).digest('hex')}.png`;
  await fetch(`${BASE}/api/boards/${b.id}/media/${mediaName}`, { method: 'PUT', body: media });
  await api(`/api/boards/${b.id}/ops`, { method: 'POST', body: JSON.stringify({ ops: [
    { k: 'add', opId: 'bk1', el: { id: 'img', type: 'image', x: 0, y: 0, w: 1, h: 1, src: mediaName } },
    { k: 'add', opId: 'bk2', el: { id: 'tile', type: 'board', boardId: child.id, x: 0, y: 0, w: 1, h: 1 } },
    { k: 'add', opId: 'bk3', el: { id: 'note', type: 'sticky', x: 0, y: 0, w: 1, h: 1, text: 'исходный' } },
  ] }) });
  await fetch(`${BASE}/api/icons/star.svg`, { method: 'PUT', body: '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1z"/></svg>' });

  // Board backup: the board, its nested board and media; named after the board.
  const boardRes = await fetch(`${BASE}/api/boards/${b.id}/backup`);
  assert.match(decodeURIComponent(boardRes.headers.get('content-disposition')), /Liro-board-Бэкап-/);
  const boardTar = new Uint8Array(await boardRes.arrayBuffer());
  const boardFiles = [...parseTar(boardTar)].map((e) => e.path);
  assert.equal(boardFiles[0], 'manifest.json');
  assert.ok(boardFiles.includes(`boards/${b.id}/board.json`) && boardFiles.includes(`boards/${child.id}/board.json`));
  assert.ok(boardFiles.includes(`boards/${b.id}/media/${mediaName}`));

  // Server backup contains every board and the uploaded icons.
  const serverTar = new Uint8Array(await (await fetch(`${BASE}/api/backup`)).arrayBuffer());
  const serverFiles = [...parseTar(serverTar)];
  const manifest = JSON.parse(new TextDecoder().decode(serverFiles[0].data));
  assert.equal(manifest.type, 'server');
  assert.ok(manifest.boards.length >= 2);
  assert.ok(serverFiles.some((e) => e.path === 'assets/icons/star.svg'));

  // Change the board, then restore without replacing: nothing changes.
  await api(`/api/boards/${b.id}/ops`, { method: 'POST', body: JSON.stringify({ ops: [{ k: 'upd', opId: 'bk4', id: 'note', set: { text: 'изменённый' } }] }) });
  let r = await api('/api/restore?replace=0', { method: 'POST', body: boardTar, headers: { 'Content-Type': 'application/x-tar' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.summary.boards.skipped, 2);
  assert.equal((await api(`/api/boards/${b.id}`)).body.elements.find((e) => e.id === 'note').text, 'изменённый');

  // Restore with replacing: the board returns to the backed-up state.
  r = await api('/api/restore?replace=1', { method: 'POST', body: boardTar, headers: { 'Content-Type': 'application/x-tar' } });
  assert.equal(r.body.summary.boards.replaced, 2);
  assert.equal((await api(`/api/boards/${b.id}`)).body.elements.find((e) => e.id === 'note').text, 'исходный');

  // Deleted boards and media come back from a backup.
  await api(`/api/boards/${b.id}`, { method: 'DELETE' });
  r = await api('/api/restore?replace=0', { method: 'POST', body: boardTar, headers: { 'Content-Type': 'application/x-tar' } });
  assert.equal(r.body.summary.boards.added, 1);
  assert.equal((await fetch(`${BASE}/api/boards/${b.id}/media/${mediaName}`)).status, 200);

  // Not a backup.
  assert.equal((await api('/api/restore', { method: 'POST', body: new Uint8Array(2048), headers: { 'Content-Type': 'application/x-tar' } })).status, 400);
});
