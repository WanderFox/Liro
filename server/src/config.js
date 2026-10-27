import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Settings file (KEY=VALUE lines). Real environment variables take precedence over the file.
// Default: /etc/liro/liro.env on Linux, %ProgramData%\Liro\liro.env on Windows; LIRO_CONFIG overrides.
export const configFile = process.env.LIRO_CONFIG
  || (process.platform === 'win32'
    ? path.join(process.env.ProgramData || 'C:\\ProgramData', 'Liro', 'liro.env')
    : '/etc/liro/liro.env');

function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadEnvFile(configFile);

const env = process.env;

function bool(v, def) {
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function ports(v) {
  return String(v || '').split(/[,\s]+/).map(Number).filter((p) => p > 0 && p < 65536);
}

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(a);
    }
  }
  return out;
}

export const config = {
  name: env.LIRO_NAME || `Liro (${os.hostname()})`,
  port: Number(env.LIRO_PORT) || 1919,
  // Additional HTTP ports, e.g. "80" so that http://liro.loc works without a port.
  extraPorts: ports(env.LIRO_EXTRA_PORTS),
  host: env.LIRO_BIND || '0.0.0.0',
  dataDir: path.resolve(env.LIRO_DATA || path.join(here, '..', 'data')),
  webDir: path.resolve(env.LIRO_WEB || path.join(here, '..', '..', 'web')),
  hostname: (env.LIRO_HOSTNAME || 'liro.loc').toLowerCase(),
  // Built-in minimal DNS responder that answers <hostname> -> this server.
  dns: bool(env.LIRO_DNS, false),
  dnsPort: Number(env.LIRO_DNS_PORT) || 53,
  publicIp: env.LIRO_PUBLIC_IP || '',
  mdns: bool(env.LIRO_MDNS, true),
  udpDiscovery: bool(env.LIRO_UDP_DISCOVERY, true),
  // User sticker packs (one folder per pack); packs bundled with the server are used as well.
  stickersDir: path.resolve(env.LIRO_STICKERS || path.join(env.LIRO_DATA ? path.resolve(env.LIRO_DATA) : path.join(here, '..', 'data'), 'stickers')),
  bundledStickersDir: path.join(here, '..', 'stickers'),
  fontsDir: path.resolve(env.LIRO_FONTS || path.join(env.LIRO_DATA ? path.resolve(env.LIRO_DATA) : path.join(here, '..', 'data'), 'fonts')),
  bundledFontsDir: path.join(here, '..', 'fonts'),
  iconsDir: path.resolve(env.LIRO_ICONS || path.join(env.LIRO_DATA ? path.resolve(env.LIRO_DATA) : path.join(here, '..', 'data'), 'icons')),
  shapesDir: path.resolve(env.LIRO_SHAPES || path.join(env.LIRO_DATA ? path.resolve(env.LIRO_DATA) : path.join(here, '..', 'data'), 'shapes')),
  // Free space thresholds of the data disk: warn below the first, refuse new content below the second.
  diskWarnGb: Number(env.LIRO_DISK_WARN_GB) || 10,
  diskBlockGb: Number(env.LIRO_DISK_BLOCK_GB) || 5,
  // Unused media files are deleted after this many hours (keeps undo working meanwhile).
  mediaGraceHours: Number(env.LIRO_MEDIA_GRACE_HOURS) || 24,
  maxUploadBytes: (Number(env.LIRO_MAX_UPLOAD_MB) || 2048) * 1024 * 1024,
};
