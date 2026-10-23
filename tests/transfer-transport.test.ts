import { expect, test } from "vite-plus/test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TailcatCliTransport } from "../apps/desktop/src/transfer/transport.ts";

const address = "tc" + "a".repeat(80);
const supervisor = resolve("apps/desktop/dist/cli-process.mjs");
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

test(
  "invalid addresses, ports and oversized requests are rejected before running the CLI",
  { tags: ["bad-requests-change-nothing"] },
  async () => {
    const f = await fixture();
    try {
      await expect(f.transport.request("http://localhost", 12345, "request")).rejects.toThrow(
        "Invalid",
      );
      for (const port of [0, 65536, 1.5])
        await expect(f.transport.request(address, port, "request")).rejects.toThrow("Invalid");
      await expect(f.transport.request(address, 12345, "x".repeat(16385))).rejects.toThrow(
        "Invalid",
      );
      await expect(f.calls()).rejects.toThrow();
    } finally {
      await f.close();
    }
  },
);
