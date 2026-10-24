import { expect } from "vite-plus/test";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, request } from "node:http";
import { mkdir, readFile, writeFile, realpath, symlink, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  FOLDER_OPERATION_CAPABILITY,
  FOLDER_OPERATION_RETENTION_MS,
  type FolderOperationRequest,
} from "@irudd-scope/protocol/folder-operation";

export function folderCommand(
  path: string,
  bytes: Buffer,
  extra: Partial<FolderOperationRequest> = {},
): FolderOperationRequest {
  return {
    version: 1,
    requestId: `${Date.now()}:${randomUUID()}`,
    kind: "file",
    path,
    expectedVersion: "missing",
    replace: false,
    payload: { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    ...extra,
  };
}

async function operationHub(base: string) {
  await mkdir(base, { recursive: true });
  const clock = join(base, "clock");
  const crash = join(base, "crash");
  await writeFile(clock, "0");
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const endpoint = `http://127.0.0.1:${port}`;
  const main = resolve("apps/hub/dist/main.mjs");
  const env = {
    ...process.env,
    SCOPE_HUB_DATA_DIR: join(base, "data"),
    SCOPE_CONNECTION_FILE: join(base, "connection.json"),
    SCOPE_ENDPOINT: undefined,
    SCOPE_TOKEN: undefined,
    SCOPE_TOKEN_FILE: undefined,
    SCOPE_FOLDER_TEST_CLOCK: clock,
    SCOPE_FOLDER_TEST_CRASH: crash,
    NODE_OPTIONS: `--import=${resolve("tests/fixtures/folder/operation-crash.mjs")}`,
  };
  const exec = (args: string[]) => promisify(execFile)(process.execPath, [main, ...args], { env });
  await exec(["configure", "--endpoint", endpoint, "--port", String(port)]);
  let child: ChildProcess;
  const start = async () => {
    child = spawn(process.execPath, [main, "run"], { env, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on("data", (bytes: Buffer) => {
        if (bytes.toString().includes("Scope hub listening")) resolve();
      });
      child.once("exit", () => reject(new Error("Synthetic hub exited before listening.")));
    });
  };
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await stopped;
  };
  await start();
  const local = JSON.parse(await readFile(env.SCOPE_CONNECTION_FILE, "utf8")) as { token: string };
  const { url: pairUrl } = (await fetch(`${endpoint}/v1/hub/pair`, {
    method: "POST",
    headers: { Authorization: `Bearer ${local.token}` },
  }).then((r) => r.json())) as { url: string };
  const paired = (await fetch(`${endpoint}/v1/pair`, {
    method: "POST",
    headers: { Authorization: `Bearer ${new URL(pairUrl).hash.slice(1)}` },
    body: JSON.stringify({ name: "Synthetic folder owner" }),
  }).then((r) => r.json())) as { token: string };
  const headers = { Authorization: `Bearer ${paired.token}` };
  const root = await realpath(base);
  const status = (id: string, caller = "peer-a") =>
    fetch(
      `${endpoint}/v1/relay/folders/operation-status?${new URLSearchParams({ caller, requestId: id })}`,
      { headers },
    ).then((r) => r.json());
  const write = (command: FolderOperationRequest, bytes: Buffer, caller = "peer-a") =>
    fetch(`${endpoint}/v1/relay/folders/operations?${new URLSearchParams({ root, caller })}`, {
      method: "PUT",
      headers: {
        ...headers,
        "Scope-Folder-Operation": Buffer.from(JSON.stringify(command)).toString("base64url"),
      },
      body: new Uint8Array(bytes),
    });
  const version = (path: string) =>
    fetch(`${endpoint}/v1/relay/folders/version?${new URLSearchParams({ root, path })}`, {
      headers,
    }).then((r) => r.json()) as Promise<{ version: string }>;
  return { endpoint, root, headers, clock, crash, start, stop, status, write, version };
}

