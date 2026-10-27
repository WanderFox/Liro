// Minimal authoritative DNS responder for a single name (liro.loc by default).
// Point your router / dnsmasq at this server for the "loc" zone, or set it as a DNS server
// on client machines, and http://liro.loc:1919 will resolve to this machine.
import dgram from 'node:dgram';
import { lanAddresses } from './config.js';

const TYPE_A = 1;
const TYPE_ANY = 255;

function readName(buf, offset) {
  const labels = [];
  let pos = offset;
  while (pos < buf.length) {
    const len = buf[pos];
    if (len === 0) return { name: labels.join('.').toLowerCase(), end: pos + 1 };
    if ((len & 0xc0) !== 0) return null; // compression is not expected in questions
    labels.push(buf.toString('latin1', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  return null;
}

export function buildResponse(query, hostname, ip) {
  if (query.length < 12) return null;
  const qdcount = query.readUInt16BE(4);
  if (qdcount < 1) return null;
  const q = readName(query, 12);
  if (!q || q.end + 4 > query.length) return null;
  const qtype = query.readUInt16BE(q.end);
  const question = query.subarray(12, q.end + 4);

  const matches = q.name === hostname || q.name.endsWith(`.${hostname}`);
  const answerA = matches && (qtype === TYPE_A || qtype === TYPE_ANY);

  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0); // id
  const rd = query[2] & 0x01;
  // QR=1, AA=1 when authoritative, RD copied; RCODE 0 (ok) or 3 (NXDOMAIN)
  header[2] = 0x80 | (matches ? 0x04 : 0) | rd;
  header[3] = matches ? 0x00 : 0x03;
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(answerA ? 1 : 0, 6);
  if (!answerA) return Buffer.concat([header, question]);

  const answer = Buffer.alloc(16);
  answer.writeUInt16BE(0xc00c, 0); // pointer to the name in the question
  answer.writeUInt16BE(TYPE_A, 2);
  answer.writeUInt16BE(1, 4); // IN
  answer.writeUInt32BE(60, 6); // TTL
  answer.writeUInt16BE(4, 10);
  ip.split('.').forEach((p, i) => { answer[12 + i] = Number(p); });
  return Buffer.concat([header, question, answer]);
}

// Binds to each LAN address separately: on Ubuntu, systemd-resolved already holds 127.0.0.53:53,
// so a wildcard bind would fail. Each socket answers with its own interface address.
export function startDns(config) {
  const addrs = lanAddresses().map((a) => a.address);
  const sockets = addrs.map((ip) => {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      try {
        const res = buildResponse(msg, config.hostname, config.publicIp || ip);
        if (res) sock.send(res, rinfo.port, rinfo.address);
      } catch (e) {
        console.error(`[dns] ${e.message}`);
      }
    });
    sock.on('error', (e) => console.error(`[dns] cannot serve DNS on ${ip}:${config.dnsPort}: ${e.message}`));
    sock.bind(config.dnsPort, ip, () => console.log(`[dns] answering ${config.hostname} on ${ip}:${config.dnsPort}/udp`));
    return sock;
  });
  return () => sockets.forEach((s) => s.close());
}
