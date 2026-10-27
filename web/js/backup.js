// Backups on the client: downloading server/board backups, building backups of local boards (and of
// cached boards when offline), and restoring a backup to a server or into local storage.
import { native } from './native.js';
import { h, modal, toast, progressDialog } from './ui.js';
import { t, getLanguage } from './i18n.js';
import { buildTarBlob, parseTar, parseHeader, backupFileName } from './tar.js';
import { mediaOfElement } from './ops.js';

const TYPE_LABEL = { server: 'Бэкап сервера', board: 'Бэкап доски', local: 'Бэкап локальных досок и настроек' };

export function downloadUrl(url) {
  if (native.download) return native.download(url);
  const a = h('a', { href: url, download: '' });
  document.body.append(a);
  a.click();
  a.remove();
}

export function saveBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: fileName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

export function pickBackupFile() {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: '.tar,application/x-tar' });
    input.onchange = () => resolve(input.files[0] || null);
    input.click();
  });
}

// manifest.json is the first entry of every Liro backup.
export async function readManifest(file) {
  const head = new Uint8Array(await file.slice(0, 512).arrayBuffer());
  const hdr = parseHeader(head);
  if (!hdr || hdr.path !== 'manifest.json' || hdr.size > 4 * 1024 * 1024) throw new Error(t('Это не бэкап Liro'));
  const text = await file.slice(512, 512 + hdr.size).text();
  const m = JSON.parse(text);
  if (!m.liroBackup) throw new Error(t('Это не бэкап Liro'));
  return m;
}

// Asks how to restore; returns { replace } or null when cancelled.
export async function confirmRestore(manifest, targetLabel) {
  const replace = h('input', { type: 'checkbox' });
  const date = new Date(manifest.created).toLocaleString(getLanguage());
  const assets = Object.values(manifest.assets || {}).reduce((a, b) => a + b, 0);
  const ok = await modal({
    title: t('Восстановить из бэкапа?'),
    text: t('{type} «{title}» от {date}. Досок: {n}, ресурсов: {a}. Куда: {target}.', {
      type: t(TYPE_LABEL[manifest.type] || 'Бэкап'), title: manifest.title || '', date, n: (manifest.boards || []).length, a: assets, target: targetLabel,
    }),
    body: h('label', { class: 'toggle' }, replace, h('span', {}, t('Заменить существующие доски и файлы с такими же именами'))),
    buttons: [{ label: t('Отмена'), value: false }, { label: t('Восстановить'), value: true, primary: true }],
  });
  return ok ? { replace: replace.checked } : null;
}

