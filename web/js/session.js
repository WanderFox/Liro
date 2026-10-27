// Board synchronization: realtime WebSocket, optimistic local ops, local cache and offline queue.
//
// Local changes are applied immediately and sent to the server. Until the server acknowledges an op
// it stays "pending"; remote ops touching an element with pending local ops are applied and then our
// pending ops are re-applied on top, which mirrors the order in which the server will apply them.
//
// When the board is cached and the connection is lost, ops are queued (and persisted) as "offline".
// On reconnect the user decides: push them to the server, discard them, or save the local state as a
// new board.

import { applyOp, uid, mediaOfOp, mediaOfElement, MEDIA_NAME_RE } from './ops.js';
import { Api } from './net.js';
import { native } from './native.js';
import { sha256Hex } from './sha256.js';
import { t } from './i18n.js';

const EXT_BY_MIME = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'image/bmp': 'bmp', 'image/avif': 'avif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/ogg': 'ogv',
  'video/quicktime': 'mov', 'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg',
  'audio/mp4': 'm4a', 'audio/aac': 'aac', 'audio/flac': 'flac', 'audio/webm': 'webm', 'application/pdf': 'pdf',
};

export function mediaExt(file) {
  const m = /\.([a-z0-9]{1,8})$/i.exec(file.name || '');
  if (m) return m[1].toLowerCase();
  return EXT_BY_MIME[file.type] || 'bin';
}

export class BoardSession extends EventTarget {
  constructor({ server, boardId, meta, user, cacheEnabled }) {
    super();
    this.server = server; // { url, serverId, name }
    this.api = new Api(server.url);
    this.boardId = boardId;
    this.meta = meta || { id: boardId, name: '' };
    this.user = user; // { cid, name }
    this.cacheEnabled = !!(cacheEnabled && native.cache);
    this.elements = new Map();
    this.seq = 0;
    this.queue = []; // [{ op, offline }] not sent yet
    this.inflight = new Map(); // opId -> { op, offline }
    this.pendingById = new Map(); // element id -> number of unacknowledged local ops
    this.outbox = [];
    this.peers = new Map();
    this.status = 'connecting';
    this.loaded = false;
    this.awaitingDecision = false;
    this.serverSnapshot = null;
    this.closed = false;
    this.ws = null;
    this.retryDelay = 1000;
    this.saveTimer = null;
  }

  // ------------------------------------------------------------ lifecycle

  async open() {
    // Browser storage keeps media as blobs: turn them into URLs before the board is drawn.
    if (native.media && native.media.prepare) await native.media.prepare(this.server.serverId, this.boardId);
    if (this.cacheEnabled) {
      const cached = await native.cache.load(this.server.serverId, this.boardId);
      if (cached) {
        if (cached.meta) this.meta = cached.meta;
        this.seq = cached.seq || 0;
        this.elements = new Map((cached.elements || []).map((el) => [el.id, el]));
        this.queue = cached.queue || [];
        this.recountPending();
        this.loaded = true;
        this.emit('reset');
        this.emit('status');
      }
    }
    if (this.server.local) {
      // Board stored only on this computer: there is no server to talk to.
      this.loaded = true;
      this.setStatus('local');
      return;
    }
    this.connect();
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    // Changes made right before leaving the board are still waiting for the microtask flush: send now.
    if (this.outbox.length && this.ws && this.ws.readyState === 1) {
      this.sendOps(this.outbox);
      this.outbox = [];
    }
    if (this.ws) this.ws.close();
    this.saveNow();
  }

