import { native } from './native.js';
import { Home } from './home.js';
import { BoardView } from './board.js';
import { BoardSession } from './session.js';
import { Api } from './net.js';
import { uid, mediaOfElement } from './ops.js';
import { toast, progressDialog, modal } from './ui.js';
import { t, setLanguage, LANGUAGES } from './i18n.js';

const $ = (id) => document.getElementById(id);

class App {
  async init() {
    this.settings = (await native.getSettings()) || {};
    if (!this.settings.cid) {
      this.settings.cid = uid('c');
      this.saveSettings();
    }
    this.settings.cache = this.settings.cache || {};
    setLanguage(this.settings.lang);
    this.initLanguageSelect();
    this.views = new Map();
    this.home = new Home(this);
    this.board = new BoardView(this);
    this.path = []; // ancestors of the open board: [{ id, name }]
    $('btn-back').onclick = () => this.goBack();
    window.addEventListener('popstate', () => {
      if (!$('board').classList.contains('hidden')) this.showHome(false);
    });
    await this.home.start();
  }

  // Interface language: system default or an explicit choice; switching reloads the UI.
  initLanguageSelect() {
    const sel = $('lang-select');
    sel.replaceChildren(...[{ id: 'system', name: t('Как в системе') }, ...LANGUAGES].map((l) => Object.assign(document.createElement('option'), { value: l.id, textContent: l.name })));
    sel.value = this.settings.lang || 'system';
    sel.onchange = () => {
      this.settings.lang = sel.value === 'system' ? undefined : sel.value;
      this.saveSettings();
      setTimeout(() => location.reload(), 150);
    };
  }

  saveSettings() {
    native.setSettings(this.settings);
  }

  cacheKey(server, boardId) {
    return `${server.serverId}/${boardId}`;
  }

  isCached(server, boardId) {
    return !!(native.cache && this.settings.cache[this.cacheKey(server, boardId)]);
  }

  setCached(server, boardId, on) {
    const key = this.cacheKey(server, boardId);
    if (on) this.settings.cache[key] = true;
    else delete this.settings.cache[key];
    this.saveSettings();
  }

  user() {
    return { cid: this.settings.cid, name: this.settings.userName || t('Гость') };
  }

  // opts.from: the board we came from (opening a nested board); opts.path: explicit ancestor list.
  openBoard(server, meta, opts = {}) {
    if (opts.path) this.path = opts.path;
    else if (opts.from) this.path = [...this.path, opts.from];
    else this.path = [];
    this.board.close();
    const cached = this.isCached(server, meta.id) || !!meta.cached || !!server.local || !!meta.pending;
    const session = new BoardSession({ server, boardId: meta.id, meta, user: this.user(), cacheEnabled: cached });
    $('home').classList.add('hidden');
    $('board').classList.remove('hidden');
    document.title = `${meta.name} — Liro`;
    if (!native.isNative) history.pushState({ board: meta.id }, '', `#${meta.id}`);
    this.board.open(session);
    session.open();
    this.renderCrumbs();
    if (!this.path.length) this.resolveParents(server, session);
  }

  goBack() {
    if (!this.path.length) return this.showHome();
    const parent = this.path[this.path.length - 1];
    const server = this.board.session.server;
    this.openBoard(server, { id: parent.id, name: parent.name, cached: this.board.session.cacheEnabled }, { path: this.path.slice(0, -1) });
  }

  renderCrumbs() {
    const nav = $('crumbs');
    nav.replaceChildren();
    const server = this.board.session && this.board.session.server;
    this.path.forEach((p, i) => {
      const b = document.createElement('button');
      b.className = 'crumb';
      b.textContent = p.name || '…';
      b.onclick = () => this.openBoard(server, { id: p.id, name: p.name, cached: this.board.session.cacheEnabled }, { path: this.path.slice(0, i) });
      nav.append(b, Object.assign(document.createElement('span'), { className: 'crumb-sep', textContent: '/' }));
    });
    nav.classList.toggle('hidden', !this.path.length);
    $('btn-back').title = this.path.length ? t('Назад: {name}', { name: this.path[this.path.length - 1].name }) : t('К списку досок');
  }

  // A nested board opened directly (from the list or a link): rebuild its parent chain for the breadcrumbs.
  async resolveParents(server, session) {
    const metaOf = async (id) => {
      if (server.local || session.status !== 'online') {
        const data = native.cache ? await native.cache.load(server.serverId, id) : null;
        return data && data.meta;
      }
      try { return (await new Api(server.url).board(id)).meta; } catch { return null; }
    };
    const wait = () => new Promise((r) => setTimeout(r, 300));
    for (let i = 0; i < 20 && !session.meta.parentId && session.status === 'connecting'; i++) await wait();
    const chain = [];
    let parentId = session.meta.parentId;
    while (parentId && chain.length < 20) {
      const m = await metaOf(parentId);
      if (!m) break;
      chain.unshift({ id: m.id, name: m.name });
      parentId = m.parentId;
    }
    if (chain.length && this.board.session === session && !this.path.length) {
      this.path = chain;
      this.renderCrumbs();
    }
  }

