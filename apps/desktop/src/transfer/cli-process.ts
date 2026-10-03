import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, constants, stat } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";
import {
  MAX_REQUEST_BYTES,
  MAX_RESPONSE_BYTES,
  validAddress,
  validBody,
  validPort,
  type CliCommand,
  type CliInput,
  type CliOutput,
} from "./cli-contract.ts";

let started = false;
let stopped = false;
let closing: Promise<void> | undefined;
let tool: ChildProcessWithoutNullStreams | undefined;
let server: Server | undefined;
let deadline: ReturnType<typeof setTimeout> | undefined;
let abortRequest: (() => void) | undefined;
let nextRequest = 0;
const pending = new Map<number, { resolve: (body: string) => void; reject: () => void }>();

function send(message: CliOutput) {
  if (!process.connected) return;
  process.send?.(message, (error: Error | null) => {
    if (error) void close();
  });
}

async function stopTool(child: ChildProcessWithoutNullStreams) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

function close() {
  closing ??= (async () => {
    stopped = true;
    clearTimeout(deadline);
    abortRequest?.();
    for (const reply of pending.values()) reply.reject();
    pending.clear();
    // Keep this port reserved until Tailcat can no longer forward to it.
    if (tool) await stopTool(tool);
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    if (process.connected) process.disconnect?.();
    process.exit(0);
  })();
  return closing;
}

function fail(error: "missing" | "unavailable" = "unavailable") {
  if (stopped) return;
  send({ type: "error", error });
  void close();
}

process.once("disconnect", () => void close());
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
if (!process.connected) process.exit(1);

async function findBinary(explicit?: string) {
  if (explicit) return explicit;
  const directories = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  if (process.platform === "darwin") directories.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const directory of directories) {
    const file = join(directory, "tailcat");
    try {
      await access(file, constants.X_OK);
      if ((await stat(file)).isFile()) return file;
    } catch {
      // GUI-launched Mac apps may need the standard Homebrew locations after PATH.
    }
  }
  return undefined;
}

function startTool(binary: string, args: string[]) {
  if (stopped) throw new Error("Closed");
  const env = { ...process.env };
  delete env.TAILCAT_ADDR_FILE;
  delete env.TAILCAT_STATUS_LOOP;
  const child = spawn(binary, args, { stdio: "pipe", env });
  tool = child;
  child.stdin.on("error", () => {});
  child.once("error", (error: NodeJS.ErrnoException) =>
    fail(error.code === "ENOENT" ? "missing" : "unavailable"),
  );
  child.once("exit", () => fail());
  return child;
}

function ready<T>(
  stream: Readable,
  child: ChildProcessWithoutNullStreams,
  parse: (line: string) => T,
) {
  return new Promise<T>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => finish(new Error("Not ready")), 35_000);
    const failed = () => finish(new Error("Disconnected"));
    const data = (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 8192) return finish(new Error("Too much output"));
      const newline = output.indexOf("\n");
      if (newline < 0) return;
      try {
        finish(undefined, parse(output.slice(0, newline)));
      } catch (error) {
        finish(error);
      }
    };
    function finish(error?: unknown, value?: T) {
      clearTimeout(timer);
      child.removeListener("error", failed);
      child.removeListener("close", failed);
      stream.removeListener("data", data);
      stream.resume();
      if (error) reject(error);
      else resolve(value!);
    }
    child.once("error", failed);
    child.once("exit", failed);
    stream.on("data", data);
  });
}

