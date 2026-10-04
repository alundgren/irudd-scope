import { afterEach, expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { MemorySync } from "@irudd-scope/memory-sync";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { memoryCredentials } from "../apps/desktop/src/credentials.ts";
import { DesktopLifecycle } from "../apps/desktop/src/lifecycle.ts";
import { Remotes } from "../apps/desktop/src/remotes.ts";
import { MemoryService } from "../apps/desktop/src/memory.ts";
import { MEMORY_REPOSITORY, memoryFixture } from "./memory-fixture.ts";

const exec = promisify(execFile);
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const f = await memoryFixture(cleanup);
  const state = await HubState.open(join(f.directory, "hub"));
  cleanup.push(() => state.close());
  const connectionFile = join(f.directory, "connection.json");
  await state.configure({ endpoint: "http://127.0.0.1:1", port: 1, connectionFile });
  const hubSync = new MemorySync({
    root: f.root("hub"),
    machine: "hub",
    env: f.env("hub"),
    intervalMs: 60 * 60_000,
  });
  const hub = await startPairedHub(state, 0, undefined, hubSync);
  cleanup.push(hub.close);
  await state.configure({ endpoint: hub.url, port: Number(new URL(hub.url).port), connectionFile });
  const store = new DesktopStore(join(f.directory, "desktop"), memoryCredentials());
  await store.load();
  cleanup.push(() => store.close());
  let memory: MemoryService | undefined;
  let lifecycle: DesktopLifecycle;
  const token = "synthetic-desktop-publishing-token";
  const desktop = await startArtifactServer({
    directory: join(f.directory, "artifacts"),
    token,
    port: 0,
    memory: {
      status: () => memory!.snapshot(),
      connect: (repository) => memory!.connect(repository),
    },
    retroConfiguration: {
      read: () => store.retroConfiguration(),
      configure: (command) => store.saveRetroConfiguration(command),
    },
    initialize: async (artifacts) => {
      lifecycle = new DesktopLifecycle(artifacts, store);
      await lifecycle.recover();
    },
    deleteArtifact: (id) => lifecycle.deleteArtifact(id),
  });
  cleanup.push(desktop.close);
  const remotes = new Remotes(store, { url: desktop.url, token }, () => {});
  memory = new MemoryService(store, remotes, () => {}, {
    root: f.root("mac"),
    env: f.env("mac"),
    intervalMs: 60 * 60_000,
  });
  cleanup.push(() => memory.close());
  cleanup.push(() => remotes.close());
  await memory.start();
  await remotes.start();
  const cli = async (...args: string[]) => {
    const result = await exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
      env: {
        ...process.env,
        SCOPE_CONNECTION_FILE: connectionFile,
        SCOPE_TOKEN: undefined,
        SCOPE_ENDPOINT: undefined,
        SCOPE_TOKEN_FILE: undefined,
      },
      timeout: 60_000,
    }).catch((error: { stdout: string; stderr: string }) => error);
    return { stdout: result.stdout, stderr: result.stderr };
  };
  const local = decodeLocalConnection(JSON.parse(await readFile(connectionFile, "utf8")));
  return { ...f, state, hubSync, store, remotes, memory, cli, local, hub };
}

test("a remote agent connects the memory repository and every paired machine syncs it", async () => {
  const f = await fixture();
  await f.remotes.pair(f.state.pairUrl());
  await expect.poll(() => f.remotes.snapshot()[0]?.connection).toBe("connected");
  const remoteId = f.remotes.snapshot()[0].id;

  const refused = await f.cli("memory", "connect", MEMORY_REPOSITORY);
  expect(refused.stderr).toContain("Turn on Memory in Scope Settings on the Mac first.");

  expect(f.memory.snapshot().okfInstalled).toBe(true);
  await f.memory.setEnabled(true);
  const connected = JSON.parse((await f.cli("memory", "connect", MEMORY_REPOSITORY)).stdout);
  expect(connected.configuration).toEqual({ enabled: true, repository: MEMORY_REPOSITORY });

  await expect.poll(() => f.hubSync.status().phase, { timeout: 30_000 }).toBe("synced");
  expect(f.state.memoryConfiguration()).toEqual({ enabled: true, repository: MEMORY_REPOSITORY });
  await f.memory.retry();
  await expect
    .poll(() => f.memory.snapshot().machines.map((machine) => machine.status?.phase))
    .toEqual(["synced", "synced"]);
  expect(f.memory.snapshot().machines[1]).toMatchObject({ id: remoteId, local: false });

  await writeFile(join(f.clone("hub"), "manual-sync.md"), "Synced by the Mac's Sync now.\n");
  await f.memory.retry();
  expect(await f.git(f.directory, "--git-dir", f.bare, "show", "main:manual-sync.md")).toBe(
    "Synced by the Mac's Sync now.\n",
  );

  const retro = await f.store.retroConfiguration();
  expect(
    retro.memory.destinations.map(({ id, type, scope, path }) => ({ id, type, scope, path })),
  ).toEqual([
    { id: "okf-personal-local", type: "okf", scope: "operator", path: f.clone("mac") },
    { id: `okf-personal-${remoteId}`, type: "okf", scope: "operator", path: f.clone("hub") },
  ]);

  await f.remotes.close();
  await writeFile(join(f.clone("hub"), "offline.md"), "Written while the Mac sleeps.\n");
  await f.hubSync.sync();
  const offline = JSON.parse((await f.cli("memory", "status")).stdout);
  expect(offline).toMatchObject({ macOffline: true, machine: { phase: "synced" } });
  await f.memory.retry();
  expect(await readFile(join(f.clone("mac"), "offline.md"), "utf8")).toBe(
    "Written while the Mac sleeps.\n",
  );

  await f.memory.setEnabled(false);
  expect((await f.store.retroConfiguration()).memory.destinations).toEqual([]);
});

test("CLI memory status reaches the local hub when a connected Mac stops responding", async () => {
  const f = await fixture();
  await f.remotes.pair(f.state.pairUrl());
  await expect.poll(() => f.remotes.snapshot()[0]?.connection).toBe("connected");
  const token = await f.store.remoteToken(f.remotes.snapshot()[0].id);
  await f.remotes.close();
  const controller = new AbortController();
  const relay = await fetch(`${f.hub.url}/v1/relay/events`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
  try {
    expect(relay.status).toBe(200);
    const status = await f.cli("memory", "status", "--timeout-ms", "1000");
    expect(status.stderr).toBe("");
    expect(JSON.parse(status.stdout)).toMatchObject({
      desktopUnavailable: true,
      machine: { phase: "off" },
    });
  } finally {
    controller.abort();
    await relay.body?.cancel().catch(() => {});
  }
});

test("unpairing a hub stops its memory sync and forgets the configuration", async () => {
  const f = await fixture();
  await f.remotes.pair(f.state.pairUrl());
  await expect.poll(() => f.remotes.snapshot()[0]?.connection).toBe("connected");
  await f.memory.setEnabled(true);
  await f.memory.connect(MEMORY_REPOSITORY);
  await expect.poll(() => f.hubSync.status().phase, { timeout: 30_000 }).toBe("synced");
  const response = await fetch(`${f.hub.url}/v1/hub/unpair`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.local.token}` },
  });
  expect(response.status).toBe(200);
  expect(f.hubSync.status().phase).toBe("off");
  expect(f.state.memoryConfiguration()).toEqual({ enabled: false, repository: null });
});
