// Nested boards: a tile on the board (coloured vector tile with an icon) that opens a child board.
// Child boards are not shown in the global board list; they are reached through their parent.
import { h, toast, promptText } from './ui.js';
import { icon } from './icons.js';
import { t } from './i18n.js';
import { withAlpha } from './colorpicker.js';
import { native } from './native.js';
import { MEDIA_NAME_RE } from './ops.js';

let iconList = null;

export async function boardIcons() {
  if (!iconList) {
    try {
      iconList = await (await fetch('icons/board/index.json')).json();
    } catch {
      iconList = ['folder'];
    }
  }
  return iconList;
}

export function pickFiles(accept, multiple = true) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple });
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

export const iconUrl = (name) => `icons/board/${encodeURIComponent(name || 'folder')}.svg`;

export const subBoardMethods = {
  // Icon of a tile: an uploaded SVG copied into the board's media, or one of the built-in icons.
  tileIconUrl(el) {
    return el.iconSrc && MEDIA_NAME_RE.test(el.iconSrc) ? this.session.mediaUrl(el.iconSrc) : iconUrl(el.icon);
  },

  draw_board(el, node) {
    const icoUrl = this.tileIconUrl(el);
    const key = JSON.stringify([el.name, icoUrl, el.fill, el.fo, el.ic, el.w, el.h]);
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    const size = Math.min(el.w, el.h);
    node.replaceChildren(
      h('div', { class: 'bd-tile', style: { background: withAlpha(el.fill || '#4262ff', el.fo ?? 1), borderRadius: `${size * 0.22}px` } },
        h('div', { class: 'bd-icon', style: {
          background: el.ic || '#ffffff',
          maskImage: `url("${icoUrl}")`, webkitMaskImage: `url("${icoUrl}")`,
          width: `${size * 0.5}px`, height: `${size * 0.5}px`,
        } })),
      h('div', { class: 'bd-name', style: { fontSize: `${Math.max(12, size * 0.11)}px` } }, el.name || t('Доска')),
    );
  },

  // Creates a child board (on the server, or locally when there is no server connection) and its tile.
  async createSubBoard(at) {
    const s = this.session;
    if (!s.canEdit) return this.readOnlyHint();
    const name = await promptText(t('Новая вложенная доска'), t('Новая доска'), t('Создать'));
    if (!name) return;
    let meta;
    try {
      if (s.status === 'online') {
        meta = await s.api.createBoard({ name, parentId: s.boardId });
        if (s.cacheEnabled) this.app.setCached(s.server, meta.id, true);
      } else {
        meta = await this.app.createLocalBoard(s.server, name, { pending: !s.server.local, parentId: s.boardId });
      }
    } catch (err) {
      return toast(`${t('Не удалось создать доску')}: ${err.message}`, { error: true });
    }
    const size = 140;
    this.addElement({
      type: 'board', boardId: meta.id, name, icon: 'folder', fill: '#4262ff', fo: 1, ic: '#ffffff',
      x: Math.round(at.x - size / 2), y: Math.round(at.y - size / 2), w: size, h: size,
    });
    this.setTool('select');
  },

  openSubBoard(el) {
    const s = this.session;
    if (!el.boardId) return;
    if (s.cacheEnabled && !s.server.local) this.app.setCached(s.server, el.boardId, true);
    this.app.openBoard(s.server, { id: el.boardId, name: el.name, cached: s.cacheEnabled }, { from: { id: s.boardId, name: s.meta.name } });
  },

  async renameSubBoard(el) {
    const name = await promptText(t('Название доски'), el.name || '', t('Сохранить'));
    if (!name) return;
    this.do([{ k: 'upd', id: el.id, set: { name } }]);
    const s = this.session;
    try {
      if (s.server.local) await this.app.renameCachedBoard(s.server, el.boardId, name);
      else if (s.status === 'online') await s.api.renameBoard(el.boardId, name);
    } catch {}
  },

  // Uploaded icons: from the server when connected, otherwise those stored on this computer/browser.
  async customIcons() {
    const s = this.session;
    const out = [];
    if (s.status === 'online' && !s.server.local) {
      try {
        for (const it of await s.api.icons()) out.push({ id: `srv:${it.id}`, name: it.name, url: `${s.server.url}${it.url}` });
      } catch {}
    }
    if (native.assets) {
      for (const it of await native.assets.list('icons')) {
        if (!out.some((o) => o.name.toLowerCase() === it.name.replace(/\.svg$/i, '').replace(/[-_]+/g, ' ').toLowerCase())) {
          out.push({ id: `loc:${it.name}`, name: it.name.replace(/\.svg$/i, ''), url: it.url });
        }
      }
    }
    return out;
  },

  async uploadIcon() {
    const files = await pickFiles('.svg,image/svg+xml');
    const s = this.session;
    for (const file of files) {
      try {
        if (s.status === 'online' && !s.server.local) {
          const res = await fetch(`${s.server.url}/api/icons/${encodeURIComponent(file.name)}`, { method: 'PUT', body: file });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        } else if (native.assets) {
          await native.assets.save('icons', file.name, await file.arrayBuffer());
        }
      } catch (err) {
        toast(`${t('Не удалось загрузить иконку')}: ${err.message}`, { error: true });
      }
    }
  },

  // Built-in icon -> { icon }; uploaded icon -> copied into the board's media -> { iconSrc }.
  async applyIcon(el, pick) {
    const isBoard = (x) => x.type === 'board';
    if (!pick.url) return this.setProp(isBoard, { icon: pick.id, iconSrc: null });
    try {
      const blob = await (await fetch(pick.url)).blob();
      const info = await this.session.addMediaFile(new File([blob], `${pick.name}.svg`, { type: 'image/svg+xml' }));
      this.setProp(isBoard, { iconSrc: info.name, icon: null });
    } catch (err) {
      toast(`${t('Не удалось применить иконку')}: ${err.message}`, { error: true });
    }
  },

  async openIconPicker(anchor, onPick, current) {
    this.closePalette();
    const icons = await boardIcons();
    let custom = await this.customIcons();
    const r = anchor.getBoundingClientRect();
    const search = h('input', { type: 'search', placeholder: t('Поиск иконок') });
    const grid = h('div', { class: 'icon-grid' });
    const tile = (id, title, url, pick) => h('button', {
      class: id === current ? 'active' : '', title,
      onclick: () => { onPick(pick); this.closePalette(); },
    }, h('span', { class: 'ip-icon', style: { maskImage: `url("${url}")`, webkitMaskImage: `url("${url}")` } }));
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const own = custom.filter((c) => !q || c.name.toLowerCase().includes(q));
      grid.replaceChildren(
        ...own.map((c) => tile(c.id, c.name, c.url, { id: c.id, name: c.name, url: c.url })),
        ...icons.filter((n) => !q || n.includes(q)).map((n) => tile(n, n, iconUrl(n), { id: n })),
      );
    };
    search.oninput = render;
    search.onkeydown = (e) => e.stopPropagation();
    const upload = h('button', { class: 'btn icon ip-upload', title: t('Загрузить SVG'), html: icon('plus', 18), onclick: async () => {
      await this.uploadIcon();
      custom = await this.customIcons();
      render();
    } });
    const pop = h('div', { class: 'palette icon-picker', style: { left: `${r.left}px`, top: `${r.bottom + 8}px` } }, h('div', { class: 'row' }, search, upload), grid);
    render();
    document.body.append(pop);
    const pr = pop.getBoundingClientRect();
    if (pr.right > innerWidth - 8) pop.style.left = `${innerWidth - pr.width - 8}px`;
    if (pr.bottom > innerHeight - 8) pop.style.top = `${Math.max(8, r.top - pr.height - 8)}px`;
    search.focus();
  },

  // Extra controls in the properties bar for a selected board tile.
  boardProps(el, btn, swatch, parts) {
    const isBoard = (x) => x.type === 'board';
    const iconBtn = h('button', { title: t('Иконка'), html: icon('image', 18) });
    iconBtn.onclick = () => this.openIconPicker(iconBtn, (pick) => this.applyIcon(el, pick), el.icon);
    parts.push(
      swatch(t('Цвет иконки'), el.ic || '#ffffff', ['#ffffff', '#1a1a1a', '#f5d128', '#ff9d48', '#f24726', '#8fd14f', '#2d9bf0', '#9510ac'], (c) => this.setProp(isBoard, { ic: c })),
      iconBtn,
      btn('pencil', t('Переименовать'), () => this.renameSubBoard(el)),
      btn('open', t('Открыть доску'), () => this.openSubBoard(el)),
    );
  },
};

