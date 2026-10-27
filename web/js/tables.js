// Tables: rows and columns of text cells, with per-cell fill, text colour, bold and alignment.
// Structure: rows/cols are id lists, row heights (rh) and column widths (cw) are relative weights,
// cells are separate fields c_<rowId>_<colId> so that editing different cells never collides.
// Also builds the year calendar (a big table with one row per month).
import { uid } from './ops.js';
import { h, modal } from './ui.js';
import { t, getLanguage } from './i18n.js';

const cellKey = (r, c) => `c_${r}_${c}`;

export function makeTable(nRows, nCols, { cellW = 140, cellH = 44 } = {}) {
  const rows = Array.from({ length: nRows }, () => uid('r').slice(0, 9));
  const cols = Array.from({ length: nCols }, () => uid('k').slice(0, 9));
  const el = {
    type: 'table', rows, cols, rh: {}, cw: {}, w: nCols * cellW, h: nRows * cellH, fs: 15, tc: '#ffffff',
  };
  for (const r of rows) el.rh[r] = cellH;
  for (const c of cols) el.cw[c] = cellW;
  return el;
}

// Year calendar: header row with weekday names, one row per month, day cells aligned by weekday.
export function makeCalendar(year) {
  const lang = getLanguage();
  const SLOTS = 37; // a month can start on any weekday: 6 leading blanks + 31 days
  const el = makeTable(13, SLOTS + 1, { cellW: 64, cellH: 84 });
  el.calendar = year;
  el.fs = 14;
  const [, ...slotCols] = el.cols;
  const monthCol = el.cols[0];
  el.cw[monthCol] = 110;
  el.rh[el.rows[0]] = 36;
  el.w = 110 + SLOTS * 64;
  el.h = 36 + 12 * 84;
  const wd = new Intl.DateTimeFormat(lang, { weekday: 'short' });
  const mn = new Intl.DateTimeFormat(lang, { month: 'long' });
  const weekday = (i) => wd.format(new Date(2024, 0, 1 + (i % 7))); // 2024-01-01 is a Monday
  const header = el.rows[0];
  el[cellKey(header, monthCol)] = { t: String(year), b: true, f: '#f5d128', tc: '#1a1a1a', a: 'center' };
  slotCols.forEach((c, i) => {
    const weekend = i % 7 >= 5;
    el[cellKey(header, c)] = { t: weekday(i), a: 'center', b: weekend, f: weekend ? '#f5d128' : '#2b2b35', tc: weekend ? '#1a1a1a' : '#bdbdc9' };
  });
  for (let m = 0; m < 12; m++) {
    const r = el.rows[m + 1];
    const name = mn.format(new Date(year, m, 1));
    el[cellKey(r, monthCol)] = { t: name.charAt(0).toUpperCase() + name.slice(1), b: true, f: '#24242d', a: 'center' };
    const offset = (new Date(year, m, 1).getDay() + 6) % 7; // Monday = 0
    const days = new Date(year, m + 1, 0).getDate();
    slotCols.forEach((c, i) => {
      const day = i - offset + 1;
      if (day < 1 || day > days) {
        el[cellKey(r, c)] = { t: '', f: '#1b1b21' };
      } else {
        const weekend = i % 7 >= 5;
        el[cellKey(r, c)] = { t: String(day), a: 'tl', f: weekend ? '#3a3424' : '#2b2b35', tc: weekend ? '#f5d9a0' : '#e8e8f0' };
      }
    });
  }
  return el;
}

