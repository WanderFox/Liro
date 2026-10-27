// Checklist element: nested task list with checkboxes.
// Items live in separate fields (i_<id>: { t: text, d: done, o: order, l: level }) so that people editing
// different items at the same time never overwrite each other.
import { uid } from './ops.js';
import { h } from './ui.js';
import { t } from './i18n.js';

const MAX_LEVEL = 4;

export const checklistMethods = {
  checkItems(el) {
    return Object.keys(el).filter((k) => k.startsWith('i_') && el[k] && typeof el[k] === 'object')
      .map((key) => ({ key, ...el[key], l: Math.max(0, Math.min(MAX_LEVEL, el[key].l || 0)) }))
      .sort((a, b) => (a.o || 0) - (b.o || 0));
  },

  // Index range [i+1, end) of the items nested under items[i].
  childrenRange(items, i) {
    let end = i + 1;
    while (end < items.length && items[end].l > items[i].l) end++;
    return end;
  },

  draw_checklist(el, node) {
    const editing = this.editingItem && this.editingItem.id === el.id ? this.editingItem : null;
    if (editing && editing.key !== '__title' && node.querySelector(`.cl-row[data-key="${editing.key}"]`)) {
      // Do not rebuild the row being typed into; refresh the other rows in place.
      for (const row of node.querySelectorAll('.cl-row')) {
        const it = el[row.dataset.key];
        if (!it || row.dataset.key === editing.key) continue;
        row.classList.toggle('done', !!it.d);
        row.querySelector('.cl-check').checked = !!it.d;
        row.querySelector('.cl-text').textContent = it.t || '';
        row.style.paddingLeft = `${(it.l || 0) * 1.4}em`;
      }
      const cur = node.querySelector(`.cl-row[data-key="${editing.key}"]`);
      if (cur && el[editing.key]) cur.style.paddingLeft = `${(el[editing.key].l || 0) * 1.4}em`;
      this.updateChecklistProgress(el, node);
      return;
    }
    if (editing && editing.key === '__title') return;
    const items = this.checkItems(el);
    node.style.fontSize = `${el.fs || 16}px`;
    node.replaceChildren(
      h('div', { class: 'cl-head' },
        h('span', { class: 'cl-title' }, el.title || t('Список задач')),
        h('span', { class: 'cl-count' })),
      h('div', { class: 'cl-progress' }, h('div')),
      ...items.map((it) => h('div', {
        class: `cl-row${it.d ? ' done' : ''}${this.activeRow && this.activeRow.id === el.id && this.activeRow.key === it.key ? ' active' : ''}`,
        'data-key': it.key, style: { paddingLeft: `${it.l * 1.4}em` },
      },
        h('span', { class: 'cl-drag', title: t('Перетащите, чтобы переместить') }),
        Object.assign(h('input', { type: 'checkbox', class: 'cl-check', title: it.d ? t('Снять отметку') : t('Выполнено') }), { checked: !!it.d }),
        h('span', { class: 'cl-text' }, it.t || ''),
        h('button', { class: 'cl-del', title: t('Удалить пункт') }, '×'))),
      h('button', { class: 'cl-add' }, `+ ${t('Добавить пункт')}`),
    );
    this.updateChecklistProgress(el, node);
    this.fitChecklist(el, node);
  },

  updateChecklistProgress(el, node) {
    const items = this.checkItems(el);
    const done = items.filter((i) => i.d).length;
    const count = node.querySelector('.cl-count');
    const bar = node.querySelector('.cl-progress > div');
    if (count) count.textContent = items.length ? `${done}/${items.length}` : '';
    if (bar) bar.style.width = `${items.length ? (done / items.length) * 100 : 0}%`;
  },

  // Keeps the element height equal to its content (only for our own changes, to avoid echo updates).
  fitChecklist(el, node) {
    if (!this.session || !this.session.canEdit || !this.localChecklistChange) return;
    const need = Math.ceil(node.scrollHeight);
    if (Math.abs(need - el.h) > 1) {
      node.style.height = `${need}px`;
      this.session.apply([{ k: 'upd', id: el.id, set: { h: need } }]);
    }
  },

  checklistOp(id, set) {
    this.localChecklistChange = true;
    this.do([{ k: 'upd', id, set }]);
    this.localChecklistChange = false;
  },

  // Checking an item checks everything under it; a parent is done exactly when all of its children are.
  toggleItem(id, key) {
    const el = this.elements.get(id);
    if (!el || !el[key]) return;
    const items = this.checkItems(el);
    const i = items.findIndex((x) => x.key === key);
    const value = !items[i].d;
    const end = this.childrenRange(items, i);
    for (let j = i; j < end; j++) items[j].d = value;
    for (let lvl = items[i].l - 1; lvl >= 0; lvl--) {
      let p = i - 1;
      while (p >= 0 && items[p].l > lvl) p--;
      if (p < 0 || items[p].l !== lvl) continue;
      const pe = this.childrenRange(items, p);
      const kids = items.slice(p + 1, pe).filter((x) => x.l === lvl + 1);
      items[p].d = kids.length > 0 && kids.every((x) => x.d);
    }
    const set = {};
    for (const it of items) {
      if (!!el[it.key].d !== !!it.d) set[it.key] = { ...el[it.key], d: it.d };
    }
    this.checklistOp(id, set);
  },

  // A parent is done exactly when all of its direct children are; adds the changed items to `set`.
  syncParents(el, items, set) {
    for (let i = items.length - 1; i >= 0; i--) {
      const end = this.childrenRange(items, i);
      if (end === i + 1) continue;
      const kids = items.slice(i + 1, end).filter((x) => x.l === items[i].l + 1);
      const done = kids.length > 0 && kids.every((x) => x.d);
      if (!!items[i].d !== done) {
        items[i].d = done;
        set[items[i].key] = { ...(set[items[i].key] || el[items[i].key]), d: done };
      }
    }
    return set;
  },

  addItem(id, afterKey = null) {
    const el = this.elements.get(id);
    if (!el) return null;
    const items = this.checkItems(el);
    let idx = afterKey ? items.findIndex((i) => i.key === afterKey) : items.length - 1;
    const level = idx >= 0 ? items[idx].l : 0;
    // A new item goes after the whole sub-list of the item Enter was pressed on, at the same level.
    if (afterKey && idx >= 0) {
      const end = this.childrenRange(items, idx);
      const hasKids = end > idx + 1;
      if (hasKids) idx = end - 1;
    }
    const prev = items[idx], next = items[idx + 1];
    const o = prev ? (next ? (prev.o + next.o) / 2 : prev.o + 1) : 1;
    const key = `i_${uid('')}`;
    this.checklistOp(id, { [key]: { t: '', d: false, o, l: level } });
    this.startItemEdit(id, key); // the row is rendered synchronously by do()
    return key;
  },

  removeItem(id, key) {
    const el = this.elements.get(id);
    if (!el) return;
    // Children move up one level instead of disappearing.
    const items = this.checkItems(el);
    const i = items.findIndex((x) => x.key === key);
    const set = { [key]: null };
    if (i >= 0) {
      const end = this.childrenRange(items, i);
      for (let j = i + 1; j < end; j++) set[items[j].key] = { ...el[items[j].key], l: Math.max(0, items[j].l - 1) };
    }
    this.checklistOp(id, set);
  },

  indentItem(id, key, delta) {
    const el = this.elements.get(id);
    if (!el || !el[key]) return;
    const items = this.checkItems(el);
    const i = items.findIndex((x) => x.key === key);
    const maxLevel = i > 0 ? Math.min(MAX_LEVEL, items[i - 1].l + 1) : 0;
    const level = Math.max(0, Math.min(maxLevel, items[i].l + delta));
    if (level === items[i].l) return;
    const diff = level - items[i].l;
    const end = this.childrenRange(items, i);
    const set = {};
    for (let j = i; j < end; j++) set[items[j].key] = { ...el[items[j].key], l: Math.max(0, Math.min(MAX_LEVEL, items[j].l + diff)) };
    if (this.editingItem && this.editingItem.key === key) {
      set[key].t = this.editingItem.span.innerText.replace(/\n+$/, '');
    }
    this.syncParents(el, this.checkItems({ ...el, ...set }), set);
    this.checklistOp(id, set);
  },

  startItemEdit(id, key) {
    const node = this.nodes.get(id);
    const span = key === '__title'
      ? node && node.querySelector('.cl-title')
      : node && node.querySelector(`.cl-row[data-key="${key}"] .cl-text`);
    if (!span) return;
    if (!this.session.canEdit) return this.readOnlyHint();
    if (this.editing) this.finishEdit();
    this.finishItemEdit();
    this.editingItem = { id, key, span };
    try { span.contentEditable = 'plaintext-only'; } catch { span.contentEditable = 'true'; }
    if (span.contentEditable !== 'plaintext-only') span.contentEditable = 'true';
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    if (key !== '__title') range.collapse(false);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    span.onblur = () => this.finishItemEdit();
    span.onkeydown = (e) => {
      e.stopPropagation();
      if (key === '__title') {
        if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); span.blur(); }
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.finishItemEdit();
        this.addItem(id, key);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.indentItem(id, key, e.shiftKey ? -1 : 1);
      } else if (e.key === 'Backspace' && !span.textContent) {
        e.preventDefault();
        const items = this.checkItems(this.elements.get(id));
        const i = items.findIndex((x) => x.key === key);
        this.editingItem = null;
        this.removeItem(id, key);
        if (items[i - 1]) this.startItemEdit(id, items[i - 1].key);
      } else if (e.key === 'Escape') {
        span.blur();
      }
    };
  },

  finishItemEdit() {
    const ed = this.editingItem;
    if (!ed) return;
    this.editingItem = null;
    const { id, key, span } = ed;
    span.onblur = span.onkeydown = null;
    span.removeAttribute('contenteditable');
    const el = this.elements.get(id);
    if (!el) return;
    const text = span.innerText.replace(/\n+$/, '');
    if (key === '__title') {
      if (text.trim() && text !== el.title) this.checklistOp(id, { title: text.trim() });
      else this.renderEl(el);
      return;
    }
    if (!el[key]) return;
    if (text !== (el[key].t || '')) this.checklistOp(id, { [key]: { ...el[key], t: text } });
    else this.renderEl(el);
  },

  renameChecklist(el) {
    this.startItemEdit(el.id, '__title');
  },

  // The item the toolbar buttons (add / indent / outdent) act on.
  setActiveRow(id, key) {
    this.activeRow = { id, key };
    const node = this.nodes.get(id);
    if (node) for (const r of node.querySelectorAll('.cl-row')) r.classList.toggle('active', r.dataset.key === key);
    this.renderProps();
  },

  checklistProps(el, btn, parts) {
    const row = this.activeRow && this.activeRow.id === el.id && el[this.activeRow.key] ? this.activeRow.key : null;
    parts.push(
      btn('plus', t('Добавить пункт (Enter)'), () => this.addItem(el.id, row)),
      btn('outdent', t('Уровень выше (Shift+Tab)'), () => row && this.indentItem(el.id, row, -1), false, !row),
      btn('indent', t('Вложить на уровень ниже (Tab)'), () => row && this.indentItem(el.id, row, 1), false, !row),
    );
  },

  // ---------------------------------------------------------------- drag & drop of items
  // Where an item would land: index in the list (without the dragged block) and nesting level.
  rowDropTarget(g, e) {
    const el = this.elements.get(g.id);
    const node = this.nodes.get(g.id);
    if (!el || !node) return null;
    const items = this.checkItems(el);
    const from = items.findIndex((x) => x.key === g.key);
    if (from < 0) return null;
    const end = this.childrenRange(items, from);
    const block = items.slice(from, end);
    const rest = items.filter((x) => !block.includes(x));
    const rows = [...node.querySelectorAll('.cl-row')].filter((r) => !block.some((b) => b.key === r.dataset.key));
    let index = rest.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { index = i; break; }
    }
    const first = node.querySelector('.cl-row');
    const left = first ? first.getBoundingClientRect().left : 0;
    const em = parseFloat(getComputedStyle(node).fontSize) * this.view.z * 1.4;
    const prev = rest[index - 1];
    const maxLevel = prev ? Math.min(4, prev.l + 1) : 0;
    const level = Math.max(0, Math.min(maxLevel, Math.round((e.clientX - left - 10) / em)));
    const ref = rows[index] || rows[rows.length - 1];
    const rr = ref ? ref.getBoundingClientRect() : node.getBoundingClientRect();
    const y = rows[index] ? rr.top : rr.bottom;
    return { el, items, block, rest, index, level, y, left: left + level * em, right: node.getBoundingClientRect().right - 12 };
  },

  dragRowFrame(g, e) {
    const tgt = this.rowDropTarget(g, e);
    g.target = tgt;
    let line = this.overlay.querySelector('.cl-drop');
    if (!line) {
      line = h('div', { class: 'cl-drop' });
      this.overlay.append(line);
    }
    if (!tgt) return;
    const vr = this.viewport.getBoundingClientRect();
    Object.assign(line.style, { left: `${tgt.left - vr.left}px`, top: `${tgt.y - vr.top - 1}px`, width: `${Math.max(20, tgt.right - tgt.left)}px` });
    const node = this.nodes.get(g.id);
    if (node) for (const r of node.querySelectorAll('.cl-row')) r.classList.toggle('dragging', tgt.block.some((b) => b.key === r.dataset.key));
  },

  dropRow(g) {
    this.overlay.querySelector('.cl-drop')?.remove();
    const node = this.nodes.get(g.id);
    if (node) for (const r of node.querySelectorAll('.cl-row.dragging')) r.classList.remove('dragging');
    const tgt = g.moved && g.target;
    if (!tgt) return;
    const { el, block, rest, index, level } = tgt;
    const order = [...rest.slice(0, index), ...block, ...rest.slice(index)];
    const diff = level - block[0].l;
    const set = {};
    order.forEach((it, i) => {
      const inBlock = block.includes(it);
      const l = inBlock ? Math.max(0, Math.min(4, it.l + diff)) : it.l;
      const cur = el[it.key];
      if (cur.o !== i + 1 || (cur.l || 0) !== l) set[it.key] = { ...cur, o: i + 1, l };
    });
    this.syncParents(el, this.checkItems({ ...el, ...set }), set);
    if (Object.keys(set).length) this.checklistOp(el.id, set);
    this.setActiveRow(el.id, g.key);
  },
};
