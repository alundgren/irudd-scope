import { afterEach, expect, test, vi } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { artifactRequest, readPairingUrl } from "@irudd-scope/protocol/remote";
import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { memoryCredentials } from "../apps/desktop/src/credentials.ts";
import { DesktopLifecycle } from "../apps/desktop/src/lifecycle.ts";
import { setTimeout as delay } from "node:timers/promises";
import { Remotes } from "../apps/desktop/src/remotes.ts";

const exec = promisify(execFile);
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(options: { shrinkDelayMs?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "scope-remotes-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const state = await HubState.open(join(directory, "hub"));
  cleanup.push(() => state.close());
  const connectionFile = join(directory, "connection.json");
  await state.configure({ endpoint: "http://127.0.0.1:1", port: 1, connectionFile });
  const hub = await startPairedHub(state, 0);
  cleanup.push(hub.close);
  await state.configure({ endpoint: hub.url, port: Number(new URL(hub.url).port), connectionFile });
  const local = decodeLocalConnection(JSON.parse(await readFile(connectionFile, "utf8")));
  const token = "synthetic-desktop-publishing-token";
  const credentials = memoryCredentials();
  const store = new DesktopStore(join(directory, "desktop"), credentials);
  await store.load();
  cleanup.push(() => store.close());
  let lifecycle: DesktopLifecycle;
  const desktop = await startArtifactServer({
    directory: join(directory, "artifacts"),
    token,
    port: 0,
    initialize: async (artifacts) => {
      lifecycle = new DesktopLifecycle(artifacts, store);
      await lifecycle.recover();
    },
    deleteArtifact: (id) => lifecycle.deleteArtifact(id),
    shrink: async (timeoutMs) => {
      if (options.shrinkDelayMs) await delay(options.shrinkDelayMs);
      return lifecycle.shrink(timeoutMs);
    },
  });
  cleanup.push(desktop.close);
  const remotes = new Remotes(store, { url: desktop.url, token }, () => {});
  cleanup.push(() => remotes.close());
  await remotes.start();
  const cli = (...args: string[]) =>
    exec(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
      env: {
        ...process.env,
        SCOPE_CONNECTION_FILE: connectionFile,
        SCOPE_TOKEN: undefined,
        SCOPE_ENDPOINT: undefined,
        SCOPE_TOKEN_FILE: undefined,
      },
      timeout: 120_000,
    });
  return {
    directory,
    state,
    hub,
    remotes,
    store,
    credentials,
    cli,
    local,
    desktop,
    token,
    client: new ScopeClient(hub.url, local.token),
  };
}

