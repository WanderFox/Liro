// Interface language. Russian strings are the keys; other languages map them to translations.
// Missing translations fall back to Russian. Parameters: t('Найдено: {n}', { n: 3 }).
import { EN } from './i18n-en.js';

const DICTS = { en: EN };
export const LANGUAGES = [
  { id: 'ru', name: 'Русский' },
  { id: 'en', name: 'English' },
];

let lang = 'ru';

export function systemLanguage() {
  const nav = (navigator.languages && navigator.languages[0]) || navigator.language || 'ru';
  return nav.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}

export function setLanguage(id) {
  lang = LANGUAGES.some((l) => l.id === id) ? id : systemLanguage();
  document.documentElement.lang = lang;
  translateDom(document);
}

export function getLanguage() {
  return lang;
}

export function t(key, params) {
  let s = (lang !== 'ru' && DICTS[lang] && DICTS[lang][key]) || key;
  if (params) s = s.replace(/\{(\w+)\}/g, (_, k) => (params[k] !== undefined ? params[k] : `{${k}}`));
  return s;
}

// Static markup: data-i18n (text), data-i18n-title, data-i18n-placeholder hold the Russian source text.
export function translateDom(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    if (!el.dataset.i18nSrc) el.dataset.i18nSrc = el.dataset.i18n || el.textContent.trim();
    el.textContent = t(el.dataset.i18nSrc);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    if (!el.dataset.i18nTitleSrc) el.dataset.i18nTitleSrc = el.dataset.i18nTitle || el.title;
    el.title = t(el.dataset.i18nTitleSrc);
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    if (!el.dataset.i18nPhSrc) el.dataset.i18nPhSrc = el.dataset.i18nPlaceholder || el.placeholder;
    el.placeholder = t(el.dataset.i18nPhSrc);
  }
}