/** Existing restart coverage also verifies the independent filesystem host's public API. */
export async function folderOperationChecks(base: string) {
  const hub = await operationHub(base);
  const bytes = Buffer.from("original");
  const command = folderCommand("durable.txt", bytes);
  try {
    const capabilities = await fetch(`${hub.endpoint}/v1/relay/folders/capabilities`, {
      headers: hub.headers,
    }).then((r) => r.json());
    expect(capabilities.capabilities).toContain(FOLDER_OPERATION_CAPABILITY);
    expect((await fetch(`${hub.endpoint}/v1/relay/folders/capabilities`)).status).toBe(401);
    expect(await (await hub.write(command, bytes)).json()).toMatchObject({
      state: "completed",
      receipt: { path: command.path, size: bytes.length },
    });
    const original = await hub.status(command.requestId);
    // Discard the write reply, restart the host and then change the file outside Scope.
    await hub.stop();
    await hub.start();
    await writeFile(join(base, command.path), "external change");
    expect(await hub.status(command.requestId)).toEqual(original);
    expect(await (await hub.write(command, bytes)).json()).toEqual(original);
    expect(await readFile(join(base, command.path), "utf8")).toBe("external change");
    expect(await hub.status(command.requestId, "peer-b")).toMatchObject({ state: "unknown" });
    const mismatch = await hub.write({ ...command, path: "different.txt" }, bytes);
    expect(mismatch.status).toBe(409);
    expect(await mismatch.json()).toMatchObject({ code: "request-mismatch" });
    const expectedVersion = (await hub.version(command.path)).version;
    const replace = folderCommand(command.path, bytes, { replace: true, expectedVersion });
    const competing = folderCommand(command.path, Buffer.from("other"), {
      replace: true,
      expectedVersion,
    });
    const results = await Promise.all([
      hub.write(replace, bytes),
      hub.write(competing, Buffer.from("other")),
    ]);
    const outcomes = await Promise.all(results.map((r) => r.json()));
    expect(outcomes.map((r) => r.state).sort((a, b) => a.localeCompare(b))).toEqual([
      "completed",
      "failed",
    ]);
    expect(outcomes.find((r) => r.state === "failed").error.code).toBe("conflict");
    const bad = folderCommand("bad.txt", bytes);
    expect(await (await hub.write(bad, Buffer.from("different"))).json()).toMatchObject({
      state: "failed",
      error: { code: "request-mismatch" },
    });
    await expect(readFile(join(base, "bad.txt"))).rejects.toThrow();
    for (const path of [".git/config", "../outside", ".scope-partial-hidden"]) {
      const rejected = await hub.write(folderCommand(path, bytes), bytes);
      const result = await rejected.json();
      expect(result.state).not.toBe("completed");
    }
    await mkdir(join(base, "outside"));
    await symlink(join(base, "outside"), join(base, "linked"));
    expect(
      await (await hub.write(folderCommand("linked/file.txt", bytes), bytes)).json(),
    ).not.toMatchObject({ state: "completed" });
    await expect(readFile(join(base, "outside/file.txt"))).rejects.toThrow();
    const directory = folderCommand("empty", Buffer.alloc(0), { kind: "directory" });
    expect(await (await hub.write(directory, Buffer.alloc(0))).json()).toMatchObject({
      state: "completed",
    });
    expect(await (await hub.write(directory, Buffer.alloc(0))).json()).toMatchObject({
      state: "completed",
    });
    // File transport is independent of the 32 MiB artifact limit.
    const large = Buffer.alloc(33 * 1024 * 1024, 71);
    const upload = folderCommand("large.bin", large);
    expect(await (await hub.write(upload, large)).json()).toMatchObject({
      state: "completed",
      receipt: { size: large.length },
    });
    expect((await readFile(join(base, upload.path))).equals(large)).toBe(true);
    await queuedOperations(hub);
    await interruptedOperation(hub);
    await writeFile(hub.crash, "crash after filesystem commit");
    const crash = folderCommand("crash-after-commit.txt", bytes);
    await hub.write(crash, bytes).then(
      (r) => r.text(),
      () => undefined,
    );
    await hub.stop();
    await hub.start();
    expect(await readFile(join(base, crash.path))).toEqual(bytes);
    expect(await hub.status(crash.requestId)).toMatchObject({ state: "unresolved" });
    await writeFile(join(base, crash.path), "after crash");
    expect(await (await hub.write(crash, bytes)).json()).toMatchObject({ state: "unresolved" });
    expect(await readFile(join(base, crash.path), "utf8")).toBe("after crash");
    const advanced = FOLDER_OPERATION_RETENTION_MS + 60_000;
    await writeFile(hub.clock, String(advanced));
    const future = folderCommand("new-era.txt", bytes, {
      requestId: `${Date.now() + advanced}:${randomUUID()}`,
    });
    expect(await (await hub.write(future, bytes)).json()).toMatchObject({ state: "completed" });
    expect(await hub.status(command.requestId)).toMatchObject({ state: "expired" });
    // Clock rollback plus restart must not turn a pruned request into a fresh write.
    await writeFile(hub.clock, "0");
    await hub.stop();
    await hub.start();
    expect(await (await hub.write(command, bytes)).json()).toMatchObject({ state: "expired" });
    expect(await readFile(join(base, command.path), "utf8")).not.toBe("external change");
  } finally {
    await hub.stop();
  }
}

