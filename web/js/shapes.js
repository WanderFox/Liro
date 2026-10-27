// Shape library. Every shape is drawn from its own width/height, so strokes never get distorted.
//   d(w, h)     outline path (filled + stroked)
//   deco(w, h)  optional inner lines (stroke only)
//   open        outline is not closed (braces, brackets): never filled

// Polygon from fractional points [[fx, fy], ...].
const poly = (pts) => (w, h) => `M${pts.map(([x, y]) => `${x * w},${y * h}`).join(' L')}Z`;

// Path template in 0..100 units (absolute M/L/C/Q/Z commands only) scaled to w x h.
const tpl = (src) => (w, h) => src.replace(/(-?\d*\.?\d+)\s*,\s*(-?\d*\.?\d+)/g, (_, x, y) => `${(x / 100) * w},${(y / 100) * h}`);

function roundRect(w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  return `M${r},0 H${w - r} Q${w},0 ${w},${r} V${h - r} Q${w},${h} ${w - r},${h} H${r} Q0,${h} 0,${h - r} V${r} Q0,0 ${r},0Z`;
}

function ellipse(cx, cy, rx, ry) {
  return `M${cx - rx},${cy} A${rx},${ry} 0 1 0 ${cx + rx},${cy} A${rx},${ry} 0 1 0 ${cx - rx},${cy}Z`;
}

function star(w, h) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const r = i % 2 ? 0.4 : 1;
    pts.push([0.5 + Math.cos(a) * r * 0.5, 0.55 + Math.sin(a) * r * 0.5]);
  }
  return poly(pts)(w, h);
}

function regular(n, rot = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i * 2 * Math.PI) / n;
    pts.push([0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5]);
  }
  return poly(pts);
}


