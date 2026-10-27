// Start screen: server selection (desktop client) and the board list.
import { native } from './native.js';
import { Api, normalizeServerUrl } from './net.js';
import { h, toast, modal, promptText, confirmDialog, timeAgo } from './ui.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { downloadUrl, pickBackupFile, readManifest, confirmRestore, restoreToServer, summaryText, buildLocalBackup, restoreLocally } from './backup.js';
import { dropdown } from './ui.js';
import { backupFileName } from './tar.js';

const $ = (id) => document.getElementById(id);

// Boards kept only on this computer (desktop client), without any server.
export const LOCAL_SERVER = { serverId: 'local', url: '', local: true, online: true };

export class Home {
  constructor(app) {
    this.app = app;
    this.servers = []; // { url, serverId, name, online }
    this.current = null;
    this.boards = [];
    this.offline = false;

    $('btn-discover').onclick = () => this.discover(true);
    $('btn-refresh').onclick = () => this.loadBoards();
    $('btn-new-board').onclick = () => this.createBoard();
    $('btn-backup').onclick = () => this.backupMenu();
    $('add-server').onsubmit = (e) => {
      e.preventDefault();
      this.addServer($('server-address').value);
    };
    $('user-name').value = app.settings.userName || '';
    $('user-name').onchange = () => {
      app.settings.userName = $('user-name').value.trim();
      app.saveSettings();
    };
  }

  async start() {
    this.servers = (this.app.settings.servers || []).map((s) => ({ ...s, online: undefined }));
    if (!native.isNative) {
      // Opened from a Liro server in a browser: that server is always in the list (no network discovery here).
      $('btn-discover').classList.add('hidden');
      const url = location.origin;
      try {
        const info = await new Api(url).info();
        this.origin = this.upsertServer({ url, serverId: info.serverId, name: info.name, online: true });
        this.persistServers();
      } catch {}
    }
    const last = this.app.settings.lastServer === 'local' ? LOCAL_SERVER
      : this.servers.find((s) => s.serverId === this.app.settings.lastServer) || this.servers[0] || LOCAL_SERVER;
    this.renderServers();
    this.select(last);
    this.probeAll();
    if (native.isNative) this.discover(false);
  }

  show() {
    if (this.current) this.loadBoards();
  }

  persistServers() {
    this.app.settings.servers = this.servers.map(({ url, serverId, name }) => ({ url, serverId, name }));
    this.app.saveSettings();
  }

  upsertServer(s) {
    const existing = this.servers.find((x) => x.serverId === s.serverId);
    if (existing) {
      Object.assign(existing, s);
      return existing;
    }
    this.servers.push(s);
    return s;
  }

  async probeAll() {
    await Promise.all(this.servers.map(async (s) => {
      try {
        const info = await new Api(s.url).info();
        s.online = info.serverId === s.serverId;
        if (s.online) s.name = info.name;
      } catch {
        s.online = false;
      }
    }));
    this.renderServers();
  }

  async discover(manual) {
    const btn = $('btn-discover');
    btn.disabled = true;
    btn.textContent = t('Поиск…');
    try {
      const found = await native.discover();
      let added = 0;
      for (const f of found) {
        const known = this.servers.some((s) => s.serverId === f.serverId);
        this.upsertServer({ url: f.url, serverId: f.serverId, name: f.name, online: true });
        if (!known) added += 1;
      }
      this.persistServers();
      this.renderServers();
      if (manual) {
        toast(found.length
          ? `${t('Найдено серверов: {n}', { n: found.length })}${added ? ` (${t('новых: {n}', { n: added })})` : ''}`
          : t('Серверы Liro в сети не найдены'));
      }
    } catch (e) {
      if (manual) toast(`${t('Ошибка поиска')}: ${e.message}`, { error: true });
    } finally {
      btn.disabled = false;
      btn.textContent = t('Найти в сети');
    }
  }

  async addServer(address) {
    let url;
    try {
      url = normalizeServerUrl(address);
    } catch {
      return toast(t('Неверный адрес'), { error: true });
    }
    if (!url) return;
    let info;
    try {
      info = await new Api(url).info();
    } catch {
      // liro.loc may not be resolvable by the OS; ask discovery for a server announcing that name.
      const host = new URL(url).hostname.toLowerCase();
      const found = (await native.discover()).find((f) => f.hostname === host || f.name.toLowerCase() === host);
      if (!found) return toast(t('Сервер {url} не отвечает', { url }), { error: true });
      url = found.url;
      info = { serverId: found.serverId, name: found.name };
    }
    $('server-address').value = '';
    const s = this.upsertServer({ url, serverId: info.serverId, name: info.name, online: true });
    this.persistServers();
    this.renderServers();
    this.select(s);
  }