  connect() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.setStatus('connecting');
    let ws;
    try {
      ws = new WebSocket(this.api.wsUrl(this.boardId, this.user.cid, this.user.name));
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    // An unreachable server can keep a socket "connecting" for a long time; give up early so a cached
    // board switches to offline mode right away.
    const connectTimer = setTimeout(() => { if (ws.readyState === 0) ws.close(); }, 4000);
    ws.onopen = () => clearTimeout(connectTimer);
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.onMessage(msg);
    };
    ws.onclose = (e) => {
      clearTimeout(connectTimer);
      if (this.ws !== ws) return;
      this.ws = null;
      this.onDisconnect();
      if (e.code === 4004) {
        if (this.meta.pending) {
          // Created while the server was offline: the server is back but does not have it yet.
          this.setStatus('offline');
          this.emit('pending');
          return;
        }
        this.emit('gone');
        return;
      }
      this.scheduleReconnect();
    };
    ws.onerror = () => {};
  }

  scheduleReconnect() {
    if (this.closed) return;
    this.setStatus('offline');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 10000);
  }

  retryNow() {
    this.retryDelay = 1000;
    if (!this.ws) this.connect();
  }

  onDisconnect() {
    // Whatever the server has not confirmed goes back to the front of the queue; resending is idempotent.
    if (this.inflight.size) {
      this.queue = [...this.inflight.values(), ...this.queue];
      this.inflight.clear();
    }
    this.outbox = [];
    this.peers.clear();
    this.emit('peers');
    this.setStatus('offline');
    this.scheduleSave();
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status');
  }

  get canEdit() {
    return this.loaded && !this.closed && !this.awaitingDecision && (this.status === 'online' || this.cacheEnabled);
  }

  get offlineCount() {
    return this.queue.filter((q) => q.offline).length + [...this.inflight.values()].filter((q) => q.offline).length;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // ------------------------------------------------------------ incoming

  onMessage(msg) {
    switch (msg.t) {
      case 'state': return this.onState(msg);
      case 'ops': return this.onRemoteOps(msg.ops);
      case 'ack': return this.onAck(msg.results);
      case 'peer-join':
        this.peers.set(msg.peer.cid, msg.peer);
        return this.emit('peers');
      case 'peer-leave':
        this.peers.delete(msg.cid);
        this.emit('cursor', { cid: msg.cid, gone: true });
        return this.emit('peers');
      case 'cursor': return this.emit('cursor', msg);
      case 'select': return this.emit('select', msg);
      case 'meta':
        this.meta = msg.meta;
        this.scheduleSave();
        return this.emit('meta');
      case 'deleted': return this.emit('gone');
      case 'shapes': return this.emit('shapes');
      case 'disk':
        this.disk = msg.disk;
        return this.emit('disk');
      default:
    }
  }

  onState(msg) {
    this.retryDelay = 1000;
    this.meta = msg.meta;
    this.seq = msg.seq;
    this.you = msg.you;
    if (msg.disk) { this.disk = msg.disk; this.emit('disk'); }
    this.peers = new Map((msg.peers || []).map((p) => [p.cid, p]));
    this.emit('peers');
    this.emit('meta');
    const server = new Map(msg.elements.map((el) => [el.id, el]));
    this.setStatus('online');
    const offline = this.offlineCount;
    if (offline > 0) {
      this.awaitingDecision = true;
      this.serverSnapshot = server;
      this.emit('status');
      this.emit('decision', { count: offline });
    } else {
      this.rebase(server);
    }
  }

  onRemoteOps(ops) {
    if (this.awaitingDecision) {
      for (const op of ops) applyOp(this.serverSnapshot, op);
      return;
    }
    const ids = new Set();
    for (const op of ops) {
      const id = op.k === 'add' ? op.el.id : op.id;
      applyOp(this.elements, op);
      if (this.pendingById.get(id)) this.reapplyPending(id);
      this.seq = Math.max(this.seq, op.seq || 0);
      ids.add(id);
    }
    this.emit('change', { ids, remote: true });
    this.scheduleSave();
  }

  onAck(results) {
    for (const r of results || []) {
      const entry = this.inflight.get(r.opId);
      if (!entry) continue;
      this.inflight.delete(r.opId);
      this.unmarkPending(entry.op);
      if (r.seq) this.seq = Math.max(this.seq, r.seq);
      if (r.error) {
        console.warn('[liro] op rejected by server', r, entry.op);
        // A refused new element must disappear locally too, or this client would drift from the server.
        if (entry.op.k === 'add' && this.elements.has(entry.op.el.id)) {
          this.elements.delete(entry.op.el.id);
          this.emit('change', { ids: new Set([entry.op.el.id]), remote: true });
        }
        this.emit('rejected', { reason: r.error });
      }
    }
    this.scheduleSave();
    this.emit('sync');
  }

  // ------------------------------------------------------------ pending bookkeeping

  opTarget(op) {
    return op.k === 'add' ? op.el.id : op.id;
  }

  markPending(op) {
    const id = this.opTarget(op);
    this.pendingById.set(id, (this.pendingById.get(id) || 0) + 1);
  }

  unmarkPending(op) {
    const id = this.opTarget(op);
    const n = (this.pendingById.get(id) || 0) - 1;
    if (n > 0) this.pendingById.set(id, n);
    else this.pendingById.delete(id);
  }

  recountPending() {
    this.pendingById.clear();
    for (const q of [...this.inflight.values(), ...this.queue]) this.markPending(q.op);
  }

  reapplyPending(id) {
    for (const q of [...this.inflight.values(), ...this.queue]) {
      if (this.opTarget(q.op) === id) applyOp(this.elements, q.op);
    }
  }

  // Server state + our not-yet-applied ops -> local state; then send the ops.
  rebase(server) {
    this.elements = server;
    for (const q of this.queue) applyOp(this.elements, q.op);
    this.recountPending();
    this.awaitingDecision = false;
    this.serverSnapshot = null;
    this.loaded = true;
    this.emit('reset');
    this.emit('status');
    this.flushQueue();
    this.scheduleSave();
    if (this.cacheEnabled) this.ensureMediaCached();
  }

  flushQueue() {
    if (this.status !== 'online' || !this.ws || this.awaitingDecision || !this.queue.length) return;
    const entries = this.queue;
    this.queue = [];
    for (const e of entries) {
      e.offline = false;
      this.inflight.set(e.op.opId, e);
    }
    this.sendOps(entries.map((e) => e.op));
  }

  sendOps(ops) {
    if (!this.ws || this.ws.readyState !== 1) return;
    for (let i = 0; i < ops.length; i += 500) {
      this.ws.send(JSON.stringify({ t: 'ops', ops: ops.slice(i, i + 500) }));
    }
  }

  // ------------------------------------------------------------ decision after offline work

  async resolveDecision(choice, onProgress) {
    if (!this.awaitingDecision) return null;
    const server = this.serverSnapshot;
    if (choice === 'push') {
      await this.uploadMissingMedia(this.boardId, this.queue.flatMap((q) => mediaOfOp(q.op)), onProgress);
      this.rebase(server);
      return null;
    }
    let created = null;
    if (choice === 'copy') {
      const elements = [...this.elements.values()];
      const board = await this.api.createBoard({ name: `${this.meta.name} (${t('офлайн-копия')})` });
      await this.uploadMissingMedia(board.id, elements.flatMap(mediaOfElement), onProgress, this.boardId);
      await this.api.postOps(board.id, elements.map((el) => ({ k: 'add', opId: uid('o'), el })), this.user.cid);
      created = board;
    }
    // 'discard' and 'copy' drop the local changes on this board.
    this.queue = [];
    this.inflight.clear();
    this.rebase(server);
    return created;
  }

  async uploadMissingMedia(targetBoardId, names, onProgress, sourceBoardId = this.boardId) {
    const unique = [...new Set(names)].filter((n) => MEDIA_NAME_RE.test(n));
    if (!unique.length) return;
    const { missing } = await this.api.mediaCheck(targetBoardId, unique);
    let done = 0;
    for (const name of missing) {
      onProgress && onProgress(done / missing.length, name);
      let ok = false;
      if (native.media) {
        ok = await native.media.upload(this.server.url, targetBoardId, this.server.serverId, sourceBoardId, name);
      }
      if (!ok && targetBoardId !== sourceBoardId) {
        // Copy straight from the source board on the server.
        try {
          const res = await fetch(this.api.mediaUrl(sourceBoardId, name));
          if (res.ok) {
            await this.api.uploadMedia(targetBoardId, name, await res.blob());
            ok = true;
          }
        } catch {}
      }
      if (!ok) console.warn(`[liro] media ${name} is not available locally and could not be uploaded`);
      done += 1;
    }
    onProgress && onProgress(1);
  }

  // ------------------------------------------------------------ local changes

  // Applies ops locally and sends or queues them. Returns false when editing is not possible.
  apply(ops) {
    if (!this.canEdit) return false;
    const online = this.status === 'online' && this.ws && this.ws.readyState === 1;
    const ids = new Set();
    for (const op of ops) {
      if (!op) continue;
      op.opId = uid('o');
      applyOp(this.elements, op);
      ids.add(this.opTarget(op));
      if (online) {
        this.inflight.set(op.opId, { op, offline: false });
        this.outbox.push(op);
        this.markPending(op);
      } else if (!this.server.local) {
        this.enqueueOffline(op);
      }
    }
    if (online && this.outbox.length && !this.outboxScheduled) {
      this.outboxScheduled = true;
      queueMicrotask(() => {
        this.outboxScheduled = false;
        const batch = this.outbox;
        this.outbox = [];
        this.sendOps(batch);
      });
    }
    this.emit('change', { ids, remote: false });
    this.scheduleSave();
    return true;
  }

  enqueueOffline(op) {
    const last = this.queue[this.queue.length - 1];
    // Collapse consecutive updates of the same element (e.g. a drag) into one queued op.
    if (last && last.offline && op.k === 'upd' && last.op.k === 'upd' && last.op.id === op.id) {
      Object.assign(last.op.set, op.set);
      return;
    }
    this.queue.push({ op, offline: true });
    this.markPending(op);
    this.emit('status');
  }

  sendCursor(x, y) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'cursor', x, y }));
  }

  sendSelection(ids) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ t: 'select', ids }));
  }

  // ------------------------------------------------------------ cache

  scheduleSave() {
    if (!this.cacheEnabled) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 400);
  }

  saveNow() {
    if (!this.cacheEnabled || !this.loaded) return;
    clearTimeout(this.saveTimer);
    native.cache.save(this.server.serverId, this.boardId, {
      meta: this.meta,
      seq: this.seq,
      elements: [...this.elements.values()],
      queue: [...this.inflight.values(), ...this.queue],
      server: { url: this.server.url, name: this.server.name },
      savedAt: Date.now(),
    });
  }

  async setCacheEnabled(on) {
    if (!native.cache) return;
    this.cacheEnabled = !!on;
    if (on) {
      this.saveNow();
      this.ensureMediaCached();
    } else {
      await native.cache.remove(this.server.serverId, this.boardId);
    }
    this.emit('status');
  }

  async ensureMediaCached() {
    if (!this.cacheEnabled || !native.media || this.mediaSyncRunning) return;
    this.mediaSyncRunning = true;
    try {
      const names = new Set([...this.elements.values()].flatMap(mediaOfElement).filter((n) => MEDIA_NAME_RE.test(n)));
      for (const name of names) {
        if (this.closed || this.status !== 'online') break;
        if (native.media.localUrl(this.server.serverId, this.boardId, name)) continue;
        await native.media.download(this.server.url, this.server.serverId, this.boardId, name);
      }
    } finally {
      this.mediaSyncRunning = false;
    }
  }

  // ------------------------------------------------------------ media

  mediaUrl(name) {
    if (!MEDIA_NAME_RE.test(name || '')) return '';
    if (native.media && (this.cacheEnabled || this.status !== 'online')) {
      const local = native.media.localUrl(this.server.serverId, this.boardId, name);
      if (local) return local;
    }
    return this.api.mediaUrl(this.boardId, name);
  }

  // False when the server is (nearly) out of disk space: only editing of existing elements is allowed.
  get canAdd() {
    return !(this.status === 'online' && this.disk && this.disk.level === 'full');
  }

  // Stores a dropped/pasted file: hashes it, keeps a local copy for cached boards, uploads when online.
  async addMediaFile(file, onProgress) {
    if (!this.canAdd) throw new Error(t('на сервере нет места'));
    const buffer = await file.arrayBuffer();
    const name = `${await sha256Hex(buffer)}.${mediaExt(file)}`;
    if (this.cacheEnabled && native.media) {
      await native.media.save(this.server.serverId, this.boardId, name, buffer);
    }
    if (this.status === 'online') {
      await this.api.uploadMedia(this.boardId, name, file, onProgress);
    } else if (!this.cacheEnabled) {
      throw new Error(t('Нет связи с сервером'));
    }
    return { name, mime: file.type || '', size: file.size, fileName: file.name || name };
  }
}
