import assert from "node:assert/strict";
import { createReadStream, fstatSync, type ReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer, connect, type Socket } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { GuestTransport, type PeerRequest } from "../apps/desktop/src/guest/transport.ts";

// Bounded, offline probe of the production HTTP adapter. The synthetic worker
// supplies a local SOCKS endpoint; no installed CLI or native credentials run.
const directory = await mkdtemp(join(tmpdir(), "scope-guest-request-"));
const sockets = new Set<Socket>();
const bodies = new Set<ReadStream>();
let mode: "stall" | "reject" | "forward" = "stall";
let negotiations = 0;
function track(socket: Socket) {
  sockets.add(socket);
  socket.on("error", () => {});
  socket.once("close", () => sockets.delete(socket));
  return socket;
}
const http = httpServer((request, response) => {
  response.writeHead(200);
  response.write("received:");
  let bytes = 0;
  request.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  request.once("end", () => setTimeout(() => response.end(String(bytes)), 100));
});
http.on("connection", track);
const proxy = createServer((socket) => {
  track(socket);
  let buffer = Buffer.alloc(0),
    greeted = false;
  const receive = (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!greeted && buffer.length >= 3) {
      greeted = true;
      negotiations++;
      if (mode === "stall") return;
      buffer = buffer.subarray(3);
      socket.write(Buffer.from([5, 0]));
    }
    if (!greeted || mode === "stall" || buffer.length < 5) return;
    const length = 7 + buffer[4]!;
    if (buffer.length < length) return;
    socket.removeListener("data", receive);
    socket.write(Buffer.from([5, mode === "reject" ? 5 : 0, 0, 1, 127, 0, 0, 1, 0, 0]));
    if (mode === "reject") return socket.end();
    const remote = track(connect((http.address() as { port: number }).port, "127.0.0.1"));
    socket.once("close", () => remote.destroy());
    remote.once("close", () => socket.destroy());
    if (buffer.length > length) remote.write(buffer.subarray(length));
    socket.pipe(remote);
    remote.pipe(socket);
  };
  socket.on("data", receive);
});
let transport: GuestTransport | undefined;
const endpoint = { address: "tc" + "a".repeat(80), port: 9 };
async function until(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.ok(check(), "cleanup or negotiation did not complete within one second");
}
async function rejected(
  label: string,
  override: Partial<PeerRequest> = {},
  trigger?: (body: ReadStream, controller: AbortController) => Promise<void>,
) {
  const body = createReadStream(join(directory, "upload"));
  bodies.add(body);
  const [fd] = (await once(body, "open")) as [number];
  const controller = new AbortController();
  const before = negotiations;
  const pending = transport!.request(endpoint, "/", {
    method: "PUT",
    body,
    signal: controller.signal,
    deadlineMs: 1500,
    idleMs: 500,
    ...override,
  });
  // Attach rejection handling before deliberately failing an asynchronous body.
  const rejected = assert.rejects(pending);
  if (trigger) await trigger(body, controller);
  await rejected;
  assert.equal(body.destroyed, true, label + ": upload not destroyed");
  await until(() => body.closed);
  assert.throws(() => fstatSync(fd), { code: "EBADF" }, label + ": descriptor still open");
  assert.equal(body.listenerCount("error"), 0, label + ": error listener retained after close");
  await until(() => sockets.size === 0);
  console.log("PASS:", label);
  return before;
}
try {
  await writeFile(join(directory, "upload"), Buffer.alloc(65536, 42));
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const port = (proxy.address() as { port: number }).port;
  const worker = join(directory, "worker.mjs");
  await writeFile(
    worker,
    `process.on('message',()=>process.send({type:'ready',address:${JSON.stringify(endpoint.address)},socksPort:${port}}));process.on('disconnect',()=>process.exit());`,
  );
  transport = new GuestTransport(() => {}, worker);
  await rejected("transport unavailable before setup");
  await transport.start("synthetic", endpoint.port);
  const before = await rejected("pre-aborted signal", { signal: AbortSignal.abort() });
  assert.equal(negotiations, before);
  await rejected("cancel stalled SOCKS", {}, async (_body, controller) => {
    const before = negotiations;
    await until(() => negotiations > before);
    controller.abort();
  });
  await rejected("SOCKS deadline");
  await rejected("body error during SOCKS setup", {}, async (body) => {
    const before = negotiations;
    await until(() => negotiations > before);
    body.destroy(new Error("Synthetic upload read failure"));
  });
  await rejected("body closed during SOCKS setup", {}, async (body) => {
    const before = negotiations;
    await until(() => negotiations > before);
    body.destroy();
  });
  mode = "reject";
  await rejected("SOCKS destination failure");
  mode = "forward";
  await rejected("HTTP construction failure", { headers: { "Invalid Header": "value" } });
  await rejected("HTTP send setup failure", {}, async (body) => {
    body.pipe = () => {
      throw new Error("Synthetic send failure");
    };
  });
  const body = new PassThrough();
  const pending = transport.request(endpoint, "/", {
    method: "PUT",
    body,
    signal: AbortSignal.timeout(3000),
    deadlineMs: 2500,
    idleMs: 1000,
  });
  body.write("first");
  const response = await pending;
  assert.equal(body.destroyed, false, "headers destroyed an unfinished upload");
  assert.equal(response.body.destroyed, false, "headers destroyed the response");
  body.end("last");
  let text = "";
  for await (const chunk of response.body) text += chunk;
  assert.equal(text, "received:9");
  await until(() => body.destroyed && sockets.size === 0);
  console.log("PASS: streamed upload and response survive headers, then clean up");
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
  await rejected("SOCKS listener connection refused");
} finally {
  for (const body of bodies) body.destroy();
  for (const socket of sockets) socket.destroy();
  await transport?.close();
  await Promise.all(
    [http, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  await rm(directory, { recursive: true, force: true });
}
