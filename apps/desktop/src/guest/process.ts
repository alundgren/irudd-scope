import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { access, constants, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { Readable } from "node:stream";

const children = new Set<ChildProcess>();
const cleanups = new Set<() => Promise<void>>();
let closing = false;
let started = false;
let startup: ReturnType<typeof setTimeout> | undefined;
const failure =
  "Guest connections need a compatible Tailcat CLI and protected key access. Retry after checking Tailcat and Windows PowerShell.";
function send(value: unknown) {
  if (process.connected) process.send?.(value);
}
async function close() {
  if (closing) return;
  closing = true;
  clearTimeout(startup);
  await Promise.all([...children].map(stop));
  await Promise.all([...cleanups].map((cleanup) => cleanup().catch(() => {})));
  process.exit(0);
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}
function fail() {
  if (!closing) {
    send({ type: "error", message: failure });
    void close();
  }
}
process.once("disconnect", () => void close());
process.once("SIGTERM", () => void close());
process.once("SIGINT", () => void close());
if (!process.connected) process.exit(1);

function start(binary: string, args: string[]) {
  const env = { ...process.env };
  delete env.TAILCAT_ADDR_FILE;
  delete env.TAILCAT_STATUS_LOOP;
  delete env.TS_DEBUG_TAILCAT_LOCAL_DERP;
  const child = spawn(binary, args, { windowsHide: true, stdio: "pipe", env });
  children.add(child);
  child.stdin.on("error", () => {});
  child.on("error", fail);
  child.once("exit", () => children.delete(child));
  return child;
}
async function binary() {
  const search =
    Object.entries(process.env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const dirs = search.split(delimiter).filter(Boolean);
  if (process.platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  for (const dir of dirs) {
    const path = join(
      dir.replace(/^"(.*)"$/, "$1"),
      process.platform === "win32" ? "tailcat.exe" : "tailcat",
    );
    try {
      await access(path, constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch {
      /* Try the next installation directory. */
    }
  }
  throw new Error(failure);
}
function lines(stream: Readable, child: ChildProcess) {
  let buffer = "";
  const queued: string[] = [];
  let waiter: { resolve: (line: string) => void; reject: (error: Error) => void } | undefined;
  let ended = false;
  stream.on("data", (bytes: Buffer) => {
    buffer += bytes.toString("utf8");
    if (Buffer.byteLength(buffer) > 32768) return fail();
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (waiter) {
        const pending = waiter;
        waiter = undefined;
        pending.resolve(line);
      } else if (queued.length < 8) queued.push(line);
      else return fail();
    }
  });
  child.once("exit", () => {
    ended = true;
    waiter?.reject(new Error(failure));
  });
  return () =>
    queued.length
      ? Promise.resolve(queued.shift()!)
      : ended
        ? Promise.reject(new Error(failure))
        : new Promise<string>((resolve, reject) => {
            waiter = { resolve, reject };
          });
}
function exited(child: ChildProcess) {
  return new Promise<void>((resolve, reject) => {
    const finish = (code: number | null) => (code === 0 ? resolve() : reject(new Error(failure)));
    if (child.exitCode !== null) finish(child.exitCode);
    else {
      child.once("exit", finish);
      child.once("error", reject);
    }
  });
}
async function keyChannel(mode: "read" | "write", key?: string) {
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot;
    if (!systemRoot) throw new Error(failure);
    const helper = start(
      join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(import.meta.dirname, "key-pipe.ps1"),
        "-Mode",
        mode,
        "-ParentId",
        String(process.pid),
      ],
    );
    helper.stderr.resume();
    const next = lines(helper.stdout, helper);
    const path = await next();
    if (!/^\\\\\.\\pipe\\scope-guest-[a-f0-9]{32}$/.test(path)) throw new Error(failure);
    if (key !== undefined) helper.stdin.end(Buffer.from(key).toString("base64") + "\n");
    else helper.stdin.end();
    const timer = setTimeout(() => {
      void stop(helper);
      fail();
    }, 35000);
    const result =
      mode === "read"
        ? next().then((value) => Buffer.from(value, "base64").toString("utf8"))
        : Promise.resolve("");
    result.catch(() => {});
    const done = exited(helper).finally(() => clearTimeout(timer));
    done.catch(() => {});
    return { path, result, done };
  }
  const directory = await mkdtemp(join(tmpdir(), "scope-guest-key-"));
  const path = join(directory, "key");
  const cleanup = async () => {
    await rm(directory, { recursive: true, force: true });
  };
  cleanups.add(cleanup);
  const fifo = start("/usr/bin/mkfifo", ["-m", "600", path]);
  fifo.stdout.resume();
  fifo.stderr.resume();
  await exited(fifo);
  if (mode === "write") {
    const stream = createWriteStream(path);
    const done = new Promise<void>((resolve, reject) => {
      stream.once("close", resolve);
      stream.once("error", reject);
    });
    done.catch(() => {});
    stream.end(key);
    return { path, result: Promise.resolve(""), done };
  }
  const stream = createReadStream(path);
  const result = (async () => {
    let value = "";
    for await (const bytes of stream) {
      value += bytes.toString();
      if (Buffer.byteLength(value) > 16384) throw new Error(failure);
    }
    return value;
  })();
  result.catch(() => {});
  return { path, result, done: result.then(() => {}) };
}
process.once("message", (input: unknown) => {
  if (started || !input || typeof input !== "object" || !("mode" in input)) return fail();
  started = true;
  startup = setTimeout(fail, 45000);
  void (async () => {
    const executable = await binary();
    const command = input as { mode: string; key?: string; port?: number };
    if (command.mode === "generate") {
      const channel = await keyChannel("read");
      const child = start(executable, [
        "genkey",
        "--key=" + channel.path,
        "--force",
        "--fixed-region",
      ]);
      // genkey prints an address containing a PSK. Keep it within this process.
      child.stdout.resume();
      child.stderr.resume();
      const [key] = await Promise.all([channel.result, exited(child), channel.done]);
      if (!key || key.length > 16384) throw new Error(failure);
      JSON.parse(key);
      send({ type: "key", key });
      await close();
      return;
    }
    if (
      command.mode !== "start" ||
      typeof command.key !== "string" ||
      command.key.length > 16384 ||
      !Number.isInteger(command.port) ||
      command.port! < 1 ||
      command.port! > 65535
    )
      throw new Error(failure);
    const serverKey = await keyChannel("write", command.key);
    const server = start(executable, [
      "--key=" + serverKey.path,
      "--json",
      "serve",
      String(command.port),
    ]);
    server.stderr.resume();
    const addressLine = lines(server.stdout, server);
    const address = JSON.parse(await addressLine()).listenAddr;
    if (typeof address !== "string" || !/^tc[A-Za-z0-9_-]{38,253}$/.test(address))
      throw new Error(failure);
    await serverKey.done;
    server.once("exit", fail);
    // Use a separate ephemeral client identity; the peer session authenticates the pairing.
    const socks = start(executable, ["--key=new", "socks", "--listen=127.0.0.1:0"]);
    socks.stdout.resume();
    const socksLine = lines(socks.stderr, socks);
    let port: number | undefined;
    for (let i = 0; i < 8; i++) {
      const match = /SOCKS running at socks5h:\/\/127\.0\.0\.1:(\d+)$/.exec(await socksLine());
      if (match) {
        port = Number(match[1]);
        break;
      }
    }
    if (!port || port > 65535) throw new Error(failure);
    socks.once("exit", fail);
    clearTimeout(startup);
    send({ type: "ready", address, socksPort: port });
  })().catch(fail);
});