async function interruptedOperation(hub: Awaited<ReturnType<typeof operationHub>>) {
  const command = folderCommand("interrupted.txt", Buffer.from("partial and more"));
  const outgoing = request(
    `${hub.endpoint}/v1/relay/folders/operations?${new URLSearchParams({ root: hub.root, caller: "peer-a" })}`,
    {
      method: "PUT",
      headers: {
        ...hub.headers,
        "Scope-Folder-Operation": Buffer.from(JSON.stringify(command)).toString("base64url"),
      },
    },
  );
  outgoing.on("error", () => {});
  outgoing.write("partial");
  await expect.poll(async () => (await hub.status(command.requestId)).state).toBe("pending");
  await hub.stop();
  outgoing.destroy();
  await hub.start();
  expect(await hub.status(command.requestId)).toMatchObject({ state: "unresolved" });
  expect(await (await hub.write(command, Buffer.from("partial and more"))).json()).toMatchObject({
    state: "unresolved",
  });
  await expect(readFile(join(hub.root, command.path))).rejects.toThrow();
}

async function queuedOperations(hub: Awaited<ReturnType<typeof operationHub>>) {
  const path = "legacy-race.txt";
  await writeFile(join(hub.root, path), "before");
  const expectedVersion = (await hub.version(path)).version;
  const legacy = (name: string) => {
    const outgoing = request(
      `${hub.endpoint}/v1/relay/folders/write?${new URLSearchParams({ root: hub.root, path: name, replace: "1" })}`,
      { method: "PUT", headers: hub.headers },
    );
    const answer = new Promise<number>((resolve, reject) => {
      outgoing.on("response", (incoming) => {
        incoming.resume();
        resolve(incoming.statusCode!);
      });
      outgoing.on("error", reject);
    });
    outgoing.write("legacy-");
    return { outgoing, answer };
  };
  const started = async () =>
    expect
      .poll(async () =>
        (await readdir(hub.root)).some((name) => name.startsWith(".scope-partial-")),
      )
      .toBe(true);
  const first = legacy(path);
  await started();
  const bytes = Buffer.from("versioned");
  const command = folderCommand(path, bytes, { replace: true, expectedVersion });
  const queued = hub.write(command, bytes);
  first.outgoing.end("commit");
  expect(await first.answer).toBe(200);
  expect(await (await queued).json()).toMatchObject({
    state: "failed",
    error: { code: "conflict" },
  });
  expect(await readFile(join(hub.root, path), "utf8")).toBe("legacy-commit");

  const second = legacy("held.txt");
  await started();
  const cancelled = folderCommand("cancelled-queue.txt", Buffer.from("queued bytes"));
  const outgoing = request(
    `${hub.endpoint}/v1/relay/folders/operations?${new URLSearchParams({ root: hub.root, caller: "peer-a" })}`,
    {
      method: "PUT",
      headers: {
        ...hub.headers,
        "Scope-Folder-Operation": Buffer.from(JSON.stringify(cancelled)).toString("base64url"),
      },
    },
  );
  outgoing.on("error", () => {});
  outgoing.write("queued");
  await new Promise<void>((resolve) => {
    outgoing.once("finish", resolve);
    outgoing.end();
  });
  outgoing.destroy();
  second.outgoing.end("commit");
  expect(await second.answer).toBe(200);
  await expect.poll(async () => (await hub.status(cancelled.requestId)).state).not.toBe("pending");
  await expect(readFile(join(hub.root, cancelled.path))).rejects.toThrow();
}
