// Board editor: rendering, tools, selection, undo/redo, clipboard, media.
import { uid, MEDIA_NAME_RE, mediaOfElement } from './ops.js';
import { SHAPE_DEFS, SHAPE_CATEGORIES, shapeDef, shapeIcon } from './shapes.js';
import { native } from './native.js';
import { h, toast, modal, progressDialog, promptText, confirmDialog } from './ui.js';
import { icon } from './icons.js';
import { checklistMethods } from './checklist.js';
import { subBoardMethods } from './subboards.js';
import { customShapeMethods } from './customshapes.js';
import { tableMethods, makeTable } from './tables.js';
import { modelMethods, MODEL_EXT, MODEL_ASSET_EXT, extOf } from './model3d.js';
import { openColorPicker, closeColorPicker, withAlpha } from './colorpicker.js';
import { loadFonts, fontFamilies, uploadFont, fontStack } from './fonts.js';
import { t } from './i18n.js';
import { dropdown } from './ui.js';
import { downloadUrl, pickBackupFile, readManifest, confirmRestore, restoreToServer, summaryText, buildLocalBackup, restoreLocally } from './backup.js';

const $ = (id) => document.getElementById(id);
const SVGNS = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};
const clone = (v) => (v === undefined ? undefined : structuredClone(v));
const round = (n) => Math.round(n * 10) / 10;
// Colours are stored and drawn as chosen: the board is dark, so new text and lines default to white ink.
const DEFAULT_INK = '#ffffff';
const DEFAULT_FRAME = '#2b2b35';
const canvasInk = (c) => c || DEFAULT_INK;
const framePaper = (c) => c || DEFAULT_FRAME;

const FILLS = ['#fff9b1', '#f5d128', '#ff9d48', '#f24726', '#ea94bb', '#d5f692', '#c9df56', '#93d275', '#67c6c0', '#a6ccf5',
  '#6cd8fa', '#be88c7', '#ffffff', '#e6e6e6', '#808080', '#1a1a1a', 'transparent'];
const INKS = ['#1a1a1a', '#808080', '#e6e6e6', '#ffffff', '#f24726', '#ff9d48', '#f5d128', '#8fd14f', '#0ca789', '#2d9bf0',
  '#4262ff', '#9510ac', '#da0063', '#652cb3'];
const FONT_SIZES = [10, 12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 80, 96, 128];
const WIDTHS = [1, 2, 3, 4, 6, 8, 12, 16];
const TEXT_TYPES = new Set(['sticky', 'text', 'shape', 'line']);
// Shapes created square by default (the rest are 200 x 120).
const SQUARE_SHAPES = new Set(['ellipse', 'triangle', 'diamond', 'star', 'pentagon', 'octagon', 'cross', 'connector', 'or', 'summing', 'double-circle', 'merge', 'sort', 'collate', 'cloud', 'callout-cloud']);
// Line tool variants (shapes menu).
const LINE_KINDS = {
  line: { name: 'Линия', key: 'L', set: { route: 'straight', startCap: 'none', endCap: 'none' } },
  arrow: { name: 'Стрелка', key: 'A', set: { route: 'straight', startCap: 'none', endCap: 'arrow' } },
  elbow: { name: 'Ломаная стрелка', set: { route: 'elbow', startCap: 'none', endCap: 'arrow' } },
  curve: { name: 'Кривая стрелка', set: { route: 'curved', startCap: 'none', endCap: 'arrow' } },
  divider: { name: 'Разделитель', set: { route: 'straight', startCap: 'none', endCap: 'none', sw: 2, stroke: '#808080' } },
};
const CAPS = { none: 'Без конца', arrow: 'Стрелка', open: 'Открытая стрелка', circle: 'Круг', diamond: 'Ромб', bar: 'Черта' };
const HANDLE_DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const TOOL_KEYS = { g: 'table', b: 'board', k: 'checklist', v: 'select', h: 'hand', n: 'sticky', t: 'text', r: 'shape', o: 'shape', l: 'line', a: 'line', p: 'pen', e: 'eraser', f: 'frame', c: 'comment' };

