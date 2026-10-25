import assert from "node:assert/strict";
import { createReadStream, fstatSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http, { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { tmpdir, type NetworkInterfaceInfo } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { GuestTransport, type PeerRequest } from "../apps/desktop/src/guest/transport.ts";
import { GuestNetwork } from "../apps/desktop/src/guest/tailscale.ts";

// Synthetic discovery and socket routing exercise the production validation and adapter.
const directory = await mkdtemp(join(tmpdir(), "scope-guest-request-"));
let mode = "normal";
let discoveries = 0;
let requests = 0;
let connections = 0;
const localAddress = "100.64.0.1";
const peerAddress = "100.64.0.2";
const network = new GuestNetwork(
  async (signal) => {
    discoveries++;
    if (mode === "discovery-stall") await delay(10000, undefined, { signal });
    if (mode === "discovery-error") throw new Error("Synthetic unavailable CLI");
    return {
      BackendState: mode === "stopped" ? "Stopped" : "Running",
      Self: { TailscaleIPs: [localAddress] },
      Peer: { synthetic: { TailscaleIPs: [peerAddress] } },
    };
  },
  () => ({
    synthetic:
      mode === "interface-missing"
        ? []
        : [{ address: localAddress, family: "IPv4", internal: false } as NetworkInterfaceInfo],
  }),
);
const transport = new GuestTransport(network);
const server = createServer((request, response) => {
  if (mode === "redirect") return response.writeHead(302, { Location: "http://example.com" }).end();
  if (mode === "idle") return;
  if (mode === "response-stall") {
    response.writeHead(200);
    response.write("first");
    return;
  }
  response.writeHead(200);
  response.write("received:");
  let bytes = 0;
  request.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
  });
  request.once("end", () => setTimeout(() => response.end(String(bytes)), 50));
});
server.on("connection", (socket) => {
  connections++;
  socket.once("close", () => connections--);
});
const originalRequest = http.request;
// Only addresses already validated by the adapter are mapped. There is no shipped bypass.
http.request = ((
  options: http.RequestOptions,
  callback: (response: http.IncomingMessage) => void,
) => {
  requests++;
  assert.equal(options.host, peerAddress);
  assert.equal(options.localAddress, localAddress);
  assert.equal(options.family, 4);
  return originalRequest({ ...options, host: "127.0.0.1", localAddress: "127.0.0.1" }, callback);
}) as typeof http.request;
syncBuiltinESMExports();
const endpoint = { address: peerAddress, port: 1 };
const defaults = { signal: AbortSignal.timeout(30000), deadlineMs: 2000, idleMs: 500 };
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await delay(10);
  assert.ok(check(), "cleanup did not finish within one second");
}
async function rejected(
  label: string,
  override: Partial<PeerRequest> = {},
  trigger?: (
    body: ReturnType<typeof createReadStream>,
    controller: AbortController,
  ) => Promise<void>,
  target = endpoint,
  path = "/guest/upload",
) {
  const body = createReadStream(join(directory, "upload"));
  const [fd] = (await once(body, "open")) as [number];
  const controller = new AbortController();
  const pending = transport.request(target, path, {
    ...defaults,
    method: "PUT",
    body,
    signal: controller.signal,
    ...override,
  });
  const failed = assert.rejects(pending);
  if (trigger) await trigger(body, controller);
  await failed;
  assert.equal(body.destroyed, true, label);
  await until(() => body.closed);
  assert.throws(() => fstatSync(fd), { code: "EBADF" });
  assert.equal(body.listenerCount("error"), 0);
  await until(() => connections === 0);
  console.log("PASS:", label);
}
try {
  await writeFile(join(directory, "upload"), Buffer.alloc(65536, 42));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint.port = (server.address() as { port: number }).port;
  for (const address of [
    "example.com",
    "https://100.64.0.2",
    "127.0.0.1",
    "0.0.0.0",
    "192.168.1.1",
    "8.8.8.8",
    "100.64.0.3",
    localAddress,
    "100.064.0.2",
  ]) {
    await rejected("invalid destination " + address, {}, undefined, { ...endpoint, address });
  }
  for (const path of [
    "/v1/artifacts",
    "http://100.64.0.2/guest/hello",
    "//100.64.0.2/guest/hello",
    "/guest/../v1/artifacts",
    "/guest/hello?redirect=1",
  ])
    await rejected("invalid route " + path, {}, undefined, endpoint, path);
  assert.equal(requests, 0);
  for (mode of ["discovery-error", "stopped", "interface-missing"]) await rejected(mode);
  const before = discoveries;
  await rejected("pre-aborted signal", { signal: AbortSignal.abort() });
  assert.equal(discoveries, before);
  mode = "discovery-stall";
  await rejected("discovery idle deadline", { idleMs: 50 });
  await rejected("discovery total deadline", { deadlineMs: 50 });
  await rejected("cancel discovery", {}, async (_body, controller) => {
    await delay(20);
    controller.abort();
  });
  await rejected("body error during discovery", {}, async (body) => {
    await delay(20);
    body.destroy(new Error("Synthetic read error"));
  });
  await rejected("body close during discovery", {}, async (body) => {
    await delay(20);
    body.destroy();
  });
  mode = "normal";
  await rejected("HTTP construction failure", { headers: { "Invalid Header": "value" } });
  await rejected("HTTP send failure", {}, async (body) => {
    body.pipe = () => {
      throw new Error("Synthetic send failure");
    };
  });
  mode = "redirect";
  await rejected("redirect rejected");
  mode = "idle";
  await rejected("HTTP idle expiry", { idleMs: 50 });
  mode = "response-stall";
  for (const cancellation of ["caller", "close", "deadline", "idle"]) {
    const controller = new AbortController();
    const response = await transport.request(endpoint, "/guest/read", {
      ...defaults,
      signal: controller.signal,
      ...(cancellation === "deadline" ? { deadlineMs: 100 } : {}),
      ...(cancellation === "idle" ? { idleMs: 100 } : {}),
    });
    const consumed = assert.rejects(async () => {
      for await (const _chunk of response.body) {
        /* consume */
      }
    });
    if (cancellation === "caller") controller.abort();
    if (cancellation === "close") await transport.close();
    await consumed;
    await until(() => connections === 0);
    console.log("PASS: response cancellation", cancellation);
  }
  mode = "normal";
  const body = new PassThrough();
  const pending = transport.request(endpoint, "/guest/upload", {
    ...defaults,
    method: "PUT",
    body,
  });
  body.write("first");
  const response = await pending;
  assert.equal(body.destroyed, false);
  body.end("last");
  let text = "";
  for await (const chunk of response.body) text += chunk;
  assert.equal(text, "received:9");
  await until(() => body.destroyed && connections === 0);
  console.log("PASS: upload and response survive headers and clean up");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rejected("connection refused");
} finally {
  http.request = originalRequest;
  syncBuiltinESMExports();
  await transport.close();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
}
