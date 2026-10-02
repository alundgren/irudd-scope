import { expect, test } from "vite-plus/test";
import { spawn, execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { NativeTransferTransport } from "../apps/desktop/src/transfer/transport.ts";

const address = `tc${"a".repeat(80)}`;
const exec = promisify(execFile);

async function fixture(source: string) {
  const directory = await mkdtemp(join(tmpdir(), "scope-transfer-transport-"));
  const binary = join(directory, "transport.cjs");
  await writeFile(binary, `#!${process.execPath}\n${source}`);
  await chmod(binary, 0o700);
  return { directory, binary };
}

const readOperation = `
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', value => {
  input += value;
  if (!input.includes('\\n')) return;
  process.stdin.removeAllListeners('data');
  const operation = JSON.parse(input);
  run(operation);
});
`;

test("the built native transport identifies its pinned library without contacting relays", async () => {
  const result = await exec(resolve("apps/desktop/dist/scope-tailcat"), ["--version"]);
  expect(result.stdout).toBe("scope-tailcat tailcat/v0.7.0\n");
  expect(result.stderr).toBe("");
});

test("the native bundle includes notices and licenses for linked dependencies and Go", async () => {
  const directory = resolve("apps/desktop/dist/transfer-licenses");
  const notices = await readFile(join(directory, "NOTICE.md"), "utf8");
  for (const name of [
    "Go standard library go1.27.1",
    "github.com/tailscale/tailcat v0.7.0",
    "github.com/tailscale/wireguard-go",
    "gvisor.dev/gvisor",
    "tailscale.com",
  ]) {
    expect(notices).toContain(name);
  }
  const links = [...notices.matchAll(/\]\(([^)]+)\)/g)];
  expect(links.length).toBeGreaterThan(30);
  for (const [, file] of links) {
    const target = join(directory, file);
    if ((await stat(target)).isDirectory()) {
      expect((await readdir(target)).length).toBeGreaterThan(0);
    } else {
      expect((await readFile(target, "utf8")).length).toBeGreaterThan(0);
    }
  }
});

test("native invalid operations fail without echoing connection details", async () => {
  const child = spawn(resolve("apps/desktop/dist/scope-tailcat"), [], { stdio: "pipe" });
  const result = await new Promise<{ code: number | null; output: string; errors: string }>(
    (resolve) => {
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk) => (output += String(chunk)));
      child.stderr.on("data", (chunk) => (errors += String(chunk)));
      child.on("close", (code) => resolve({ code, output, errors }));
      child.stdin.end(
        `${JSON.stringify({ mode: "request", address: "https://synthetic-secret", body: "secret" })}\n`,
      );
    },
  );
  expect(result).toEqual({ code: 1, output: "", errors: "Scope transfer transport failed.\n" });
});

test("requests carry addresses and encrypted payloads only over stdin", async () => {
  const { directory, binary } = await fixture(`${readOperation}
function run(operation) {
  if (process.argv.length !== 2) process.exit(1);
  process.stdout.write(JSON.stringify(operation));
  process.exit(0);
}
`);
  try {
    const transport = new NativeTransferTransport(binary);
    const body = '{"ciphertext":"synthetic-encrypted-value"}';
    expect(JSON.parse(await transport.request(address, body))).toEqual({
      mode: "request",
      address,
      body,
    });
    await expect(transport.request("http://localhost", body)).rejects.toThrow(
      "Invalid Scope transfer request",
    );
    await expect(transport.request(address, "a".repeat(16 * 1024 + 1))).rejects.toThrow(
      "Invalid Scope transfer request",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("listeners accept only bounded JSON POST requests and close their helper", async () => {
  const { directory, binary } = await fixture(`${readOperation}
async function run(operation) {
  process.stdin.on('end', () => process.exit(0));
  process.stdout.write(JSON.stringify({address: '${address}'}) + '\\n');
  const endpoint = 'http://127.0.0.1:' + operation.port + '/';
  for (const options of [
    {method: 'GET'},
    {method: 'POST', headers: {'content-type': 'application/json', origin: 'https://example.invalid'}, body: 'blocked'},
    {method: 'POST', headers: {'content-type': 'application/json'}, body: 'x'.repeat(16385)},
    {method: 'POST', headers: {'content-type': 'text/plain'}, body: 'blocked'},
  ]) {
    try {
      const response = await fetch(endpoint, options);
      if (response.status === 200) process.exit(2);
    } catch {}
  }
  const response = await fetch(endpoint, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({pid: process.pid})});
  if (await response.text() !== 'synthetic-encrypted-response') process.exit(3);
}
`);
  let listener: Awaited<ReturnType<NativeTransferTransport["listen"]>> | undefined;
  try {
    const received: string[] = [];
    let delivered!: (pid: number) => void;
    const delivery = new Promise<number>((resolve) => (delivered = resolve));
    listener = await new NativeTransferTransport(binary).listen(async (body) => {
      received.push(body);
      delivered(JSON.parse(body).pid);
      return "synthetic-encrypted-response";
    });
    expect(listener.address).toBe(address);
    const pid = await delivery;
    expect(received).toHaveLength(1);
    await listener.close();
    await listener.close();
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    await listener?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing and failed helpers reject calls without revealing stderr", async () => {
  const { directory, binary } = await fixture(`${readOperation}
function run() { process.stderr.write('synthetic-secret'); process.exit(1); }
`);
  try {
    for (const executable of [binary, join(directory, "missing")]) {
      const transport = new NativeTransferTransport(executable);
      await expect(transport.request(address, "encrypted")).rejects.toThrow(
        "Scope transfer transport is unavailable or disconnected.",
      );
      await expect(transport.listen(async () => "encrypted")).rejects.toThrow(
        "Scope transfer transport is unavailable or disconnected.",
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an oversized helper response fails instead of returning partial bytes", async () => {
  const { directory, binary } = await fixture(`${readOperation}
function run() {
  process.stdout.write(Buffer.alloc(64 * 1024 * 1024 + 1, 97), () => process.exit(0));
}
`);
  try {
    await expect(new NativeTransferTransport(binary).request(address, "encrypted")).rejects.toThrow(
      "Scope transfer transport is unavailable or disconnected.",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("listener failure disconnects pending requests and leaves close usable", async () => {
  const { directory, binary } = await fixture(`${readOperation}
function run(operation) {
  process.stdout.write(JSON.stringify({address: 'tc' + 'a'.repeat(38) + operation.port}) + '\\n');
  setTimeout(() => process.exit(1), 1000);
}
`);
  let listener: Awaited<ReturnType<NativeTransferTransport["listen"]>> | undefined;
  let finish!: (value: string) => void;
  const result = new Promise<string>((resolve) => (finish = resolve));
  try {
    listener = await new NativeTransferTransport(binary).listen(() => result);
    const port = Number(listener.address.slice(40));
    await expect(
      fetch(`http://127.0.0.1:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "encrypted",
      }),
    ).rejects.toThrow();
    await listener.close();
  } finally {
    finish("encrypted");
    await listener?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