export const SHAPE_DEFS = {
  // ---------------------------------------------------------------- basic
  rect: { name: 'Прямоугольник', cat: 'basic', kw: 'rectangle квадрат', d: (w, h) => roundRect(w, h, Math.min(6, w * 0.06, h * 0.06)) },
  roundrect: { name: 'Скруглённый', cat: 'basic', kw: 'rounded', d: (w, h) => roundRect(w, h, Math.min(w, h) * 0.18) },
  ellipse: { name: 'Овал', cat: 'basic', kw: 'oval circle круг эллипс', d: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2) },
  triangle: { name: 'Треугольник', cat: 'basic', kw: 'triangle', d: poly([[0.5, 0], [1, 1], [0, 1]]) },
  diamond: { name: 'Ромб', cat: 'basic', kw: 'rhombus diamond decision решение', d: poly([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]) },
  'callout-rect': {
    name: 'Выноска', cat: 'basic', kw: 'speech bubble callout реплика',
    d: (w, h) => {
      const b = h * 0.8, r = Math.min(10, w * 0.08, b * 0.1);
      return `M${r},0 H${w - r} Q${w},0 ${w},${r} V${b - r} Q${w},${b} ${w - r},${b} H${w * 0.4} L${w * 0.2},${h} L${w * 0.24},${b} H${r} Q0,${b} 0,${b - r} V${r} Q0,0 ${r},0Z`;
    },
  },
  parallelogram: { name: 'Параллелограмм', cat: 'basic', kw: 'parallelogram data данные', d: poly([[0.2, 0], [1, 0], [0.8, 1], [0, 1]]) },
  star: { name: 'Звезда', cat: 'basic', kw: 'star', d: star },
  'arrow-right': { name: 'Блочная стрелка', cat: 'basic', kw: 'block arrow стрелка вправо', d: poly([[0, 0.25], [0.6, 0.25], [0.6, 0], [1, 0.5], [0.6, 1], [0.6, 0.75], [0, 0.75]]) },
  'arrow-left': { name: 'Стрелка влево', cat: 'basic', kw: 'arrow left', d: poly([[1, 0.25], [0.4, 0.25], [0.4, 0], [0, 0.5], [0.4, 1], [0.4, 0.75], [1, 0.75]]) },
  'arrow-double': { name: 'Двойная стрелка', cat: 'basic', kw: 'double arrow', d: poly([[0, 0.5], [0.25, 0], [0.25, 0.25], [0.75, 0.25], [0.75, 0], [1, 0.5], [0.75, 1], [0.75, 0.75], [0.25, 0.75], [0.25, 1]]) },
  pentagon: { name: 'Пятиугольник', cat: 'basic', kw: 'pentagon', d: regular(5, -Math.PI / 2) },
  octagon: { name: 'Восьмиугольник', cat: 'basic', kw: 'octagon stop', d: poly([[0.3, 0], [0.7, 0], [1, 0.3], [1, 0.7], [0.7, 1], [0.3, 1], [0, 0.7], [0, 0.3]]) },
  hexagon: { name: 'Шестиугольник', cat: 'basic', kw: 'hexagon preparation подготовка', d: poly([[0.25, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0.25, 1], [0, 0.5]]) },
  predefined: {
    name: 'Предопределённый процесс', cat: 'basic', kw: 'predefined process subroutine подпрограмма',
    d: (w, h) => roundRect(w, h, Math.min(4, w * 0.04)), deco: (w, h) => `M${w * 0.1},0 V${h} M${w * 0.9},0 V${h}`,
  },
  trapezoid: { name: 'Трапеция', cat: 'basic', kw: 'trapezoid', d: poly([[0.2, 0], [0.8, 0], [1, 1], [0, 1]]) },
  cloud: {
    name: 'Облако', cat: 'basic', kw: 'cloud',
    d: tpl('M25,85 C8,85 2,68 12,58 C2,45 14,28 30,33 C34,14 58,10 66,25 C78,15 96,26 90,42 C102,50 98,78 80,80 C76,92 58,95 50,86 C42,94 30,92 25,85Z'),
  },
  cross: { name: 'Крест', cat: 'basic', kw: 'cross plus плюс', d: poly([[0.33, 0], [0.67, 0], [0.67, 0.33], [1, 0.33], [1, 0.67], [0.67, 0.67], [0.67, 1], [0.33, 1], [0.33, 0.67], [0, 0.67], [0, 0.33], [0.33, 0.33]]) },
  cylinder: {
    name: 'Цилиндр', cat: 'basic', kw: 'cylinder can database база данных',
    d: (w, h) => { const e = Math.min(h * 0.12, w * 0.2); return `M0,${e} A${w / 2},${e} 0 0 1 ${w},${e} V${h - e} A${w / 2},${e} 0 0 1 0,${h - e}Z`; },
    deco: (w, h) => { const e = Math.min(h * 0.12, w * 0.2); return `M0,${e} A${w / 2},${e} 0 0 0 ${w},${e}`; },
  },
  'brace-left': { name: 'Фигурная скобка', cat: 'basic', kw: 'brace {', open: true, d: tpl('M90,0 C55,0 55,5 55,20 L55,38 C55,48 45,50 10,50 C45,50 55,52 55,62 L55,80 C55,95 55,100 90,100') },
  'brace-right': { name: 'Скобка справа', cat: 'basic', kw: 'brace }', open: true, d: tpl('M10,0 C45,0 45,5 45,20 L45,38 C45,48 55,50 90,50 C55,50 45,52 45,62 L45,80 C45,95 45,100 10,100') },
  chevron: { name: 'Шеврон', cat: 'basic', kw: 'chevron step шаг', d: poly([[0, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0, 1], [0.25, 0.5]]) },
  tag: { name: 'Ярлык', cat: 'basic', kw: 'tag pentagon arrow label', d: poly([[0, 0], [0.75, 0], [1, 0.5], [0.75, 1], [0, 1]]) },

  // ---------------------------------------------------------------- flowchart
  terminator: { name: 'Начало / конец', cat: 'flow', kw: 'terminator start end stadium старт', d: (w, h) => roundRect(w, h, h / 2) },
  document: { name: 'Документ', cat: 'flow', kw: 'document', d: (w, h) => `M0,0 H${w} V${h * 0.85} C${w * 0.75},${h * 0.7} ${w * 0.5},${h * 1.05} ${w * 0.25},${h} C${w * 0.12},${h * 0.97} ${w * 0.05},${h * 0.9} 0,${h * 0.88}Z` },
  multidoc: {
    name: 'Несколько документов', cat: 'flow', kw: 'multiple documents',
    d: (w, h) => `M0,${h * 0.14} H${w * 0.86} V${h * 0.88} C${w * 0.64},${h * 0.76} ${w * 0.43},${h * 1.04} ${w * 0.21},${h} C${w * 0.1},${h * 0.98} ${w * 0.04},${h * 0.93} 0,${h * 0.9}Z`,
    deco: (w, h) => `M${w * 0.07},${h * 0.14} V${h * 0.07} H${w * 0.93} V${h * 0.8} H${w * 0.86} M${w * 0.14},${h * 0.07} V0 H${w} V${h * 0.72} H${w * 0.93}`,
  },
  'manual-input': { name: 'Ручной ввод', cat: 'flow', kw: 'manual input', d: poly([[0, 0.3], [1, 0], [1, 1], [0, 1]]) },
  'direct-access': {
    name: 'Прямой доступ', cat: 'flow', kw: 'direct access storage drum',
    d: (w, h) => { const e = Math.min(w * 0.12, h * 0.3); return `M${e},0 H${w - e} A${e},${h / 2} 0 0 1 ${w - e},${h} H${e} A${e},${h / 2} 0 0 1 ${e},0Z`; },
    deco: (w, h) => { const e = Math.min(w * 0.12, h * 0.3); return `M${w - e},0 A${e},${h / 2} 0 0 0 ${w - e},${h}`; },
  },
  'internal-storage': {
    name: 'Внутренняя память', cat: 'flow', kw: 'internal storage',
    d: (w, h) => roundRect(w, h, Math.min(4, w * 0.04)), deco: (w, h) => `M${w * 0.15},0 V${h} M0,${h * 0.18} H${w}`,
  },
  'manual-op': { name: 'Ручная операция', cat: 'flow', kw: 'manual operation', d: poly([[0, 0], [1, 0], [0.8, 1], [0.2, 1]]) },
  delay: { name: 'Задержка', cat: 'flow', kw: 'delay D', d: (w, h) => `M0,0 H${w * 0.6} C${w * 1.13},0 ${w * 1.13},${h} ${w * 0.6},${h} H0Z` },
  'stored-data': { name: 'Хранимые данные', cat: 'flow', kw: 'stored data', d: (w, h) => `M${w * 0.15},0 H${w} C${w * 0.82},${h * 0.2} ${w * 0.82},${h * 0.8} ${w},${h} H${w * 0.15} C${-w * 0.05},${h * 0.8} ${-w * 0.05},${h * 0.2} ${w * 0.15},0Z` },
  merge: { name: 'Слияние', cat: 'flow', kw: 'merge triangle down', d: poly([[0, 0], [1, 0], [0.5, 1]]) },
  connector: { name: 'Соединитель', cat: 'flow', kw: 'connector circle', d: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2) },
  or: { name: 'ИЛИ', cat: 'flow', kw: 'or circle plus', d: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2), deco: (w, h) => `M${w / 2},0 V${h} M0,${h / 2} H${w}` },
  summing: {
    name: 'Суммирование', cat: 'flow', kw: 'summing junction x',
    d: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2),
    deco: (w, h) => { const k = 0.5 - 0.5 / Math.SQRT2; return `M${w * k},${h * k} L${w * (1 - k)},${h * (1 - k)} M${w * (1 - k)},${h * k} L${w * k},${h * (1 - k)}`; },
  },
  'double-circle': { name: 'Двойной круг', cat: 'flow', kw: 'double circle state', d: (w, h) => ellipse(w / 2, h / 2, w / 2, h / 2), deco: (w, h) => ellipse(w / 2, h / 2, w * 0.4, h * 0.4) },
  offpage: { name: 'Межстраничный переход', cat: 'flow', kw: 'off-page connector', d: poly([[0, 0], [1, 0], [1, 0.65], [0.5, 1], [0, 0.65]]) },
  'loop-limit': { name: 'Граница цикла', cat: 'flow', kw: 'loop limit', d: poly([[0.15, 0], [0.85, 0], [1, 0.25], [1, 1], [0, 1], [0, 0.25]]) },
  card: { name: 'Карта', cat: 'flow', kw: 'card punched', d: poly([[0.18, 0], [1, 0], [1, 1], [0, 1], [0, 0.25]]) },
  'punched-tape': {
    name: 'Перфолента', cat: 'flow', kw: 'punched tape',
    d: (w, h) => `M0,${h * 0.1} C${w * 0.25},${h * 0.35} ${w * 0.25},${-h * 0.15} ${w * 0.5},${h * 0.1} C${w * 0.75},${h * 0.35} ${w * 0.75},${-h * 0.15} ${w},${h * 0.1} V${h * 0.9} C${w * 0.75},${h * 0.65} ${w * 0.75},${h * 1.15} ${w * 0.5},${h * 0.9} C${w * 0.25},${h * 0.65} ${w * 0.25},${h * 1.15} 0,${h * 0.9}Z`,
  },
  display: { name: 'Дисплей', cat: 'flow', kw: 'display screen', d: (w, h) => `M0,${h / 2} L${w * 0.18},0 H${w * 0.82} C${w * 1.06},0 ${w * 1.06},${h} ${w * 0.82},${h} H${w * 0.18}Z` },
  collate: { name: 'Сопоставление', cat: 'flow', kw: 'collate hourglass', d: poly([[0, 0], [1, 0], [0, 1], [1, 1]]) },
  sort: { name: 'Сортировка', cat: 'flow', kw: 'sort', d: poly([[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]), deco: (w, h) => `M0,${h / 2} H${w}` },
  annotation: { name: 'Комментарий', cat: 'flow', kw: 'annotation bracket [', open: true, d: (w, h) => `M${w * 0.3},0 H0 V${h} H${w * 0.3}` },
  folder: { name: 'Папка', cat: 'flow', kw: 'folder', d: (w, h) => `M0,${h * 0.15} V${h} H${w} V${h * 0.15} H${w * 0.45} L${w * 0.38},0 H${w * 0.06} L0,${h * 0.15}Z` },

  // ---------------------------------------------------------------- callouts
  'callout-oval': {
    name: 'Овальная выноска', cat: 'callout', kw: 'callout oval speech',
    d: (w, h) => `M${w * 0.28},${h * 0.79} C${w * 0.05},${h * 0.72} 0,${h * 0.55} 0,${h * 0.42} C0,${h * 0.19} ${w * 0.22},0 ${w * 0.5},0 C${w * 0.78},0 ${w},${h * 0.19} ${w},${h * 0.42} C${w},${h * 0.65} ${w * 0.78},${h * 0.84} ${w * 0.5},${h * 0.84} C${w * 0.44},${h * 0.84} ${w * 0.38},${h * 0.83} ${w * 0.33},${h * 0.82} L${w * 0.15},${h}Z`,
  },
  'callout-cloud': {
    name: 'Мысль', cat: 'callout', kw: 'thought cloud callout',
    d: tpl('M25,75 C8,75 2,60 12,52 C2,40 14,24 30,28 C34,12 58,8 66,22 C78,12 96,22 90,36 C102,44 98,70 80,72 C76,82 58,85 50,78 C42,84 30,82 25,75Z M14,86 C14,82 20,82 20,86 C20,90 14,90 14,86Z M6,96 C6,94 9,94 9,96 C9,98 6,98 6,96Z'),
  },
};

export const SHAPE_CATEGORIES = [
  { id: 'basic', name: 'Основные' },
  { id: 'flow', name: 'Блок-схемы' },
  { id: 'callout', name: 'Выноски' },
];

// Quick list shown in the shapes menu (like Miro's).
export const QUICK_SHAPES = ['rect', 'ellipse', 'diamond', 'triangle'];

export function shapeDef(kind) {
  return SHAPE_DEFS[kind] || SHAPE_DEFS.rect;
}

export function shapeIcon(kind, size = 24) {
  const def = shapeDef(kind);
  const w = 24, hh = kind === 'terminator' || kind === 'tag' || kind.startsWith('arrow') || kind === 'chevron' || kind === 'direct-access' ? 16 : 20;
  const oy = (24 - hh) / 2;
  return `<svg width="${size}" height="${size}" viewBox="-2 -2 28 28"><g transform="translate(0 ${oy})" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="${def.d(w, hh)}"/>${def.deco ? `<path d="${def.deco(w, hh)}"/>` : ''}</g></svg>`;
}
