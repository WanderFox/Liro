// Fonts provided by the Liro server: registered with @font-face so text elements can use them.
import { Api } from './net.js';
import { native } from './native.js';

let loadedFrom = null;
let families = [];

export function fontFamilies() {
  return families;
}

// Server fonts (when serverUrl is given) plus fonts stored locally on this computer/browser.
export async function loadFonts(serverUrl, force = false) {
  const key = serverUrl || 'local';
  if (loadedFrom === key && !force) return families;
  let list = [];
  if (serverUrl) {
    try {
      list = (await new Api(serverUrl).fonts()).map((f) => ({ ...f, url: `${serverUrl}${f.url}` }));
    } catch {}
  }
  if (native.assets) {
    for (const it of await native.assets.list('fonts')) {
      const family = it.name.replace(/\.(ttf|otf|woff2?)$/i, '').replace(/[-_](regular|bold|italic|light|medium|semibold|black|thin)\b.*$/i, '').replace(/[-_]+/g, ' ');
      if (!list.some((f) => f.family === family)) list.push({ family, weight: '100 900', italic: /italic/i.test(it.name), url: it.url });
    }
  }
  loadedFrom = key;
  const css = list.map((f) => `@font-face { font-family: "${f.family.replace(/"/g, '')}"; src: url("${f.url}"); font-weight: ${f.weight}; font-style: ${f.italic ? 'italic' : 'normal'}; font-display: swap; }`).join('\n');
  let style = document.getElementById('liro-fonts');
  if (!style) {
    style = document.createElement('style');
    style.id = 'liro-fonts';
    document.head.append(style);
  }
  style.textContent = css;
  families = [...new Set(list.map((f) => f.family))].sort((a, b) => a.localeCompare(b));
  return families;
}

// Uploads to the server, or keeps the font locally when there is no server (serverUrl empty).
export async function uploadFont(serverUrl, file) {
  if (serverUrl) {
    const res = await fetch(`${serverUrl}/api/fonts/${encodeURIComponent(file.name)}`, { method: 'PUT', body: file });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
  } else if (native.assets) {
    await native.assets.save('fonts', file.name, await file.arrayBuffer());
  }
  await loadFonts(serverUrl, true);
  return families;
}

// CSS font-family value for an element (system UI font when none is set).
export function fontStack(family) {
  return family ? `"${family}", system-ui, sans-serif` : '';
}