async function readBody(stream: AsyncIterable<Uint8Array>, limit: number) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.length;
    if (length > limit) throw new Error("Too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function listen(binary: string) {
  server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    if (
      stopped ||
      request.method !== "POST" ||
      request.url !== "/" ||
      request.headers.origin !== undefined ||
      request.headers["content-type"] !== "application/json" ||
      pending.size >= 4
    ) {
      response.writeHead(400).end();
      return;
    }
    void (async () => {
      const body = await readBody(request, MAX_REQUEST_BYTES);
      if (stopped || pending.size >= 4) throw new Error("Closed");
      const id = ++nextRequest;
      const result = await new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject: () => reject(new Error("Rejected")) });
        send({ type: "request", id, body });
      });
      if (!response.destroyed) {
        response.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
        response.end(result);
      }
    })().catch(() => {
      if (!response.destroyed) response.writeHead(400).end();
    });
  });
  server.maxConnections = 4;
  server.requestTimeout = 60_000;
  server.headersTimeout = 10_000;
  server.timeout = 60_000;
  server.maxRequestsPerSocket = 1;
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(0, "127.0.0.1", resolve);
  });
  server.on("error", () => fail());
  const endpoint = server.address();
  if (stopped || !endpoint || typeof endpoint === "string") throw new Error("Closed");
  const child = startTool(binary, ["--key=new", "--json", "serve", String(endpoint.port)]);
  child.stderr.resume();
  const address = await ready(child.stdout, child, (line) => {
    const value: unknown = JSON.parse(line);
    if (
      !value ||
      typeof value !== "object" ||
      !("listenAddr" in value) ||
      !validAddress(value.listenAddr)
    )
      throw new Error("Invalid address");
    return value.listenAddr;
  });
  if (!stopped) send({ type: "listening", address, port: endpoint.port });
}

async function request(binary: string, command: Extract<CliCommand, { mode: "request" }>) {
  const child = startTool(binary, [
    "--key=new",
    "forward",
    "--bind=127.0.0.1",
    command.address,
    "0:" + command.port,
  ]);
  child.stdout.resume();
  const port = await ready(child.stderr, child, (line) => {
    const match = /^# forwarding 127\.0\.0\.1:(\d+) -> remote localhost:(\d+)$/.exec(line);
    if (!match || !validPort(Number(match[1])) || Number(match[2]) !== command.port)
      throw new Error("Invalid forwarding endpoint");
    return Number(match[1]);
  });
  if (stopped) return;
  const body = await new Promise<string>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/",
        method: "POST",
        agent: false,
        maxHeaderSize: 8192,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(command.body),
          Connection: "close",
        },
      },
      (response) => {
        if (
          response.statusCode !== 200 ||
          response.headers["content-type"] !== "application/json"
        ) {
          response.destroy();
          reject(new Error("Rejected"));
          return;
        }
        void readBody(response, MAX_RESPONSE_BYTES).then(resolve, reject);
      },
    );
    abortRequest = () => request.destroy(new Error("Closed"));
    request.once("error", reject);
    request.end(command.body);
  });
  if (!stopped) send({ type: "result", body });
  await close();
}

async function run(command: CliCommand) {
  const binary = await findBinary(command.binary);
  if (stopped) return;
  if (!binary) return fail("missing");
  deadline = setTimeout(() => fail(), command.mode === "listen" ? 40_000 : 65_000);
  if (command.mode === "listen") {
    await listen(binary);
    clearTimeout(deadline);
  } else await request(binary, command);
}

process.on("message", (input: unknown) => {
  if (stopped) return;
  if (!input || typeof input !== "object" || !("type" in input)) return fail();
  const message = input as CliInput;
  if (message.type === "start") {
    const command = message.command;
    if (
      started ||
      !command ||
      typeof command !== "object" ||
      (command.binary !== undefined &&
        (typeof command.binary !== "string" || command.binary.length > 4096)) ||
      (command.mode !== "listen" && command.mode !== "request") ||
      (command.mode === "request" &&
        (!validAddress(command.address) ||
          !validPort(command.port) ||
          !validBody(command.body, MAX_REQUEST_BYTES)))
    )
      return fail();
    started = true;
    void run(command).catch(() => fail());
  } else if (
    (message.type === "response" || message.type === "handler-error") &&
    Number.isSafeInteger(message.id)
  ) {
    const reply = pending.get(message.id);
    if (!reply) return fail();
    pending.delete(message.id);
    if (message.type === "response" && validBody(message.body, MAX_RESPONSE_BYTES))
      reply.resolve(message.body);
    else reply.reject();
  } else fail();
});