test("a Mac pairs once, receives CLI publications over connections it opens, and disconnects without replay", async () => {
  const f = await fixture();
  await expect(f.client.list()).rejects.toMatchObject({ status: 503 });
  const link = f.state.pairUrl();
  await f.remotes.pair(link);
  await expect.poll(() => f.remotes.snapshot()[0]?.connection).toBe("connected");
  const id = f.remotes.snapshot()[0].id;
  const pairing = readPairingUrl(link);
  const used = await fetch(`${f.hub.url}/v1/pair`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pairing.token}` },
    body: JSON.stringify({ name: "Second Mac" }),
  });
  expect(used.status).toBe(401);
  const events: string[] = [];
  const watch = new AbortController();
  const watching = f.client.watch((event) => events.push(event.type), watch.signal).catch(() => {});
  cleanup.push(async () => {
    watch.abort();
    await watching;
  });
  await expect.poll(() => events).toContain("ready");
  const receipt = JSON.parse(
    (await f.cli("text", "Remote finding", "--id", "remote-review")).stdout,
  );
  expect(receipt).toMatchObject({ id: "remote-review", revision: 1 });
  await expect.poll(() => events).toContain("artifact");
  const bytes = Buffer.alloc(2 * 1024 * 1024, 73);
  const file = join(f.directory, "report.bin");
  await writeFile(file, bytes);
  await f.cli("add", file, "--id", "large-file");
  expect(Buffer.from(await f.client.content("large-file")).equals(bytes)).toBe(true);
  const direct = new ScopeClient(f.desktop.url, f.token);
  expect(new TextDecoder().decode(await direct.content("remote-review"))).toBe("Remote finding");
  await f.remotes.setEnabled(id, false);
  await expect(f.cli("text", "Do not replay", "--id", "offline")).rejects.toMatchObject({
    stderr: expect.stringContaining("disconnected"),
  });
  expect((await f.store.remotes())[0].enabled).toBe(false);
  await f.remotes.setEnabled(id, true);
  await expect.poll(() => f.remotes.snapshot()[0].connection).toBe("connected");
  expect((await f.client.list()).map((artifact) => artifact.id)).not.toContain("offline");
  await f.cli("update", "remote-review", file);
  expect((await f.client.get("remote-review")).revision).toBe(2);
});

test("pairing credentials stay out of SQLite and removal revokes access without removing the provider key", async () => {
  const f = await fixture();
  await f.store.saveSettings({
    diagramGenerationEnabled: true,
    apiKey: "synthetic-provider-secret",
  });
  await f.remotes.pair(f.state.pairUrl());
  await expect.poll(() => f.remotes.snapshot()[0]?.connection).toBe("connected");
  const remote = f.remotes.snapshot()[0];
  const token = (await f.credentials.read()).remoteTokens![remote.id];
  for (const [method, path] of [
    ["DELETE", "/v1/artifacts/auth-check"],
    ["POST", "/v1/artifacts/auth-check/tab"],
    ["POST", `/v1/tabs/${crypto.randomUUID()}/blobs`],
    ["POST", "/v1/maintenance/shrink"],
    ["POST", "/v1/hub/shrink"],
  ]) {
    expect(
      (
        await fetch(`${f.hub.url}${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${f.hub.url}${path}`, {
          method,
          headers: { Authorization: `Bearer ${f.local.token}`, Origin: "https://example.invalid" },
        })
      ).status,
    ).toBe(403);
    if (!path.startsWith("/v1/hub/")) {
      expect(artifactRequest(method, path)).toBe(true);
      expect(
        (
          await fetch(`${f.desktop.url}${path}`, {
            method,
            headers: { Authorization: `Bearer ${f.token}`, Origin: "https://example.invalid" },
          })
        ).status,
      ).toBe(403);
    }
  }
  for (const [method, path] of [
    ["POST", "/v1/hub/shrink"],
    ["GET", "/v1/hub/maintenance"],
    ["DELETE", "/v1/artifacts/auth-check/content"],
    ["POST", "/v1/maintenance/shrink?extra=1"],
    ["POST", "/v1/blobs"],
  ])
    expect(artifactRequest(method, path)).toBe(false);
  for (const file of [
    "hub/hub.db",
    "hub/hub.db-wal",
    "desktop/desktop.db",
    "desktop/desktop.db-wal",
  ]) {
    const bytes = await readFile(join(f.directory, file)).catch(() => Buffer.alloc(0));
    expect(bytes.includes(Buffer.from(token))).toBe(false);
  }
  expect(
    (await fetch(`${f.hub.url}/v1/artifacts`, { headers: { Authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(401);
  expect(
    (
      await fetch(`${f.hub.url}/v1/relay/events`, {
        headers: { Authorization: `Bearer ${f.local.token}` },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(`${f.hub.url}/v1/artifacts`, {
        headers: { Authorization: `Bearer ${f.local.token}`, Origin: "https://example.invalid" },
      })
    ).status,
  ).toBe(403);
  await f.remotes.remove(remote.id);
  expect(await f.store.remotes()).toEqual([]);
  expect((await f.credentials.read()).apiKey).toBe("synthetic-provider-secret");
  expect((await f.credentials.read()).remoteTokens?.[remote.id]).toBeUndefined();
  expect(
    (await fetch(`${f.hub.url}/v1/relay/events`, { headers: { Authorization: `Bearer ${token}` } }))
      .status,
  ).toBe(401);
  await expect(f.client.list()).rejects.toMatchObject({ status: 503 });
});

test("expired pairing links fail and generating another link invalidates the previous link", async () => {
  const f = await fixture();
  const first = f.state.pairUrl();
  const second = f.state.pairUrl();
  await expect(f.remotes.pair(first)).rejects.toThrow("fresh link");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 11 * 60_000);
  await expect(f.remotes.pair(second)).rejects.toThrow("fresh link");
  vi.useRealTimers();
  await f.remotes.pair(f.state.pairUrl());
  await expect.poll(() => f.remotes.snapshot()[0]?.connection).toBe("connected");
});

test("saved connections reconnect after a desktop restart and explicit disconnect stays off", async () => {
  const f = await fixture();
  await f.remotes.pair(f.state.pairUrl());
  await expect.poll(() => f.remotes.snapshot()[0]?.connection).toBe("connected");
  await f.remotes.close();
  const restored = new Remotes(f.store, { url: f.desktop.url, token: f.token }, () => {});
  cleanup.push(() => restored.close());
  await restored.start();
  await expect.poll(() => restored.snapshot()[0]?.connection).toBe("connected");
  await f.cli("text", "After restart", "--id", "after-restart");
  await restored.setEnabled(restored.snapshot()[0].id, false);
  await restored.close();
  const disconnected = new Remotes(f.store, { url: f.desktop.url, token: f.token }, () => {});
  cleanup.push(() => disconnected.close());
  await disconnected.start();
  expect(disconnected.snapshot()[0]).toMatchObject({ connection: "disconnected", enabled: false });
  await expect(f.client.list()).rejects.toMatchObject({ status: 503 });
});

test("CLI deletion and desktop shrink cross the relay, while hub shrink works without the Mac", async () => {
  const f = await fixture();
  await f.remotes.pair(f.state.pairUrl());
  await expect.poll(() => f.remotes.snapshot()[0]?.connection).toBe("connected");
  await f.cli("text", "Delete through the relay", "--id", "delete-me");
  expect(JSON.parse((await f.cli("delete", "delete-me", "--timeout-ms", "120000")).stdout)).toEqual(
    { id: "delete-me", deleted: true },
  );
  expect(JSON.parse((await f.cli("delete", "delete-me")).stdout)).toEqual({
    id: "delete-me",
    deleted: false,
  });
  expect(await f.client.list()).toEqual([]);
  const receipt = JSON.parse((await f.cli("shrink", "--timeout-ms", "120000")).stdout);
  expect(receipt.target).toBe("desktop");
  expect(receipt.databases[0]).toMatchObject({ database: "scope.db", status: "completed" });
  await f.remotes.setEnabled(f.remotes.snapshot()[0].id, false);
  const hub = JSON.parse((await f.cli("hub", "shrink", "--timeout-ms", "120000")).stdout);
  expect(hub.target).toBe("hub");
  expect(hub.databases[0]).toMatchObject({ database: "hub.db", status: "completed" });
  expect(f.state.status().pairedMac).not.toBeNull();
  expect(
    JSON.parse((await f.cli("hub", "shrink", "--status")).stdout).databases[0].lastSuccess,
  ).toBe(hub.databases[0].lastSuccess);
  await expect(f.cli("shrink", "--timeout-ms", "120000")).rejects.toMatchObject({
    stderr: expect.stringContaining("disconnected"),
  });
});

test("a remote CLI maintenance request can exceed thirty seconds while relay heartbeats continue", async () => {
  const f = await fixture({ shrinkDelayMs: 31_000 });
  await f.remotes.pair(f.state.pairUrl());
  await expect.poll(() => f.remotes.snapshot()[0]?.connection).toBe("connected");
  const result = JSON.parse((await f.cli("shrink", "--timeout-ms", "45000")).stdout);
  expect(
    result.databases.map((database: { database: string; status: string }) => [
      database.database,
      database.status,
    ]),
  ).toEqual([
    ["scope.db", "completed"],
    ["desktop.db", "completed"],
  ]);
  expect(f.remotes.snapshot()[0].connection).toBe("connected");
}, 60_000);
