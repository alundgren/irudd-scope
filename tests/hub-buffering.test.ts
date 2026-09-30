import { afterEach, expect, test, vi } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScopeClient } from "@irudd-scope/protocol/client";
import {
  BUFFERED_TAB_TTL_MS,
  MAX_CONTENT_BYTES,
  decodeLocalConnection,
} from "@irudd-scope/protocol";
import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { memoryCredentials } from "../apps/desktop/src/credentials.ts";
import { Remotes } from "../apps/desktop/src/remotes.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const metadata = {
  expectedRevision: 0,
  title: "Offline report",
  kind: "text",
  fileName: "report.txt",
  mediaType: "text/plain",
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "scope-buffering-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const clock = { now: Date.now() };
  const connectionFile = join(directory, "connection.json");
  const hubDirectory = join(directory, "hub");
  let state = await HubState.open(hubDirectory, () => clock.now);
  cleanup.push(() => state.close());
  await state.configure({ endpoint: "http://127.0.0.1:1", port: 1, connectionFile });
  let hub = await startPairedHub(state, 0);
  cleanup.push(() => hub.close());
  const port = Number(new URL(hub.url).port);
  await state.configure({ endpoint: hub.url, port, connectionFile });
  const local = decodeLocalConnection(JSON.parse(await readFile(connectionFile, "utf8")));
  const credentials = memoryCredentials();
  const store = new DesktopStore(join(directory, "desktop"), credentials);
  await store.load();
  cleanup.push(() => store.close());
  const desktop = await startArtifactServer({
    directory: join(directory, "artifacts"),
    token: "synthetic-desktop-publishing-token",
    port: 0,
  });
  cleanup.push(desktop.close);
  const localDesktop = { url: desktop.url, token: "synthetic-desktop-publishing-token" };
  const remotes = new Remotes(store, localDesktop, () => {});
  await remotes.start();
  cleanup.push(() => remotes.close());
  const client = new ScopeClient(hub.url, local.token);
  const direct = new ScopeClient(desktop.url, localDesktop.token);
  const request = (path: string, init: RequestInit = {}) => {
    const headers = new Headers({ Authorization: `Bearer ${local.token}` });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    return fetch(`${local.endpoint}${path}`, {
      ...init,
      headers,
    });
  };
  const queue = async () => (await request("/v1/hub/queue")).json();
  const cli = async (...args: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [resolve("packages/cli/dist/main.mjs"), ...args],
          {
            env: {
              ...process.env,
              SCOPE_CONNECTION_FILE: connectionFile,
              SCOPE_ENDPOINT: undefined,
              SCOPE_TOKEN: undefined,
              SCOPE_TOKEN_FILE: undefined,
            },
            timeout: 30_000,
          },
        )
      ).stdout,
    );
  async function offline() {
    await remotes.pair(state.pairUrl());
    await expect.poll(() => remotes.snapshot()[0]?.connection).toBe("connected");
    await remotes.setEnabled(remotes.snapshot()[0].id, false);
    await expect(client.list()).rejects.toMatchObject({ status: 503 });
  }
  async function reconnect() {
    await remotes.setEnabled(remotes.snapshot()[0].id, true);
    await expect.poll(() => remotes.snapshot()[0].connection).toBe("connected");
  }
  return {
    local,
    directory,
    hubDirectory,
    clock,
    store,
    remotes,
    client,
    direct,
    request,
    queue,
    cli,
    offline,
    reconnect,
    state: () => state,
    restart: async () => {
      await hub.close();
      state.close();
      state = await HubState.open(hubDirectory, () => clock.now);
      hub = await startPairedHub(state, port);
    },
  };
}