  removeServer(s) {
    this.servers = this.servers.filter((x) => x !== s);
    this.persistServers();
    if (this.current === s) this.select(LOCAL_SERVER);
    this.renderServers();
  }

  serverName(s) {
    return s.local ? t('Локальные доски') : s.name || s.url;
  }

  renderServers() {
    const list = $('server-list');
    list.replaceChildren();
    const item = (s) => h('div', {
      class: `server-item${this.current && this.current.serverId === s.serverId ? ' active' : ''}`,
      onclick: () => this.select(s),
    },
    s.local ? h('span', { class: 'local-ico', html: icon('laptop', 16) })
      : h('span', { class: `dot${s.online ? ' on' : ''}`, title: s.online ? t('В сети') : s.online === false ? t('Недоступен') : '' }),
    h('div', { class: 'meta' }, h('b', {}, this.serverName(s)), h('small', {}, s.local ? (native.isNative ? t('На этом компьютере, без сервера') : t('В этом браузере, без сервера')) : s.url.replace(/^https?:\/\//, ''))),
    s.local ? null : h('button', { class: 'x', title: t('Забыть сервер'), onclick: (e) => { e.stopPropagation(); this.removeServer(s); } }, '✕'));
    if (native.cache) list.append(item(LOCAL_SERVER));
    if (!this.servers.length) {
      list.append(h('div', { class: 'empty', style: { padding: '10px' } }, t('Нет серверов. Нажмите «Найти в сети» или введите адрес.')));
    }
    for (const s of this.servers) list.append(item(s));
  }

  select(s) {
    this.current = s;
    this.app.settings.lastServer = s.serverId;
    this.app.saveSettings();
    this.renderServers();
    this.loadBoards();
  }

  async loadBoards() {
    const s = this.current;
    if (!s) return this.renderBoards();
    $('boards-title').textContent = `${t('Доски')} — ${this.serverName(s)}`;
    const state = $('server-state');
    if (s.local) {
      const cached = await native.cache.list('local');
      if (this.current !== s) return;
      this.offline = false;
      this.boards = cached.filter((c) => !c.meta.parentId).map((c) => ({ ...c.meta, elementCount: c.elementCount, cached: true, local: true }));
      state.className = 'badge';
      state.textContent = t('на этом компьютере');
      $('btn-new-board').disabled = false;
      return this.renderBoards();
    }
    state.className = 'badge';
    state.textContent = t('подключение…');
    let boards = null;
    try {
      boards = await new Api(s.url).boards();
      s.online = true;
    } catch {
      s.online = false;
    }
    if (this.current !== s) return;
    const cached = native.cache ? (await native.cache.list(s.serverId)).filter((c) => !c.meta.parentId) : [];
    const cachedIds = new Set(cached.map((c) => c.meta.id));
    if (boards) {
      this.offline = false;
      this.boards = boards.map((b) => ({ ...b, cached: cachedIds.has(b.id) || this.app.isCached(s, b.id) }));
      // Boards that exist only in the local cache: created while the server was offline (pending),
      // or deleted on the server meanwhile.
      for (const c of cached) {
        if (boards.some((b) => b.id === c.meta.id)) continue;
        this.boards.push({ ...c.meta, cached: true, localOnly: !c.meta.pending, queue: c.queueLength, elementCount: c.elementCount });
      }
      state.className = 'badge ok';
      state.textContent = t('в сети');
      this.app.offerAssetUpload(s);
    } else {
      this.offline = true;
      this.boards = cached.map((c) => ({ ...c.meta, elementCount: c.elementCount, cached: true, queue: c.queueLength }));
      state.className = 'badge err';
      state.textContent = cached.length ? t('нет связи — доступны кешированные доски') : t('нет связи');
    }
    // Offline, new boards are created locally and offered for upload when the server is back.
    $('btn-new-board').disabled = this.offline && !native.cache;
    this.renderServers();
    this.renderBoards();
  }

  renderBoards() {
    const grid = $('board-list');
    grid.replaceChildren();
    if (!this.current) {
      grid.append(h('div', { class: 'empty' }, t('Выберите сервер слева.')));
      return;
    }
    if (!this.boards.length) {
      grid.append(h('div', { class: 'empty' }, this.offline ? t('Сервер недоступен, кешированных досок нет.') : t('Досок пока нет. Создайте первую!')));
      return;
    }
    for (const b of this.boards) {
      const actions = h('div', { class: 'actions', onclick: (e) => e.stopPropagation() });
      if (native.cache && !b.local && !b.pending) {
        const cb = h('input', { type: 'checkbox' });
        cb.checked = !!b.cached;
        cb.onchange = () => this.toggleCache(b, cb);
        actions.append(h('label', { class: 'toggle', title: t('Хранить локально и работать без сети') }, cb, h('span', {}, t('Кешировать'))));
      }
      actions.append(h('span', { class: 'spacer' }));
      if (b.local) {
        actions.append(
          h('button', { class: 'btn', onclick: () => this.moveToServer(b) }, t('На сервер…')),
          h('button', { class: 'btn', onclick: () => this.rename(b) }, t('Переименовать')),
          h('button', { class: 'btn danger', html: icon('trash', 14), title: t('Удалить'), onclick: () => this.remove(b) }),
        );
      } else if (b.pending) {
        if (!this.offline) actions.append(h('button', { class: 'btn primary', onclick: () => this.uploadPending(b) }, t('Загрузить на сервер')));
      } else if (!this.offline && !b.localOnly) {
        actions.append(
          h('button', { class: 'btn', onclick: () => this.rename(b) }, t('Переименовать')),
          h('button', { class: 'btn danger', html: icon('trash', 14), title: t('Удалить'), onclick: () => this.remove(b) }),
        );
      }
      const notes = [];
      if (b.elementCount !== undefined) notes.push(t('{n} эл.', { n: b.elementCount }));
      if (b.updatedAt) notes.push(timeAgo(b.updatedAt));
      if (b.queue && !b.pending) notes.push(t('несинхр. изменений: {n}', { n: b.queue }));
      if (b.pending) notes.push(t('ещё не загружена на сервер'));
      if (b.localOnly) notes.push(t('нет на сервере'));
      grid.append(h('div', { class: `board-card${b.pending ? ' pending' : ''}`, onclick: () => this.open(b) },
        h('div', { class: 'thumb', html: icon(b.local ? 'laptop' : 'frame', 40) }),
        h('div', { class: 'info' }, h('div', { class: 'title' }, b.name), h('small', {}, notes.join(' · '))),
        actions));
    }
  }

  async toggleCache(b, cb) {
    if (!cb.checked && b.queue) {
      const ok = await confirmDialog(t('Отключить кеш?'), t('На доске есть {n} несинхронизированных изменений. Они будут потеряны.', { n: b.queue }), t('Отключить'));
      if (!ok) { cb.checked = true; return; }
    }
    b.cached = cb.checked;
    this.app.setCached(this.current, b.id, cb.checked);
    if (cb.checked) {
      // Download the board now so it is available offline right away.
      try {
        await this.app.prefetchBoard(this.current, b);
        toast(t('«{name}» сохранена локально', { name: b.name }));
      } catch (e) {
        toast(`${t('Не удалось закешировать')}: ${e.message}`, { error: true });
      }
    } else {
      await native.cache.remove(this.current.serverId, b.id);
      if (this.offline || b.localOnly) this.loadBoards();
    }
  }

  async createBoard() {
    const name = await promptText(t('Новая доска'), t('Новая доска'), t('Создать'));
    if (!name) return;
    const s = this.current;
    try {
      if (s.local || this.offline) {
        const meta = await this.app.createLocalBoard(s, name, { pending: !s.local });
        if (!s.local) toast(t('Сервер недоступен: доска создана локально и будет предложена к загрузке, когда он появится'));
        return this.app.openBoard(s, meta);
      }
      const b = await new Api(s.url).createBoard({ name });
      this.open(b);
    } catch (e) {
      toast(`${t('Ошибка')}: ${e.message}`, { error: true });
    }
  }

  async rename(b) {
    const name = await promptText(t('Переименовать доску'), b.name, t('Сохранить'));
    if (!name) return;
    try {
      if (b.local) await this.app.renameCachedBoard(LOCAL_SERVER, b.id, name);
      else await new Api(this.current.url).renameBoard(b.id, name);
      this.loadBoards();
    } catch (e) {
      toast(`${t('Ошибка')}: ${e.message}`, { error: true });
    }
  }

  async remove(b) {
    const text = b.local ? t('Доска «{name}» будет удалена с этого компьютера.', { name: b.name })
      : t('Доска «{name}» будет удалена с сервера для всех пользователей.', { name: b.name });
    if (!(await confirmDialog(t('Удалить доску?'), text))) return;
    try {
      if (!b.local) await new Api(this.current.url).deleteBoard(b.id);
      if (native.cache) await native.cache.remove(this.current.serverId, b.id);
      this.app.setCached(this.current, b.id, false);
      this.loadBoards();
    } catch (e) {
      toast(`${t('Ошибка')}: ${e.message}`, { error: true });
    }
  }

  // Backup of the selected place: the whole server, or the local boards with settings.
  backupMenu() {
    const s = this.current;
    if (!s) return;
    if (s.local) {
      return dropdown($('btn-backup'), [
        { label: t('Сохранить бэкап локальных досок и настроек'), onClick: () => buildLocalBackup(this.app, { type: 'local', serverId: 'local', title: t('Локальные доски') }) },
        { label: t('Восстановить из бэкапа…'), onClick: () => this.restore() },
      ]);
    }
    dropdown($('btn-backup'), [
      { label: t('Сохранить бэкап сервера (все доски и файлы)'), disabled: this.offline, onClick: () => downloadUrl(`${s.url}/api/backup`) },
      { label: t('Восстановить из бэкапа…'), disabled: this.offline, onClick: () => this.restore() },
    ]);
  }

  async restore() {
    const s = this.current;
    const file = await pickBackupFile();
    if (!file) return;
    try {
      const manifest = await readManifest(file);
      const choice = await confirmRestore(manifest, this.serverName(s));
      if (!choice) return;
      const summary = s.local
        ? await restoreLocally(this.app, file, { replace: choice.replace })
        : (await restoreToServer(s.url, file, choice.replace)).summary;
      toast(summaryText(summary), { ms: 6000 });
      this.loadBoards();
    } catch (e) {
      toast(`${t('Не удалось восстановить')}: ${e.message}`, { error: true });
    }
  }

  // Local board -> a server chosen from the known ones.
  async moveToServer(b) {
    const online = [];
    await Promise.all(this.servers.map(async (s) => {
      try { if ((await new Api(s.url).info(1500)).serverId === s.serverId) online.push(s); } catch {}
    }));
    if (!online.length) return toast(t('Нет доступных серверов'), { error: true });
    const select = h('select', { class: 'wide' }, online.map((s) => h('option', { value: s.serverId }, s.name || s.url)));
    const keep = h('input', { type: 'checkbox' });
    const target = await modal({
      title: t('Перенести доску на сервер'),
      text: t('Доска «{name}» и все её файлы будут загружены на выбранный сервер.', { name: b.name }),
      body: h('div', { class: 'col' }, select, h('label', { class: 'toggle' }, keep, h('span', {}, t('Оставить копию на этом компьютере')))),
      buttons: [{ label: t('Отмена'), value: null }, { label: t('Перенести'), value: () => online.find((s) => s.serverId === select.value), primary: true }],
    });
    if (!target) return;
    const created = await this.app.uploadBoard(LOCAL_SERVER, b, target, { keepLocal: keep.checked });
    if (created) {
      toast(t('Доска перенесена на сервер «{name}»', { name: target.name || target.url }));
      this.loadBoards();
    }
  }

  // Board created while the server was offline -> upload it with the same id.
  async uploadPending(b) {
    const created = await this.app.uploadBoard(this.current, b, this.current, { keepId: true });
    if (created) this.loadBoards();
  }

  open(b) {
    if (this.offline && !b.cached) return toast(t('Сервер недоступен'), { error: true });
    if (b.pending && !this.offline) {
      return modal({
        title: t('Доска ещё не на сервере'),
        text: t('Эта доска создана, пока сервер был недоступен. Загрузить её на сервер сейчас?'),
        buttons: [
          { label: t('Открыть локально'), value: 'open' },
          { label: t('Загрузить на сервер'), value: 'upload', primary: true },
        ],
      }).then(async (v) => {
        if (v === 'upload') {
          const created = await this.app.uploadBoard(this.current, b, this.current, { keepId: true });
          if (created) this.app.openBoard(this.current, created);
        } else if (v === 'open') {
          this.app.openBoard(this.current, b);
        }
      });
    }
    if (b.localOnly) {
      return modal({
        title: t('Доски нет на сервере'),
        text: t('Эта доска есть только в локальном кеше (на сервере её удалили). Можно восстановить её на сервере как новую доску.'),
        buttons: [
          { label: t('Отмена'), value: null },
          { label: t('Удалить из кеша'), value: 'drop', danger: true },
          { label: t('Восстановить на сервере'), value: 'restore', primary: true },
        ],
      }).then(async (v) => {
        if (v === 'drop') {
          await native.cache.remove(this.current.serverId, b.id);
          this.app.setCached(this.current, b.id, false);
          this.loadBoards();
        } else if (v === 'restore') {
          const created = await this.app.restoreFromCache(this.current, b);
          if (created) this.loadBoards();
        }
      });
    }
    this.app.openBoard(this.current, b);
  }
}
