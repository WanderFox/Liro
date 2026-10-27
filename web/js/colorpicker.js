// Colour popover: preset swatches, the user's saved colours, an HSV colour wheel and an opacity slider.
import { h } from './ui.js';
import { t } from './i18n.js';

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  let s = m[1];
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  return { r: parseInt(s.slice(0, 2), 16), g: parseInt(s.slice(2, 4), 16), b: parseInt(s.slice(4, 6), 16) };
}

export function rgbToHex({ r, g, b }) {
  return `#${[r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
}

// Colour with opacity for CSS (keeps 'transparent' and non-hex values as they are).
export function withAlpha(color, alpha = 1) {
  if (alpha >= 1 || !color || color === 'transparent') return color;
  const rgb = hexToRgb(color);
  return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})` : color;
}

function hsvToRgb(hh, s, v) {
  const f = (n) => { const k = (n + hh / 60) % 6; return v - v * s * Math.max(0, Math.min(k, 4 - k, 1)); };
  return { r: f(5) * 255, g: f(3) * 255, b: f(1) * 255 };
}

function rgbToHsv({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let hh = 0;
  if (d) {
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
    if (hh < 0) hh += 360;
  }
  return { h: hh, s: max ? d / max : 0, v: max };
}

let openEl = null;

export function closeColorPicker() {
  if (openEl) openEl.remove();
  openEl = null;
}

/**
 * opts: { anchor, colors, value, allowNone, opacity (0..1 or undefined to hide the slider),
 *         presets: string[], onChange(color), onOpacity(value), onPresets(newList) }
 */
export function openColorPicker(opts) {
  closeColorPicker();
  let current = opts.value || '#ffffff';
  let hsv = rgbToHsv(hexToRgb(current) || { r: 255, g: 255, b: 255 });
  const presets = [...(opts.presets || [])];

  const swatch = (c, extra = '') => h('button', {
    class: `cp-swatch${c === current ? ' active' : ''}${c === 'transparent' ? ' none' : ''}${extra}`,
    style: c === 'transparent' ? {} : { background: c },
    title: c === 'transparent' ? t('Без заливки') : c,
    onclick: () => pick(c, true),
  });

  const wheel = h('canvas', { class: 'cp-wheel', width: 180, height: 180 });
  const hex = h('input', { class: 'cp-hex', value: current, maxlength: 7, spellcheck: 'false' });
  const preview = h('span', { class: 'cp-preview' });
  const custom = h('div', { class: 'cp-custom hidden' }, wheel,
    h('div', { class: 'row' }, preview, hex,
      h('button', { class: 'btn', title: t('Сохранить в пресеты'), onclick: () => {
        if (!presets.includes(current)) {
          presets.unshift(current);
          presets.splice(18);
          opts.onPresets && opts.onPresets(presets);
          renderPresets();
        }
      } }, `+ ${t('В пресеты')}`)));
  const presetRow = h('div', { class: 'cp-grid' });
  const renderPresets = () => {
    presetRow.replaceChildren(...presets.map((c) => {
      const b = swatch(c);
      b.oncontextmenu = (e) => {
        e.preventDefault();
        presets.splice(presets.indexOf(c), 1);
        opts.onPresets && opts.onPresets(presets);
        renderPresets();
      };
      b.title = `${c} — ${t('правый клик: удалить')}`;
      return b;
    }));
    presetRow.classList.toggle('hidden', !presets.length);
  };

  const drawWheel = () => {
    const g = wheel.getContext('2d');
    const W = wheel.width, R = W / 2, ring = 16;
    g.clearRect(0, 0, W, W);
    for (let a = 0; a < 360; a += 1) {
      g.beginPath();
      g.strokeStyle = `hsl(${a}, 100%, 50%)`;
      g.lineWidth = ring;
      g.arc(R, R, R - ring / 2, ((a - 1) * Math.PI) / 180, ((a + 1) * Math.PI) / 180);
      g.stroke();
    }
    // Saturation/value square inside the ring.
    const side = (R - ring - 6) * Math.SQRT2, x0 = R - side / 2;
    const base = hsvToRgb(hsv.h, 1, 1);
    const gs = g.createLinearGradient(x0, 0, x0 + side, 0);
    gs.addColorStop(0, '#fff');
    gs.addColorStop(1, rgbToHex(base));
    g.fillStyle = gs;
    g.fillRect(x0, x0, side, side);
    const gv = g.createLinearGradient(0, x0, 0, x0 + side);
    gv.addColorStop(0, 'rgba(0,0,0,0)');
    gv.addColorStop(1, '#000');
    g.fillStyle = gv;
    g.fillRect(x0, x0, side, side);
    // Markers.
    const ha = (hsv.h * Math.PI) / 180;
    g.strokeStyle = '#fff';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(R + Math.cos(ha) * (R - ring / 2), R + Math.sin(ha) * (R - ring / 2), 6, 0, Math.PI * 2);
    g.stroke();
    g.beginPath();
    g.arc(x0 + hsv.s * side, x0 + (1 - hsv.v) * side, 6, 0, Math.PI * 2);
    g.strokeStyle = hsv.v > 0.5 ? '#000' : '#fff';
    g.stroke();
    return { R, ring, side, x0 };
  };

  const fromPointer = (e, mode) => {
    const r = wheel.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * wheel.width, y = ((e.clientY - r.top) / r.height) * wheel.height;
    const { R, side, x0 } = drawWheel();
    if (mode === 'ring') {
      hsv.h = ((Math.atan2(y - R, x - R) * 180) / Math.PI + 360) % 360;
    } else {
      hsv.s = Math.max(0, Math.min(1, (x - x0) / side));
      hsv.v = Math.max(0, Math.min(1, 1 - (y - x0) / side));
    }
    pick(rgbToHex(hsvToRgb(hsv.h, hsv.s, hsv.v)), false);
  };
  wheel.onpointerdown = (e) => {
    const r = wheel.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * wheel.width - wheel.width / 2;
    const y = ((e.clientY - r.top) / r.height) * wheel.height - wheel.height / 2;
    const mode = Math.hypot(x, y) > wheel.width / 2 - 22 ? 'ring' : 'square';
    wheel.setPointerCapture(e.pointerId);
    fromPointer(e, mode);
    wheel.onpointermove = (ev) => fromPointer(ev, mode);
    wheel.onpointerup = () => { wheel.onpointermove = null; };
  };
  hex.onchange = () => {
    const rgb = hexToRgb(hex.value);
    if (!rgb) return;
    hsv = rgbToHsv(rgb);
    pick(rgbToHex(rgb), false);
  };
  hex.onkeydown = (e) => e.stopPropagation();

  function pick(c, fromSwatch) {
    current = c;
    if (c !== 'transparent') {
      if (fromSwatch) hsv = rgbToHsv(hexToRgb(c) || { r: 0, g: 0, b: 0 });
      hex.value = c;
      preview.style.background = c;
      drawWheel();
    }
    for (const b of root.querySelectorAll('.cp-swatch')) b.classList.toggle('active', b.title.startsWith(c));
    opts.onChange && opts.onChange(c);
  }

  const children = [
    h('div', { class: 'cp-grid' }, [...opts.colors, ...(opts.allowNone ? ['transparent'] : [])].map((c) => swatch(c)),
      h('button', { class: 'cp-swatch cp-more', title: t('Свой цвет'), onclick: () => { custom.classList.toggle('hidden'); drawWheel(); } }, '+')),
    presetRow,
    custom,
  ];
  if (opts.opacity !== undefined) {
    const val = h('span', { class: 'cp-op-val' }, `${Math.round(opts.opacity * 100)}%`);
    const range = h('input', { type: 'range', min: 0, max: 100, value: Math.round(opts.opacity * 100) });
    range.oninput = () => { val.textContent = `${range.value}%`; };
    range.onchange = () => opts.onOpacity && opts.onOpacity(Number(range.value) / 100);
    children.push(h('label', { class: 'cp-opacity' }, h('span', {}, t('Непрозрачность')), range, val));
  }
  const root = h('div', { class: 'color-picker' }, children);
  renderPresets();
  preview.style.background = current;
  document.body.append(root);
  openEl = root;
  const outside = (e) => {
    if (!openEl || root.contains(e.target) || opts.anchor.contains(e.target)) return;
    document.removeEventListener('pointerdown', outside, true);
    if (openEl === root) closeColorPicker();
  };
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);
  const r = opts.anchor.getBoundingClientRect();
  root.style.left = `${Math.min(r.left, innerWidth - root.offsetWidth - 8)}px`;
  root.style.top = `${r.bottom + 8 + root.offsetHeight > innerHeight ? Math.max(8, r.top - root.offsetHeight - 8) : r.bottom + 8}px`;
  return root;
}