test("offline CLI publications survive hub restart and arrive automatically with original bytes", async () => {
  const f = await fixture();
  await f.offline();
  const receipt = await f.cli("text", "Buffered finding", "--id", "offline-report");
  expect(receipt).toEqual({
    id: "offline-report",
    queued: true,
    expiresAt: new Date(f.clock.now + BUFFERED_TAB_TTL_MS).toISOString(),
  });
  expect(receipt).not.toHaveProperty("revision");
  const file = join(f.directory, "report.bin");
  const bytes = Buffer.alloc(2 * 1024 * 1024, 73);
  await writeFile(file, bytes);
  expect(await f.cli("add", file, "--id", "offline-file", "--name", "offline-file")).toMatchObject({
    queued: true,
  });
  await expect(f.direct.get("offline-report")).rejects.toMatchObject({ status: 404 });
  await f.restart();
  expect((await f.cli("hub", "queue")).items).toHaveLength(2);
  await f.reconnect();
  await expect.poll(async () => (await f.direct.list()).length).toBe(2);
  expect(new TextDecoder().decode(await f.direct.content("offline-report"))).toBe(
    "Buffered finding",
  );
  expect(Buffer.from(await f.direct.content("offline-file")).equals(bytes)).toBe(true);
  expect((await f.direct.named("offline-file")).id).toBe("offline-file");
  await expect.poll(async () => (await f.queue()).items.length).toBe(0);
  expect(await f.cli("text", "Connected finding", "--id", "online-report")).toMatchObject({
    id: "online-report",
    revision: 1,
  });
});

test("the 50-tab cap rejects overflow without losing accepted tabs and discard frees capacity", async () => {
  const f = await fixture();
  await f.offline();
  for (let i = 0; i < 50; i++)
    await f.client.publishOrQueue(`queued-${i}`, metadata, Buffer.from(String(i)));
  await expect(
    f.client.publishOrQueue("overflow", metadata, Buffer.from("overflow")),
  ).rejects.toMatchObject({ status: 503, message: expect.stringContaining("50") });
  expect((await f.queue()).items).toHaveLength(50);
  expect(await f.cli("hub", "discard", "queued-0")).toEqual({ id: "queued-0", deleted: true });
  await f.client.publishOrQueue("replacement", metadata, Buffer.from("replacement"));
  await f.reconnect();
  await expect.poll(async () => (await f.queue()).items.length, { timeout: 15_000 }).toBe(0);
  expect(await f.direct.list()).toHaveLength(50);
  await expect(f.direct.get("queued-0")).rejects.toMatchObject({ status: 404 });
});

test("completed and abandoned tabs expire at 48 hours without extending expiry on retries", async () => {
  const f = await fixture();
  await f.offline();
  await f.client.publishOrQueue("expiring", metadata, Buffer.from("private synthetic bytes"));
  const reserve = () =>
    f.request("/v1/artifacts/abandoned/tab", {
      method: "POST",
      headers: { "Scope-Buffer-Publication": "1" },
      body: JSON.stringify({ expectedRevision: 0 }),
    });
  const first = await (await reserve()).json();
  f.clock.now += BUFFERED_TAB_TTL_MS - 1;
  expect(await (await reserve()).json()).toEqual(first);
  expect((await f.queue()).items).toHaveLength(2);
  f.clock.now++;
  const database = new DatabaseSync(join(f.hubDirectory, "hub.db"));
  cleanup.push(() => database.close());
  await expect
    .poll(() => database.prepare("SELECT count(*) AS count FROM publication_queue").get()!.count, {
      timeout: 5000,
    })
    .toBe(0);
  expect(
    database.prepare("SELECT sum(length(content)) AS bytes FROM publication_queue").get()!.bytes,
  ).toBeNull();
  await f.restart();
  await f.reconnect();
  expect(await f.direct.list()).toEqual([]);
});

test("a desktop revision conflict is reported in the queue while other buffered tabs still deliver", async () => {
  const f = await fixture();
  const artifact = await f.direct.publish("existing", metadata, Buffer.from("original"));
  await f.offline();
  await f.client.publishOrQueue(
    "existing",
    { ...metadata, expectedRevision: artifact.revision },
    Buffer.from("stale offline update"),
  );
  await f.client.publishOrQueue("other", metadata, Buffer.from("other"));
  await f.direct.publish(
    "existing",
    { ...metadata, expectedRevision: artifact.revision },
    Buffer.from("new desktop update"),
  );
  await f.reconnect();
  await expect
    .poll(async () => (await f.queue()).items)
    .toEqual([
      expect.objectContaining({
        id: "existing",
        status: "blocked",
        error: expect.stringContaining("changed"),
      }),
    ]);
  expect(new TextDecoder().decode(await f.direct.content("existing"))).toBe("new desktop update");
  expect(new TextDecoder().decode(await f.direct.content("other"))).toBe("other");
});

