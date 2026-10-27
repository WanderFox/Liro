// Finds Liro servers on the local network: UDP broadcast probe, mDNS (_liro._tcp) and the liro.loc name.
const dgram = require('dgram');
const os = require('os');
const { Bonjour } = require('bonjour-service');

const MAGIC = 'LIRO_DISCOVER_V1';
const PORT = 1919;

function broadcastAddresses() {
  const out = new Set(['255.255.255.255']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal) continue;
      const ip = a.address.split('.').map(Number);
      const mask = a.netmask.split('.').map(Number);
      out.add(ip.map((p, i) => (p & mask[i]) | (~mask[i] & 255)).join('.'));
    }
  }
  return [...out];
}

async function probe(url, timeout) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(`${url}/api/info`, { signal: ctl.signal });
    const info = await res.json();
    return info && info.liro ? info : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function discover({ timeout = 1800, hostnames = ['liro.loc', 'liro.local'] } = {}) {
  return new Promise((resolve) => {
    const found = new Map(); // serverId -> { serverId, name, url, hostname, source }
    const add = (entry) => {
      if (!entry.serverId) return;
      const prev = found.get(entry.serverId);
      // Prefer addresses learned from UDP replies (the server picks the address reachable from us).
      if (!prev || (prev.source !== 'udp' && entry.source === 'udp')) found.set(entry.serverId, entry);
    };

    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    sock.on('error', () => {});
    sock.on('message', (msg, rinfo) => {
      try {
        const info = JSON.parse(msg.toString('utf8'));
        if (!info.liro) return;
        const address = rinfo.address || info.address;
        add({ serverId: info.serverId, name: info.name, hostname: info.hostname, url: `http://${address}:${info.port || PORT}`, source: 'udp' });
      } catch {}
    });
    sock.bind(0, () => {
      try { sock.setBroadcast(true); } catch {}
      const send = () => {
        for (const addr of broadcastAddresses()) sock.send(MAGIC, PORT, addr, () => {});
      };
      send();
      setTimeout(send, 400);
    });

    let bonjour = null;
    try {
      bonjour = new Bonjour();
      bonjour.find({ type: 'liro' }, (svc) => {
        const ip = (svc.addresses || []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || svc.host;
        if (!ip) return;
        add({ serverId: svc.txt && svc.txt.serverId, name: svc.name, hostname: svc.txt && svc.txt.hostname, url: `http://${ip}:${svc.port}`, source: 'mdns' });
      });
    } catch {}

    const named = Promise.all(hostnames.flatMap((hn) => [`http://${hn}:${PORT}`, `http://${hn}`]).map(async (url) => {
      const info = await probe(url, timeout - 200);
      if (info) add({ serverId: info.serverId, name: info.name, hostname: info.hostname, url, source: 'dns' });
    }));

    setTimeout(async () => {
      await named;
      try { sock.close(); } catch {}
      try { bonjour && bonjour.destroy(); } catch {}
      resolve([...found.values()]);
    }, timeout);
  });
}

module.exports = { discover };
