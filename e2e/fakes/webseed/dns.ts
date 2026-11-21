// A DNS responder beside the web seed, for gluetun behind the vpn scenario's
// test VPN servers, where no other DNS server answers. With `DNS_SERVER=off`,
// gluetun resolves github.com (up to ten tries, each one timing out) before
// its public-IP lookup on every tunnel up (`check.WaitForDNS` in
// internal/vpn/tunnelup.go), which put the exit IP about 105 s behind the
// tunnel. `DNS_ADDRESS` in compose.vpn.test.yml points gluetun here, through
// the tunnel. Every A query is answered with one address, every other type
// with no record. No package dependencies, as the web seed has none.
import { createSocket, type Socket } from 'node:dgram';

/** The answer to one query, or undefined for a packet that isn't one. */
export function dnsAnswer(query: Uint8Array, ipv4: string): Buffer | undefined {
  const q = Buffer.from(query);
  if (q.length < 12 || q.readUInt16BE(4) !== 1) return undefined;
  // The question's name: labels up to the zero byte, then its type and class.
  let offset = 12;
  while (offset < q.length && q[offset] !== 0) offset += q[offset]! + 1;
  const end = offset + 5;
  if (end > q.length) return undefined;
  const isA = q.readUInt16BE(offset + 1) === 1;

  const header = Buffer.alloc(12);
  q.copy(header, 0, 0, 2);
  // A response (QR), recursion available, the query's RD bit, no error.
  header.writeUInt16BE(0x8080 | (q.readUInt16BE(2) & 0x0100), 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(isA ? 1 : 0, 6);
  const question = q.subarray(12, end);
  if (!isA) return Buffer.concat([header, question]);

  // The name as a pointer to the question's, type A, class IN, a TTL of 60 s, four bytes.
  const record = Buffer.alloc(16);
  record.writeUInt16BE(0xc00c, 0);
  record.writeUInt16BE(1, 2);
  record.writeUInt16BE(1, 4);
  record.writeUInt32BE(60, 6);
  record.writeUInt16BE(4, 10);
  ipv4.split('.').forEach((octet, i) => record.writeUInt8(Number(octet), 12 + i));
  return Buffer.concat([header, question, record]);
}

/** A UDP DNS server answering every A query with `ipv4`; bind it with `.bind(port)`. */
export function createDnsResponder(ipv4: string): Socket {
  const socket = createSocket('udp4');
  socket.on('message', (query, from) => {
    const reply = dnsAnswer(query, ipv4);
    if (reply) socket.send(reply, from.port, from.address);
  });
  return socket;
}
