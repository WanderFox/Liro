// Dialogs and toasts.
import { t } from './i18n.js';

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function toast(text, { error = false, ms = 3200 } = {}) {
  const t = h('div', { class: `toast${error ? ' err' : ''}` }, text);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

// buttons: [{ label, value, primary, danger }]. Resolves with the value (null when dismissed).
export function modal({ title, text, body, buttons = [{ label: 'OK', value: true, primary: true }], dismissable = true }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modal-root');
    const close = (v) => {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === 'Escape' && dismissable) { e.stopPropagation(); close(null); }
    };
    const btns = buttons.map((b) => h('button', {
      class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`,
      onclick: () => close(typeof b.value === 'function' ? b.value() : b.value),
    }, b.label));
    const box = h('div', { class: 'modal' },
      title && h('h3', {}, title),
      text && h('p', {}, text),
      body,
      h('div', { class: 'buttons' }, btns));
    const back = h('div', { class: 'modal-back', onmousedown: (e) => { if (e.target === back && dismissable) close(null); } }, box);
    root.append(back);
    document.addEventListener('keydown', onKey, true);
    const input = box.querySelector('input');
    (input || btns.find((b) => b.classList.contains('primary')) || btns[0])?.focus();
    if (input) {
      input.select();
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); btns.find((b) => b.classList.contains('primary'))?.click(); }
      });
    }
  });
}

export async function promptText(title, value = '', okLabel = 'OK') {
  const input = h('input', { value });
  const res = await modal({
    title,
    body: input,
    buttons: [{ label: t('Отмена'), value: null }, { label: okLabel, value: () => input.value.trim(), primary: true }],
  });
  return res || null;
}

export function confirmDialog(title, text, okLabel = t('Удалить'), danger = true) {
  return modal({ title, text, buttons: [{ label: t('Отмена'), value: false }, { label: okLabel, value: true, primary: !danger, danger }] });
}

// Non-dismissable progress dialog; returns { set(fraction, text), close() }.
export function progressDialog(title) {
  const bar = h('div');
  const label = h('p', {}, '');
  const back = h('div', { class: 'modal-back' }, h('div', { class: 'modal' }, h('h3', {}, title), label, h('div', { class: 'progress' }, bar)));
  document.getElementById('modal-root').append(back);
  return {
    set(f, text) {
      bar.style.width = `${Math.round(Math.max(0, Math.min(1, f)) * 100)}%`;
      if (text !== undefined) label.textContent = text;
    },
    close() { back.remove(); },
  };
}

// Simple dropdown menu under `anchor`: items [{ label, onClick, disabled }].
export function dropdown(anchor, items) {
  document.querySelector('.dropdown-menu')?.remove();
  const r = anchor.getBoundingClientRect();
  const menu = h('div', { class: 'menu dropdown-menu', style: { left: `${r.left}px`, top: `${r.bottom + 6}px` } },
    items.map((it) => h('button', {
      class: 'menu-item', disabled: it.disabled || undefined,
      onclick: () => { menu.remove(); it.onClick(); },
    }, h('span', { class: 'mi-label' }, it.label))));
  document.body.append(menu);
  const mr = menu.getBoundingClientRect();
  if (mr.right > innerWidth - 8) menu.style.left = `${innerWidth - mr.width - 8}px`;
  const close = (e) => {
    if (menu.contains(e.target) || anchor.contains(e.target)) return;
    menu.remove();
    document.removeEventListener('pointerdown', close, true);
  };
  setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
}

export function timeAgo(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return t('только что');
  if (s < 3600) return t('{n} мин назад', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} ч назад', { n: Math.round(s / 3600) });
  return new Date(ts).toLocaleDateString();
}
