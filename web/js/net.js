// HTTP helpers for talking to a Liro server.

export function normalizeServerUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  // "liro.loc" or "192.168.1.5" means the default Liro port; an explicit "http://liro.loc" means port 80.
  const hadScheme = /^https?:\/\//i.test(s);
  if (!hadScheme) s = `http://${s}`;
  const u = new URL(s);
  if (!u.port && !hadScheme) u.port = '1919';
  return `${u.protocol}//${u.host}`;
}

async function request(url, { method = 'GET', body, timeout = 8000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      signal: ctl.signal,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
    if (!res.ok) throw Object.assign(new Error((data && data.error) || `HTTP ${res.status}`), { status: res.status });
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export class Api {
  constructor(baseUrl) {
    this.base = baseUrl.replace(/\/$/, '');
  }

  info(timeout = 3000) { return request(`${this.base}/api/info`, { timeout }); }
  boards() { return request(`${this.base}/api/boards`); }
  board(id) { return request(`${this.base}/api/boards/${id}`, { timeout: 30000 }); }
  createBoard(body) { return request(`${this.base}/api/boards`, { method: 'POST', body, timeout: 60000 }); }
  renameBoard(id, name) { return request(`${this.base}/api/boards/${id}`, { method: 'PATCH', body: { name } }); }
  deleteBoard(id) { return request(`${this.base}/api/boards/${id}`, { method: 'DELETE' }); }
  postOps(id, ops, by) { return request(`${this.base}/api/boards/${id}/ops`, { method: 'POST', body: { ops, by }, timeout: 60000 }); }
  icons() { return request(`${this.base}/api/icons`); }
  shapes() { return request(`${this.base}/api/shapes`); }
  fonts() { return request(`${this.base}/api/fonts`); }
  stickers() { return request(`${this.base}/api/stickers`); }
  unfurl(id, url) { return request(`${this.base}/api/boards/${id}/unfurl`, { method: 'POST', body: { url }, timeout: 30000 }); }
  mediaCheck(id, names) { return request(`${this.base}/api/boards/${id}/media-check`, { method: 'POST', body: { names } }); }

  mediaUrl(boardId, name) {
    return `${this.base}/api/boards/${boardId}/media/${name}`;
  }

  wsUrl(boardId, cid, name) {
    const u = new URL(this.base);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.pathname = '/ws';
    u.search = new URLSearchParams({ board: boardId, cid, name }).toString();
    return u.toString();
  }

  uploadMedia(boardId, name, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', this.mediaUrl(boardId, name));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => onProgress && e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => (xhr.status < 300 ? resolve(JSON.parse(xhr.responseText)) : reject(new Error(`upload failed: ${xhr.status}`)));
      xhr.onerror = () => reject(new Error('upload failed: network error'));
      xhr.send(blob);
    });
  }
}