test("a lost delivery acknowledgement is recovered after reconnect without duplicating a revision", async () => {
  const f = await fixture();
  await f.offline();
  await f.client.publishOrQueue("uncertain", metadata, Buffer.from("accepted bytes"));
  const original = globalThis.fetch;
  let interrupted = false;
  let disconnecting: Promise<void> | undefined;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : input.toString();
    const response = await original(input, init);
    if (!interrupted && url.endsWith("/v1/artifacts/uncertain") && init?.method === "PUT") {
      interrupted = true;
      disconnecting = f.remotes.setEnabled(f.remotes.snapshot()[0].id, false);
      throw new Error("Synthetic lost acknowledgement after desktop commit.");
    }
    return response;
  });
  cleanup.push(() => fetcher.mockRestore());
  await f.reconnect().catch(() => {});
  await expect.poll(() => interrupted).toBe(true);
  await disconnecting;
  expect((await f.direct.get("uncertain")).revision).toBe(1);
  expect((await f.queue()).items).toHaveLength(1);
  fetcher.mockRestore();
  await f.restart();
  await f.reconnect();
  await expect.poll(async () => (await f.queue()).items.length).toBe(0);
  expect((await f.direct.get("uncertain")).revision).toBe(1);
});

test("buffering requires pairing and opt-in, preserves authentication and rejects oversized input", async () => {
  const f = await fixture();
  await expect(
    f.client.publishOrQueue("unpaired", metadata, Buffer.from("test")),
  ).rejects.toMatchObject({ status: 503, message: expect.stringContaining("Pair") });
  await f.offline();
  await expect(
    f.client.publish("synchronous", metadata, Buffer.from("test")),
  ).rejects.toMatchObject({ status: 503 });
  expect(
    (await f.request("/v1/hub/queue", { headers: { Authorization: "Bearer invalid" } })).status,
  ).toBe(401);
  expect(
    (await f.request("/v1/hub/queue", { headers: { Origin: "https://example.invalid" } })).status,
  ).toBe(403);
  const reserved = await (
    await f.request("/v1/artifacts/large/tab", {
      method: "POST",
      headers: { "Scope-Buffer-Publication": "1" },
      body: JSON.stringify({ expectedRevision: 0 }),
    })
  ).json();
  expect(
    (
      await f.request(`/v1/tabs/${reserved.tabId}/blobs`, {
        method: "POST",
        body: Buffer.alloc(MAX_CONTENT_BYTES + 1),
      })
    ).status,
  ).toBe(413);
  await expect(
    f.client.publishOrQueue(
      "invalid-media",
      { ...metadata, mediaType: "text/html" },
      Buffer.from("test"),
    ),
  ).rejects.toMatchObject({ status: 400 });
  await expect(f.client.publishOrQueue("empty", metadata, Buffer.alloc(0))).resolves.toMatchObject({
    queued: true,
  });
  await f.reconnect();
  await expect.poll(async () => (await f.direct.get("empty")).size).toBe(0);
  await expect(f.direct.get("large")).rejects.toMatchObject({ status: 404 });
});

test("unpairing deletes buffered content before another Mac can pair", async () => {
  const f = await fixture();
  await f.offline();
  await f.client.publishOrQueue("private", metadata, Buffer.from("synthetic private report"));
  expect((await f.request("/v1/hub/unpair", { method: "POST" })).status).toBe(200);
  expect((await f.queue()).items).toEqual([]);
  await expect(
    f.client.publishOrQueue("after-unpair", metadata, Buffer.from("test")),
  ).rejects.toMatchObject({ status: 503 });
});

