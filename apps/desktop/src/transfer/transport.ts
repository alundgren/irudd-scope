import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

export interface TransferTransport {
  listen(handler: (body: string) => Promise<string>): Promise<{
    address: string;
    close: () => Promise<void>;
  }>;
  request(address: string, body: string): Promise<string>;
}

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const validAddress = (address: string) => /^tc[A-Za-z0-9_-]{38,4094}$/.test(address);
const transportError = () => new Error("Scope transfer transport is unavailable or disconnected.");

function start(binary: string, operation: object) {
  const child = spawn(binary, [], { stdio: "pipe" });
  // Diagnostics from the transport or its dependencies can contain connection details.
  child.stderr.resume();
  child.stdin.on("error", () => {});
  child.stdin.write(`${JSON.stringify(operation)}\n`);
  return child;
}

async function stop(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
    child.stdin.end();
  });
}

function validRequest(request: IncomingMessage) {
  return (
    request.method === "POST" &&
    request.url === "/" &&
    request.headers.origin === undefined &&
    request.headers["content-type"] === "application/json"
  );
}

async function receive(
  request: IncomingMessage,
  response: ServerResponse,
  handler: (body: string) => Promise<string>,
) {
  if (!validRequest(request)) {
    response.writeHead(400).end();
    return;
  }
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of request) {
      const bytes = Buffer.from(chunk);
      length += bytes.length;
      if (length > MAX_REQUEST_BYTES) {
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(bytes);
    }
    const result = await handler(Buffer.concat(chunks).toString("utf8"));
    if (Buffer.byteLength(result) > MAX_RESPONSE_BYTES) throw transportError();
    if (response.destroyed) return;
    response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    response.end(result);
  } catch {
    if (!response.destroyed) response.writeHead(400).end();
  }
}

export class NativeTransferTransport implements TransferTransport {
  private readonly binary: string;

  constructor(binary = join(import.meta.dirname, "scope-tailcat")) {
    this.binary = binary;
  }

  async listen(handler: (body: string) => Promise<string>) {
    let active = 0;
    const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
      if (active >= 4) {
        response.writeHead(503).end();
        return;
      }
      active++;
      void receive(request, response, handler).finally(() => active--);
    });
    server.requestTimeout = 60_000;
    server.headersTimeout = 10_000;
    server.timeout = 60_000;
    server.maxRequestsPerSocket = 1;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const endpoint = server.address();
    if (!endpoint || typeof endpoint === "string") throw transportError();
    const child = start(this.binary, { mode: "listen", port: endpoint.port });
    let closed: Promise<void> | undefined;
    const close = () => {
      closed ??= (async () => {
        server.closeAllConnections();
        await Promise.all([
          stop(child),
          new Promise<void>((resolve) => server.close(() => resolve())),
        ]);
      })();
      return closed;
    };
    try {
      const address = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(transportError()), 35_000);
        const fail = () => {
          clearTimeout(timer);
          reject(transportError());
          void close();
        };
        child.once("error", fail);
        child.once("close", fail);
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString("utf8");
          if (output.length > 8192) return fail();
          if (!output.includes("\n")) return;
          try {
            const parsed: unknown = JSON.parse(output);
            if (
              typeof parsed !== "object" ||
              parsed === null ||
              !("address" in parsed) ||
              typeof parsed.address !== "string" ||
              !validAddress(parsed.address)
            )
              return fail();
            clearTimeout(timer);
            resolve(parsed.address);
          } catch {
            fail();
          }
        });
      });
      return { address, close };
    } catch (error) {
      await close();
      throw error;
    }
  }

  async request(address: string, body: string) {
    if (!validAddress(address) || Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
      throw new Error("Invalid Scope transfer request.");
    }
    const child = start(this.binary, { mode: "request", address, body });
    child.stdin.end();
    try {
      return await new Promise<string>((resolve, reject) => {
        const chunks: Buffer[] = [];
        let length = 0;
        const fail = () => reject(transportError());
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          fail();
        }, 65_000);
        child.once("error", () => {
          clearTimeout(timer);
          fail();
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          if (code !== 0) return fail();
          resolve(Buffer.concat(chunks).toString("utf8"));
        });
        child.stdout.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_RESPONSE_BYTES) {
            child.kill("SIGKILL");
            fail();
            return;
          }
          chunks.push(chunk);
        });
      });
    } finally {
      await stop(child);
    }
  }
}