  showHome(pushHistory = true) {
    this.board.close();
    $('board').classList.add('hidden');
    $('home').classList.remove('hidden');
    document.title = 'Liro';
    if (pushHistory && !native.isNative && location.hash) history.pushState({}, '', location.pathname);
    this.home.show();
  }

  // Downloads a board (state + media) into the local cache without opening it.
  async prefetchBoard(server, meta) {
    if (!native.cache) return;
    const existing = await native.cache.load(server.serverId, meta.id);
    const api = new Api(server.url);
    const snap = await api.board(meta.id);
    if (!existing || !(existing.queue || []).length) {
      await native.cache.save(server.serverId, meta.id, {
        meta: snap.meta, seq: snap.seq, elements: snap.elements, queue: [],
        server: { url: server.url, name: server.name }, savedAt: Date.now(),
      });
    }
    const names = [...new Set(snap.elements.flatMap(mediaOfElement))];
    for (const name of names) {
      if (!native.media.localUrl(server.serverId, meta.id, name)) {
        await native.media.download(server.url, server.serverId, meta.id, name);
      }
    }
  }

  // A board that exists only on this computer: in the local store, or (pending) for a server that is offline.
  async createLocalBoard(server, name, { pending = false, parentId = null } = {}) {
    const now = Date.now();
    const meta = { id: uid('b'), name, createdAt: now, updatedAt: now };
    if (pending) meta.pending = true;
    if (parentId) meta.parentId = parentId;
    await native.cache.save(server.serverId, meta.id, {
      meta, seq: 0, elements: [], queue: [], server: { url: server.url, name: server.name }, savedAt: now,
    });
    this.setCached(server, meta.id, true);
    return { ...meta, cached: true };
  }

  async renameCachedBoard(server, id, name) {
    const data = await native.cache.load(server.serverId, id);
    if (!data) return;
    data.meta = { ...data.meta, name, updatedAt: Date.now() };
    await native.cache.save(server.serverId, id, data);
  }

  // Ids of boards nested in a cached board (board-link elements), recursively.
  async cachedSubBoards(server, id, seen = new Set()) {
    if (seen.has(id)) return [];
    seen.add(id);
    const data = await native.cache.load(server.serverId, id);
    const out = [];
    for (const el of (data && data.elements) || []) {
      if (el.type === 'board' && el.boardId && !seen.has(el.boardId)) {
        out.push(el.boardId, ...(await this.cachedSubBoards(server, el.boardId, seen)));
      }
    }
    return out;
  }

  /**
   * Uploads a locally stored board (and its nested boards) to `target`, keeping the board ids.
   * from: LOCAL_SERVER or the board's own server (pending boards created offline).
   */
  async uploadBoard(from, meta, target, { keepLocal = false } = {}) {
    const api = new Api(target.url);
    const progress = progressDialog(t('Загрузка доски на сервер…'));
    try {
      const ids = [meta.id, ...(await this.cachedSubBoards(from, meta.id))];
      let first = null;
      for (const [i, id] of ids.entries()) {
        const data = await native.cache.load(from.serverId, id);
        if (!data) continue;
        progress.set(i / ids.length, data.meta.name);
        const created = await api.createBoard({ id, name: data.meta.name, parentId: data.meta.parentId || undefined });
        const elements = data.elements || [];
        const names = [...new Set(elements.flatMap(mediaOfElement))];
        for (const n of names) await native.media.upload(target.url, created.id, from.serverId, id, n);
        await api.postOps(created.id, elements.map((el) => ({ k: 'add', opId: uid('o'), el })), this.settings.cid);
        if (!first) first = created;
        // The board now lives on the server: keep it cached there (moving media files along).
        const snap = await api.board(created.id);
        await native.cache.save(target.serverId, created.id, {
          meta: snap.meta, seq: snap.seq, elements: snap.elements, queue: [],
          server: { url: target.url, name: target.name }, savedAt: Date.now(),
        });
        this.setCached(target, created.id, true);
        for (const n of names) {
          if (!native.media.localUrl(target.serverId, created.id, n)) await native.media.download(target.url, target.serverId, created.id, n);
        }
        if (from.serverId !== target.serverId && !keepLocal) {
          await native.cache.remove(from.serverId, id);
          this.setCached(from, id, false);
        }
      }
      toast(t('Доска «{name}» загружена на сервер', { name: first ? first.name : meta.name }));
      return first;
    } catch (e) {
      toast(`${t('Не удалось загрузить доску')}: ${e.message}`, { error: true });
      return null;
    } finally {
      progress.close();
    }
  }