test("hub schema 2 upgrades retain pairing and settings alongside the new queue", async () => {
  const f = await fixture();
  await f.offline();
  const database = new DatabaseSync(join(f.hubDirectory, "hub.db"));
  database.exec("DROP TABLE publication_queue; PRAGMA user_version = 2;");
  database.close();
  await f.restart();
  expect(f.state().status().pairedMac).not.toBeNull();
  await f.client.publishOrQueue("migrated", metadata, Buffer.from("migration"));
  await f.reconnect();
  await expect.poll(async () => (await f.direct.get("migrated")).id).toBe("migrated");
});

test("a complete buffered publication rejects competing writes under the same ID", async () => {
  const f = await fixture();
  await f.offline();
  await f.client.publishOrQueue("same-id", metadata, Buffer.from("first writer"));
  await expect(
    f.client.publishOrQueue("same-id", metadata, Buffer.from("second writer")),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    f.client.publish("same-id", metadata, Buffer.from("synchronous writer")),
  ).rejects.toMatchObject({ status: 409 });
  expect((await f.queue()).items).toHaveLength(1);
  await f.reconnect();
  await expect.poll(async () => (await f.queue()).items.length).toBe(0);
  expect(new TextDecoder().decode(await f.direct.content("same-id"))).toBe("first writer");
});

test("a reservation made offline can complete after the Mac reconnects", async () => {
  const f = await fixture();
  await f.offline();
  const { tabId } = await (
    await f.request("/v1/artifacts/transition/tab", {
      method: "POST",
      headers: { "Scope-Buffer-Publication": "1" },
      body: JSON.stringify({ expectedRevision: 0 }),
    })
  ).json();
  await f.reconnect();
  const { blob } = await (
    await f.request(`/v1/tabs/${tabId}/blobs`, { method: "POST", body: "transition bytes" })
  ).json();
  const result = await f.request("/v1/artifacts/transition", {
    method: "PUT",
    body: JSON.stringify({ ...metadata, tabId, blob }),
  });
  expect(result.status).toBe(202);
  expect(await result.json()).toMatchObject({ id: "transition", queued: true });
  await expect.poll(async () => (await f.queue()).items.length).toBe(0);
  expect(new TextDecoder().decode(await f.direct.content("transition"))).toBe("transition bytes");
});

test.each(["flags", "environment"])(
  "queue inspection and discard use the explicitly selected hub through %s",
  async (selection) => {
    const local = await fixture();
    const explicit = await fixture();
    await local.offline();
    await explicit.offline();
    await local.client.publishOrQueue(
      "same-id",
      { ...metadata, title: "Local report" },
      Buffer.from("local bytes"),
    );
    await explicit.client.publishOrQueue(
      "same-id",
      { ...metadata, title: "Explicit report" },
      Buffer.from("explicit bytes"),
    );
    const tokenFile = join(local.directory, "explicit-token");
    await writeFile(tokenFile, explicit.local.token, { mode: 0o600 });
    const cli = async (...args: string[]) =>
      JSON.parse(
        (
          await promisify(execFile)(
            process.execPath,
            [
              resolve("packages/cli/dist/main.mjs"),
              ...args,
              ...(selection === "flags"
                ? ["--endpoint", explicit.local.endpoint, "--token-file", tokenFile]
                : []),
            ],
            {
              env: {
                ...process.env,
                SCOPE_CONNECTION_FILE: join(local.directory, "connection.json"),
                SCOPE_ENDPOINT: selection === "environment" ? explicit.local.endpoint : undefined,
                SCOPE_TOKEN_FILE: selection === "environment" ? tokenFile : undefined,
                SCOPE_TOKEN: undefined,
              },
              timeout: 30_000,
            },
          )
        ).stdout,
      );
    expect((await cli("hub", "queue")).items).toEqual([
      expect.objectContaining({ id: "same-id", title: "Explicit report" }),
    ]);
    expect(await cli("hub", "discard", "same-id")).toEqual({ id: "same-id", deleted: true });
    expect((await explicit.queue()).items).toEqual([]);
    expect((await local.queue()).items).toEqual([
      expect.objectContaining({ id: "same-id", title: "Local report" }),
    ]);
    await expect(
      local.cli("hub", "discard", "same-id", "--endpoint", explicit.local.endpoint),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("explicit endpoint needs") });
    expect((await local.queue()).items).toHaveLength(1);
  },
);
