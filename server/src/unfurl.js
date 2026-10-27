// Link previews: fetches a page, reads its OpenGraph / Twitter / <title> metadata and downloads the
// preview image and favicon. Images are stored as board media, so the card keeps working offline
// (and in the clients' local cache) after it has been unfurled once.

const MAX_HTML = 1.5 * 1024 * 1024;
const MAX_IMAGE = 8 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36 LiroBot/1.0';

const IMAGE_EXT = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg',
  'image/avif': 'avif', 'image/x-icon': 'ico', 'image/vnd.microsoft.icon': 'ico', 'image/bmp': 'bmp',
};

async function fetchLimited(url, limit, timeout = 8000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'User-Agent': UA, 'Accept-Language': 'ru,en;q=0.8' } });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > limit) {
        if (limit === MAX_HTML) break; // the <head> is enough for HTML
        throw new Error('too large');
      }
      chunks.push(chunk);
    }
    return { res, buf: Buffer.concat(chunks.map((c) => Buffer.from(c))) };
  } finally {
    clearTimeout(timer);
  }
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z:-]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    out[m[1].toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  }
  return out;
}

function decodeHtml(buf, contentType) {
  let charset = /charset=([\w-]+)/i.exec(contentType || '')?.[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

export function parseMeta(html, baseUrl) {
  const meta = {};
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const key = (a.property || a.name || a.itemprop || '').toLowerCase();
    if (key && a.content && !(key in meta)) meta[key] = a.content.trim();
  }
  const icons = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const a = attrs(m[0]);
    const rel = (a.rel || '').toLowerCase();
    if (a.href && /(^|\s)(icon|shortcut icon|apple-touch-icon)(\s|$)/.test(rel)) icons.push({ href: a.href, apple: rel.includes('apple') });
    if (a.href && rel === 'image_src' && !meta['og:image']) meta['og:image'] = a.href;
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  const abs = (u) => { try { return u ? new URL(u, baseUrl).href : null; } catch { return null; } };
  const clean = (s, n) => (s ? decodeEntities(s).replace(/\s+/g, ' ').trim().slice(0, n) : '');
  const icon = icons.find((i) => i.apple) || icons[0];
  return {
    title: clean(meta['og:title'] || meta['twitter:title'] || titleTag, 300),
    description: clean(meta['og:description'] || meta['twitter:description'] || meta.description, 600),
    site: clean(meta['og:site_name'] || meta['application-name'], 100),
    image: abs(meta['og:image:secure_url'] || meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || meta['twitter:image:src']),
    icon: abs(icon ? icon.href : '/favicon.ico'),
  };
}

// saveMedia(buffer, ext) -> media file name stored on the board.
export async function unfurl(rawUrl, saveMedia) {
  const url = new URL(rawUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Object.assign(new Error('only http(s) links'), { status: 400 });
  const result = { url: url.href, title: '', description: '', site: url.hostname.replace(/^www\./, ''), image: null, icon: null };

  const grabImage = async (src) => {
    if (!src) return null;
    try {
      const { res, buf } = await fetchLimited(src, MAX_IMAGE, 8000);
      const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const ext = IMAGE_EXT[type];
      if (!ext || buf.length < 16) return null;
      return await saveMedia(buf, ext);
    } catch {
      return null;
    }
  };

  const { res, buf } = await fetchLimited(url.href, MAX_HTML);
  const finalUrl = res.url || url.href;
  const type = (res.headers.get('content-type') || '').toLowerCase();
  if (type.startsWith('image/')) {
    const ext = IMAGE_EXT[type.split(';')[0].trim()];
    if (ext) result.image = await saveMedia(buf, ext);
    result.title = decodeURIComponent(url.pathname.split('/').pop() || url.hostname);
    return result;
  }
  if (!type.includes('html')) {
    result.title = decodeURIComponent(url.pathname.split('/').pop() || url.hostname);
    return result;
  }
  const m = parseMeta(decodeHtml(buf, type), finalUrl);
  result.title = m.title || url.hostname;
  result.description = m.description;
  if (m.site) result.site = m.site;
  const [image, icon] = await Promise.all([grabImage(m.image), grabImage(m.icon)]);
  result.image = image;
  result.icon = icon;
  return result;
}
