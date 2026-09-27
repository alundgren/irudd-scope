import { afterEach, expect, test, vi } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { readPairingUrl } from "@irudd-scope/protocol/remote";
import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { memoryCredentials } from "../apps/desktop/src/credentials.ts";
import { Remotes } from "../apps/desktop/src/remotes.ts";

const exec = promisify(execFile);
const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
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
  const desktop = await startArtifactServer({
    directory: join(directory, "artifacts"),
    token,
    port: 0,
  });
  cleanup.push(desktop.close);
  const credentials = memoryCredentials();
  const store = new DesktopStore(join(directory, "desktop"), credentials);
  await store.load();
  cleanup.push(() => store.close());
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
      timeout: 15_000,
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
  await f.store.saveSettings({ apiKey: "synthetic-provider-secret" });
  await f.remotes.pair(f.state.pairUrl());
  await expect.poll(() => f.remotes.snapshot()[0]?.connection).toBe("connected");
  const remote = f.remotes.snapshot()[0];
  const token = (await f.credentials.read()).remoteTokens![remote.id];
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
