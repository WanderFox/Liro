// Custom shapes uploaded as SVG to the server. Every client sees them in the shape library; a placed
// shape copies the SVG into the board's media (so it also works offline) and is drawn as a colour
// fill masked by the SVG, so its colour and opacity can be changed like any other shape.
import { h, toast } from './ui.js';
import { t } from './i18n.js';
import { withAlpha } from './colorpicker.js';
import { MEDIA_NAME_RE } from './ops.js';
import { native } from './native.js';
import { pickFiles } from './subboards.js';

export const customShapeMethods = {
  // Server shapes when connected, plus shapes stored on this computer/browser (work without a server).
  async loadCustomShapes() {
    const s = this.session;
    const list = [];
    if (s && !s.server.local) {
      try {
        for (const it of await s.api.shapes()) list.push({ id: it.id, name: it.name, url: `${s.server.url}${it.url}` });
      } catch {}
    }
    if (native.assets) {
      for (const it of await native.assets.list('shapes')) {
        if (!list.some((x) => x.id === it.name)) list.push({ id: `local/${it.name}`, name: it.name.replace(/\.svg$/i, ''), url: it.url });
      }
    }
    this.customShapes = list;
    this.renderLibrary();
  },

  renderCustomShapes(body, q) {
    const s = this.session;
    const items = (this.customShapes || []).filter((it) => !q || it.name.toLowerCase().includes(q));
    const upload = h('button', { class: 'btn lib-upload', onclick: () => this.uploadCustomShape() }, `+ ${t('Загрузить SVG')}`);
    body.append(h('h4', {}, t('Свои фигуры')));
    body.append(upload);
    if (!items.length) return;
    body.append(h('div', { class: 'lib-grid' }, items.map((it) => {
      const { url } = it;
      return h('button', {
        class: this.tool === 'shape' && this.shapeKind === `custom:${it.id}` ? 'active' : '', title: it.name, draggable: 'true',
        onclick: () => this.pickShape(`custom:${it.id}`),
        ondragstart: (e) => { e.dataTransfer.setData('application/x-liro-shape', `custom:${it.id}`); e.dataTransfer.effectAllowed = 'copy'; },
      }, h('img', { src: url, alt: it.name, class: 'lib-custom' }));
    })));
  },

  async uploadCustomShape() {
    const s = this.session;
    const toServer = s.status === 'online' && !s.server.local;
    for (const file of await pickFiles('.svg,image/svg+xml')) {
      try {
        if (toServer) {
          const res = await fetch(`${s.server.url}/api/shapes/${encodeURIComponent(file.name)}`, { method: 'PUT', body: file });
          if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
        } else if (native.assets) {
          await native.assets.save('shapes', file.name, await file.arrayBuffer());
        }
      } catch (err) {
        toast(`${t('Не удалось загрузить фигуру')}: ${err.message}`, { error: true });
      }
    }
    await this.loadCustomShapes();
    toast(toServer ? t('Фигуры загружены на сервер') : t('Фигуры сохранены локально'));
  },

  async createCustomShape(id, rect) {
    const s = this.session;
    const item = (this.customShapes || []).find((x) => x.id === id);
    const file = item ? `${item.name}.svg` : id;
    try {
      const res = await fetch(item ? item.url : `${s.server.url}/shapes/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const info = await s.addMediaFile(new File([blob], file, { type: 'image/svg+xml' }));
      this.addElement({
        type: 'shape', shape: 'custom', src: info.name, name: file.replace(/\.svg$/i, ''),
        x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.w), h: Math.round(rect.h),
        fill: '#ffffff', fo: 1, tc: '#1a1a1a', fs: 16, text: '',
      });
    } catch (err) {
      toast(`${t('Не удалось добавить фигуру')}: ${err.message}`, { error: true });
    }
  },

  drawCustomShape(el, node) {
    let fillEl = node.querySelector(':scope > .custom-shape');
    if (!fillEl) {
      node.querySelector('svg.shape')?.remove();
      fillEl = h('div', { class: 'custom-shape' });
      node.prepend(fillEl);
    }
    const url = el.src && MEDIA_NAME_RE.test(el.src) ? this.session.mediaUrl(el.src) : '';
    Object.assign(fillEl.style, {
      background: withAlpha(el.fill || '#ffffff', el.fo ?? 1),
      maskImage: url ? `url("${url}")` : 'none', webkitMaskImage: url ? `url("${url}")` : 'none',
    });
    const txt = this.textNode(node, el);
    txt.style.position = 'relative';
  },
};
