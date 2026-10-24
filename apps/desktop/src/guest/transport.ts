import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { connect, type Socket } from "node:net";
import {
  Agent,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import type { Readable } from "node:stream";
import type { GuestEndpoint } from "@irudd-scope/protocol/guest";

export type PeerRequest = {
  method?: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: Uint8Array | Readable;
  signal: AbortSignal;
  deadlineMs: number;
  idleMs: number;
};
export type PeerResponse = { status: number; headers: IncomingHttpHeaders; body: IncomingMessage };
const failure = () =>
  new Error("Guest transport disconnected. Check Tailcat and retry the connection.");
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    if (child.connected) child.disconnect();
    else child.kill();
  });
}
export class GuestTransport {
  private child?: ChildProcess;
  private socksPort?: number;
  private pending?: Promise<unknown>;
  private readonly disconnected: () => void;
  private readonly worker: string;
  constructor(disconnected: () => void, worker = join(import.meta.dirname, "guest-process.mjs")) {
    this.disconnected = disconnected;
    this.worker = worker;
  }
  private run(command: { mode: "generate" } | { mode: "start"; key: string; port: number }) {
    const child = fork(this.worker, [], {
      execArgv: [],
      serialization: "advanced",
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child = child;
    const result = new Promise<{ key?: string; address?: string; socksPort?: number }>(
      (resolve, reject) => {
        const timer = setTimeout(() => {
          reject(failure());
          void stop(child);
        }, 50000);
        child.once("error", () => {
          clearTimeout(timer);
          reject(failure());
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(failure());
          if (this.child === child) {
            this.child = undefined;
            this.socksPort = undefined;
            this.disconnected();
          }
        });
        child.on("message", (input: unknown) => {
          if (!input || typeof input !== "object" || !("type" in input)) return;
          const message = input as {
            type: string;
            key?: string;
            address?: string;
            socksPort?: number;
            message?: string;
          };
          if (message.type === "error") {
            clearTimeout(timer);
            reject(new Error(message.message ?? failure().message));
            void stop(child);
          } else if (
            (command.mode === "generate" &&
              message.type === "key" &&
              typeof message.key === "string") ||
            (command.mode === "start" &&
              message.type === "ready" &&
              typeof message.address === "string" &&
              Number.isInteger(message.socksPort))
          ) {
            clearTimeout(timer);
            resolve(message);
          }
        });
        child.send(command, (error) => {
          if (error) reject(failure());
        });
      },
    );
    this.pending = result;
    return result;
  }
  async generate() {
    const result = await this.run({ mode: "generate" });
    await this.close();
    return result.key!;
  }
  async start(key: string, port: number): Promise<GuestEndpoint> {
    const result = await this.run({ mode: "start", key, port });
    this.socksPort = result.socksPort;
    return { address: result.address!, port };
  }
  async close() {
    const child = this.child;
    this.child = undefined;
    this.socksPort = undefined;
    if (child) await stop(child);
    await this.pending?.catch(() => {});
  }
  async request(
    endpoint: GuestEndpoint,
    path: string,
    options: PeerRequest,
  ): Promise<PeerResponse> {
    if (!this.socksPort) throw failure();
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.deadlineMs)]);
    const socket = await socksConnect(this.socksPort, endpoint, signal);
    // agent:false creates Node's default Agent and discards createConnection.
    // This Agent can use only the already authenticated transport socket.
    const agent = new Agent({ keepAlive: false });
    agent.createConnection = () => socket;
    socket.once("close", () => agent.destroy());
    return new Promise<PeerResponse>((resolve, reject) => {
      const request = httpRequest(
        {
          method: options.method ?? "GET",
          path,
          host: "scope-peer.invalid",
          port: endpoint.port,
          agent,
          signal,
          maxHeaderSize: 16384,
          headers: { ...options.headers, Connection: "close" },
        },
        (response) => {
          response.setTimeout(options.idleMs, () => response.destroy(failure()));
          resolve({
            status: response.statusCode ?? 502,
            headers: response.headers,
            body: response,
          });
        },
      );
      request.setTimeout(options.idleMs, () => request.destroy(failure()));
      request.once("error", (error) => {
        socket.destroy();
        reject(error);
      });
      if (options.body && "pipe" in options.body) {
        const body = options.body;
        body.once("error", () => request.destroy(failure()));
        request.once("close", () => body.destroy());
        body.pipe(request);
      } else request.end(options.body);
    }).catch((error: unknown) => {
      socket.destroy();
      throw error;
    });
  }
}
function socksConnect(port: number, endpoint: GuestEndpoint, signal: AbortSignal): Promise<Socket> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let buffer = Buffer.alloc(0);
    let greeting = false;
    let complete = false;
    const abort = () => socket.destroy(failure());
    signal.addEventListener("abort", abort, { once: true });
    socket.once("close", () => {
      signal.removeEventListener("abort", abort);
      if (!complete) reject(failure());
    });
    socket.once("error", () => reject(failure()));
    socket.once("connect", () => socket.write(Buffer.from([5, 1, 0])));
    const data = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 4096) return abort();
      if (!greeting) {
        if (buffer.length < 2) return;
        if (buffer[0] !== 5 || buffer[1] !== 0) return abort();
        buffer = buffer.subarray(2);
        greeting = true;
        const host = Buffer.from(endpoint.address);
        if (host.length > 255) return abort();
        const targetPort = Buffer.alloc(2);
        targetPort.writeUInt16BE(endpoint.port);
        socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, host.length]), host, targetPort]));
      }
      if (buffer.length < 5) return;
      if (buffer[0] !== 5 || buffer[1] !== 0) return abort();
      const size =
        buffer[3] === 1 ? 10 : buffer[3] === 4 ? 22 : buffer[3] === 3 ? 7 + buffer[4]! : 0;
      if (!size) return abort();
      if (buffer.length < size) return;
      socket.removeListener("data", data);
      socket.pause();
      if (buffer.length > size) socket.unshift(buffer.subarray(size));
      complete = true;
      resolve(socket);
    };
    socket.on("data", data);
  });
}
