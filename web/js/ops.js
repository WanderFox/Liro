// Shared board operation model. Used by the server (Node) and the client (browser/Electron).
//
// A board is a map of elements keyed by id. Every change is an operation:
//   { k: 'add', el: {...} }              create (or overwrite) an element
//   { k: 'upd', id, set: {field: value} } shallow-merge fields into an element
//   { k: 'del', id }                     remove an element
// Each op carries an `opId` (unique, client generated) so resending is idempotent,
// and the server stamps a monotonically increasing `seq`.

export const ELEMENT_TYPES = [
  'sticky', 'text', 'shape', 'line', 'pen', 'image', 'video', 'audio', 'file', 'frame', 'checklist', 'comment', 'link',
  'board', 'table', 'model',
];

export const SHAPES = ['rect', 'roundrect', 'ellipse', 'diamond', 'triangle', 'hexagon', 'star', 'parallelogram'];

const MAX_STRING = 200_000;
const MAX_POINTS = 20_000;

export function uid(prefix = '') {
  const rnd = (globalThis.crypto && globalThis.crypto.randomUUID)
    ? globalThis.crypto.randomUUID().replace(/-/g, '')
    : Math.random().toString(16).slice(2) + Date.now().toString(16) + Math.random().toString(16).slice(2);
  return prefix + rnd.slice(0, 20);
}

function cleanValue(v, depth = 0) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') return v.length > MAX_STRING ? v.slice(0, MAX_STRING) : v;
  if (depth > 3) return null;
  if (Array.isArray(v)) return v.slice(0, MAX_POINTS * 2).map((x) => cleanValue(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = cleanValue(x, depth + 1);
    }
    return out;
  }
  return null;
}

// Validates and normalizes an op coming from an untrusted source. Returns null when invalid.
export function sanitizeOp(op) {
  if (!op || typeof op !== 'object') return null;
  const opId = typeof op.opId === 'string' ? op.opId.slice(0, 64) : uid('op');
  if (op.k === 'add') {
    const el = cleanValue(op.el);
    if (!el || typeof el.id !== 'string' || !ELEMENT_TYPES.includes(el.type)) return null;
    el.id = el.id.slice(0, 64);
    return { k: 'add', opId, el };
  }
  if (op.k === 'upd') {
    if (typeof op.id !== 'string' || !op.set || typeof op.set !== 'object') return null;
    const set = cleanValue(op.set);
    delete set.id;
    delete set.type;
    return { k: 'upd', opId, id: op.id, set };
  }
  if (op.k === 'del') {
    if (typeof op.id !== 'string') return null;
    return { k: 'del', opId, id: op.id };
  }
  return null;
}

// Applies an op to an elements Map. Returns true when the board changed.
export function applyOp(elements, op) {
  switch (op.k) {
    case 'add':
      elements.set(op.el.id, { ...op.el });
      return true;
    case 'upd': {
      const el = elements.get(op.id);
      if (!el) return false;
      Object.assign(el, op.set);
      return true;
    }
    case 'del':
      return elements.delete(op.id);
    default:
      return false;
  }
}

// Builds the op that reverts `op` given the state *before* it was applied.
export function inverseOp(elements, op) {
  switch (op.k) {
    case 'add': {
      const prev = elements.get(op.el.id);
      return prev ? { k: 'add', el: structuredClone(prev) } : { k: 'del', id: op.el.id };
    }
    case 'upd': {
      const el = elements.get(op.id);
      if (!el) return null;
      const set = {};
      for (const key of Object.keys(op.set)) set[key] = el[key] === undefined ? null : structuredClone(el[key]);
      return { k: 'upd', id: op.id, set };
    }
    case 'del': {
      const el = elements.get(op.id);
      return el ? { k: 'add', el: structuredClone(el) } : null;
    }
    default:
      return null;
  }
}

// Media referenced by an element or op (file names inside the board's media store).
// Fields that reference board media: file/image source, link-preview image and site icon.
// plus a 3D model's thumbnail and its companion files (textures, materials).
const MEDIA_FIELDS = ['src', 'image', 'icon', 'iconSrc', 'thumb'];

export function mediaOfElement(el) {
  if (!el) return [];
  const out = MEDIA_FIELDS.map((f) => el[f]).filter((v) => typeof v === 'string' && v);
  if (el.assets && typeof el.assets === 'object') out.push(...Object.values(el.assets).filter((v) => typeof v === 'string' && v));
  return out;
}

export function mediaOfOp(op) {
  if (op.k === 'add') return mediaOfElement(op.el);
  if (op.k === 'upd') return mediaOfElement(op.set);
  return [];
}

export const MEDIA_NAME_RE = /^[a-f0-9]{64}(\.[a-z0-9]{1,8})?$/;