export function restoreToServer(serverUrl, file, replace) {
  const progress = progressDialog(t('Восстановление из бэкапа…'));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${serverUrl}/api/restore?replace=${replace ? 1 : 0}`);
    xhr.setRequestHeader('Content-Type', 'application/x-tar');
    xhr.upload.onprogress = (e) => e.lengthComputable && progress.set(e.loaded / e.total, t('Загрузка архива…'));
    xhr.onload = () => {
      progress.close();
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status < 300) resolve(body);
      else reject(new Error(body.error || `HTTP ${xhr.status}`));
    };
    xhr.onerror = () => { progress.close(); reject(new Error(t('Нет связи с сервером'))); };
    xhr.send(file);
  });
}

export function summaryText(summary) {
  const b = summary.boards, a = summary.assets;
  return t('Досок: добавлено {ba}, заменено {br}, пропущено {bs}. Ресурсов: добавлено {aa}, заменено {ar}, пропущено {as}.', {
    ba: b.added, br: b.replaced, bs: b.skipped, aa: a.added, ar: a.replaced, as: a.skipped,
  });
}

// Board ids reachable from `rootId` in locally stored boards (nested-board tiles).
async function cachedTree(serverId, rootId) {
  const out = [];
  const seen = new Set();
  const walk = async (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const data = await native.cache.load(serverId, id);
    if (!data) return;
    out.push(data);
    for (const el of data.elements || []) if (el.type === 'board' && el.boardId) await walk(el.boardId);
  };
  await walk(rootId);
  return out;
}

async function boardEntries(serverId, datas) {
  const entries = [];
  for (const d of datas) {
    const id = d.meta.id;
    entries.push({ path: `boards/${id}/board.json`, data: JSON.stringify({ meta: d.meta, seq: d.seq || 0, elements: d.elements || [] }) });
    for (const name of new Set((d.elements || []).flatMap(mediaOfElement))) {
      const blob = await native.media.read(serverId, id, name);
      if (blob) entries.push({ path: `boards/${id}/media/${name}`, data: blob });
    }
  }
  return entries;
}

async function assetEntries() {
  const entries = [];
  const counts = {};
  if (!native.assets) return { entries, counts };
  for (const kind of ['fonts', 'shapes', 'icons']) {
    for (const it of await native.assets.list(kind)) {
      const blob = await native.assets.read(kind, it.name);
      if (!blob) continue;
      entries.push({ path: `assets/${kind}/${it.name}`, data: blob });
      counts[kind] = (counts[kind] || 0) + 1;
    }
  }
  return { entries, counts };
}

// Backup built on this device: all local boards + local assets + settings ("local"),
// or one stored board with its nested boards ("board").
export async function buildLocalBackup(app, { type, serverId, boardId, title }) {
  const progress = progressDialog(t('Подготовка бэкапа…'));
  try {
    let datas = [];
    if (type === 'local') {
      for (const c of await native.cache.list('local')) {
        const d = await native.cache.load('local', c.meta.id);
        if (d) datas.push(d);
      }
    } else {
      datas = await cachedTree(serverId, boardId);
    }
    const entries = await boardEntries(serverId, datas);
    let counts = {};
    if (type === 'local') {
      const a = await assetEntries();
      entries.push(...a.entries);
      counts = a.counts;
      const { cache, cid, ...settings } = app.settings;
      entries.push({ path: 'settings.json', data: JSON.stringify(settings, null, 2) });
    }
    const manifest = {
      liroBackup: 1, type, title, created: new Date().toISOString(),
      source: { name: title, local: serverId === 'local' },
      boards: datas.map((d) => ({ id: d.meta.id, name: d.meta.name, parentId: d.meta.parentId || null, elements: (d.elements || []).length })),
      assets: counts,
    };
    const blob = buildTarBlob([{ path: 'manifest.json', data: JSON.stringify(manifest, null, 2) }, ...entries]);
    saveBlob(blob, backupFileName(type, title));
  } finally {
    progress.close();
  }
}

// Restores any Liro backup into this device's storage (local boards by default).
export async function restoreLocally(app, file, { replace, serverId = 'local', server = null }) {
  const progress = progressDialog(t('Восстановление из бэкапа…'));
  const summary = { boards: { added: 0, replaced: 0, skipped: 0 }, assets: { added: 0, replaced: 0, skipped: 0 } };
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const files = new Map();
    for (const e of parseTar(bytes)) files.set(e.path, e.data);
    const decode = (d) => new TextDecoder().decode(d);
    const boardIds = [...new Set([...files.keys()].map((p) => /^boards\/([^/]+)\/board\.json$/.exec(p)?.[1]).filter(Boolean))];
    let i = 0;
    for (const id of boardIds) {
      progress.set(i++ / Math.max(1, boardIds.length), id);
      const data = JSON.parse(decode(files.get(`boards/${id}/board.json`)));
      const exists = await native.cache.load(serverId, id);
      if (exists && !replace) { summary.boards.skipped += 1; continue; }
      if (exists) await native.cache.remove(serverId, id);
      await native.cache.save(serverId, id, {
        meta: data.meta, seq: data.seq || 0, elements: data.elements || [], queue: [],
        server: server ? { url: server.url, name: server.name } : {}, savedAt: Date.now(),
      });
      for (const [p, d] of files) {
        const m = new RegExp(`^boards/${id}/media/([^/]+)$`).exec(p);
        if (m) await native.media.save(serverId, id, m[1], d.slice().buffer);
      }
      app.setCached({ serverId }, id, true);
      summary.boards[exists ? 'replaced' : 'added'] += 1;
    }
    if (native.assets) {
      for (const [p, d] of files) {
        const m = /^assets\/(fonts|shapes|icons)\/([^/]+)$/.exec(p);
        if (!m) continue;
        const exists = await native.assets.read(m[1], m[2]);
        if (exists && !replace) { summary.assets.skipped += 1; continue; }
        await native.assets.save(m[1], m[2], d.slice().buffer);
        summary.assets[exists ? 'replaced' : 'added'] += 1;
      }
    }
    if (files.has('settings.json')) {
      // Settings are merged: known servers and colour presets are added, the rest is taken when replacing.
      const s = JSON.parse(decode(files.get('settings.json')));
      const cur = app.settings;
      const servers = [...(cur.servers || [])];
      for (const sv of s.servers || []) if (!servers.some((x) => x.serverId === sv.serverId)) servers.push(sv);
      cur.servers = servers;
      cur.colorPresets = [...new Set([...(cur.colorPresets || []), ...(s.colorPresets || [])])].slice(0, 18);
      if (replace || !cur.userName) cur.userName = s.userName || cur.userName;
      if (replace && s.lang) cur.lang = s.lang;
      app.saveSettings();
    }
    return summary;
  } finally {
    progress.close();
  }
}

export const backupLabels = TYPE_LABEL;
