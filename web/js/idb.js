// Browser storage for the parts the desktop client keeps on disk: cached and local boards, their media,
// and locally added assets (icons, shapes, fonts). Same interface as the Electron bridge (preload.js).
const DB_NAME = 'liro';
let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        for (const s of ['boards', 'media', 'assets']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

const reqP = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

// Reads resolve with the request result; writes resolve when the transaction is committed.
async function read(store, fn) {
  const s = (await db()).transaction(store, 'readonly').objectStore(store);
  return fn(s);
}

async function write(store, fn) {
  const t = (await db()).transaction(store, 'readwrite');
  fn(t.objectStore(store));
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function getAll(store, prefix) {
  return read(store, async (s) => {
    const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
    const [keys, values] = await Promise.all([reqP(s.getAllKeys(range)), reqP(s.getAll(range))]);
    return keys.map((k, i) => [k, values[i]]);
  });
}

// Object URLs of media blobs, so that mediaUrl() can answer synchronously.
const urls = new Map();
const mediaKey = (serverId, boardId, name) => `${serverId}/${boardId}/${name}`;

function remember(key, blob) {
  if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob));
  return urls.get(key);
}

export const idbBridge = {
  cache: {
    async load(serverId, boardId) {
      const v = await read('boards', (s) => reqP(s.get(`${serverId}/${boardId}`)));
      return v ? structuredClone(v) : null;
    },
    async save(serverId, boardId, data) {
      await write('boards', (s) => s.put(structuredClone(data), `${serverId}/${boardId}`));
      return true;
    },
    async remove(serverId, boardId) {
      await write('boards', (s) => s.delete(`${serverId}/${boardId}`));
      const media = await getAll('media', `${serverId}/${boardId}/`);
      await write('media', (s) => { for (const [k] of media) s.delete(k); });
      for (const [k] of media) { if (urls.has(k)) { URL.revokeObjectURL(urls.get(k)); urls.delete(k); } }
      return true;
    },
    async list(serverId) {
      const rows = await getAll('boards', `${serverId}/`);
      return rows.filter(([, d]) => d && d.meta).map(([, d]) => ({
        meta: d.meta,
        elementCount: (d.elements || []).length,
        queueLength: (d.queue || []).filter((q) => q.offline).length,
        savedAt: d.savedAt,
      }));
    },
  },
  media: {
    localUrl(serverId, boardId, name) {
      return urls.get(mediaKey(serverId, boardId, name)) || null;
    },
    // Loads a board's stored media into object URLs (called before the board is drawn).
    async prepare(serverId, boardId) {
      for (const [k, blob] of await getAll('media', `${serverId}/${boardId}/`)) remember(k, blob);
    },
    async save(serverId, boardId, name, buffer) {
      const blob = buffer instanceof Blob ? buffer : new Blob([buffer]);
      const key = mediaKey(serverId, boardId, name);
      await write('media', (s) => s.put(blob, key));
      return remember(key, blob);
    },
    async download(serverUrl, serverId, boardId, name) {
      try {
        const res = await fetch(`${serverUrl}/api/boards/${boardId}/media/${name}`);
        if (!res.ok) return null;
        return this.save(serverId, boardId, name, await res.blob());
      } catch {
        return null;
      }
    },
    async read(serverId, boardId, name) {
      return read('media', (s) => reqP(s.get(mediaKey(serverId, boardId, name))));
    },
    async upload(serverUrl, targetBoardId, serverId, sourceBoardId, name) {
      const blob = await this.read(serverId, sourceBoardId, name);
      if (!blob) return false;
      const res = await fetch(`${serverUrl}/api/boards/${targetBoardId}/media/${name}`, { method: 'PUT', body: blob });
      return res.ok;
    },
  },
  // Locally added assets (when working without a server): kind = 'icons' | 'shapes' | 'fonts'.
  assets: {
    async list(kind) {
      return (await getAll('assets', `${kind}/`)).map(([k, blob]) => ({ name: k.slice(kind.length + 1), url: remember(`asset:${k}`, blob), size: blob.size }));
    },
    async save(kind, name, buffer) {
      const blob = buffer instanceof Blob ? buffer : new Blob([buffer]);
      await write('assets', (s) => s.put(blob, `${kind}/${name}`));
      urls.delete(`asset:${kind}/${name}`);
      return remember(`asset:${kind}/${name}`, blob);
    },
    async read(kind, name) {
      return read('assets', (s) => reqP(s.get(`${kind}/${name}`)));
    },
    async remove(kind, name) {
      await write('assets', (s) => s.delete(`${kind}/${name}`));
    },
  },
};
