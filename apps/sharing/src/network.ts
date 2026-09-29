import { createSocket } from "node:dgram";

// Cloudflare's published global tunnel addresses. Changes require a service update.
export const regions = {
  "region1.v2.argotunnel.com": [167, 67, 57, 107, 27, 7, 227, 47, 37, 77].map(
    (n) => `198.41.192.${n}`,
  ),
  "region2.v2.argotunnel.com": [13, 193, 33, 233, 53, 63, 113, 73, 43, 23].map(
    (n) => `198.41.200.${n}`,
  ),
};
const discovery = "_v2-origintunneld._tcp.argotunnel.com";
const domainBytes = (name: string) =>
  Buffer.concat([
    ...name
      .split(".")
      .map((label) => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])),
    Buffer.from([0]),
  ]);

export function dnsAnswer(query: Buffer): Buffer | undefined {
  if (
    query.length < 17 ||
    query.length > 512 ||
    query.readUInt16BE(4) !== 1 ||
    (query[2] & 0xf8) !== 0
  )
    return;
  const labels: string[] = [];
  let end = 12;
  while (end < query.length && query[end]) {
    const length = query[end++];
    if (length > 63 || end + length >= query.length) return;
    labels.push(query.toString("ascii", end, end + length).toLowerCase());
    end += length;
  }
  end++;
  if (end + 4 > query.length || query.readUInt16BE(end + 2) !== 1) return;
  const type = query.readUInt16BE(end);
  const name = labels.join(".");
  const addresses = Object.entries(regions).find(([key]) => key === name)?.[1];
  const payloads: Buffer[] = [];
  if (type === 1 && addresses)
    for (const address of addresses) payloads.push(Buffer.from(address.split(".").map(Number)));
  if (type === 33 && name === discovery)
    for (const [index, target] of Object.keys(regions).entries()) {
      const prefix = Buffer.alloc(6);
      prefix.writeUInt16BE(index + 1, 0);
      prefix.writeUInt16BE(1, 2);
      prefix.writeUInt16BE(7844, 4);
      payloads.push(Buffer.concat([prefix, domainBytes(target)]));
    }
  const header = Buffer.alloc(12);
  query.copy(header, 0, 0, 2);
  header.writeUInt16BE(addresses || name === discovery ? 0x8180 : 0x8183, 2);
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(payloads.length, 6);
  const records = payloads.map((payload) => {
    const record = Buffer.alloc(12);
    record.writeUInt16BE(0xc00c, 0);
    record.writeUInt16BE(type, 2);
    record.writeUInt16BE(1, 4);
    record.writeUInt32BE(60, 6);
    record.writeUInt16BE(payload.length, 10);
    return Buffer.concat([record, payload]);
  });
  return Buffer.concat([header, query.subarray(12, end + 4), ...records]);
}

export async function startDns() {
  // This resolver never forwards queries, including queries with unknown names.
  const socket = createSocket("udp4");
  socket.on("message", (query, peer) => {
    const answer = dnsAnswer(query);
    if (answer) socket.send(answer, peer.port, peer.address);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(53, "127.0.0.53", () => {
      socket.removeListener("error", reject);
      resolve();
    });
  });
  return socket;
}