// Adds or removes a leading tab on the caret's line inside a plain-text contenteditable.
function indentCaretLine(span, delta) {
  const sel = getSelection();
  if (!sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(span);
  pre.setEnd(r.startContainer, r.startOffset);
  const caret = pre.toString().length;
  const text = span.innerText.replace(/\n$/, '');
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1;
  let next = text, pos = caret;
  if (delta > 0) {
    next = `${text.slice(0, lineStart)}\t${text.slice(lineStart)}`;
    pos += 1;
  } else if (text[lineStart] === '\t') {
    next = text.slice(0, lineStart) + text.slice(lineStart + 1);
    pos = Math.max(lineStart, pos - 1);
  }
  span.textContent = next;
  const tn = span.firstChild;
  if (!tn) return;
  const range = document.createRange();
  range.setStart(tn, Math.min(pos, tn.length));
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

// Lines of a text element as list items. Leading tabs set the nesting level; numbering restarts per level.
function renderList(text, kind) {
  const counters = [];
  const bullets = ['•', '◦', '▪'];
  return text.split('\n').map((line) => {
    const m = /^\t*/.exec(line);
    const lvl = Math.min(m[0].length, 6);
    const content = line.slice(m[0].length);
    counters.length = lvl + 1;
    counters[lvl] = (counters[lvl] || 0) + 1;
    const marker = !content.trim() ? '' : kind === 'number' ? `${counters[lvl]}.` : bullets[lvl % bullets.length];
    if (!content.trim()) counters[lvl] -= 1;
    return h('div', { class: 'li', style: { paddingLeft: `${lvl * 1.3 + 1.4}em` } },
      h('span', { class: 'li-m', style: { left: `${lvl * 1.3}em` } }, marker), content || '\u200b');
  });
}

// ---------------------------------------------------------------- pen smoothing
// Weighted moving average (1-2-1) over a flat [x0, y0, x1, y1, ...] array; endpoints stay in place.
function smoothPoints(pts, passes = 2) {
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    if (cur.length <= 4) break;
    const out = cur.slice();
    for (let i = 2; i < cur.length - 2; i += 2) {
      out[i] = (cur[i - 2] + 2 * cur[i] + cur[i + 2]) / 4;
      out[i + 1] = (cur[i - 1] + 2 * cur[i + 1] + cur[i + 3]) / 4;
    }
    cur = out;
  }
  return cur;
}

// Ramer-Douglas-Peucker simplification with tolerance eps.
function simplify(pts, eps) {
  const n = pts.length / 2;
  if (n < 3) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a * 2], ay = pts[a * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    let best = -1, dist = eps;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((bx - ax) * (ay - pts[i * 2 + 1]) - (ax - pts[i * 2]) * (by - ay)) / len;
      if (d > dist) { dist = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

// Smooth SVG path through the points: quadratic curves between segment midpoints.
function smoothPath(pts) {
  if (pts.length < 6) {
    let d = '';
    for (let i = 0; i < pts.length; i += 2) d += `${i ? 'L' : 'M'}${pts[i]},${pts[i + 1]}`;
    return d;
  }
  let d = `M${pts[0]},${pts[1]}`;
  for (let i = 2; i < pts.length - 2; i += 2) {
    const mx = (pts[i] + pts[i + 2]) / 2, my = (pts[i + 1] + pts[i + 3]) / 2;
    d += `Q${pts[i]},${pts[i + 1]} ${round(mx)},${round(my)}`;
  }
  return `${d}L${pts[pts.length - 2]},${pts[pts.length - 1]}`;
}

function fmtSize(n) {
  if (!n) return '';
  if (n < 1024) return `${n} ${t('Б')}`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} ${t('КБ')}`;
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(1)} ${t('МБ')}`;
  return `${(n / 1024 ** 3).toFixed(2)} ${t('ГБ')}`;
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function rectContains(outer, inner) {
  return inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
}

function unionRect(rects) {
  if (!rects.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const r of rects) {
    x1 = Math.min(x1, r.x); y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w); y2 = Math.max(y2, r.y + r.h);
  }
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

export class BoardView {
  constructor(app) {
    this.app = app;
    this.viewport = $('viewport');
    this.world = $('world');
    this.overlay = $('overlay');
    this.session = null;
    this.view = { x: 0, y: 0, z: 1 };
    this.nodes = new Map();
    this.selection = new Set();
    this.tool = 'select';
    this.shapeKind = 'rect';
    this.lineKind = 'arrow';
    this.undoStack = [];
    this.redoStack = [];
    this.txn = null;
    this.gesture = null;
    this.editing = null;
    this.cursors = new Map();
    this.peerSelections = new Map();
    this.spaceDown = false;
    this.lastPointer = { x: 0, y: 0 };

    this.selLayer = h('div');
    this.cursorLayer = h('div');
    this.overlay.append(this.selLayer, this.cursorLayer);
    this.bindUi();
  }

  get elements() {
    return this.session ? this.session.elements : new Map();
  }

  // ================================================================== lifecycle

  open(session) {
    this.session = session;
    this.selection.clear();
    this.undoStack = [];
    this.redoStack = [];
    this.nodes.clear();
    this.world.replaceChildren();
    this.cursors.clear();
    this.cursorLayer.replaceChildren();
    this.peerSelections.clear();
    this.fitted = false;
    this.setTool('select');

    const on = (type, fn) => session.addEventListener(type, fn);
    on('reset', () => { this.renderAll(); this.renderStatus(); });
    on('change', (e) => this.onChange(e.detail));
    on('status', () => this.renderStatus());
    on('disk', () => this.renderStatus());
    on('rejected', (e) => { if (e.detail.reason === 'disk-full') this.diskHint(); });
    on('sync', () => this.renderStatus());
    on('peers', () => this.renderPeers());
    on('meta', () => { if (document.activeElement !== $('board-name')) $('board-name').value = session.meta.name || ''; });
    on('cursor', (e) => this.onRemoteCursor(e.detail));
    on('select', (e) => { this.peerSelections.set(e.detail.cid, e.detail.ids); this.renderOverlay(); });
    on('decision', (e) => this.askDecision(e.detail.count));
    on('gone', () => this.onGone());
    on('shapes', () => this.loadCustomShapes());
    on('pending', () => this.offerPendingUpload());

    $('board-name').value = session.meta.name || '';
    loadFonts(session.server.local ? '' : session.server.url);
    this.customShapes = [];
    this.loadCustomShapes();
    $('cache-toggle').checked = session.cacheEnabled;
    $('cache-toggle').parentElement.classList.toggle('hidden', !native.cache);
    this.renderAll();
    this.renderStatus();
    this.renderPeers();
    this.viewport.focus();
  }

  close() {
    this.stopModelViewer();
    if (this.editing) this.finishEdit();
    this.finishItemEdit();
    this.closeComment(true);
    if (this.session) this.session.close();
    this.session = null;
    this.hideProps();
  }

  // ================================================================== coordinates & view

  toWorld(clientX, clientY) {
    const r = this.viewport.getBoundingClientRect();
    return { x: (clientX - r.left - this.view.x) / this.view.z, y: (clientY - r.top - this.view.y) / this.view.z };
  }

  toScreen(x, y) {
    return { x: x * this.view.z + this.view.x, y: y * this.view.z + this.view.y };
  }

  screenRect(r) {
    const p = this.toScreen(r.x, r.y);
    return { x: p.x, y: p.y, w: r.w * this.view.z, h: r.h * this.view.z };
  }

  applyView() {
    const { x, y, z } = this.view;
    this.world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    this.world.style.setProperty('--inv-z', String(1 / Math.max(z, 0.2)));
    let step = 24 * z;
    while (step < 10) step *= 4;
    this.viewport.style.backgroundSize = `${step}px ${step}px`;
    this.viewport.style.backgroundPosition = `${x}px ${y}px`;
    $('zoom-level').textContent = `${Math.round(z * 100)}%`;
    this.renderOverlay();
    this.renderCursors();
    this.positionComment();
  }

  zoomAt(factor, sx, sy) {
    const z = Math.min(30, Math.max(0.01, this.view.z * factor));
    const k = z / this.view.z;
    this.view.x = sx - (sx - this.view.x) * k;
    this.view.y = sy - (sy - this.view.y) * k;
    this.view.z = z;
    this.applyView();
  }

  zoomCenter(factor) {
    const r = this.viewport.getBoundingClientRect();
    this.zoomAt(factor, r.width / 2, r.height / 2);
  }

  fitTo(rect) {
    const r = this.viewport.getBoundingClientRect();
    if (!rect || !rect.w || !rect.h) {
      this.view = { x: r.width / 2, y: r.height / 2, z: 1 };
    } else {
      const pad = 80;
      const z = Math.min(2, Math.max(0.01, Math.min((r.width - pad * 2) / rect.w, (r.height - pad * 2) / rect.h)));
      this.view = { z, x: r.width / 2 - (rect.x + rect.w / 2) * z, y: r.height / 2 - (rect.y + rect.h / 2) * z };
    }
    this.applyView();
  }

  fitAll() {
    this.fitTo(unionRect([...this.elements.values()].map((el) => this.bounds(el))));
  }

  viewCenter() {
    const r = this.viewport.getBoundingClientRect();
    return this.toWorld(r.left + r.width / 2, r.top + r.height / 2);
  }

  // ================================================================== geometry

  bounds(el) {
    if (el.type === 'line') {
      const pts = this.lineGeom(el).pts;
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      const x = Math.min(...xs), y = Math.min(...ys);
      return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
    }
    if (el.type === 'comment') return { x: el.x, y: el.y, w: 32 / this.view.z, h: 32 / this.view.z }; // constant screen size
    return { x: el.x, y: el.y, w: el.w, h: el.h };
  }

  anchor(target, toward) {
    const b = this.bounds(target);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    let dx = toward.x - cx, dy = toward.y - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    let t;
    if (target.type === 'shape' && target.shape === 'ellipse') {
      t = 1 / Math.sqrt((dx * dx) / ((b.w / 2) ** 2 || 1) + (dy * dy) / ((b.h / 2) ** 2 || 1));
    } else {
      t = Math.min(dx ? (b.w / 2) / Math.abs(dx) : Infinity, dy ? (b.h / 2) / Math.abs(dy) : Infinity);
    }
    t = Math.min(t, 1);
    return { x: cx + dx * t, y: cy + dy * t };
  }

  // Endpoints of a straight connector: anchored on the outline of bound elements.
  straightPoints(el) {
    let a = { x: el.x1, y: el.y1 };
    let b = { x: el.x2, y: el.y2 };
    const A = el.startId && this.elements.get(el.startId);
    const B = el.endId && this.elements.get(el.endId);
    if (A && B) {
      const ca = this.center(A), cb = this.center(B);
      a = this.anchor(A, cb);
      b = this.anchor(B, ca);
    } else if (A) {
      a = this.anchor(A, b);
    } else if (B) {
      b = this.anchor(B, a);
    }
    return [a, b];
  }

  center(el) {
    const r = this.bounds(el);
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  }

  // Middle of the side of `target` facing `toward`, with the outward direction (for elbow/curved lines).
  sideAnchor(target, toward) {
    const b = this.bounds(target);
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
    const dx = (toward.x - cx) / (b.w || 1), dy = (toward.y - cy) / (b.h || 1);
    if (Math.abs(dx) >= Math.abs(dy)) return { x: dx >= 0 ? b.x + b.w : b.x, y: cy, dir: { x: dx >= 0 ? 1 : -1, y: 0 } };
    return { x: cx, y: dy >= 0 ? b.y + b.h : b.y, dir: { x: 0, y: dy >= 0 ? 1 : -1 } };
  }

  linePoints(el) {
    const g = this.lineGeom(el);
    return [g.a, g.b];
  }

  // Full connector geometry: path, points for bounds, travel directions at both tips, label position.
  lineGeom(el) {
    const route = el.route || 'straight';
    const unit = (x, y) => { const l = Math.hypot(x, y) || 1; return { x: x / l, y: y / l }; };
    if (route === 'straight') {
      const [a, b] = this.straightPoints(el);
      return {
        a, b, pts: [a, b], d: `M${a.x},${a.y} L${b.x},${b.y}`,
        endDir: unit(b.x - a.x, b.y - a.y), startDir: unit(a.x - b.x, a.y - b.y),
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    }
    const A = el.startId && this.elements.get(el.startId);
    const B = el.endId && this.elements.get(el.endId);
    const pa = { x: el.x1, y: el.y1 }, pb = { x: el.x2, y: el.y2 };
    const ca = A ? this.center(A) : pa, cb = B ? this.center(B) : pb;
    let a = pa, b = pb, da = null, db = null;
    if (A) { const s = this.sideAnchor(A, cb); a = s; da = s.dir; }
    if (B) { const s = this.sideAnchor(B, ca); b = s; db = s.dir; }
    const horiz = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y);
    const sx = Math.sign(b.x - a.x) || 1, sy = Math.sign(b.y - a.y) || 1;
    da = da || (horiz ? { x: sx, y: 0 } : { x: 0, y: sy });
    db = db || (horiz ? { x: -sx, y: 0 } : { x: 0, y: -sy });
    a = { x: a.x, y: a.y };
    b = { x: b.x, y: b.y };
    if (route === 'curved') {
      const k = Math.max(40, Math.hypot(b.x - a.x, b.y - a.y) * 0.4);
      const c1 = { x: a.x + da.x * k, y: a.y + da.y * k }, c2 = { x: b.x + db.x * k, y: b.y + db.y * k };
      const t = 0.5, u = 0.5;
      const mid = {
        x: u ** 3 * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * b.x,
        y: u ** 3 * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * b.y,
      };
      return {
        a, b, pts: [a, b, mid], d: `M${a.x},${a.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${b.x},${b.y}`,
        endDir: { x: -db.x, y: -db.y }, startDir: { x: -da.x, y: -da.y }, mid,
      };
    }
    // Elbow: short stubs out of each side, joined by one or two orthogonal bends.
    const gap = 24;
    const a1 = { x: a.x + da.x * gap, y: a.y + da.y * gap }, b1 = { x: b.x + db.x * gap, y: b.y + db.y * gap };
    let pts;
    if (da.x !== 0 && db.x !== 0) {
      const mx = (a1.x + b1.x) / 2;
      pts = [a, a1, { x: mx, y: a1.y }, { x: mx, y: b1.y }, b1, b];
    } else if (da.y !== 0 && db.y !== 0) {
      const my = (a1.y + b1.y) / 2;
      pts = [a, a1, { x: a1.x, y: my }, { x: b1.x, y: my }, b1, b];
    } else if (da.x !== 0) {
      pts = [a, a1, { x: b1.x, y: a1.y }, b1, b];
    } else {
      pts = [a, a1, { x: a1.x, y: b1.y }, b1, b];
    }
    // Drop zero-length and collinear points.
    const clean = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const p = pts[i], q = clean[clean.length - 1];
      if (Math.abs(p.x - q.x) < 0.01 && Math.abs(p.y - q.y) < 0.01) continue;
      const r = clean[clean.length - 2];
      if (r && ((Math.abs(r.x - q.x) < 0.01 && Math.abs(q.x - p.x) < 0.01) || (Math.abs(r.y - q.y) < 0.01 && Math.abs(q.y - p.y) < 0.01))) clean.pop();
      clean.push(p);
    }
    const last = clean[clean.length - 2] || a, first = clean[1] || b;
    const mi = Math.floor((clean.length - 1) / 2);
    const m1 = clean[mi], m2 = clean[mi + 1] || m1;
    return {
      a, b, pts: clean, d: `M${clean.map((p) => `${p.x},${p.y}`).join(' L')}`,
      endDir: unit(b.x - last.x, b.y - last.y), startDir: unit(a.x - first.x, a.y - first.y),
      mid: { x: (m1.x + m2.x) / 2, y: (m1.y + m2.y) / 2 },
    };
  }

  caps(el) {
    // Older elements stored booleans.
    return [el.startCap || (el.startArrow ? 'arrow' : 'none'), el.endCap || (el.endArrow ? 'arrow' : 'none')];
  }

  // Topmost element under a world point (model-based, so it works under the cursor during drags).
  hitTest(p, filter = () => true) {
    let best = null;
    for (const el of this.elements.values()) {
      if (!filter(el)) continue;
      const b = this.bounds(el);
      if (p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h && (!best || (el.z || 0) >= (best.z || 0))) best = el;
    }
    return best;
  }

  bindable(el, exceptId) {
    return el.id !== exceptId && !['line', 'pen', 'frame', 'comment'].includes(el.type);
  }

  maxZ() {
    let z = 0;
    for (const el of this.elements.values()) z = Math.max(z, el.z || 0);
    return z;
  }

  minZ() {
    let z = 0;
    for (const el of this.elements.values()) z = Math.min(z, el.z || 0);
    return z;
  }

  // ================================================================== rendering

  renderAll() {
    const seen = new Set();
    for (const el of this.elements.values()) {
      this.renderEl(el);
      seen.add(el.id);
    }
    for (const [id, node] of this.nodes) {
      if (!seen.has(id)) { node.remove(); this.nodes.delete(id); }
    }
    for (const id of [...this.selection]) if (!this.elements.has(id)) this.selection.delete(id);
    if (!this.fitted && this.session && this.session.loaded) {
      this.fitted = true;
      const saved = this.app.views.get(this.session.boardId);
      if (saved) { this.view = { ...saved }; this.applyView(); } else this.fitAll();
    } else {
      this.applyView();
    }
    this.renderProps();
    this.updateUndoButtons();
  }

  onChange({ ids, remote }) {
    const lineDeps = new Set();
    for (const id of ids) {
      const el = this.elements.get(id);
      if (el) this.renderEl(el);
      else {
        this.nodes.get(id)?.remove();
        this.nodes.delete(id);
        if (this.selection.delete(id)) this.selectionChanged(false);
      }
      lineDeps.add(id);
    }
    for (const el of this.elements.values()) {
      if (el.type === 'line' && (lineDeps.has(el.startId) || lineDeps.has(el.endId))) this.renderEl(el);
    }
    if (this.commentOpen && ids.has(this.commentOpen.id)) this.renderCommentThread();
    this.renderOverlay();
    if (!this.gesture && (remote ? [...ids].some((id) => this.selection.has(id)) : true)) this.renderProps();
  }

  renderEl(el) {
    let node = this.nodes.get(el.id);
    if (!node || node.dataset.type !== el.type) {
      node?.remove();
      node = h('div', { class: `el el-${el.type}`, 'data-id': el.id, 'data-type': el.type });
      this.nodes.set(el.id, node);
      this.world.append(node);
    }
    node.style.zIndex = el.type === 'comment' ? '900000000' : String(Math.round(el.z || 0) + 100000);
    if (el.type !== 'line') {
      Object.assign(node.style, { left: `${el.x}px`, top: `${el.y}px`, width: `${el.w}px`, height: `${el.h}px` });
    }
    const fn = this[`draw_${el.type}`];
    if (fn) fn.call(this, el, node);
  }

  textNode(node, el, { align = 'center', valign = 'center' } = {}) {
    let txt = node.querySelector(':scope > .txt');
    if (!txt) {
      txt = h('div', { class: 'txt' }, h('span'));
      node.append(txt);
    }
    const span = txt.firstChild;
    const editing = this.editing && this.editing.id === el.id;
    if (!editing) {
      const key = JSON.stringify([el.text || '', el.list || '']);
      if (span.dataset.key !== key) {
        span.dataset.key = key;
        if (el.list) span.replaceChildren(...renderList(el.text || '', el.list));
        else span.textContent = el.text || '';
      }
    }
    Object.assign(txt.style, {
      fontFamily: fontStack(el.ff),
      fontSize: `${el.fs || 16}px`,
      color: el.tc || '#1a1a1a',
      textAlign: el.align || align,
      justifyContent: valign === 'top' ? 'flex-start' : 'center',
      fontWeight: el.bold ? '700' : '400',
      fontStyle: el.italic ? 'italic' : 'normal',
      textDecoration: el.underline ? 'underline' : 'none',
    });
    span.style.minHeight = '1.3em';
    return txt;
  }

  // Dash pattern: dl = dash length and dg = gap, both in stroke widths.
  dashArray(el, sw, defDash, defGap) {
    if (!el.dash) return '';
    return `${sw * (el.dl || defDash)} ${sw * (el.dg || defGap)}`;
  }

  draw_sticky(el, node) {
    node.style.background = withAlpha(el.fill || '#fff9b1', el.fo ?? 1);
    this.textNode(node, el);
  }

  draw_text(el, node) {
    const txt = this.textNode(node, el, { align: 'left', valign: 'top' });
    txt.style.color = canvasInk(el.tc);
  }

  draw_shape(el, node) {
    if (el.shape === 'custom') return this.drawCustomShape(el, node);
    node.querySelector(':scope > .custom-shape')?.remove();
    let s = node.querySelector('svg.shape');
    if (!s) {
      s = svg('svg', { class: 'shape' });
      s.append(svg('path', { 'stroke-linejoin': 'round' }), svg('path', { fill: 'none', class: 'deco' }));
      node.prepend(s);
    }
    s.setAttribute('viewBox', `0 0 ${el.w} ${el.h}`);
    const def = shapeDef(el.shape);
    const [path, deco] = s.children;
    path.setAttribute('d', def.d(el.w, el.h));
    path.setAttribute('fill', def.open ? 'none' : el.fill || 'transparent');
    path.setAttribute('fill-opacity', el.fo ?? 1);
    path.setAttribute('stroke-opacity', el.so ?? 1);
    deco.setAttribute('stroke-opacity', el.so ?? 1);
    deco.setAttribute('d', def.deco ? def.deco(el.w, el.h) : '');
    deco.setAttribute('stroke', el.stroke || 'transparent');
    deco.setAttribute('stroke-width', el.sw ?? 2);
    path.setAttribute('stroke', el.stroke || 'transparent');
    path.setAttribute('stroke-width', el.sw ?? 2);
    path.setAttribute('stroke-dasharray', this.dashArray(el, el.sw || 2, 3, 2));
    const onCanvas = def.open || !el.fill || el.fill === 'transparent';
    path.style.stroke = onCanvas ? canvasInk(el.stroke) : '';
    deco.style.stroke = path.style.stroke;
    const txt = this.textNode(node, el);
    if (onCanvas) txt.style.color = canvasInk(el.tc);
  }

  // ---------------------------------------------------------------- comments
  // A comment is a pin with a thread. Messages are separate fields (m_<id>) so replies never collide.
  commentMessages(el) {
    return Object.keys(el).filter((k) => k.startsWith('m_') && el[k] && typeof el[k] === 'object')
      .map((key) => ({ key, ...el[key] })).sort((a, b) => (a.ts || 0) - (b.ts || 0));
  }

  draw_comment(el, node) {
    const msgs = this.commentMessages(el);
    const first = msgs[0];
    node.classList.toggle('resolved', !!el.resolved);
    node.replaceChildren(h('div', { class: 'pin', style: { background: first ? first.c || '#4262ff' : 'var(--accent)' } },
      first ? (first.a || '?').slice(0, 1).toUpperCase() : '+',
      msgs.length > 1 ? h('span', { class: 'pin-count' }, String(msgs.length)) : null));
    node.title = first ? `${first.a}: ${first.t}` : t('Новый комментарий');
  }

  openComment(id, { fresh = false } = {}) {
    this.closeComment(true);
    this.commentOpen = { id, fresh };
    this.renderCommentThread();
    $('comment-popover').classList.remove('hidden');
    this.positionComment();
    setTimeout(() => $('comment-popover').querySelector('textarea')?.focus(), 0);
  }

  // Closing an empty new comment removes its pin.
  closeComment(silent = false) {
    const open = this.commentOpen;
    if (!open) return;
    this.commentOpen = null;
    $('comment-popover').classList.add('hidden');
    const el = this.elements.get(open.id);
    if (el && !this.commentMessages(el).length && this.session && this.session.canEdit) {
      this.selection.delete(el.id);
      this.do([{ k: 'del', id: el.id }]);
    }
    if (!silent) this.renderOverlay();
  }

  positionComment() {
    const pop = $('comment-popover');
    if (!this.commentOpen || pop.classList.contains('hidden')) return;
    const el = this.elements.get(this.commentOpen.id);
    if (!el) return this.closeComment();
    const p = this.toScreen(el.x, el.y);
    const vr = this.viewport.getBoundingClientRect();
    let left = p.x + 40, top = p.y - 8;
    if (left + pop.offsetWidth > vr.width - 8) left = p.x - pop.offsetWidth - 12;
    top = Math.max(66, Math.min(top, vr.height - pop.offsetHeight - 8));
    Object.assign(pop.style, { left: `${left}px`, top: `${top}px` });
  }

  renderCommentThread() {
    const pop = $('comment-popover');
    const el = this.commentOpen && this.elements.get(this.commentOpen.id);
    if (!el) return this.closeComment();
    const draft = pop.querySelector('textarea')?.value || '';
    const me = this.session.you || {};
    const msgs = this.commentMessages(el);
    const input = h('textarea', { rows: 2, placeholder: msgs.length ? t('Ответить…') : t('Напишите комментарий…') });
    input.value = draft;
    const send = () => {
      const t = input.value.trim();
      if (!t) return;
      input.value = '';
      this.do([{ k: 'upd', id: el.id, set: { [`m_${uid('')}`]: { t, a: this.session.user.name, cid: this.session.user.cid, c: me.color || '#4262ff', ts: Date.now() } } }]);
      this.commentOpen.fresh = false;
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
      if (e.key === 'Escape') this.closeComment();
    };
    const fmt = (ts) => new Date(ts).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    pop.replaceChildren(
      h('div', { class: 'cp-head' },
        h('b', {}, el.resolved ? t('Решено') : t('Комментарий')),
        msgs.length ? h('button', { class: 'btn icon', title: el.resolved ? t('Открыть снова') : t('Отметить решённым'), html: icon('check', 16),
          onclick: () => this.do([{ k: 'upd', id: el.id, set: { resolved: !el.resolved } }]) }) : null,
        msgs.length ? h('button', { class: 'btn icon', title: t('Удалить ветку'), html: icon('trash', 16),
          onclick: () => { const id = el.id; this.commentOpen = null; pop.classList.add('hidden'); this.do([{ k: 'del', id }]); } }) : null,
        h('button', { class: 'btn icon', title: t('Закрыть'), onclick: () => this.closeComment() }, '✕')),
      h('div', { class: 'cp-list' }, msgs.map((m) => h('div', { class: 'cp-msg' },
        h('div', { class: 'cp-meta' }, h('span', { class: 'cp-dot', style: { background: m.c } }), h('b', {}, m.a || t('Гость')), h('small', {}, fmt(m.ts)),
          m.cid === this.session.user.cid ? h('button', { class: 'cp-del', title: t('Удалить'), onclick: () => this.do([{ k: 'upd', id: el.id, set: { [m.key]: null } }]) }, '×') : null),
        h('div', { class: 'cp-text' }, m.t)))),
      h('div', { class: 'cp-input' }, input, h('button', { class: 'btn primary icon', title: t('Отправить (Enter)'), html: icon('send', 16), onclick: send })),
    );
    const list = pop.querySelector('.cp-list');
    list.scrollTop = list.scrollHeight;
    this.positionComment();
  }

  // ---------------------------------------------------------------- link cards
  safeUrl(url) {
    try {
      const u = new URL(url);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
    } catch {
      return null;
    }
  }

  openUrl(url) {
    const safe = this.safeUrl(url);
    if (safe) window.open(safe, '_blank', 'noopener');
  }

  draw_link(el, node) {
    const url = this.safeUrl(el.url) || '';
    let host = '';
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch {}
    const img = el.image && MEDIA_NAME_RE.test(el.image) ? this.session.mediaUrl(el.image) : '';
    const ico = el.icon && MEDIA_NAME_RE.test(el.icon) ? this.session.mediaUrl(el.icon) : '';
    const key = JSON.stringify([url, el.title, el.description, el.site, img, ico, el.loading]);
    if (node.dataset.key === key) return;
    node.dataset.key = key;
    node.classList.toggle('has-image', !!img);
    node.replaceChildren(
      img ? h('div', { class: 'lk-image' }, h('img', { src: img, alt: '', draggable: 'false' })) : null,
      h('div', { class: 'lk-body' },
        h('div', { class: 'lk-title lk-open', title: url }, el.title || host || url),
        el.description ? h('div', { class: 'lk-desc' }, el.description) : null,
        h('div', { class: 'lk-site' },
          ico ? h('img', { src: ico, alt: '' }) : h('span', { html: icon('link', 14) }),
          h('span', {}, el.loading ? t('Загрузка превью…') : el.site || host),
          h('span', { class: 'lk-open lk-go', title: t('Открыть ссылку') }, '↗'))),
    );
  }

  async addLink(url, at) {
    const safe = this.safeUrl(url);
    if (!safe) return;
    const w = 360, hh = 112;
    const el = this.addElement({ type: 'link', url: safe, title: '', x: round(at.x - w / 2), y: round(at.y - hh / 2), w, h: hh, loading: this.session.status === 'online' });
    if (!el || this.session.status !== 'online') return;
    try {
      const meta = await this.session.api.unfurl(this.session.boardId, safe);
      const cur = this.elements.get(el.id);
      if (!cur) return;
      const set = { title: meta.title, description: meta.description, site: meta.site, image: meta.image, icon: meta.icon, loading: false };
      if (meta.image) set.h = Math.round(cur.w * 0.52) + 104 + (meta.description ? 36 : 0);
      else if (meta.description) set.h = 148;
      // Not part of undo history: it completes the card that was just created.
      this.session.apply([{ k: 'upd', id: el.id, set }]);
      if (this.session.cacheEnabled) this.session.ensureMediaCached();
    } catch {
      if (this.elements.get(el.id)) this.session.apply([{ k: 'upd', id: el.id, set: { loading: false } }]);
    }
  }

  // ---------------------------------------------------------------- stickers
  async toggleStickers(show = $('sticker-panel').classList.contains('hidden')) {
    $('sticker-panel').classList.toggle('hidden', !show);
    if (!show) return;
    $('shape-library').classList.add('hidden');
    $('sticker-search').focus();
    const body = $('sticker-body');
    if (!this.stickerPacks || this.stickerServer !== this.session.server.url) {
      body.replaceChildren(h('p', { class: 'muted' }, t('Загрузка…')));
      try {
        this.stickerPacks = await this.session.api.stickers();
        this.stickerServer = this.session.server.url;
      } catch {
        body.replaceChildren(h('p', { class: 'muted' }, t('Стикеры доступны, когда есть связь с сервером.')));
        return;
      }
    }
    this.renderStickers();
  }

  renderStickers() {
    const body = $('sticker-body');
    const q = $('sticker-search').value.trim().toLowerCase();
    body.replaceChildren();
    for (const pack of this.stickerPacks || []) {
      const items = pack.items.filter((it) => !q || it.name.toLowerCase().includes(q) || pack.name.toLowerCase().includes(q));
      if (!items.length) continue;
      body.append(h('h4', { title: pack.license ? `${pack.source} · ${pack.license}` : '' }, pack.name), h('div', { class: 'sticker-grid' }, items.map((it) => {
        const url = `${this.session.server.url}${it.url}`;
        return h('button', {
          title: it.name, draggable: 'true',
          onclick: () => this.addSticker(url, this.viewCenter()),
          ondragstart: (e) => { e.dataTransfer.setData('application/x-liro-sticker', url); e.dataTransfer.effectAllowed = 'copy'; },
        }, h('img', { src: url, alt: it.name, loading: 'lazy' }));
      })));
    }
    if (!body.children.length) body.append(h('p', { class: 'muted' }, (this.stickerPacks || []).length ? t('Ничего не найдено') : t('На сервере нет стикер-паков.')));
  }

  // A sticker becomes an image on the board (copied into the board's media, so it works offline).
  async addSticker(url, at) {
    if (!this.session.canEdit) return this.readOnlyHint();
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const name = decodeURIComponent(url.split('/').pop());
      const info = await this.session.addMediaFile(new File([blob], name, { type: blob.type || 'image/svg+xml' }));
      const size = 140;
      this.addElement({ type: 'image', sticker: true, x: round(at.x - size / 2), y: round(at.y - size / 2), w: size, h: size, src: info.name, mime: info.mime, name: info.fileName, size: info.size });
    } catch (err) {
      toast(`${t('Не удалось добавить стикер')}: ${err.message}`, { error: true });
    }
  }

  draw_frame(el, node) {
    node.style.background = withAlpha(framePaper(el.fill), el.fo ?? 1);
    let title = node.querySelector('.frame-title');
    if (!title) {
      title = h('div', { class: 'frame-title' });
      node.append(title);
    }
    title.textContent = el.name || t('Фрейм');
  }

  mediaUrl(el) {
    return this.session ? this.session.mediaUrl(el.src) : '';
  }

  draw_image(el, node) {
    let img = node.querySelector('img');
    const url = this.mediaUrl(el);
    if (!img) {
      img = h('img', { draggable: 'false', alt: el.name || '' });
      img.onerror = () => { node.title = t('Изображение недоступно'); img.style.background = '#eee'; };
      node.append(img);
    }
    if (img.dataset.src !== el.src) {
      img.dataset.src = el.src;
      img.src = url;
    }
  }

  mediaHead(node, el, iconName) {
    let head = node.querySelector('.media-head');
    if (!head) {
      head = h('div', { class: 'media-head' }, h('i', { html: icon(iconName, 14) }), h('span'));
      node.append(head);
    }
    head.lastChild.textContent = el.name || '';
  }

  draw_video(el, node) {
    this.mediaHead(node, el, 'file');
    let v = node.querySelector('video');
    if (!v) {
      v = h('video', { controls: true, preload: 'metadata', playsinline: true });
      node.append(v);
    }
    if (v.dataset.src !== el.src) {
      v.dataset.src = el.src;
      v.src = this.mediaUrl(el);
    }
  }

  // Audio is just the player; a small grip on its left edge is used to drag it.
  draw_audio(el, node) {
    let a = node.querySelector('audio');
    if (!a) {
      a = h('audio', { controls: true, preload: 'metadata' });
      node.append(h('div', { class: 'audio-grip', title: t('Перетащить') }), a);
    }
    a.title = el.name || '';
    if (a.dataset.src !== el.src) {
      a.dataset.src = el.src;
      a.src = this.mediaUrl(el);
    }
  }

  draw_file(el, node) {
    this.mediaHead(node, el, 'file');
    let body = node.querySelector('.file-body');
    if (!body) {
      body = h('div', { class: 'file-body' });
      node.append(body);
    }
    body.replaceChildren(
      h('span', { html: icon('file', 28) }),
      h('div', {}, h('div', {}, fmtSize(el.size)),
        h('a', { href: this.mediaUrl(el), download: el.name || 'file', target: '_blank', onpointerdown: (e) => e.stopPropagation() }, t('Скачать'))),
    );
  }

  draw_pen(el, node) {
    let s = node.querySelector('svg');
    if (!s) {
      s = svg('svg', { preserveAspectRatio: 'none' });
      s.append(svg('path', { class: 'hit' }), svg('path', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      node.append(s);
    }
    Object.assign(s.style, { left: '0', top: '0' });
    s.setAttribute('width', el.w);
    s.setAttribute('height', el.h);
    s.setAttribute('viewBox', `0 0 ${el.pw || el.w || 1} ${el.ph || el.h || 1}`);
    const pts = el.pts || [];
    let d = smoothPath(pts);
    if (pts.length === 2) d += `L${pts[0] + 0.1},${pts[1]}`;
    const [hit, path] = s.children;
    hit.setAttribute('d', d);
    hit.setAttribute('stroke-width', Math.max(14, (el.sw || 3) + 10));
    path.setAttribute('d', d);
    path.setAttribute('stroke', el.stroke || '#1a1a1a');
    path.setAttribute('stroke-width', el.sw || 3);
    path.setAttribute('stroke-opacity', el.so ?? el.opacity ?? 1);
    path.style.stroke = canvasInk(el.stroke);
  }

  draw_line(el, node) {
    const geo = this.lineGeom(el);
    const sw = el.sw || 2;
    const pad = 24 + sw * 3;
    const xs = geo.pts.map((p) => p.x), ys = geo.pts.map((p) => p.y);
    const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
    const w = Math.max(...xs) - Math.min(...xs) + pad * 2, hgt = Math.max(...ys) - Math.min(...ys) + pad * 2;
    Object.assign(node.style, { left: `${minX}px`, top: `${minY}px`, width: `${w}px`, height: `${hgt}px` });
    let s = node.querySelector('svg');
    if (!s) {
      s = svg('svg');
      s.append(svg('path', { class: 'hit' }), svg('path', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
        svg('path', { class: 'heads' }), svg('path', { class: 'heads-open', fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      node.append(s);
    }
    s.setAttribute('width', w);
    s.setAttribute('height', hgt);
    Object.assign(s.style, { left: '0', top: '0' });
    s.setAttribute('viewBox', `${minX} ${minY} ${w} ${hgt}`);
    const [hit, path, heads, open] = s.children;
    hit.setAttribute('d', geo.d);
    hit.setAttribute('stroke-width', Math.max(14, sw + 10));
    path.setAttribute('d', geo.d);
    path.setAttribute('stroke-width', sw);
    path.setAttribute('stroke-dasharray', this.dashArray(el, sw, 4, 3));
    for (const p of [path, heads, open]) p.setAttribute('opacity', el.so ?? 1);
    const L = 8 + sw * 3, W = L * 0.55;
    let filled = '', stroked = '';
    const cap = (kind, p, u) => {
      const nx = -u.y, ny = u.x; // normal
      if (kind === 'arrow') filled += `M${p.x},${p.y} L${p.x - u.x * L + nx * W},${p.y - u.y * L + ny * W} L${p.x - u.x * L - nx * W},${p.y - u.y * L - ny * W}Z`;
      else if (kind === 'open') stroked += `M${p.x - u.x * L + nx * W},${p.y - u.y * L + ny * W} L${p.x},${p.y} L${p.x - u.x * L - nx * W},${p.y - u.y * L - ny * W}`;
      else if (kind === 'circle') { const r = 3 + sw; filled += `M${p.x - r},${p.y} a${r},${r} 0 1 0 ${r * 2},0 a${r},${r} 0 1 0 ${-r * 2},0Z`; }
      else if (kind === 'diamond') { const r = 4 + sw * 1.5; filled += `M${p.x},${p.y} L${p.x - u.x * r + nx * r * 0.6},${p.y - u.y * r + ny * r * 0.6} L${p.x - u.x * r * 2},${p.y - u.y * r * 2} L${p.x - u.x * r - nx * r * 0.6},${p.y - u.y * r - ny * r * 0.6}Z`; }
      else if (kind === 'bar') stroked += `M${p.x + nx * W},${p.y + ny * W} L${p.x - nx * W},${p.y - ny * W}`;
    };
    const [startCap, endCap] = this.caps(el);
    cap(endCap, geo.b, geo.endDir);
    cap(startCap, geo.a, geo.startDir);
    heads.setAttribute('d', filled);
    open.setAttribute('d', stroked);
    open.setAttribute('stroke-width', sw);
    const ink = canvasInk(el.stroke);
    path.style.stroke = ink;
    heads.style.fill = ink;
    open.style.stroke = ink;
    // Label in the middle of the line.
    const editing = this.editing && this.editing.id === el.id;
    const txt = this.textNode(node, el);
    txt.classList.add('line-label');
    Object.assign(txt.style, { left: `${geo.mid.x - minX}px`, top: `${geo.mid.y - minY}px`, display: el.text || editing ? '' : 'none' });
  }

  // ================================================================== overlay (selection, handles, cursors)

  renderOverlay() {
    const layer = this.selLayer;
    layer.replaceChildren();
    for (const [id, node] of this.nodes) node.classList.toggle('selected', this.selection.has(id));
    for (const [cid, ids] of this.peerSelections) {
      const peer = this.session && this.session.peers.get(cid);
      if (!peer) continue;
      for (const id of ids) {
        const el = this.elements.get(id);
        if (!el) continue;
        const r = this.screenRect(this.bounds(el));
        layer.append(h('div', { class: 'sel-box peer', style: { left: `${r.x - 3}px`, top: `${r.y - 3}px`, width: `${r.w + 6}px`, height: `${r.h + 6}px`, borderColor: peer.color } }));
      }
    }
    const sel = [...this.selection].map((id) => this.elements.get(id)).filter((el) => el && el.type !== 'comment');
    if (!sel.length) return;
    for (const el of sel) {
      if (el.type === 'line') continue;
      const r = this.screenRect(this.bounds(el));
      layer.append(h('div', { class: 'sel-box', style: { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` } }));
    }
    if (this.editing || (this.gesture && this.gesture.hideHandles)) return;
    if (sel.length === 1 && sel[0].type === 'line') {
      const [a, b] = this.linePoints(sel[0]).map((p) => this.toScreen(p.x, p.y));
      layer.append(
        h('div', { class: 'handle round', 'data-handle': 'p1', style: { left: `${a.x}px`, top: `${a.y}px`, cursor: 'move' } }),
        h('div', { class: 'handle round', 'data-handle': 'p2', style: { left: `${b.x}px`, top: `${b.y}px`, cursor: 'move' } }),
      );
      return;
    }
    const box = this.screenRect(unionRect(sel.map((el) => this.bounds(el))));
    if (sel.length > 1) {
      layer.append(h('div', { class: 'sel-box', style: { left: `${box.x - 4}px`, top: `${box.y - 4}px`, width: `${box.w + 8}px`, height: `${box.h + 8}px`, borderStyle: 'dashed' } }));
    }
    const pos = {
      nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
    };
    const cursors = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
    for (const dir of HANDLE_DIRS) {
      if ((dir.length === 1) && (box.w < 30 || box.h < 30) && (dir === 'n' || dir === 's' ? box.w < 30 : box.h < 30)) continue;
      const [fx, fy] = pos[dir];
      layer.append(h('div', { class: 'handle', 'data-handle': dir, style: { left: `${box.x + box.w * fx}px`, top: `${box.y + box.h * fy}px`, cursor: cursors[dir] } }));
    }
  }

  onRemoteCursor(msg) {
    if (msg.gone) {
      this.cursors.get(msg.cid)?.node.remove();
      this.cursors.delete(msg.cid);
      this.peerSelections.delete(msg.cid);
      this.renderOverlay();
      return;
    }
    let c = this.cursors.get(msg.cid);
    if (!c) {
      const node = h('div', { class: 'cursor', html: `<svg width="16" height="18" viewBox="0 0 16 18"><path d="M1 1l13 7-6 1.5L5 16z" fill="${msg.color}" stroke="#fff" stroke-width="1.2"/></svg>` },
        h('span', { style: { background: msg.color } }, msg.name));
      c = { node };
      this.cursors.set(msg.cid, c);
      this.cursorLayer.append(node);
    }
    c.x = msg.x;
    c.y = msg.y;
    c.at = Date.now();
    this.renderCursors();
  }

  renderCursors() {
    for (const c of this.cursors.values()) {
      const p = this.toScreen(c.x, c.y);
      c.node.style.transform = `translate(${p.x}px, ${p.y}px)`;
      c.node.style.opacity = Date.now() - c.at > 30000 ? '0.3' : '1';
    }
  }

  renderPeers() {
    const box = $('peers');
    box.replaceChildren();
    if (!this.session) return;
    for (const p of this.session.peers.values()) {
      box.append(h('div', { class: 'peer', title: p.name, style: { background: p.color } }, (p.name || '?').slice(0, 1).toUpperCase()));
    }
  }

  renderStatus() {
    const s = this.session;
    if (!s) return;
    const badge = $('sync-status');
    let cls = 'badge', text = '';
    const unsynced = s.offlineCount;
    if (s.status === 'local') { text = t('На этом компьютере'); }
    else if (s.awaitingDecision) { cls += ' warn'; text = t('Ожидает решения…'); }
    else if (s.status === 'online') {
      cls += ' ok';
      text = s.inflight.size || s.queue.length ? t('Сохранение…') : t('В сети');
    } else if (s.status === 'connecting' && !s.loaded) { text = t('Подключение…'); }
    else if (s.meta.pending) { cls += ' warn'; text = t('Не загружена на сервер'); }
    else if (s.cacheEnabled) { cls += ' warn'; text = unsynced ? t('Офлайн · изменений: {n}', { n: unsynced }) : t('Офлайн'); }
    else { cls += ' err'; text = t('Нет связи — только просмотр'); }
    badge.className = cls;
    badge.textContent = text;
    badge.title = s.status === 'local' ? t('Доска хранится только на этом компьютере')
      : s.status === 'online' ? `${t('Сервер')}: ${s.server.url}` : t('Нажмите, чтобы переподключиться');
    $('board-name').disabled = s.status !== 'online' && s.status !== 'local';
    $('cache-toggle').parentElement.classList.toggle('hidden', !native.cache || s.status === 'local' || !!s.meta.pending);
    for (const b of document.querySelectorAll('#tools button[data-tool]')) {
      b.disabled = !s.canEdit && !['select', 'hand'].includes(b.dataset.tool);
    }
    $('btn-upload').disabled = !s.canEdit || !s.canAdd;
    const disk = $('disk-status');
    const level = s.status === 'online' && s.disk ? s.disk.level : 'ok';
    disk.classList.toggle('hidden', level === 'ok');
    if (level !== 'ok') {
      const gb = (s.disk.free / 1024 ** 3).toFixed(1);
      disk.className = `badge ${level === 'full' ? 'err' : 'warn'}`;
      disk.textContent = level === 'full' ? t('Сервер заполнен ({gb} ГБ)', { gb }) : t('Мало места на сервере: {gb} ГБ', { gb });
      disk.title = level === 'full' ? t('Добавлять новое нельзя — только редактировать. Освободите место на сервере.') : t('Когда останется меньше 5 ГБ, добавлять новое станет нельзя.');
    }
    if (!s.canAdd) {
      for (const b of document.querySelectorAll('#tools button[data-tool]')) {
        if (!['select', 'hand', 'eraser'].includes(b.dataset.tool)) b.disabled = true;
      }
      $('btn-stickers').disabled = true;
    } else {
      $('btn-stickers').disabled = !s.canEdit;
    }
  }

  // ================================================================== editing primitives (undo-aware)

  beginTxn() {
    if (!this.txn) this.txn = { before: new Map(), depth: 0 };
    this.txn.depth += 1;
  }

  commitTxn() {
    if (!this.txn) return;
    this.txn.depth -= 1;
    if (this.txn.depth > 0) return;
    const { before } = this.txn;
    this.txn = null;
    if (!before.size) return;
    this.undoStack.push(before);
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
    this.updateUndoButtons();
  }

  // Applies ops through the session, remembering the previous state of touched elements for undo.
  do(ops) {
    ops = ops.filter(Boolean);
    if (!ops.length) return true;
    if (!this.session || !this.session.canEdit) {
      this.readOnlyHint();
      return false;
    }
    if (!this.session.canAdd && ops.some((op) => op.k === 'add' && !this.elements.has(op.el.id))) {
      this.diskHint();
      return false;
    }
    this.beginTxn();
    for (const op of ops) {
      const id = op.k === 'add' ? op.el.id : op.id;
      if (!this.txn.before.has(id)) this.txn.before.set(id, clone(this.elements.get(id)) || null);
    }
    const ok = this.session.apply(ops);
    this.commitTxn();
    return ok;
  }

  diskHint() {
    const now = Date.now();
    if (this.lastDiskHint && now - this.lastDiskHint < 3000) return;
    this.lastDiskHint = now;
    toast(t('На сервере заканчивается место: добавлять новое нельзя, можно только редактировать существующее.'), { error: true });
  }

  readOnlyHint() {
    const now = Date.now();
    if (this.lastHint && now - this.lastHint < 3000) return;
    this.lastHint = now;
    toast(this.session && this.session.awaitingDecision ? t('Сначала решите, что делать с офлайн-изменениями') : t('Нет связи с сервером — доска только для просмотра. Включите «Кешировать», чтобы работать офлайн.'));
  }

  // Ops that turn the current state of `ids` into `target` (Map id -> element|null).
  diffOps(target) {
    const ops = [];
    for (const [id, want] of target) {
      const cur = this.elements.get(id);
      if (!want && cur) ops.push({ k: 'del', id });
      else if (want && !cur) ops.push({ k: 'add', el: clone(want) });
      else if (want && cur) {
        const set = {};
        for (const k of new Set([...Object.keys(want), ...Object.keys(cur)])) {
          if (k === 'id') continue;
          if (JSON.stringify(want[k]) !== JSON.stringify(cur[k])) set[k] = want[k] === undefined ? null : clone(want[k]);
        }
        if (Object.keys(set).length) ops.push({ k: 'upd', id, set });
      }
    }
    return ops;
  }

  snapshot(ids) {
    return new Map([...ids].map((id) => [id, clone(this.elements.get(id)) || null]));
  }

  undo() { this.stepHistory(this.undoStack, this.redoStack); }

  redo() { this.stepHistory(this.redoStack, this.undoStack); }

  stepHistory(from, to) {
    if (this.editing) this.finishEdit();
    const entry = from.pop();
    if (!entry) return;
    if (!this.session.canEdit) {
      from.push(entry);
      return this.readOnlyHint();
    }
    const current = this.snapshot(entry.keys());
    this.session.apply(this.diffOps(entry));
    to.push(current);
    for (const id of [...this.selection]) if (!this.elements.has(id)) this.selection.delete(id);
    this.selectionChanged();
    this.updateUndoButtons();
  }

  updateUndoButtons() {
    $('btn-undo').disabled = !this.undoStack.length;
    $('btn-redo').disabled = !this.redoStack.length;
  }

  // ================================================================== selection

  select(ids, { add = false } = {}) {
    if (!add) this.selection.clear();
    if (this.modelViewer && !ids.includes(this.modelViewer.id)) this.stopModelViewer();
    if (this.tableSel && !ids.includes(this.tableSel.id)) this.clearCellSel();
    for (const id of ids) if (this.elements.has(id)) this.selection.add(id);
    this.selectionChanged();
  }

  selectionChanged(render = true) {
    if (render) {
      this.renderOverlay();
      this.renderProps();
    }
    if (this.session) this.session.sendSelection([...this.selection]);
  }

  selected() {
    return [...this.selection].map((id) => this.elements.get(id)).filter(Boolean);
  }

  deleteSelection() {
    const ids = [...this.selection];
    if (!ids.length) return;
    const ops = ids.map((id) => ({ k: 'del', id }));
    // Keep lines that pointed at deleted elements where they were.
    for (const el of this.elements.values()) {
      if (el.type !== 'line' || this.selection.has(el.id)) continue;
      const set = {};
      const [a, b] = this.linePoints(el);
      if (ids.includes(el.startId)) Object.assign(set, { startId: null, x1: a.x, y1: a.y });
      if (ids.includes(el.endId)) Object.assign(set, { endId: null, x2: b.x, y2: b.y });
      if (Object.keys(set).length) ops.push({ k: 'upd', id: el.id, set });
    }
    this.selection.clear();
    this.do(ops);
    this.selectionChanged();
  }

  // ================================================================== element creation

  addElement(partial, { select = true, edit = false } = {}) {
    const el = { id: uid('e'), z: this.maxZ() + 1, ...partial };
    if (!this.do([{ k: 'add', el }])) return null;
    if (select) this.select([el.id]);
    if (edit) requestAnimationFrame(() => this.startEdit(el.id));
    return el;
  }

  defaultsFor(tool, r) {
    switch (tool) {
      case 'sticky': return { type: 'sticky', w: 200, h: 200, fill: this.lastStickyFill || '#fff9b1', tc: '#1a1a1a', fs: 18, text: '' };
      case 'text': return { type: 'text', w: 260, h: 30, tc: DEFAULT_INK, fs: 22, text: '', align: 'left' };
      case 'shape': {
        const sq = SQUARE_SHAPES.has(this.shapeKind);
        const open = shapeDef(this.shapeKind).open;
        return { type: 'shape', shape: this.shapeKind, w: sq ? 160 : open ? 60 : 200, h: sq ? 160 : 120, fill: open ? 'transparent' : '#ffffff', stroke: '#1a1a1a', sw: 2, tc: '#1a1a1a', fs: 16, text: '' };
      }
      case 'checklist': {
        const key = `i_${uid('')}`;
        return { type: 'checklist', w: 320, h: 120, title: t('Список задач'), fs: 16, [key]: { t: '', d: false, o: 1 } };
      }
      case 'frame': return { type: 'frame', w: 800, h: 560, fill: DEFAULT_FRAME, name: `${t('Фрейм')} ${[...this.elements.values()].filter((e) => e.type === 'frame').length + 1}` };
      default: return r;
    }
  }

  // ================================================================== text editing

  startEdit(id) {
    const el = this.elements.get(id);
    const node = this.nodes.get(id);
    if (!el || !node || !TEXT_TYPES.has(el.type)) return;
    if (!this.session.canEdit) return this.readOnlyHint();
    if (this.editing) this.finishEdit();
    const span = node.querySelector('.txt > span');
    if (!span) return;
    span.textContent = el.text || ''; // raw text (list markers are only drawn when not editing)
    span.dataset.key = '';
    this.select([id]);
    this.beginTxn();
    this.txn.before.set(id, clone(el));
    this.editing = { id, span };
    try { span.contentEditable = 'plaintext-only'; } catch { span.contentEditable = 'true'; }
    if (span.contentEditable !== 'plaintext-only') span.contentEditable = 'true';
    span.focus();
    const range = document.createRange();
    range.selectNodeContents(span);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    span.oninput = () => this.autosizeText(id);
    span.onblur = () => this.finishEdit();
    span.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); span.blur(); }
      if (e.key === 'Tab') {
        e.preventDefault();
        indentCaretLine(span, e.shiftKey ? -1 : 1);
      }
    };
    span.onpaste = (e) => {
      e.preventDefault();
      e.stopPropagation();
      document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
    };
    this.renderOverlay();
    this.hideProps();
  }

  autosizeText(id) {
    const el = this.elements.get(id);
    const node = this.nodes.get(id);
    if (!el || el.type !== 'text' || !node) return;
    const span = node.querySelector('.txt > span');
    const need = Math.ceil(span.scrollHeight);
    if (Math.abs(need - el.h) > 1) {
      node.style.height = `${need}px`;
      this.session.apply([{ k: 'upd', id, set: { h: need } }]);
    }
  }

  finishEdit() {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    const { id, span } = ed;
    span.onblur = span.oninput = span.onkeydown = span.onpaste = null;
    span.removeAttribute('contenteditable');
    getSelection().removeAllRanges();
    const text = span.innerText.replace(/\n$/, '');
    const el = this.elements.get(id);
    if (el) {
      if (el.type === 'text' && !text.trim()) {
        this.selection.delete(id);
        this.do([{ k: 'del', id }]);
      } else {
        const set = { text };
        if (el.type === 'text') set.h = Math.max(Math.ceil(span.scrollHeight), Math.ceil((el.fs || 16) * 1.3));
        this.do([{ k: 'upd', id, set }]);
      }
    }
    this.commitTxn();
    this.viewport.focus({ preventScroll: true });
    this.renderOverlay();
    this.renderProps();
  }

  // ================================================================== tools

  setTool(tool) {
    this.tool = tool;
    for (const b of document.querySelectorAll('#tools button[data-tool]')) {
      b.classList.toggle('active', b.dataset.tool === tool || (b.dataset.tool === 'shape' && tool === 'line'));
    }
    this.viewport.className = `tool-${tool}`;
    $('shape-picker').classList.add('hidden');
    this.renderLibrary();
    if (tool !== 'select' && tool !== 'hand') {
      if (this.selection.size) this.select([]);
    }
  }

  // Miro-like menu: line variants, quick shapes, divider and the full library.
  showShapePicker() {
    const picker = $('shape-picker');
    const lineIcon = (kind) => icon({ line: 'line2', arrow: 'line', elbow: 'elbow', curve: 'curve', divider: 'divider' }[kind], 18);
    const item = (html, label, key, active, onclick) => h('button', { class: `menu-item${active ? ' active' : ''}`, onclick },
      h('span', { class: 'mi-icon', html }), h('span', { class: 'mi-label' }, label), key ? h('kbd', {}, key) : null);
    const isLine = this.tool === 'line';
    picker.replaceChildren(
      ...['line', 'arrow', 'elbow', 'curve'].map((k) => item(lineIcon(k), t(LINE_KINDS[k].name), LINE_KINDS[k].key, isLine && this.lineKind === k, () => this.pickLine(k))),
      item(shapeIcon('arrow-right', 18), t('Блочная стрелка'), '', this.tool === 'shape' && this.shapeKind === 'arrow-right', () => this.pickShape('arrow-right')),
      h('hr'),
      ...[['rect', 'R'], ['ellipse', 'O'], ['diamond', ''], ['triangle', '']].map(([k, key]) => item(shapeIcon(k, 18), t(shapeDef(k).name), key, this.tool === 'shape' && this.shapeKind === k, () => this.pickShape(k))),
      item(lineIcon('divider'), t(LINE_KINDS.divider.name), '', isLine && this.lineKind === 'divider', () => this.pickLine('divider')),
      h('hr'),
      item(icon('shape', 18), t('Больше фигур…'), '', false, () => { picker.classList.add('hidden'); this.toggleLibrary(true); }),
    );
    const btn = document.querySelector('#tools button[data-tool="shape"]').getBoundingClientRect();
    Object.assign(picker.style, { left: `${btn.right + 10}px`, top: `${Math.max(66, btn.top - 120)}px` });
    picker.classList.remove('hidden');
  }

  pickLine(kind) {
    this.lineKind = kind;
    this.setTool('line');
  }

  pickShape(kind) {
    this.shapeKind = kind;
    this.setTool('shape');
  }

  toggleLibrary(show = $('shape-library').classList.contains('hidden')) {
    $('shape-library').classList.toggle('hidden', !show);
    if (show) $('sticker-panel').classList.add('hidden');
    if (show) {
      this.renderLibrary();
      $('shape-search').focus();
    }
  }

  renderLibrary() {
    const panel = $('shape-library');
    if (panel.classList.contains('hidden')) return;
    const q = $('shape-search').value.trim().toLowerCase();
    const body = $('shape-library-body');
    body.replaceChildren();
    for (const cat of SHAPE_CATEGORIES) {
      const kinds = Object.entries(SHAPE_DEFS).filter(([id, d]) => d.cat === cat.id
        && (!q || `${id} ${d.name} ${t(d.name)} ${d.kw || ''}`.toLowerCase().includes(q)));
      if (!kinds.length) continue;
      body.append(h('h4', {}, t(cat.name)), h('div', { class: 'lib-grid' }, kinds.map(([id, d]) => h('button', {
        class: this.tool === 'shape' && this.shapeKind === id ? 'active' : '',
        title: t(d.name), html: shapeIcon(id, 26), draggable: 'true',
        onclick: () => this.pickShape(id),
        ondragstart: (e) => { e.dataTransfer.setData('application/x-liro-shape', id); e.dataTransfer.effectAllowed = 'copy'; },
      }))));
    }
    const before = body.children.length;
    this.renderCustomShapes(body, q);
    if (!before && body.querySelectorAll('.lib-grid').length === 0) body.append(h('p', { class: 'muted' }, t('Ничего не найдено')));
  }

  // ================================================================== pointer handling

  bindUi() {
    for (const b of document.querySelectorAll('#tools button[data-tool]')) {
      b.innerHTML = icon(b.dataset.tool);
      b.onclick = () => {
        if (b.dataset.tool === 'shape') {
          if (!['shape', 'line'].includes(this.tool)) this.setTool('shape');
          this.showShapePicker();
        } else this.setTool(b.dataset.tool);
      };
    }
    $('btn-upload').innerHTML = icon('upload');
    $('btn-stickers').innerHTML = icon('sticker');
    $('btn-stickers').onclick = () => this.toggleStickers();
    $('sticker-panel-close').onclick = () => this.toggleStickers(false);
    $('sticker-search').oninput = () => this.renderStickers();
    $('shape-library-close').onclick = () => this.toggleLibrary(false);
    $('shape-search').oninput = () => this.renderLibrary();
    $('btn-undo').innerHTML = icon('undo');
    $('btn-redo').innerHTML = icon('redo');
    $('btn-upload').onclick = () => $('file-input').click();
    $('file-input').onchange = (e) => {
      const files = [...e.target.files];
      e.target.value = '';
      this.addFiles(files, this.viewCenter());
    };
    $('btn-undo').onclick = () => this.undo();
    $('btn-redo').onclick = () => this.redo();
    $('zoom-in').onclick = () => this.zoomCenter(1.25);
    $('zoom-out').onclick = () => this.zoomCenter(0.8);
    $('zoom-level').onclick = () => this.zoomCenter(1 / this.view.z);
    $('zoom-fit').onclick = () => this.fitAll();
    $('sync-status').onclick = () => this.session && this.session.retryNow();
    $('board-name').onchange = async (e) => {
      const name = e.target.value.trim();
      if (!name || !this.session) return;
      try {
        if (this.session.server.local) await this.app.renameCachedBoard(this.session.server, this.session.boardId, name);
        else await this.session.api.renameBoard(this.session.boardId, name);
        this.session.meta.name = name;
        this.session.saveNow();
      } catch (err) {
        toast(`${t('Не удалось переименовать')}: ${err.message}`, { error: true });
        e.target.value = this.session.meta.name;
      }
    };
    $('board-name').onkeydown = (e) => { if (e.key === 'Enter') e.target.blur(); };
    $('btn-board-backup').onclick = () => this.backupMenu();
    $('cache-toggle').onchange = async (e) => {
      const s = this.session;
      if (!s) return;
      if (!e.target.checked && s.offlineCount) {
        e.target.checked = true;
        return toast(t('Есть несинхронизированные изменения — сначала подключитесь к серверу'), { error: true });
      }
      await s.setCacheEnabled(e.target.checked);
      this.app.setCached(s.server, s.boardId, e.target.checked);
      toast(e.target.checked ? t('Доска и её файлы будут храниться на этом компьютере') : t('Локальная копия удалена'));
      this.renderStatus();
    };

    const vp = this.viewport;
    vp.addEventListener('pointerdown', (e) => this.onPointerDown(e));
    window.addEventListener('pointermove', (e) => this.onPointerMove(e));
    window.addEventListener('pointerup', (e) => this.onPointerUp(e));
    window.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    vp.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    vp.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.cl-check')) e.preventDefault(); });
    vp.addEventListener('contextmenu', (e) => e.preventDefault());
    vp.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    vp.addEventListener('dragover', (e) => {
      const types = [...e.dataTransfer.types];
      if (types.includes('application/x-liro-shape') || types.includes('application/x-liro-sticker') || (types.includes('text/uri-list') && !types.includes('Files'))) {
        e.preventDefault();
        return;
      }
      if (!types.includes('Files')) return;
      e.preventDefault();
      $('drop-hint').classList.remove('hidden');
    });
    vp.addEventListener('dragleave', (e) => { if (e.target === vp || !vp.contains(e.relatedTarget)) $('drop-hint').classList.add('hidden'); });
    vp.addEventListener('drop', (e) => {
      $('drop-hint').classList.add('hidden');
      const shape = e.dataTransfer.getData('application/x-liro-shape');
      const sticker = e.dataTransfer.getData('application/x-liro-sticker');
      const uri = (e.dataTransfer.getData('text/uri-list') || '').split('\n').find((l) => /^https?:\/\//.test(l.trim()));
      if (uri && !e.dataTransfer.files.length && !shape && !sticker) {
        e.preventDefault();
        return this.addLink(uri.trim(), this.toWorld(e.clientX, e.clientY));
      }
      if (shape || sticker) {
        e.preventDefault();
        const p = this.toWorld(e.clientX, e.clientY);
        if (sticker) return this.addSticker(sticker, p);
        this.shapeKind = shape;
        const base = this.defaultsFor('shape');
        if (shape.startsWith('custom:')) return this.createCustomShape(shape.slice(7), { x: p.x - 80, y: p.y - 80, w: 160, h: 160 });
        this.addElement({ ...base, x: round(p.x - base.w / 2), y: round(p.y - base.h / 2) });
        return;
      }
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      this.addFiles([...e.dataTransfer.files], this.toWorld(e.clientX, e.clientY));
    });
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') { this.spaceDown = false; vp.classList.remove('panning'); }
    });
    document.addEventListener('copy', (e) => this.onCopy(e));
    document.addEventListener('cut', (e) => { if (this.onCopy(e)) this.deleteSelection(); });
    document.addEventListener('paste', (e) => this.onPaste(e));
    window.addEventListener('resize', () => this.applyView());
    setInterval(() => this.renderCursors(), 5000);
  }

  active() {
    return this.session && !$('board').classList.contains('hidden') && !document.querySelector('.modal-back');
  }

  onPointerDown(e) {
    if (!this.session) return;
    $('shape-picker').classList.add('hidden');
    this.closePalette();
    const target = e.target;
    if (this.commentOpen && !target.closest('.el-comment')) this.closeComment();
    if (this.editingCell) {
      if (this.editingCell.span.contains(target)) return;
      this.finishCellEdit();
    }
    if (this.editing) {
      if (this.editing.span.contains(target)) return;
      this.finishEdit();
    }
    // Form fields keep their own behaviour (checklist checkboxes are handled by the board below).
    if (target.closest('input, textarea, select') && !target.closest('.cl-check')) return;
    const p = this.toWorld(e.clientX, e.clientY);
    const start = { sx: e.clientX, sy: e.clientY, p, moved: false, pointerId: e.pointerId };

    if (e.button === 1 || e.button === 2 || this.tool === 'hand' || this.spaceDown) {
      e.preventDefault();
      return this.startGesture({ ...start, kind: 'pan', vx: this.view.x, vy: this.view.y });
    }
    if (e.button !== 0) return;
    this.viewport.focus({ preventScroll: true });

    const handle = target.closest('.handle');
    if (handle) {
      e.preventDefault();
      const dir = handle.dataset.handle;
      if (dir === 'p1' || dir === 'p2') return this.startEndpointDrag(start, dir);
      return this.startResize(start, dir, e.shiftKey);
    }

    const node = target.closest('.el');
    const el = node && this.elements.get(node.dataset.id);

    if (el && el.type === 'comment' && (this.tool === 'select' || this.tool === 'comment')) {
      e.preventDefault();
      this.select([el.id]);
      this.openComment(el.id);
      return this.startMove(start, el.id);
    }

    if (el && el.type === 'link' && this.tool === 'select' && target.closest('.lk-open')) {
      e.preventDefault();
      this.openUrl(el.url);
      return;
    }

    if (el && el.type === 'checklist' && this.tool === 'select') {
      if (target.closest('.cl-check')) {
        e.preventDefault();
        const key = target.closest('.cl-row').dataset.key;
        if (this.session.canEdit) this.toggleItem(el.id, key); else this.readOnlyHint();
        return;
      }
      if (target.closest('.cl-add')) { e.preventDefault(); this.addItem(el.id, this.activeRow && this.activeRow.id === el.id ? this.activeRow.key : null); return; }
      if (target.closest('.cl-del')) { e.preventDefault(); this.removeItem(el.id, target.closest('.cl-row').dataset.key); return; }
      if (target.closest('.cl-drag')) {
        e.preventDefault();
        if (!this.session.canEdit) return this.readOnlyHint();
        return this.startGesture({ ...start, kind: 'clrow', id: el.id, key: target.closest('.cl-row').dataset.key });
      }
      if (this.editingItem && this.editingItem.span.contains(target)) return;
      const row = target.closest('.cl-row');
      if (row) this.setActiveRow(el.id, row.dataset.key);
    }

    switch (this.tool) {
      case 'select': {
        if (el && el.type === 'frame' && !target.closest('.frame-title')) {
          return this.startGesture({ ...start, kind: 'marquee', add: e.shiftKey, clickFrame: el.id });
        }
        if (!el) return this.startGesture({ ...start, kind: 'marquee', add: e.shiftKey });
        const nativeControl = target.closest('video, audio, a');
        if (nativeControl && this.selection.has(el.id)) return; // let the media controls work
        if (nativeControl && nativeControl.tagName === 'AUDIO') {
          // The audio player is always usable; clicking it only selects it (drag it by its grip).
          if (!this.selection.has(el.id)) this.select([el.id], { add: e.shiftKey });
          return;
        }
        const cell = el.type === 'table' && this.selection.has(el.id) && target.closest('.tb-cell');
        if (cell) {
          // Table already selected: a click picks a cell (Shift extends the range), a drag still moves the table.
          e.preventDefault();
          return this.startMove(start, el.id, { tableCell: { id: el.id, r: cell.dataset.r, c: cell.dataset.c, extend: e.shiftKey } });
        }
        if (this.tableSel && this.tableSel.id !== el.id) this.clearCellSel();
        if (e.shiftKey) {
          if (this.selection.has(el.id)) {
            this.selection.delete(el.id);
            this.selectionChanged();
            return;
          }
          this.selection.add(el.id);
          this.selectionChanged();
        } else if (!this.selection.has(el.id)) {
          this.select([el.id]);
        }
        if (!nativeControl) e.preventDefault();
        return this.startMove(start, el.id);
      }
      case 'board':
        e.preventDefault();
        this.createSubBoard(p);
        return;
      case 'table': {
        e.preventDefault();
        const tb = makeTable(4, 3);
        this.addElement({ ...tb, x: round(p.x - tb.w / 2), y: round(p.y - tb.h / 2) });
        this.setTool('select');
        return;
      }
      case 'calendar':
        e.preventDefault();
        this.createCalendar(p);
        return;
      case 'comment': {
        e.preventDefault();
        const on = this.hitTest(p, (x) => x.type !== 'frame' && x.type !== 'comment' && x.type !== 'line');
        const c = this.addElement({ type: 'comment', x: round(p.x), y: round(p.y - 32 / this.view.z), w: 32, h: 32, attachTo: on ? on.id : null, resolved: false });
        this.setTool('select');
        if (c) this.openComment(c.id, { fresh: true });
        return;
      }
      case 'sticky': case 'text': case 'shape': case 'frame': case 'checklist':
        e.preventDefault();
        return this.startGesture({ ...start, kind: 'create', tool: this.tool });
      case 'line': {
        e.preventDefault();
        const from = this.hitTest(p, (x) => this.bindable(x));
        return this.startGesture({ ...start, kind: 'line', startId: from ? from.id : null });
      }
      case 'pen':
        e.preventDefault();
        return this.startGesture({ ...start, kind: 'pen', pts: [p.x, p.y] });
      case 'eraser':
        e.preventDefault();
        this.beginTxn();
        this.startGesture({ ...start, kind: 'erase' });
        return this.eraseAt(e);
      default:
    }
  }

  startGesture(g) {
    this.gesture = g;
    try { this.viewport.setPointerCapture(g.pointerId); } catch {}
  }

  startMove(start, clickedId, extra = {}) {
    const moving = new Set(this.selection);
    // Moving a frame drags the elements lying inside it.
    for (const id of this.selection) {
      const f = this.elements.get(id);
      if (!f || f.type !== 'frame') continue;
      for (const el of this.elements.values()) {
        if (el.id !== f.id && !moving.has(el.id) && rectContains(this.bounds(f), this.bounds(el))) moving.add(el.id);
      }
    }
    // Comments pinned to a moved element travel with it.
    for (const el of this.elements.values()) {
      if (el.type === 'comment' && el.attachTo && moving.has(el.attachTo)) moving.add(el.id);
    }
    const origin = new Map();
    const lineEnds = new Map();
    for (const id of moving) {
      const el = this.elements.get(id);
      if (!el) continue;
      origin.set(id, clone(el));
      if (el.type === 'line') lineEnds.set(id, this.linePoints(el));
    }
    this.startGesture({ ...start, ...extra, kind: 'move', origin, lineEnds, clickedId, hideHandles: true, snap: this.snapTargets(origin) });
  }

  startResize(start, dir, shift) {
    const sel = this.selected();
    if (!sel.length) return;
    const box = unionRect(sel.map((el) => this.bounds(el)));
    const origin = new Map(sel.map((el) => [el.id, clone(el)]));
    const keepRatio = shift || sel.some((el) => ['image', 'video'].includes(el.type)) || (sel.length > 1);
    this.startGesture({ ...start, kind: 'resize', dir, box, origin, keepRatio, hideHandles: true, snap: this.snapTargets(origin) });
  }

  startEndpointDrag(start, which) {
    const el = this.selected()[0];
    if (!el) return;
    this.startGesture({ ...start, kind: 'endpoint', which, id: el.id, origin: clone(el), hideHandles: true });
  }

  onPointerMove(e) {
    if (this.session && this.active() && e.target.closest && e.target.closest('#viewport')) {
      const now = performance.now();
      if (!this.lastCursorSent || now - this.lastCursorSent > 50) {
        this.lastCursorSent = now;
        const p = this.toWorld(e.clientX, e.clientY);
        this.session.sendCursor(round(p.x), round(p.y));
      }
    }
    this.lastPointer = { x: e.clientX, y: e.clientY };
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) < 3) return;
    if (!g.moved) {
      g.moved = true;
      if (['move', 'resize', 'endpoint'].includes(g.kind)) {
        this.beginTxn();
        for (const id of g.origin ? (g.origin instanceof Map ? g.origin.keys() : [g.id]) : []) {
          if (!this.txn.before.has(id)) this.txn.before.set(id, clone(this.elements.get(id)) || null);
        }
        this.hideProps();
      }
    }
    g.last = e;
    if (g.kind === 'pan') {
      this.view.x = g.vx + (e.clientX - g.sx);
      this.view.y = g.vy + (e.clientY - g.sy);
      this.applyView();
      return;
    }
    if (g.kind === 'erase') return this.eraseAt(e);
    if (!g.raf) {
      g.raf = requestAnimationFrame(() => {
        g.raf = 0;
        if (this.gesture === g) this.gestureFrame(g, g.last);
      });
    }
  }

  gestureFrame(g, e) {
    const p = this.toWorld(e.clientX, e.clientY);
    const dx = p.x - g.p.x, dy = p.y - g.p.y;
    switch (g.kind) {
      case 'move': {
        // Snap the moved group's edges/centres to other elements (hold Alt to move freely).
        const box = unionRect([...g.origin.values()].filter((o) => o.type !== 'line').map((o) => this.bounds(o)));
        let sdx = dx, sdy = dy;
        if (box && !e.altKey) {
          const moved = { x: box.x + dx, y: box.y + dy, w: box.w, h: box.h };
          const sx = this.snapAxis(g.snap.xs, [moved.x, moved.x + moved.w / 2, moved.x + moved.w]);
          const sy = this.snapAxis(g.snap.ys, [moved.y, moved.y + moved.h / 2, moved.y + moved.h]);
          sdx += sx.delta;
          sdy += sy.delta;
          this.drawGuides(sx, sy, { x: box.x + sdx, y: box.y + sdy, w: box.w, h: box.h });
        } else this.drawGuides(null, null);
        return this.moveFrame(g, sdx, sdy);
      }
      case 'resize': {
        let q = p;
        if (!e.altKey) {
          const sx = g.dir.match(/[ew]/) ? this.snapAxis(g.snap.xs, [p.x]) : { delta: 0 };
          const sy = g.dir.match(/[ns]/) ? this.snapAxis(g.snap.ys, [p.y]) : { delta: 0 };
          q = { x: p.x + sx.delta, y: p.y + sy.delta };
          this.drawGuides(sx.delta || sx.hit ? sx : null, sy.delta || sy.hit ? sy : null, null);
        }
        return this.resizeFrame(g, q, e.shiftKey);
      }
      case 'endpoint': return this.endpointFrame(g, p);
      case 'marquee': case 'create': return this.drawRubber(g, p);
      case 'clrow': return this.dragRowFrame(g, e);
      case 'line': return this.drawRubberLine(g, this.constrainLine(g.p, p, e.shiftKey));
      case 'pen': {
        const last = g.pts.length - 2;
        if (Math.hypot(p.x - g.pts[last], p.y - g.pts[last + 1]) * this.view.z > 1.5) g.pts.push(round(p.x), round(p.y));
        return this.drawPenPreview(g);
      }
      default:
    }
  }

  moveFrame(g, dx, dy) {
    const ops = [];
    for (const [id, o] of g.origin) {
      if (!this.elements.has(id)) continue;
      if (o.type === 'line') {
        // An end bound to an element that moves along stays bound; otherwise the end moves freely.
        const [a, b] = g.lineEnds.get(id);
        const set = {};
        if (!(o.startId && g.origin.has(o.startId))) Object.assign(set, { x1: round(a.x + dx), y1: round(a.y + dy), startId: null });
        if (!(o.endId && g.origin.has(o.endId))) Object.assign(set, { x2: round(b.x + dx), y2: round(b.y + dy), endId: null });
        ops.push({ k: 'upd', id, set });
      } else if (o.type === 'comment' && this.selection.has(id) && o.attachTo && !g.origin.has(o.attachTo)) {
        ops.push({ k: 'upd', id, set: { x: round(o.x + dx), y: round(o.y + dy), attachTo: null } }); // dragged off its element
      } else {
        ops.push({ k: 'upd', id, set: { x: round(o.x + dx), y: round(o.y + dy) } });
      }
    }
    this.session.apply(ops);
  }

  resizeFrame(g, p, shift) {
    const b = g.box;
    let x1 = b.x, y1 = b.y, x2 = b.x + b.w, y2 = b.y + b.h;
    if (g.dir.includes('w')) x1 = Math.min(p.x, x2 - 8);
    if (g.dir.includes('e')) x2 = Math.max(p.x, x1 + 8);
    if (g.dir.includes('n')) y1 = Math.min(p.y, y2 - 8);
    if (g.dir.includes('s')) y2 = Math.max(p.y, y1 + 8);
    let w = x2 - x1, hh = y2 - y1;
    if ((g.keepRatio || shift) && g.dir.length === 2 && b.w && b.h) {
      const k = Math.max(w / b.w, hh / b.h);
      w = b.w * k;
      hh = b.h * k;
      if (g.dir.includes('w')) x1 = x2 - w;
      if (g.dir.includes('n')) y1 = y2 - hh;
    }
    const sx = b.w ? w / b.w : 1, sy = b.h ? hh / b.h : 1;
    const mx = (x) => round(x1 + (x - b.x) * sx);
    const my = (y) => round(y1 + (y - b.y) * sy);
    const ops = [];
    for (const [id, o] of g.origin) {
      if (o.type === 'line') {
        const set = {};
        if (!o.startId || !g.origin.has(o.startId)) Object.assign(set, { x1: mx(o.x1), y1: my(o.y1) });
        if (!o.endId || !g.origin.has(o.endId)) Object.assign(set, { x2: mx(o.x2), y2: my(o.y2) });
        ops.push({ k: 'upd', id, set });
      } else {
        const set = { x: mx(o.x), y: my(o.y), w: Math.max(4, round(o.w * sx)), h: Math.max(4, round(o.h * sy)) };
        ops.push({ k: 'upd', id, set });
      }
    }
    this.session.apply(ops);
  }

  // Edges and centres of elements near the viewport, used for snapping.
  snapTargets(exclude) {
    const r = this.viewport.getBoundingClientRect();
    const a = this.toWorld(r.left, r.top), b = this.toWorld(r.right, r.bottom);
    const view = { x: a.x - (b.x - a.x), y: a.y - (b.y - a.y), w: (b.x - a.x) * 3, h: (b.y - a.y) * 3 };
    const xs = [], ys = [];
    for (const el of this.elements.values()) {
      if (exclude.has(el.id) || el.type === 'line' || el.type === 'comment') continue;
      const bb = this.bounds(el);
      if (!rectsIntersect(view, bb)) continue;
      xs.push({ v: bb.x, bb }, { v: bb.x + bb.w / 2, bb }, { v: bb.x + bb.w, bb });
      ys.push({ v: bb.y, bb }, { v: bb.y + bb.h / 2, bb }, { v: bb.y + bb.h, bb });
    }
    return { xs, ys };
  }

  // Finds the closest target line for any of `values`; returns the correction and the matched target.
  snapAxis(targets, values) {
    const threshold = 6 / this.view.z;
    let best = null;
    for (const v of values) {
      for (const t of targets) {
        const d = t.v - v;
        if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.delta))) best = { delta: d, v: t.v, bb: t.bb, hit: true };
      }
    }
    return best || { delta: 0 };
  }

  drawGuides(sx, sy, box) {
    this.overlay.querySelectorAll('.guide').forEach((n) => n.remove());
    const line = (x1, y1, x2, y2) => {
      const a = this.toScreen(x1, y1), b = this.toScreen(x2, y2);
      this.overlay.append(h('div', { class: 'guide', style: {
        left: `${Math.min(a.x, b.x)}px`, top: `${Math.min(a.y, b.y)}px`,
        width: `${Math.max(1, Math.abs(b.x - a.x))}px`, height: `${Math.max(1, Math.abs(b.y - a.y))}px`,
      } }));
    };
    if (sx && sx.hit) {
      const ys = [sx.bb.y, sx.bb.y + sx.bb.h, ...(box ? [box.y, box.y + box.h] : [])];
      line(sx.v, Math.min(...ys) - 10, sx.v, Math.max(...ys) + 10);
    }
    if (sy && sy.hit) {
      const xs = [sy.bb.x, sy.bb.x + sy.bb.w, ...(box ? [box.x, box.x + box.w] : [])];
      line(Math.min(...xs) - 10, sy.v, Math.max(...xs) + 10, sy.v);
    }
  }

  align(mode) {
    const els = this.selected().filter((el) => el.type !== 'line' && el.type !== 'comment');
    if (els.length < 2) return;
    const box = unionRect(els.map((el) => this.bounds(el)));
    let ops;
    if (mode === 'distH' || mode === 'distV') {
      const horiz = mode === 'distH';
      const sorted = [...els].sort((a, b) => (horiz ? a.x + a.w / 2 - b.x - b.w / 2 : a.y + a.h / 2 - b.y - b.h / 2));
      const total = sorted.reduce((sum, el) => sum + (horiz ? el.w : el.h), 0);
      const gap = ((horiz ? box.w : box.h) - total) / (sorted.length - 1);
      let pos = horiz ? box.x : box.y;
      ops = sorted.map((el) => {
        const set = horiz ? { x: round(pos) } : { y: round(pos) };
        pos += (horiz ? el.w : el.h) + gap;
        return { k: 'upd', id: el.id, set };
      });
    } else {
      ops = els.map((el) => {
        const set = {
          left: { x: box.x }, centerH: { x: box.x + (box.w - el.w) / 2 }, right: { x: box.x + box.w - el.w },
          top: { y: box.y }, middle: { y: box.y + (box.h - el.h) / 2 }, bottom: { y: box.y + box.h - el.h },
        }[mode];
        for (const k of Object.keys(set)) set[k] = round(set[k]);
        return { k: 'upd', id: el.id, set };
      });
    }
    this.do(ops);
  }

  endpointFrame(g, p) {
    const target = this.hitTest(p, (x) => this.bindable(x, g.id));
    const key = g.which === 'p1' ? ['x1', 'y1', 'startId'] : ['x2', 'y2', 'endId'];
    g.bindTo = target ? target.id : null;
    this.session.apply([{ k: 'upd', id: g.id, set: { [key[0]]: round(p.x), [key[1]]: round(p.y), [key[2]]: g.bindTo } }]);
    this.highlightTarget(target);
  }

  highlightTarget(el) {
    this.overlay.querySelector('.bind-target')?.remove();
    if (!el) return;
    const r = this.screenRect(this.bounds(el));
    this.overlay.append(h('div', { class: 'sel-box bind-target', style: { left: `${r.x - 4}px`, top: `${r.y - 4}px`, width: `${r.w + 8}px`, height: `${r.h + 8}px`, borderWidth: '2px' } }));
  }

  drawRubber(g, p) {
    const a = this.toScreen(g.p.x, g.p.y), b = this.toScreen(p.x, p.y);
    if (!g.rubber) {
      g.rubber = h('div', { class: 'marquee' });
      this.overlay.append(g.rubber);
    }
    Object.assign(g.rubber.style, {
      left: `${Math.min(a.x, b.x)}px`, top: `${Math.min(a.y, b.y)}px`, width: `${Math.abs(a.x - b.x)}px`, height: `${Math.abs(a.y - b.y)}px`,
    });
    g.rect = { x: Math.min(g.p.x, p.x), y: Math.min(g.p.y, p.y), w: Math.abs(g.p.x - p.x), h: Math.abs(g.p.y - p.y) };
  }

  drawRubberLine(g, p) {
    if (!g.preview) {
      g.preview = svg('svg', { class: 'preview-path' });
      g.preview.append(svg('path', { stroke: '#4262ff', 'stroke-width': 2, fill: 'none', 'stroke-dasharray': '6 4' }));
      this.overlay.append(g.preview);
    }
    const a = this.toScreen(g.p.x, g.p.y), b = this.toScreen(p.x, p.y);
    g.preview.firstChild.setAttribute('d', `M${a.x},${a.y} L${b.x},${b.y}`);
    this.highlightTarget(this.hitTest(p, (x) => this.bindable(x)));
  }

  drawPenPreview(g) {
    if (!g.preview) {
      g.preview = svg('svg', { class: 'preview-path' });
      g.preview.append(svg('path', { fill: 'none', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
      this.overlay.append(g.preview);
    }
    const path = g.preview.firstChild;
    path.setAttribute('stroke', this.penColor || DEFAULT_INK);
    path.setAttribute('stroke-width', (this.penWidth || 3) * this.view.z);
    const screen = [];
    for (let i = 0; i < g.pts.length; i += 2) {
      const s = this.toScreen(g.pts[i], g.pts[i + 1]);
      screen.push(s.x, s.y);
    }
    path.setAttribute('d', smoothPath(smoothPoints(screen, 1)));
  }

  eraseAt(e) {
    const hit = document.elementsFromPoint(e.clientX, e.clientY).map((n) => n.closest && n.closest('.el')).find(Boolean);
    const el = hit && this.elements.get(hit.dataset.id);
    if (el && el.type !== 'frame') this.do([{ k: 'del', id: el.id }]);
  }

  onPointerUp(e) {
    const g = this.gesture;
    if (!g || e.pointerId !== g.pointerId) return;
    this.gesture = null;
    if (g.raf) cancelAnimationFrame(g.raf);
    if (g.moved && g.last) this.gestureFrame(g, g.last);
    g.rubber?.remove();
    this.drawGuides(null, null);
    g.preview?.remove();
    this.highlightTarget(null);
    const p = this.toWorld(e.clientX, e.clientY);

    switch (g.kind) {
      case 'move':
        if (!g.moved && g.tableCell) this.selectCell(g.tableCell.id, g.tableCell.r, g.tableCell.c, g.tableCell.extend);
        if (!g.moved && g.clickedId && this.selection.size > 1 && !e.shiftKey) this.select([g.clickedId]);
        if (g.moved) this.commitTxn();
        break;
      case 'resize':
        if (g.moved) {
          this.normalizePens([...g.origin.keys()]);
          this.commitTxn();
        }
        break;
      case 'endpoint':
        if (g.moved) this.commitTxn();
        break;
      case 'marquee': {
        if (!g.moved) {
          if (g.clickFrame) this.select([g.clickFrame], { add: g.add });
          else if (!g.add) this.select([]);
          break;
        }
        const r = g.rect;
        const ids = [...this.elements.values()].filter((el) => {
          const b = this.bounds(el);
          if (el.type === 'comment') return false;
          return el.type === 'frame' ? rectContains(r, b) : rectsIntersect(r, b);
        }).map((el) => el.id);
        this.select(ids, { add: g.add });
        break;
      }
      case 'create': this.finishCreate(g, p); break;
      case 'line': this.finishLine(g, p); break;
      case 'pen': this.finishPen(g); break;
      case 'erase': this.commitTxn(); break;
      case 'clrow': this.dropRow(g); break;
      default:
    }
    this.renderOverlay();
    if (['move', 'resize', 'endpoint'].includes(g.kind)) this.renderProps();
  }

  finishCreate(g, p) {
    const base = this.defaultsFor(g.tool);
    let r;
    if (g.moved && g.rect && g.rect.w > 10 && g.rect.h > 10) {
      r = g.rect;
      if (g.tool === 'text') r = { ...r, h: base.h };
    } else if (g.tool === 'text') {
      r = { x: p.x, y: p.y - base.h / 2, w: base.w, h: base.h };
    } else {
      r = { x: p.x - base.w / 2, y: p.y - base.h / 2, w: base.w, h: base.h };
    }
    const el = { ...base, x: round(r.x), y: round(r.y), w: round(r.w), h: round(r.h) };
    if (g.tool === 'frame') el.z = this.minZ() - 1;
    this.setTool('select');
    if (g.tool === 'shape' && String(this.shapeKind).startsWith('custom:')) {
      this.createCustomShape(this.shapeKind.slice(7), r);
      return;
    }
    if (g.tool === 'checklist') {
      el.h = 120;
      this.localChecklistChange = true;
      const created = this.addElement(el);
      this.localChecklistChange = false;
      if (created) this.startItemEdit(created.id, this.checkItems(this.elements.get(created.id))[0].key);
      return;
    }
    this.addElement(el, { edit: g.tool === 'sticky' || g.tool === 'text' });
  }

  finishLine(g, p) {
    const kind = LINE_KINDS[this.lineKind] || LINE_KINDS.arrow;
    let end = this.constrainLine(g.p, p, g.last && g.last.shiftKey);
    if (!g.moved || Math.hypot(end.x - g.p.x, end.y - g.p.y) * this.view.z < 6) end = { x: g.p.x + (this.lineKind === 'divider' ? 300 : 160), y: g.p.y };
    const to = g.moved && this.lineKind !== 'divider' ? this.hitTest(end, (x) => this.bindable(x)) : null;
    this.addElement({
      type: 'line', x1: round(g.p.x), y1: round(g.p.y), x2: round(end.x), y2: round(end.y),
      startId: this.lineKind === 'divider' ? null : g.startId, endId: to && to.id !== g.startId ? to.id : null,
      stroke: this.lineColor || DEFAULT_INK, sw: 2, ...kind.set,
    });
    this.setTool('select');
  }

  // Dividers are horizontal; Shift snaps other lines to 45 degrees.
  constrainLine(a, p, shift) {
    if (this.lineKind === 'divider') return { x: p.x, y: a.y };
    if (!shift) return p;
    const ang = Math.round(Math.atan2(p.y - a.y, p.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(p.x - a.x, p.y - a.y);
    return { x: a.x + Math.cos(ang) * len, y: a.y + Math.sin(ang) * len };
  }

  finishPen(g) {
    // Smooth out hand jitter, then drop points that do not change the shape.
    const pts = simplify(smoothPoints(g.pts, 2), 0.8 / this.view.z);
    if (pts.length < 2) return;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x1 = Math.min(x1, pts[i]); x2 = Math.max(x2, pts[i]);
      y1 = Math.min(y1, pts[i + 1]); y2 = Math.max(y2, pts[i + 1]);
    }
    const w = Math.max(1, x2 - x1), hh = Math.max(1, y2 - y1);
    const rel = pts.map((v, i) => round(i % 2 ? v - y1 : v - x1));
    this.addElement({
      type: 'pen', x: round(x1), y: round(y1), w: round(w), h: round(hh), pw: round(w), ph: round(hh), pts: rel,
      stroke: this.penColor || DEFAULT_INK, sw: this.penWidth || 3,
    }, { select: false });
  }

  // After a resize, bake the scale into pen points so strokes are not distorted.
  normalizePens(ids) {
    const ops = [];
    for (const id of ids) {
      const el = this.elements.get(id);
      if (!el || el.type !== 'pen' || !el.pts) continue;
      const sx = el.w / (el.pw || el.w), sy = el.h / (el.ph || el.h);
      if (Math.abs(sx - 1) < 1e-3 && Math.abs(sy - 1) < 1e-3) continue;
      ops.push({ k: 'upd', id, set: { pts: el.pts.map((v, i) => round(v * (i % 2 ? sy : sx))), pw: el.w, ph: el.h } });
    }
    if (ops.length) this.do(ops);
  }

  onDoubleClick(e) {
    if (!this.session) return;
    // While a gesture holds pointer capture the event targets the viewport; use what is really under the cursor.
    const under = document.elementsFromPoint(e.clientX, e.clientY).find((n) => n.closest && n.closest('.el, #overlay .handle'));
    const target = under || e.target;
    e = { clientX: e.clientX, clientY: e.clientY, target };
    const node = target.closest('.el');
    const el = node && this.elements.get(node.dataset.id);
    if (!el) {
      if (this.tool === 'select' && this.session.canEdit) {
        const p = this.toWorld(e.clientX, e.clientY);
        const base = this.defaultsFor('sticky');
        this.addElement({ ...base, x: round(p.x - base.w / 2), y: round(p.y - base.h / 2) }, { edit: true });
      }
      return;
    }
    if (el.type === 'frame') {
      if (e.target.closest('.frame-title')) this.renameFrame(el);
      return;
    }
    if (el.type === 'board') return this.openSubBoard(el);
    if (el.type === 'model') return this.startModelViewer(el);
    if (el.type === 'table') {
      const cell = e.target.closest('.tb-cell');
      if (cell) this.startCellEdit(el.id, cell.dataset.r, cell.dataset.c);
      return;
    }
    if (el.type === 'checklist') {
      const row = e.target.closest('.cl-row');
      if (row) this.startItemEdit(el.id, row.dataset.key);
      else if (e.target.closest('.cl-title')) this.renameChecklist(el);
      return;
    }
    if (TEXT_TYPES.has(el.type)) this.startEdit(el.id);
  }

  async renameFrame(el) {
    const name = await promptText(t('Название фрейма'), el.name || '', t('Сохранить'));
    if (name) this.do([{ k: 'upd', id: el.id, set: { name } }]);
  }

  onWheel(e) {
    if (!this.session) return;
    e.preventDefault();
    const r = this.viewport.getBoundingClientRect();
    const trackpadPan = !e.ctrlKey && e.deltaMode === 0 && Math.abs(e.deltaX) > 0 && Math.abs(e.deltaY) < 60;
    if (e.shiftKey && !e.ctrlKey) {
      this.view.x -= e.deltaY || e.deltaX;
      this.applyView();
    } else if (trackpadPan) {
      this.view.x -= e.deltaX;
      this.view.y -= e.deltaY;
      this.applyView();
    } else {
      const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      this.zoomAt(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    }
    if (this.app.views && this.session) this.app.views.set(this.session.boardId, { ...this.view });
  }

  onKeyDown(e) {
    if (!this.active() || this.editing || this.editingItem) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, select, [contenteditable]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (e.code === 'Space' && !this.spaceDown) {
      this.spaceDown = true;
      this.viewport.classList.add('panning');
      e.preventDefault();
      return;
    }
    if (mod && (e.code === 'KeyZ')) { e.preventDefault(); return e.shiftKey ? this.redo() : this.undo(); }
    if (mod && e.code === 'KeyY') { e.preventDefault(); return this.redo(); }
    if (mod && e.code === 'KeyA') { e.preventDefault(); return this.select([...this.elements.keys()]); }
    if (mod && e.code === 'KeyD') { e.preventDefault(); return this.duplicate(); }
    if (mod) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      // With table cells selected, Delete clears their text instead of removing the table.
      const tbl = this.tableSel && this.elements.get(this.tableSel.id);
      if (tbl && this.selection.has(tbl.id)) return this.setCells(tbl, { t: '' });
      return this.deleteSelection();
    }
    if (e.key === 'Escape') {
      if (this.tool !== 'select') this.setTool('select');
      else this.select([]);
      return;
    }
    if (e.key === 'Enter' && this.tableSel && this.selection.has(this.tableSel.id)) {
      e.preventDefault();
      return this.startCellEdit(this.tableSel.id, this.tableSel.r1, this.tableSel.c1);
    }
    if (e.key === 'Enter' && this.selection.size === 1) {
      e.preventDefault();
      return this.startEdit([...this.selection][0]);
    }
    if (e.key.startsWith('Arrow') && this.selection.size) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      return this.do(this.selected().map((el) => (el.type === 'line'
        ? { k: 'upd', id: el.id, set: { x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy } }
        : { k: 'upd', id: el.id, set: { x: el.x + dx, y: el.y + dy } })));
    }
    if (e.shiftKey && e.code === 'Digit1') return this.fitAll();
    if (e.shiftKey && e.code === 'Digit0') return this.zoomCenter(1 / this.view.z);
    if (e.key === '+' || e.key === '=') return this.zoomCenter(1.2);
    if (e.key === '-') return this.zoomCenter(1 / 1.2);
    if (TOOL_KEYS[key] && !e.altKey) {
      if (key === 'o') this.shapeKind = 'ellipse';
      if (key === 'r') this.shapeKind = 'rect';
      if (key === 'l') this.lineKind = 'line';
      if (key === 'a') this.lineKind = 'arrow';
      this.setTool(TOOL_KEYS[key]);
    }
  }

  // ================================================================== clipboard

  onCopy(e) {
    if (!this.active() || this.editing || !this.selection.size) return false;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, [contenteditable]')) return false;
    const els = this.selected().map(clone);
    e.clipboardData.setData('text/plain', `LIRO:${JSON.stringify({ server: this.session.server.url, board: this.session.boardId, els })}`);
    e.preventDefault();
    return true;
  }

  async onPaste(e) {
    if (!this.active() || this.editing) return;
    const t = e.target;
    if (t && t.closest && t.closest('input, textarea, [contenteditable]')) return;
    e.preventDefault();
    const vr = this.viewport.getBoundingClientRect();
    const inside = this.lastPointer.x > vr.left && this.lastPointer.x < vr.right && this.lastPointer.y > vr.top && this.lastPointer.y < vr.bottom;
    const at = inside ? this.toWorld(this.lastPointer.x, this.lastPointer.y) : this.viewCenter();
    const files = [...e.clipboardData.files];
    if (files.length) return this.addFiles(files, at);
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    if (text.startsWith('LIRO:')) {
      try {
        const data = JSON.parse(text.slice(5));
        return this.pasteElements(data, at);
      } catch {}
    }
    if (/^https?:\/\/\S+$/.test(text.trim())) return this.addLink(text.trim(), at);
    const base = this.defaultsFor(text.length > 120 ? 'text' : 'sticky');
    const el = this.addElement({ ...base, x: round(at.x - base.w / 2), y: round(at.y - base.h / 2), w: text.length > 120 ? 420 : base.w, text });
    if (el && el.type === 'text') requestAnimationFrame(() => this.autosizeText(el.id));
  }

  async pasteElements({ server, board, els }, at) {
    if (!Array.isArray(els) || !els.length) return;
    const box = unionRect(els.map((el) => (el.type === 'line'
      ? { x: Math.min(el.x1, el.x2), y: Math.min(el.y1, el.y2), w: Math.abs(el.x1 - el.x2), h: Math.abs(el.y1 - el.y2) }
      : { x: el.x, y: el.y, w: el.w, h: el.h })));
    const dx = round(at.x - (box.x + box.w / 2)), dy = round(at.y - (box.y + box.h / 2));
    await this.cloneElements(els, dx, dy, { server, board });
  }

  async cloneElements(els, dx, dy, source) {
    const ids = new Map(els.map((el) => [el.id, uid('e')]));
    let z = this.maxZ();
    const sorted = [...els].sort((a, b) => (a.z || 0) - (b.z || 0));
    const out = sorted.map((o) => {
      const el = { ...clone(o), id: ids.get(o.id), z: o.type === 'frame' ? o.z : ++z };
      if (el.type === 'line') {
        Object.assign(el, { x1: el.x1 + dx, y1: el.y1 + dy, x2: el.x2 + dx, y2: el.y2 + dy });
        el.startId = el.startId && ids.get(el.startId) || null;
        el.endId = el.endId && ids.get(el.endId) || null;
      } else {
        el.x += dx;
        el.y += dy;
      }
      return el;
    });
    // Media copied from another board must be available on this board too.
    const media = out.flatMap(mediaOfElement).filter((n) => MEDIA_NAME_RE.test(n));
    if (media.length && source && source.board !== this.session.boardId && this.session.status === 'online') {
      try {
        await this.session.uploadMissingMedia(this.session.boardId, media, null, source.board);
      } catch (err) {
        toast(`${t('Не все файлы удалось скопировать')}: ${err.message}`, { error: true });
      }
    }
    if (this.do(out.map((el) => ({ k: 'add', el })))) this.select(out.map((el) => el.id));
  }

  duplicate() {
    const els = this.selected();
    if (els.length) this.cloneElements(els.map(clone), 30, 30, null);
  }

  // ================================================================== media

  async addFiles(files, at) {
    if (!this.session) return;
    if (!this.session.canEdit) return this.readOnlyHint();
    if (!this.session.canAdd) return this.diskHint();
    let offset = 0;
    // 3D models: files dropped together with a model (.mtl, .bin, textures) are its assets.
    const models = files.filter((f) => MODEL_EXT.includes(extOf(f.name)));
    if (models.length) {
      const companions = files.filter((f) => !models.includes(f) && MODEL_ASSET_EXT.includes(extOf(f.name)));
      const grouped = companions.some((f) => ['mtl', 'bin'].includes(extOf(f.name))) || (models.length === 1 && companions.length && models[0].name.match(/\.(gltf|obj|fbx|dae)$/i));
      for (const m of models) {
        await this.addModel(m, grouped ? companions : [], { x: at.x + offset, y: at.y + offset });
        offset += 30;
      }
      files = files.filter((f) => !models.includes(f) && !(grouped && companions.includes(f)));
    }
    for (const file of files) {
      const big = file.size > 8 * 1024 * 1024;
      const progress = big ? progressDialog(t('Загрузка «{name}»', { name: file.name })) : null;
      try {
        const kind = file.type.startsWith('image/') ? 'image' : file.type.startsWith('video/') ? 'video' : file.type.startsWith('audio/') ? 'audio' : 'file';
        const dims = await this.mediaDims(file, kind);
        progress && progress.set(0, fmtSize(file.size));
        const info = await this.session.addMediaFile(file, (f) => progress && progress.set(f));
        const type = dims ? kind : 'file';
        let w = 260, hh = 76;
        if (type === 'image' || type === 'video') {
          const k = Math.min(1, (type === 'image' ? 640 : 560) / Math.max(dims.w, dims.h, 1));
          w = Math.max(40, Math.round(dims.w * k));
          hh = Math.max(40, Math.round(dims.h * k)) + (type === 'video' ? 28 : 0);
        } else if (type === 'audio') {
          w = 320; hh = 54;
        }
        this.addElement({
          type, x: round(at.x - w / 2 + offset), y: round(at.y - hh / 2 + offset), w, h: hh,
          src: info.name, mime: info.mime, name: info.fileName, size: info.size,
        });
        offset += 30;
      } catch (err) {
        toast(`${t('Не удалось добавить')} «${file.name}»: ${err.message}`, { error: true });
      } finally {
        progress && progress.close();
      }
    }
  }

  async addModel(file, companions, at) {
    const progress = progressDialog(t('Загрузка модели «{name}»', { name: file.name }));
    try {
      const assets = {};
      for (const [i, c] of companions.entries()) {
        progress.set(i / (companions.length + 1), c.name);
        assets[c.name] = (await this.session.addMediaFile(c)).name;
      }
      progress.set(companions.length / (companions.length + 1), file.name);
      const info = await this.session.addMediaFile(file, (f) => progress.set((companions.length + f) / (companions.length + 1)));
      const size = 320;
      this.addElement({
        type: 'model', x: round(at.x - size / 2), y: round(at.y - size / 2), w: size, h: size,
        src: info.name, name: info.fileName, ext: extOf(file.name), size: info.size, assets,
      });
    } catch (err) {
      toast(`${t('Не удалось добавить')} «${file.name}»: ${err.message}`, { error: true });
    } finally {
      progress.close();
    }
  }

  mediaDims(file, kind) {
    if (kind === 'audio') return Promise.resolve({ w: 0, h: 0 });
    if (kind !== 'image' && kind !== 'video') return Promise.resolve(null);
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const done = (v) => { URL.revokeObjectURL(url); resolve(v); };
      if (kind === 'image') {
        const img = new Image();
        img.onload = () => done({ w: img.naturalWidth || 400, h: img.naturalHeight || 300 });
        img.onerror = () => done(null);
        img.src = url;
      } else {
        const v = document.createElement('video');
        v.preload = 'metadata';
        v.onloadedmetadata = () => done({ w: v.videoWidth || 640, h: v.videoHeight || 360 });
        v.onerror = () => done({ w: 640, h: 360 });
        v.src = url;
      }
      setTimeout(() => done(kind === 'video' ? { w: 640, h: 360 } : null), 8000);
    });
  }

  // ================================================================== properties bar

  hideProps() {
    $('props').classList.add('hidden');
    this.closePalette();
  }

  // Small dropdown menu: items are [icon, label, value, disabled] or null for a separator.
  openMenu(anchor, items, onPick) {
    this.closePalette();
    const r = anchor.getBoundingClientRect();
    const menu = h('div', { class: 'menu palette-menu palette', style: { left: `${r.left}px`, top: `${r.bottom + 8}px` } },
      items.map((it) => (it ? h('button', {
        class: 'menu-item', disabled: it[3] || undefined,
        onclick: () => { this.closePalette(); onPick(it[2]); },
      }, h('span', { class: 'mi-icon', html: icon(it[0], 18) }), h('span', { class: 'mi-label' }, it[1])) : h('hr'))));
    document.body.append(menu);
    const mr = menu.getBoundingClientRect();
    if (mr.right > innerWidth - 8) menu.style.left = `${innerWidth - mr.width - 8}px`;
  }

  closePalette() {
    document.querySelector('.palette')?.remove();
    closeColorPicker();
  }

  openPalette(anchor, colors, current, onPick) {
    this.closePalette();
    const r = anchor.getBoundingClientRect();
    const pal = h('div', { class: 'palette', style: { left: `${r.left}px`, top: `${r.bottom + 8}px` } },
      colors.map((c) => h('button', {
        class: `${c === current ? 'active' : ''}${c === 'transparent' ? ' swatch none' : ''}`,
        style: c === 'transparent' ? {} : { background: c },
        title: c === 'transparent' ? t('Без заливки') : c,
        onclick: () => { onPick(c); this.closePalette(); },
      })));
    document.body.append(pal);
    const pr = pal.getBoundingClientRect();
    if (pr.right > innerWidth - 8) pal.style.left = `${innerWidth - pr.width - 8}px`;
  }

  fontSelect(textEl, texty) {
    const s = h('select', { class: 'font-select', title: t('Шрифт') },
      h('option', { value: '' }, t('Системный')),
      fontFamilies().map((f) => h('option', { value: f, style: { fontFamily: fontStack(f) } }, f)),
      h('option', { value: '__upload' }, t('Загрузить шрифт…')));
    if (textEl.ff && !fontFamilies().includes(textEl.ff)) s.insertBefore(h('option', { value: textEl.ff }, textEl.ff), s.children[1]);
    s.value = textEl.ff || '';
    s.style.fontFamily = fontStack(textEl.ff);
    s.onchange = async () => {
      if (s.value !== '__upload') return this.setProp(texty, { ff: s.value || null });
      s.value = textEl.ff || '';
      const input = h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2' });
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        try {
          const toServer = this.session.status === 'online' && !this.session.server.local;
          await uploadFont(toServer ? this.session.server.url : '', file);
          const fam = fontFamilies().find((f) => file.name.toLowerCase().replace(/[^a-z0-9]/g, '').startsWith(f.toLowerCase().replace(/[^a-z0-9]/g, '')));
          toast(toServer ? t('Шрифт загружен на сервер') : t('Шрифт сохранён локально'));
          if (fam) this.setProp(texty, { ff: fam }); else this.renderProps();
        } catch (err) {
          toast(`${t('Не удалось загрузить шрифт')}: ${err.message}`, { error: true });
        }
      };
      input.click();
    };
    return s;
  }

  // Number field with up/down steppers; any size can be typed in.
  fontSizeControl(textEl, texty) {
    const cur = textEl.fs || 16;
    const input = h('input', { class: 'fs-input', type: 'number', min: 4, max: 999, value: cur, title: t('Размер шрифта') });
    const apply = (v) => {
      const n = Math.max(4, Math.min(999, Math.round(Number(v) || cur)));
      input.value = n;
      this.setProp(texty, { fs: n });
    };
    input.onchange = () => apply(input.value);
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') input.blur(); };
    const step = (dir) => {
      const v = Number(input.value) || cur;
      const next = dir > 0 ? FONT_SIZES.find((f) => f > v) || v + 16 : [...FONT_SIZES].reverse().find((f) => f < v) || Math.max(4, v - 1);
      apply(next);
    };
    return h('span', { class: 'fs-ctl' }, input,
      h('span', { class: 'fs-steps' },
        h('button', { title: t('Больше'), onclick: () => step(1) }, '▲'),
        h('button', { title: t('Меньше'), onclick: () => step(-1) }, '▼')));
  }

  // Dash settings: on/off, dash length, gap and line opacity.
  openDashPopover(anchor, el, filter) {
    this.closePalette();
    const r = anchor.getBoundingClientRect();
    const slider = (label, value, min, max, stepv, fmt, onSet) => {
      const val = h('span', { class: 'cp-op-val' }, fmt(value));
      const range = h('input', { type: 'range', min, max, step: stepv, value });
      range.oninput = () => { val.textContent = fmt(Number(range.value)); };
      range.onchange = () => onSet(Number(range.value));
      return h('label', { class: 'cp-opacity' }, h('span', {}, label), range, val);
    };
    const on = h('input', { type: 'checkbox' });
    on.checked = !!el.dash;
    on.onchange = () => this.setProp(filter, { dash: on.checked });
    const isLine = el.type === 'line';
    const pop = h('div', { class: 'palette dash-pop', style: { left: `${r.left}px`, top: `${r.bottom + 8}px` } },
      h('label', { class: 'toggle' }, on, h('span', {}, t('Пунктир'))),
      slider(t('Длина штриха'), el.dl || (isLine ? 4 : 3), 0.5, 12, 0.5, (v) => `×${v}`, (v) => this.setProp(filter, { dash: true, dl: v })),
      slider(t('Промежуток'), el.dg || (isLine ? 3 : 2), 0.5, 12, 0.5, (v) => `×${v}`, (v) => this.setProp(filter, { dash: true, dg: v })),
      slider(t('Непрозрачность линии'), Math.round((el.so ?? 1) * 100), 5, 100, 5, (v) => `${v}%`, (v) => this.setProp(filter, { so: v / 100 })));
    document.body.append(pop);
    const pr = pop.getBoundingClientRect();
    if (pr.right > innerWidth - 8) pop.style.left = `${innerWidth - pr.width - 8}px`;
  }

  setProp(filter, set) {
    const ops = this.selected().filter(filter).map((el) => ({ k: 'upd', id: el.id, set: typeof set === 'function' ? set(el) : set }));
    this.do(ops);
  }

  renderProps() {
    const bar = $('props');
    const sel = this.selected().filter((el) => el.type !== 'comment');
    if (!sel.length || this.editing || !this.session) return this.hideProps();
    const types = new Set(sel.map((el) => el.type));
    const first = sel[0];
    const parts = [];
    const sep = () => parts.push(h('span', { class: 'sep' }));
    const btn = (iconName, title, onclick, active = false, disabled = false) => h('button', { title, class: active ? 'active' : '', html: icon(iconName, 18), onclick, disabled });
    // Colour button: palette + colour wheel + saved presets (+ opacity slider when `opacity` is given).
    const swatch = (title, color, colors, apply, { allowNone = false, opacity, applyOpacity } = {}) => {
      const b = h('button', { title }, h('span', { class: `swatch${color === 'transparent' ? ' none' : ''}`, style: color === 'transparent' ? {} : { background: withAlpha(color, opacity ?? 1) } }));
      b.onclick = () => openColorPicker({
        anchor: b, colors, value: color, allowNone, opacity,
        presets: this.app.settings.colorPresets || [],
        onPresets: (list) => { this.app.settings.colorPresets = list; this.app.saveSettings(); },
        onChange: apply, onOpacity: applyOpacity,
      });
      return b;
    };
    const selectBox = (title, options, value, apply, fmt = (v) => v) => {
      const s = h('select', { title }, options.map((o) => h('option', { value: o }, fmt(o))));
      if (!options.includes(value)) s.prepend(h('option', { value }, fmt(value)));
      s.value = String(value);
      s.onchange = () => apply(s.value);
      return s;
    };

    const fillable = (el) => ['sticky', 'shape', 'frame', 'board'].includes(el.type);
    const stroked = (el) => (el.type === 'shape' && el.shape !== 'custom') || el.type === 'line' || el.type === 'pen';
    const texty = (el) => TEXT_TYPES.has(el.type);

    if (types.size === 1 && types.has('shape') && first.shape !== 'custom') {
      const shapeSel = h('select', { title: t('Фигура') }, SHAPE_CATEGORIES.map((c) => h('optgroup', { label: t(c.name) },
        Object.entries(SHAPE_DEFS).filter(([, d]) => d.cat === c.id).map(([id, d]) => h('option', { value: id }, t(d.name))))));
      shapeSel.value = SHAPE_DEFS[first.shape] ? first.shape : 'rect';
      shapeSel.onchange = () => this.setProp((el) => el.type === 'shape', { shape: shapeSel.value });
      parts.push(shapeSel);
      sep();
    }
    const fillEl = sel.find(fillable);
    if (fillEl) {
      parts.push(swatch(t('Заливка'), fillEl.fill || '#ffffff', FILLS.filter((c) => c !== 'transparent'), (c) => {
        if (fillEl.type === 'sticky') this.lastStickyFill = c;
        this.setProp(fillable, { fill: c });
      }, { allowNone: true, opacity: fillEl.fo ?? 1, applyOpacity: (v) => this.setProp(fillable, { fo: v }) }));
    }
    const strokeEl = sel.find(stroked);
    if (strokeEl) {
      parts.push(swatch(t('Цвет линии'), strokeEl.stroke || DEFAULT_INK, INKS, (c) => {
        if (strokeEl.type === 'pen') this.penColor = c;
        if (strokeEl.type === 'line') this.lineColor = c;
        this.setProp(stroked, { stroke: c });
      }, { allowNone: true, opacity: strokeEl.so ?? 1, applyOpacity: (v) => this.setProp(stroked, { so: v }) }));
      parts.push(selectBox(t('Толщина'), WIDTHS, strokeEl.sw ?? 2, (v) => this.setProp(stroked, { sw: Number(v) }), (v) => `${v}px`));
    }
    if (types.has('line')) {
      const line = sel.find((el) => el.type === 'line');
      const isLine = (el) => el.type === 'line';
      const route = line.route || 'straight';
      parts.push(btn('line2', t('Прямая'), () => this.setProp(isLine, { route: 'straight' }), route === 'straight'));
      parts.push(btn('elbow', t('Ломаная'), () => this.setProp(isLine, { route: 'elbow' }), route === 'elbow'));
      parts.push(btn('curve', t('Кривая'), () => this.setProp(isLine, { route: 'curved' }), route === 'curved'));
      const [sc, ec] = this.caps(line);
      const capNames = Object.keys(CAPS);
      parts.push(selectBox(t('Начало линии'), capNames, sc, (v) => this.setProp(isLine, { startCap: v, startArrow: null }), (v) => `◂ ${t(CAPS[v])}`));
      parts.push(selectBox(t('Конец линии'), capNames, ec, (v) => this.setProp(isLine, { endCap: v, endArrow: null }), (v) => `${t(CAPS[v])} ▸`));
    }
    if (types.has('line') || types.has('shape')) {
      const d = sel.find((el) => el.type === 'line' || el.type === 'shape');
      const dashed = (el) => el.type === 'line' || el.type === 'shape';
      const dashBtn = btn('dash', t('Пунктир'), () => this.openDashPopover(dashBtn, d, dashed), !!d.dash);
      parts.push(dashBtn);
    }
    const textEl = sel.find(texty);
    if (textEl) {
      if (parts.length) sep();
      parts.push(swatch(t('Цвет текста'), textEl.tc || DEFAULT_INK, INKS, (c) => this.setProp(texty, { tc: c })));
      parts.push(this.fontSelect(textEl, texty));
      parts.push(this.fontSizeControl(textEl, texty));
      parts.push(btn('bold', t('Жирный'), () => this.setProp(texty, { bold: !textEl.bold }), !!textEl.bold));
      parts.push(btn('italic', t('Курсив'), () => this.setProp(texty, { italic: !textEl.italic }), !!textEl.italic));
      parts.push(btn('underline', t('Подчёркнутый'), () => this.setProp(texty, { underline: !textEl.underline }), !!textEl.underline));
      const listBtn = h('button', { title: t('Список'), class: textEl.list ? 'active' : '', html: icon(textEl.list === 'number' ? 'listNumber' : 'listBullet', 18) });
      listBtn.onclick = () => this.openMenu(listBtn, [
        ['listBullet', t('Маркированный список'), 'bullet'], ['listNumber', t('Нумерованный список'), 'number'], null, ['left', t('Без списка'), ''],
      ], (v) => this.setProp(texty, { list: v || null }));
      parts.push(listBtn);
      const align = textEl.align || (textEl.type === 'text' ? 'left' : 'center');
      for (const a of ['left', 'center', 'right']) {
        parts.push(btn(a, { left: t('По левому краю'), center: t('По центру'), right: t('По правому краю') }[a], () => this.setProp(texty, { align: a }), align === a));
      }
    }
    if (sel.length === 1 && first.type === 'board') this.boardProps(first, btn, swatch, parts);
    if (sel.length === 1 && first.type === 'checklist') this.checklistProps(first, btn, parts);
    if (sel.length === 1 && first.type === 'model') this.modelProps(first, btn, parts);
    if (sel.length === 1 && first.type === 'table') {
      parts.push(this.fontSizeControl(first, (x) => x.type === 'table'));
      this.tableProps(first, btn, swatch, parts, { fills: FILLS.filter((c) => c !== 'transparent'), inks: INKS });
    }
    if (sel.length === 1 && ['image', 'video', 'audio', 'file'].includes(first.type)) {
      if (parts.length) sep();
      const a = h('a', { href: this.mediaUrl(first), download: first.name || 'file', target: '_blank', style: { display: 'none' } });
      parts.push(a, btn('download', t('Скачать файл'), () => a.click()));
    }
    if (parts.length) sep();
    const alignable = sel.filter((el) => el.type !== 'line' && el.type !== 'comment');
    if (alignable.length >= 2) {
      const alignBtn = h('button', { title: t('Выравнивание'), html: icon('alignLeft', 18) });
      alignBtn.onclick = () => this.openMenu(alignBtn, [
        ['alignLeft', t('По левому краю'), 'left'], ['alignCenterH', t('По центру'), 'centerH'], ['alignRight', t('По правому краю'), 'right'],
        null,
        ['alignTop', t('По верху'), 'top'], ['alignMiddle', t('По середине'), 'middle'], ['alignBottom', t('По низу'), 'bottom'],
        null,
        ['distH', t('Распределить по горизонтали'), 'distH', alignable.length < 3], ['distV', t('Распределить по вертикали'), 'distV', alignable.length < 3],
      ], (mode) => this.align(mode));
      parts.push(alignBtn, h('span', { class: 'sep' }));
    }
    parts.push(btn('front', t('На передний план'), () => {
      let z = this.maxZ();
      this.do(sel.sort((a, b) => (a.z || 0) - (b.z || 0)).map((el) => ({ k: 'upd', id: el.id, set: { z: ++z } })));
    }));
    parts.push(btn('back', t('На задний план'), () => {
      let z = this.minZ();
      this.do(sel.sort((a, b) => (b.z || 0) - (a.z || 0)).map((el) => ({ k: 'upd', id: el.id, set: { z: --z } })));
    }));
    parts.push(btn('copy', t('Дублировать (Ctrl+D)'), () => this.duplicate()));
    parts.push(btn('trash', t('Удалить (Del)'), () => this.deleteSelection()));

    bar.replaceChildren(...parts);
    bar.classList.remove('hidden');
    const box = this.screenRect(unionRect(sel.map((el) => this.bounds(el))));
    const vr = this.viewport.getBoundingClientRect();
    const bw = bar.offsetWidth, bh = bar.offsetHeight;
    let left = box.x + box.w / 2 - bw / 2;
    let top = box.y - bh - 18;
    if (top < 66) top = box.y + box.h + 18;
    if (top + bh > vr.height - 8) top = 66;
    left = Math.max(60, Math.min(left, vr.width - bw - 8));
    Object.assign(bar.style, { left: `${left}px`, top: `${top}px` });
  }

  // ================================================================== sync decisions

  async askDecision(count) {
    const s = this.session;
    const choice = await modal({
      title: t('Связь с сервером восстановлена'),
      text: t('Пока сервер был недоступен, вы внесли изменения в доску «{name}» (операций: {n}). Отправить их на сервер? Другие участники увидят ваши новые и изменённые элементы.', { name: s.meta.name, n: count }),
      dismissable: false,
      buttons: [
        { label: t('Отменить мои изменения'), value: 'discard', danger: true },
        { label: t('Сохранить копией'), value: 'copy' },
        { label: t('Обновить доску на сервере'), value: 'push', primary: true },
      ],
    });
    if (s !== this.session) return;
    if (choice === 'discard') {
      if (!(await confirmDialog(t('Отменить изменения?'), t('Ваши офлайн-изменения будут потеряны, доска примет состояние с сервера.'), t('Отменить изменения')))) {
        return this.askDecision(count);
      }
    }
    const progress = progressDialog(t('Синхронизация…'));
    try {
      const created = await s.resolveDecision(choice, (f, name) => progress.set(f, name ? `${t('Загрузка файлов…')} ${Math.round(f * 100)}%` : ''));
      progress.close();
      this.undoStack = [];
      this.redoStack = [];
      this.updateUndoButtons();
      if (choice === 'push') toast(t('Изменения отправлены на сервер'));
      if (created) {
        const open = await modal({
          title: t('Копия создана'),
          text: t('Ваша офлайн-версия сохранена на сервере как «{name}».', { name: created.name }),
          buttons: [{ label: t('Остаться здесь'), value: false }, { label: t('Открыть копию'), value: true, primary: true }],
        });
        if (open) this.app.openBoard(s.server, created);
      }
    } catch (err) {
      progress.close();
      toast(`${t('Ошибка синхронизации')}: ${err.message}`, { error: true });
      setTimeout(() => this.session === s && s.awaitingDecision && this.askDecision(count), 1500);
    }
  }

  // Backup of the open board (with its nested boards): from the server when connected, otherwise
  // built from the copy stored on this device.
  backupMenu() {
    const s = this.session;
    if (!s) return;
    const fromServer = s.status === 'online' && !s.server.local;
    const canLocal = !!(native.cache && (s.server.local || s.cacheEnabled));
    dropdown($('btn-board-backup'), [
      {
        label: t('Сохранить бэкап доски'), disabled: !fromServer && !canLocal,
        onClick: () => (fromServer
          ? downloadUrl(`${s.server.url}/api/boards/${s.boardId}/backup`)
          : (s.saveNow(), buildLocalBackup(this.app, { type: 'board', serverId: s.server.serverId, boardId: s.boardId, title: s.meta.name }))),
      },
      { label: t('Восстановить доску из бэкапа…'), disabled: !fromServer && !s.server.local, onClick: () => this.restoreBoard() },
    ]);
  }

  async restoreBoard() {
    const s = this.session;
    const file = await pickBackupFile();
    if (!file) return;
    try {
      const manifest = await readManifest(file);
      const choice = await confirmRestore(manifest, s.server.local ? t('Локальные доски') : s.server.name || s.server.url);
      if (!choice) return;
      const summary = s.server.local
        ? await restoreLocally(this.app, file, { replace: choice.replace })
        : (await restoreToServer(s.server.url, file, choice.replace)).summary;
      toast(summaryText(summary), { ms: 6000 });
      // Show the restored board: the current one again (if it was replaced) or the backup's main board.
      const main = (manifest.boards || []).find((b) => !b.parentId) || (manifest.boards || [])[0];
      if (main) this.app.openBoard(s.server, { id: main.id, name: main.name, cached: s.cacheEnabled || s.server.local });
    } catch (e) {
      toast(`${t('Не удалось восстановить')}: ${e.message}`, { error: true });
    }
  }

  // A board created while its server was offline: the server is reachable again.
  async offerPendingUpload() {
    const s = this.session;
    const v = await modal({
      title: t('Сервер снова доступен'),
      text: t('Доска «{name}» создана, пока сервер был недоступен. Загрузить её на сервер?', { name: s.meta.name }),
      buttons: [{ label: t('Позже'), value: false }, { label: t('Загрузить на сервер'), value: true, primary: true }],
    });
    if (!v || s !== this.session) return;
    s.saveNow();
    await new Promise((r) => setTimeout(r, 300));
    const created = await this.app.uploadBoard(s.server, s.meta, s.server);
    if (created) this.app.openBoard(s.server, { ...created, cached: true });
  }

  async onGone() {
    const s = this.session;
    if (!s) return;
    s.closed = true;
    const buttons = [{ label: t('К списку досок'), value: 'back', primary: true }];
    if (s.elements.size) buttons.unshift({ label: t('Восстановить как новую доску'), value: 'restore' });
    const v = await modal({ title: t('Доска удалена'), text: t('Доска «{name}» была удалена на сервере.', { name: s.meta.name }), buttons, dismissable: false });
    if (v === 'restore') {
      const created = await this.app.restoreFromSession(s);
      if (created) return this.app.openBoard(s.server, created);
    }
    this.app.showHome();
  }
}

Object.assign(BoardView.prototype, checklistMethods, subBoardMethods, customShapeMethods, tableMethods, modelMethods);