export const tableMethods = {
  draw_table(el, node) {
    const rows = el.rows || [], cols = el.cols || [];
    const editing = this.editingCell && this.editingCell.id === el.id ? this.editingCell : null;
    const sum = (ids, sizes, def) => ids.reduce((s, id) => s + (sizes && sizes[id] ? sizes[id] : def), 0);
    const tw = sum(cols, el.cw, 140), th = sum(rows, el.rh, 44);
    let grid = node.querySelector(':scope > .tb-grid');
    if (!grid) {
      grid = h('div', { class: 'tb-grid' });
      node.append(grid);
    }
    grid.style.gridTemplateColumns = cols.map((c) => `${((el.cw && el.cw[c]) || 140) / tw}fr`).join(' ');
    grid.style.gridTemplateRows = rows.map((r) => `${((el.rh && el.rh[r]) || 44) / th}fr`).join(' ');
    grid.style.fontSize = `${el.fs || 15}px`;
    grid.style.color = el.tc || '#ffffff';
    const sel = this.tableSel && this.tableSel.id === el.id ? this.tableSel : null;
    const key = JSON.stringify([rows, cols]);
    if (grid.dataset.key !== key) {
      grid.dataset.key = key;
      grid.replaceChildren(...rows.flatMap((r) => cols.map((c) => h('div', { class: 'tb-cell', 'data-r': r, 'data-c': c }, h('span')))));
    }
    for (const cell of grid.children) {
      const { r, c } = cell.dataset;
      const v = el[cellKey(r, c)] || {};
      const isEditing = editing && editing.r === r && editing.c === c;
      if (!isEditing && cell.firstChild.textContent !== (v.t || '')) cell.firstChild.textContent = v.t || '';
      const align = v.a || 'left';
      Object.assign(cell.style, {
        background: v.f || '',
        color: v.tc || '',
        fontWeight: v.b ? '700' : '',
        justifyContent: align === 'center' ? 'center' : align === 'right' ? 'flex-end' : 'flex-start',
        alignItems: align === 'tl' ? 'flex-start' : 'center',
        textAlign: align === 'tl' ? 'left' : align,
      });
      cell.classList.toggle('sel', !!(sel && this.cellInSel(el, sel, r, c)));
    }
  },

  // Rectangular cell range of the current table selection.
  cellInSel(el, sel, r, c) {
    const ri = el.rows.indexOf(r), ci = el.cols.indexOf(c);
    const r0 = el.rows.indexOf(sel.r0), r1 = el.rows.indexOf(sel.r1), c0 = el.cols.indexOf(sel.c0), c1 = el.cols.indexOf(sel.c1);
    return ri >= Math.min(r0, r1) && ri <= Math.max(r0, r1) && ci >= Math.min(c0, c1) && ci <= Math.max(c0, c1);
  },

  selectedCells(el) {
    const sel = this.tableSel;
    if (!sel || sel.id !== el.id) return [];
    const out = [];
    for (const r of el.rows) for (const c of el.cols) if (this.cellInSel(el, sel, r, c)) out.push([r, c]);
    return out;
  },

  selectCell(id, r, c, extend = false) {
    const prev = this.tableSel;
    if (extend && prev && prev.id === id) this.tableSel = { ...prev, r1: r, c1: c };
    else this.tableSel = { id, r0: r, c0: c, r1: r, c1: c };
    const el = this.elements.get(id);
    if (el) this.renderEl(el);
    this.renderProps();
  },

  clearCellSel() {
    if (!this.tableSel) return;
    const el = this.elements.get(this.tableSel.id);
    this.tableSel = null;
    if (el) this.renderEl(el);
  },

  setCells(el, patch) {
    const set = {};
    for (const [r, c] of this.selectedCells(el)) set[cellKey(r, c)] = { ...(el[cellKey(r, c)] || {}), ...patch };
    if (Object.keys(set).length) this.do([{ k: 'upd', id: el.id, set }]);
  },

  startCellEdit(id, r, c) {
    const el = this.elements.get(id);
    const node = this.nodes.get(id);
    const cell = node && node.querySelector(`.tb-cell[data-r="${r}"][data-c="${c}"]`);
    if (!el || !cell) return;
    if (!this.session.canEdit) return this.readOnlyHint();
    this.finishCellEdit();
    const span = cell.firstChild;
    this.editingCell = { id, r, c, span };
    this.tableSel = { id, r0: r, c0: c, r1: r, c1: c };
    try { span.contentEditable = 'plaintext-only'; } catch { span.contentEditable = 'true'; }
    if (span.contentEditable !== 'plaintext-only') span.contentEditable = 'true';
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    span.onblur = () => this.finishCellEdit();
    span.onkeydown = (e) => {
      e.stopPropagation();
      const ri = el.rows.indexOf(r), ci = el.cols.indexOf(c);
      if (e.key === 'Escape') { e.preventDefault(); span.blur(); }
      else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        this.finishCellEdit();
        const nr = el.rows[ri + 1];
        if (nr) this.startCellEdit(id, nr, c);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        this.finishCellEdit();
        let ni = ci + (e.shiftKey ? -1 : 1), nri = ri;
        if (ni >= el.cols.length) { ni = 0; nri += 1; }
        if (ni < 0) { ni = el.cols.length - 1; nri -= 1; }
        if (el.rows[nri]) this.startCellEdit(id, el.rows[nri], el.cols[ni]);
      }
    };
    this.hideProps();
  },

  finishCellEdit() {
    const ed = this.editingCell;
    if (!ed) return;
    this.editingCell = null;
    const { id, r, c, span } = ed;
    span.onblur = span.onkeydown = null;
    span.removeAttribute('contenteditable');
    const el = this.elements.get(id);
    if (!el) return;
    const text = span.innerText.replace(/\n+$/, '');
    const cur = el[cellKey(r, c)] || {};
    if (text !== (cur.t || '')) this.do([{ k: 'upd', id, set: { [cellKey(r, c)]: { ...cur, t: text } } }]);
    this.renderProps();
  },

  // Inserts a row/column next to the selected cell (dir: -1 before, 1 after) or removes it.
  tableStructure(el, what) {
    const sel = this.tableSel && this.tableSel.id === el.id ? this.tableSel : { r0: el.rows[el.rows.length - 1], c0: el.cols[el.cols.length - 1] };
    const rows = [...el.rows], cols = [...el.cols];
    const rh = { ...(el.rh || {}) }, cw = { ...(el.cw || {}) };
    const set = {};
    if (what === 'rowAbove' || what === 'rowBelow') {
      const id = uid('r').slice(0, 9);
      const at = rows.indexOf(sel.r0) + (what === 'rowBelow' ? 1 : 0);
      rows.splice(at, 0, id);
      rh[id] = rh[sel.r0] || 44;
      set.h = Math.round(el.h * (1 + rh[id] / Object.values(el.rh || {}).reduce((a, b) => a + b, 0)));
    } else if (what === 'colLeft' || what === 'colRight') {
      const id = uid('k').slice(0, 9);
      const at = cols.indexOf(sel.c0) + (what === 'colRight' ? 1 : 0);
      cols.splice(at, 0, id);
      cw[id] = cw[sel.c0] || 140;
      set.w = Math.round(el.w * (1 + cw[id] / Object.values(el.cw || {}).reduce((a, b) => a + b, 0)));
    } else if (what === 'delRow' && rows.length > 1) {
      const total = Object.values(rh).reduce((a, b) => a + b, 0);
      const rm = new Set(this.selectedCells(el).map(([r]) => r));
      if (!rm.size) rm.add(sel.r0);
      let removed = 0;
      for (const r of rm) { removed += rh[r] || 44; rows.splice(rows.indexOf(r), 1); delete rh[r]; for (const c of cols) set[cellKey(r, c)] = null; }
      if (!rows.length) return;
      set.h = Math.round(el.h * (1 - removed / total));
    } else if (what === 'delCol' && cols.length > 1) {
      const total = Object.values(cw).reduce((a, b) => a + b, 0);
      const rm = new Set(this.selectedCells(el).map(([, c]) => c));
      if (!rm.size) rm.add(sel.c0);
      let removed = 0;
      for (const c of rm) { removed += cw[c] || 140; cols.splice(cols.indexOf(c), 1); delete cw[c]; for (const r of rows) set[cellKey(r, c)] = null; }
      if (!cols.length) return;
      set.w = Math.round(el.w * (1 - removed / total));
    } else return;
    Object.assign(set, { rows, cols, rh, cw });
    this.tableSel = null;
    this.do([{ k: 'upd', id: el.id, set }]);
  },

  tableProps(el, btn, swatch, parts, colors) {
    const cells = this.selectedCells(el);
    const tableMenu = h('button', { title: t('Строки и столбцы'), html: '<b style="font-size:13px">⊞</b>' });
    tableMenu.onclick = () => this.openMenu(tableMenu, [
      ['arrowUp', t('Строка выше'), 'rowAbove'], ['arrowDown', t('Строка ниже'), 'rowBelow'],
      ['arrowStart', t('Столбец слева'), 'colLeft'], ['arrowEnd', t('Столбец справа'), 'colRight'],
      null,
      ['trash', t('Удалить строку'), 'delRow', el.rows.length < 2], ['trash', t('Удалить столбец'), 'delCol', el.cols.length < 2],
    ], (what) => this.tableStructure(el, what));
    parts.push(tableMenu);
    if (!cells.length) return;
    const v = el[cellKey(cells[0][0], cells[0][1])] || {};
    parts.push(
      swatch(t('Заливка ячеек'), v.f || '#2b2b35', colors.fills, (c) => this.setCells(el, { f: c === 'transparent' ? '' : c }), { allowNone: true }),
      swatch(t('Цвет текста'), v.tc || el.tc || '#ffffff', colors.inks, (c) => this.setCells(el, { tc: c })),
      btn('bold', t('Жирный'), () => this.setCells(el, { b: !v.b }), !!v.b),
      btn('left', t('По левому краю'), () => this.setCells(el, { a: 'left' }), (v.a || 'left') === 'left'),
      btn('center', t('По центру'), () => this.setCells(el, { a: 'center' }), v.a === 'center'),
      btn('right', t('По правому краю'), () => this.setCells(el, { a: 'right' }), v.a === 'right'),
    );
  },

  async createCalendar(at) {
    const input = h('input', { type: 'number', min: 1900, max: 2200, value: new Date().getFullYear() });
    const year = await modal({
      title: t('Календарь на год'),
      body: h('label', { class: 'col' }, h('span', {}, t('Год')), input),
      buttons: [{ label: t('Отмена'), value: null }, { label: t('Создать'), value: () => Number(input.value), primary: true }],
    });
    if (!year || year < 1900 || year > 2200) return;
    const el = makeCalendar(year);
    this.addElement({ ...el, x: Math.round(at.x - el.w / 2), y: Math.round(at.y - el.h / 2) });
    this.setTool('select');
  },
};