  // Icons, shapes and fonts added while working without a server: offer to put them on `server`
  // (once per server per app run, or whenever new local ones appear).
  async offerAssetUpload(server) {
    if (!native.assets || server.local) return;
    this.assetOffers = this.assetOffers || new Map();
    const api = new Api(server.url);
    const svgName = (n) => { const f = n.replace(/[^\w\- ().а-яё]+/gi, '_'); return f.toLowerCase().endsWith('.svg') ? f : `${f}.svg`; };
    const fontName = (n) => n.replace(/[^\w.\- ()]+/g, '_');
    const missing = [];
    try {
      const [icons, shapes, fonts] = await Promise.all([api.icons(), api.shapes(), api.fonts()]);
      const have = {
        icons: new Set(icons.map((x) => x.id)),
        shapes: new Set(shapes.map((x) => x.id)),
        fonts: new Set(fonts.map((f) => decodeURIComponent(f.url.split('/').pop()))),
      };
      for (const kind of ['icons', 'shapes', 'fonts']) {
        for (const it of await native.assets.list(kind)) {
          const remote = kind === 'fonts' ? fontName(it.name) : svgName(it.name);
          if (!have[kind].has(remote)) missing.push({ kind, name: it.name });
        }
      }
    } catch {
      return;
    }
    const sig = missing.map((m) => `${m.kind}/${m.name}`).sort().join('|');
    if (!missing.length || this.assetOffers.get(server.serverId) === sig) return;
    this.assetOffers.set(server.serverId, sig);
    const count = (k) => missing.filter((m) => m.kind === k).length;
    const ok = await modal({
      title: t('Загрузить локальные ресурсы на сервер?'),
      text: t('На этом устройстве есть ресурсы, которых нет на сервере «{name}»: иконки — {i}, фигуры — {s}, шрифты — {f}. Загрузить их, чтобы они были доступны всем?',
        { name: server.name || server.url, i: count('icons'), s: count('shapes'), f: count('fonts') }),
      buttons: [{ label: t('Не сейчас'), value: false }, { label: t('Загрузить'), value: true, primary: true }],
    });
    if (!ok) return;
    let done = 0;
    for (const m of missing) {
      try {
        const blob = await native.assets.read(m.kind, m.name);
        const res = await fetch(`${server.url}/api/${m.kind}/${encodeURIComponent(m.name)}`, { method: 'PUT', body: blob });
        if (res.ok) done += 1;
      } catch {}
    }
    toast(t('Загружено на сервер: {n} из {total}', { n: done, total: missing.length }));
  }

  // Re-creates a board that only exists in the local cache as a new board on the server.
  async restoreFromCache(server, meta) {
    const cached = await native.cache.load(server.serverId, meta.id);
    if (!cached) return null;
    return this.restoreElements(server, meta.id, cached.meta.name || meta.name, cached.elements || []);
  }

  restoreFromSession(session) {
    return this.restoreElements(session.server, session.boardId, session.meta.name, [...session.elements.values()]);
  }

  async restoreElements(server, oldBoardId, name, elements) {
    const api = new Api(server.url);
    const progress = progressDialog(t('Восстановление доски…'));
    try {
      const board = await api.createBoard({ name: `${name} (${t('восстановлена')})` });
      const names = [...new Set(elements.flatMap(mediaOfElement))];
      let done = 0;
      for (const n of names) {
        if (native.media) await native.media.upload(server.url, board.id, server.serverId, oldBoardId, n);
        progress.set(++done / Math.max(names.length, 1), t('Загрузка файлов…'));
      }
      await api.postOps(board.id, elements.map((el) => ({ k: 'add', opId: uid('o'), el })), this.settings.cid);
      if (native.cache) {
        await native.cache.remove(server.serverId, oldBoardId);
        this.setCached(server, oldBoardId, false);
      }
      toast(t('Доска восстановлена как «{name}»', { name: board.name }));
      return board;
    } catch (e) {
      toast(`${t('Не удалось восстановить')}: ${e.message}`, { error: true });
      return null;
    } finally {
      progress.close();
    }
  }
}

const app = new App();
app.init().then(async () => {
  // Deep link for the browser version: http://liro.loc:1919/#<boardId>
  if (!native.isNative && location.hash.length > 1) {
    const id = decodeURIComponent(location.hash.slice(1));
    try {
      const snap = await new Api(location.origin).board(id);
      app.openBoard(app.home.origin || app.home.current, snap.meta);
    } catch {}
  }
});
window.liroApp = app;
