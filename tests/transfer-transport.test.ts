import { expect, test } from "vite-plus/test";
import { fork } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { desktopFixture } from "./desktop-fixture.ts";
import { readTransferUrl } from "@irudd-scope/protocol/transfer";
import { TailcatCliTransport } from "../apps/desktop/src/transfer/transport.ts";

const address = "tc" + "a".repeat(80);
const supervisor = resolve("apps/desktop/dist/cli-process.mjs");
const unavailable = "Tailcat could not start or disconnected";

async function fixture(source: string = cli) {
  const directory = await mkdtemp(join(tmpdir(), "scope-tailcat-cli-"));
  const binary = join(directory, "tailcat");
  const calls = join(directory, "calls.jsonl");
  const stopped = join(directory, "stopped");
  const stopping = join(directory, "stopping");
  await writeFile(
    binary,
    "#!" +
      process.execPath +
      "\n" +
      [
        "const fs = require('node:fs');",
        "const net = require('node:net');",
        "const args = process.argv.slice(2);",
        "const calls = " + JSON.stringify(calls) + ";",
        "const stopped = " + JSON.stringify(stopped) + ";",
        "const stopping = " + JSON.stringify(stopping) + ";",
        "fs.appendFileSync(calls, JSON.stringify({args, pid: process.pid}) + '\\n');",
        "if (args[0] !== '--key=new' || process.env.TAILCAT_ADDR_FILE || process.env.TAILCAT_STATUS_LOOP) process.exit(2);",
        source,
      ].join("\n"),
  );
  await chmod(binary, 0o700);
  return {
    directory,
    binary,
    stopped,
    stopping,
    transport: new TailcatCliTransport(binary, supervisor),
    calls: async () =>
      (await readFile(calls, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { args: string[]; pid: number }),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

const cli = `
if (args[1] === '--json' && args[2] === 'serve' && args.length === 4) {
  process.stdout.write(JSON.stringify({listenAddr: '${address}'}) + '\\n');
  setInterval(() => {}, 1000);
} else if (args[1] === 'forward' && args[2] === '--bind=127.0.0.1' && args.length === 5) {
  const remotePort = Number(args[4].slice(2));
  net.createServer(socket => {
    const remote = net.connect(remotePort, '127.0.0.1');
    socket.on('error', () => remote.destroy());
    remote.on('error', () => socket.destroy());
    socket.pipe(remote); remote.pipe(socket);
  }).listen(0, '127.0.0.1', function() {
    process.stderr.write('# forwarding 127.0.0.1:' + this.address().port + ' -> remote localhost:' + remotePort + '\\n');
  });
} else process.exit(3);
`;

test("installed CLI serves only the source port, uses ephemeral keys, and carries payloads over HTTP", async () => {
  const f = await fixture();
  const oldAddressFile = process.env.TAILCAT_ADDR_FILE;
  const oldStatus = process.env.TAILCAT_STATUS_LOOP;
  process.env.TAILCAT_ADDR_FILE = join(f.directory, "must-not-be-written");
  process.env.TAILCAT_STATUS_LOOP = "1";
  let listener: Awaited<ReturnType<TailcatCliTransport["listen"]>> | undefined;
  try {
    const body = '{"ciphertext":"synthetic-encrypted-value"}';
    listener = await f.transport.listen(async (input) => {
      expect(input).toBe(body);
      return '{"ciphertext":"synthetic-response"}';
    });
    expect(await f.transport.request(listener.address, listener.port, body)).toBe(
      '{"ciphertext":"synthetic-response"}',
    );
    expect((await f.calls()).map((call) => call.args)).toEqual([
      ["--key=new", "--json", "serve", String(listener.port)],
      ["--key=new", "forward", "--bind=127.0.0.1", address, "0:" + listener.port],
    ]);
    expect(JSON.stringify(await f.calls())).not.toContain("synthetic-encrypted-value");
    await listener.close();
    await expect(fetch("http://127.0.0.1:" + listener.port)).rejects.toThrow();
  } finally {
    if (oldAddressFile === undefined) delete process.env.TAILCAT_ADDR_FILE;
    else process.env.TAILCAT_ADDR_FILE = oldAddressFile;
    if (oldStatus === undefined) delete process.env.TAILCAT_STATUS_LOOP;
    else process.env.TAILCAT_STATUS_LOOP = oldStatus;
    await listener?.close();
    await f.close();
  }
});

test("CLI discovery finds a user executable on PATH without provisioning anything", async () => {
  const f = await fixture();
  const previous = process.env.PATH;
  process.env.PATH = f.directory;
  let listener: Awaited<ReturnType<TailcatCliTransport["listen"]>> | undefined;
  try {
    listener = await new TailcatCliTransport(undefined, supervisor).listen(async () => "response");
    expect(listener.address).toBe(address);
    expect((await f.calls())[0].args[1]).toBe("--json");
  } finally {
    if (previous === undefined) delete process.env.PATH;
    else process.env.PATH = previous;
    await listener?.close();
    await f.close();
  }
});

test("missing user-installed CLI produces an actionable error for both transfer directions", async () => {
  const transport = new TailcatCliTransport("/scope-synthetic-missing/tailcat", supervisor);
  const message = "Tab transfers require the Tailcat CLI installed separately on this Mac.";
  await expect(transport.listen(async () => "response")).rejects.toThrow(message);
  await expect(transport.request(address, 12345, "request")).rejects.toThrow(message);
});

test("invalid addresses, ports and oversized requests are rejected before running the CLI", async () => {
  const f = await fixture();
  try {
    await expect(f.transport.request("http://localhost", 12345, "request")).rejects.toThrow(
      "Invalid",
    );
    for (const port of [0, 65536, 1.5])
      await expect(f.transport.request(address, port, "request")).rejects.toThrow("Invalid");
    await expect(f.transport.request(address, 12345, "x".repeat(16385))).rejects.toThrow("Invalid");
    await expect(f.calls()).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("source accepts only bounded JSON POST requests at its dedicated endpoint", async () => {
  const f = await fixture();
  let listener: Awaited<ReturnType<TailcatCliTransport["listen"]>> | undefined;
  const seen: string[] = [];
  try {
    listener = await f.transport.listen(async (body) => {
      seen.push(body);
      return "synthetic-response";
    });
    const endpoint = "http://127.0.0.1:" + listener.port + "/";
    const rejected: RequestInit[] = [
      { method: "GET" },
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://example.invalid" },
        body: "blocked",
      },
      { method: "POST", headers: { "content-type": "text/plain" }, body: "blocked" },
      { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(16385) },
    ];
    for (const options of rejected) {
      const response = await fetch(endpoint, options).catch(() => undefined);
      expect(response?.status).not.toBe(200);
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "approved",
    });
    expect(await response.text()).toBe("synthetic-response");
    expect(seen).toEqual(["approved"]);
  } finally {
    await listener?.close();
    await f.close();
  }
});

test("malformed, oversized or incompatible CLI readiness fails without echoing diagnostics", async () => {
  for (const output of [
    "not-json\n",
    "x".repeat(8193),
    JSON.stringify({ listenAddr: "https://secret.invalid" }) + "\n",
  ]) {
    const f = await fixture(
      "process.stdout.write(" + JSON.stringify(output) + "); setInterval(() => {}, 1000);",
    );
    try {
      await expect(f.transport.listen(async () => "response")).rejects.toThrow(unavailable);
    } finally {
      await f.close();
    }
  }
  const f = await fixture(
    "process.stderr.write('# forwarding 0.0.0.0:12345 -> remote localhost:80\\n'); setInterval(() => {}, 1000);",
  );
  try {
    await expect(f.transport.request(address, 12345, "request")).rejects.toThrow(unavailable);
  } finally {
    await f.close();
  }
});

test("forwarder failure ends pending requests and source CLI failure leaves close usable", async () => {
  const f = await fixture(cli + "\nsetTimeout(() => process.exit(1), 300);");
  let listener: Awaited<ReturnType<TailcatCliTransport["listen"]>> | undefined;
  let finish!: (value: string) => void;
  try {
    listener = await f.transport.listen(() => new Promise<string>((resolve) => (finish = resolve)));
    await expect(f.transport.request(listener.address, listener.port, "request")).rejects.toThrow(
      unavailable,
    );
    await listener.close();
    await expect(fetch("http://127.0.0.1:" + listener.port)).rejects.toThrow();
  } finally {
    finish?.("response");
    await listener?.close();
    await f.close();
  }
});

test("oversized responses are rejected and the request forwarder is stopped", async () => {
  const f = await fixture(`
require('node:http').createServer((_request, response) => {
  response.writeHead(200, {'content-type': 'application/json'});
  response.on('error', () => {});
  const chunk = Buffer.alloc(64 * 1024, 97);
  let count = 0;
  function write() {
    while (count++ < 1025) if (!response.write(chunk)) { response.once('drain', write); return; }
    response.end();
  }
  write();
}).listen(0, '127.0.0.1', function() {
  process.stderr.write('# forwarding 127.0.0.1:' + this.address().port + ' -> remote localhost:12345\\n');
});
process.on('SIGTERM', () => { fs.writeFileSync(stopped, 'done'); process.exit(0); });
`);
  try {
    await expect(f.transport.request(address, 12345, "request")).rejects.toThrow(unavailable);
    await expect.poll(() => readFile(f.stopped, "utf8").catch(() => "")).toBe("done");
  } finally {
    await f.close();
  }
});

for (const mode of ["listen", "request"] as const) {
  test("abrupt owner exit stops the " + mode + " CLI before releasing its port", async () => {
    const f = await fixture(
      cli +
        `
process.on('SIGTERM', () => {
  fs.writeFileSync(stopping, 'stopping');
  setTimeout(() => { fs.writeFileSync(stopped, 'done'); process.exit(0); }, 300);
});
`,
    );
    const ownerFile = join(f.directory, "owner.cjs");
    await writeFile(
      ownerFile,
      `
const worker = require('node:child_process').fork(${JSON.stringify(supervisor)}, [], {
  execArgv: [], serialization: 'advanced', stdio: ['ignore','ignore','ignore','ipc'],
  env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}
});
worker.on('message', message => { if (message.type === 'listening') process.send(message); });
worker.send({type:'start',command:${JSON.stringify({ mode, binary: f.binary, address, port: 12345, body: "request" })}});
setInterval(() => {}, 1000);
`,
    );
    const owner = fork(ownerFile, [], {
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let port: number | undefined;
    try {
      if (mode === "listen") {
        port = await new Promise<number>((resolve) =>
          owner.once("message", (message: { port: number }) => resolve(message.port)),
        );
      } else {
        await expect.poll(async () => (await f.calls().catch(() => [])).length).toBe(1);
      }
      owner.kill("SIGKILL");
      await expect.poll(() => readFile(f.stopping, "utf8").catch(() => "")).toBe("stopping");
      if (port) {
        const reservation = createServer();
        await expect(
          new Promise<void>((resolve, reject) => {
            reservation.once("error", reject);
            reservation.listen(port, "127.0.0.1", resolve);
          }),
        ).rejects.toMatchObject({ code: "EADDRINUSE" });
        reservation.close();
      }
      await expect.poll(() => readFile(f.stopped, "utf8").catch(() => "")).toBe("done");
      if (port) {
        const reservation = createServer();
        await expect
          .poll(async () => {
            return new Promise<boolean>((resolve) => {
              reservation.once("error", () => resolve(false));
              reservation.listen(port, "127.0.0.1", () => {
                reservation.close(() => resolve(true));
              });
            });
          })
          .toBe(true);
      }
    } finally {
      owner.kill("SIGKILL");
      await f.close();
    }
  });
}

test("Electron main supervises the installed CLI when creating and cancelling a real pairing", async () => {
  const f = await fixture();
  const desktop = await desktopFixture();
  const app = await desktop.launch();
  try {
    await app.evaluate((_electron, directory) => {
      process.env.PATH = directory;
    }, f.directory);
    const page = await app.firstWindow();
    const invitation = await page.evaluate(() => window.scope.createPairing("Studio Mac"));
    const parsed = readTransferUrl(invitation.url);
    expect(parsed.version).toBe(2);
    expect(parsed.port).toBe(Number((await f.calls())[0].args[3]));
    const pid = (await f.calls())[0].pid;
    await page.evaluate((id) => window.scope.cancelTransfer(id), invitation.id);
    await expect
      .poll(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      })
      .toBe(true);
  } finally {
    await app.close();
    await rm(desktop.directory, { recursive: true, force: true });
    await f.close();
  }
});

test("the source rejects additional sockets before they can send HTTP headers", async () => {
  const f = await fixture();
  const listener = await f.transport.listen(async () => "response");
  const sockets = [];
  try {
    for (let index = 0; index < 4; index++) {
      const socket = connect(listener.port, "127.0.0.1");
      sockets.push(socket);
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
      });
    }
    const extra = connect(listener.port, "127.0.0.1");
    sockets.push(extra);
    await new Promise<void>((resolve) => {
      extra.once("close", () => resolve());
      extra.on("error", () => {});
    });
    expect(sockets.slice(0, 4).every((socket) => !socket.destroyed)).toBe(true);
  } finally {
    for (const socket of sockets) socket.destroy();
    await listener.close();
    await f.close();
  }
});
