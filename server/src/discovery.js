import dgram from 'node:dgram';
import { Bonjour } from 'bonjour-service';
import { lanAddresses } from './config.js';

export const DISCOVER_MAGIC = 'LIRO_DISCOVER_V1';

function ipToInt(ip) {
  return ip.split('.').reduce((acc, p) => ((acc << 8) + Number(p)) >>> 0, 0);
}

// Picks the server address that is reachable from `remote` (same subnet), falling back to the first LAN IP.
export function addressFor(remote, preferred) {
  if (preferred) return preferred;
  const addrs = lanAddresses();
  if (remote && /^\d+\.\d+\.\d+\.\d+$/.test(remote)) {
    const r = ipToInt(remote);
    for (const a of addrs) {
      const mask = ipToInt(a.netmask);
      if ((ipToInt(a.address) & mask) === (r & mask)) return a.address;
    }
  }
  return addrs[0] ? addrs[0].address : '127.0.0.1';
}

// Answers UDP broadcast probes from clients: the client sends DISCOVER_MAGIC to port 1919/udp,
// the server replies with a JSON description of itself.
export function startUdpDiscovery(config, info) {
  const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => {
    if (msg.toString('utf8').trim() !== DISCOVER_MAGIC) return;
    const reply = JSON.stringify({
      liro: 1,
      name: config.name,
      serverId: info.serverId,
      port: config.port,
      hostname: config.hostname,
      address: addressFor(rinfo.address, config.publicIp),
    });
    sock.send(reply, rinfo.port, rinfo.address);
  });
  sock.on('error', (e) => console.error(`[discovery] UDP error: ${e.message}`));
  sock.bind(config.port, () => console.log(`[discovery] answering UDP broadcast probes on :${config.port}/udp`));
  return () => sock.close();
}

export function startMdns(config, info) {
  try {
    const bonjour = new Bonjour();
    const txt = { serverId: info.serverId, hostname: config.hostname, path: '/' };
    bonjour.publish({ name: config.name, type: 'liro', port: config.port, txt });
    bonjour.publish({ name: `${config.name} (web)`, type: 'http', port: config.port, txt });
    console.log('[discovery] mDNS service _liro._tcp published');
    return () => bonjour.unpublishAll(() => bonjour.destroy());
  } catch (e) {
    console.error(`[discovery] mDNS failed: ${e.message}`);
    return () => {};
  }
}
