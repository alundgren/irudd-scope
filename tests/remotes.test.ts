import { afterEach, expect, test, vi } from "vite-plus/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
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
    shrink: (timeoutMs) => lifecycle.shrink(timeoutMs),
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

test("a Mac pairs once and receives live and buffered CLI publications over connections it opens", async () => {
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
  expect(receipt).toMatchObject({ id: "remote-review", queued: true });
  await expect.poll(() => events).toContain("artifact");
  const bytes = Buffer.alloc(2 * 1024 * 1024, 73);
  const file = join(f.directory, "report.bin");
  await writeFile(file, bytes);
  await f.cli("add", file, "--id", "large-file");
  await expect.poll(async () => (await f.client.get("large-file")).revision).toBe(1);
  expect(Buffer.from(await f.client.content("large-file")).equals(bytes)).toBe(true);
  const direct = new ScopeClient(f.desktop.url, f.token);
  expect(new TextDecoder().decode(await direct.content("remote-review"))).toBe("Remote finding");
  await f.remotes.setEnabled(id, false);
  expect(
    JSON.parse((await f.cli("text", "Buffered report", "--id", "offline")).stdout),
  ).toMatchObject({ id: "offline", queued: true });
  expect((await f.store.remotes())[0].enabled).toBe(false);
  await f.remotes.setEnabled(id, true);
  await expect.poll(() => f.remotes.snapshot()[0].connection).toBe("connected");
  await expect
    .poll(async () => (await f.client.list()).map((artifact) => artifact.id))
    .toContain("offline");
  await f.cli("update", "remote-review", file);
  await expect.poll(async () => (await f.client.get("remote-review")).revision).toBe(2);
});

test("pairing credentials stay out of SQLite and removal revokes access without removing the provider key", async () => {
  const f = await fixture();
  await f.store.saveSettings({
    voiceGenerationEnabled: true,
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

test.each(["body-fetch", "body-stream", "local-http", "response-post", "response-status"])(
  "relay diagnostics identify %s failures with a request ID and elapsed time",
  async (failure) => {
    const f = await fixture();
    await f.remotes.pair(f.state.pairUrl());
    await expect.poll(() => f.remotes.snapshot()[0]?.connection).toBe("connected");
    const logs = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => logs.mockRestore());
    const original = globalThis.fetch;
    const injected = new Error("Injected forwarding failure", {
      cause: new Error(`Credential ${f.token}`),
    });
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith("/response") && failure === "response-status")
        return Response.json({ error: "The publication request has ended." }, { status: 404 });
      if (url.endsWith("/body") && failure === "body-stream") {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(injected);
            },
          }),
        );
      }
      if (
        (url.endsWith("/body") && failure === "body-fetch") ||
        (url.startsWith(f.desktop.url) && failure === "local-http") ||
        (url.endsWith("/response") && failure === "response-post")
      )
        throw injected;
      return original(input, init);
    });
    cleanup.push(() => fetcher.mockRestore());
    const controller = new AbortController();
    const pending = f.client
      .publish(
        "diagnostic-failure",
        {
          expectedRevision: 0,
          title: "Synthetic diagnostic",
          kind: "html",
          fileName: "test.html",
          mediaType: "text/html",
        },
        Buffer.from("<html>test</html>"),
        controller.signal,
      )
      .catch(() => {});
    cleanup.push(async () => {
      controller.abort();
      await pending;
    });
    const entries = () =>
      logs.mock.calls
        .filter(([label]) => label === "Scope relay")
        .map(([, value]) => JSON.parse(String(value)));
    await expect.poll(() => entries().some((entry) => entry.stage === "forward-error")).toBe(true);
    const entry = entries().find((value) => value.stage === "forward-error");
    expect(entry).toMatchObject({
      phase:
        failure === "body-stream"
          ? "local-http"
          : failure === "response-status"
            ? "response-post"
            : failure,
      requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      elapsedMs: expect.any(Number),
      phaseMs: expect.any(Number),
      error: expect.objectContaining({ message: expect.any(String) }),
    });
    expect(JSON.stringify(entries())).not.toContain(f.token);
    if (failure !== "response-status") expect(JSON.stringify(entries())).toContain("[redacted]");
    else expect(entry.error.message).toContain("HTTP 404");
    if (failure === "body-stream")
      expect(entries()).toContainEqual(
        expect.objectContaining({
          stage: "body-error",
          requestId: entry.requestId,
          bodyComplete: false,
        }),
      );
  },
);

test("paired hubs forward pull request snapshots and local writes, and reject oversized or offline commands", async () => {
  const f = await fixture();
  await f.remotes.pair(f.state.pairUrl());
  await expect.poll(() => f.remotes.snapshot()[0]?.connection).toBe("connected");
  const html = join(f.directory, "inbox.html");
  await writeFile(html, "<h1>PR inbox</h1>");
  await f.cli("add", html, "--pull-requests", "--name", "remote-inbox");
  await expect.poll(async () => (await f.client.named("remote-inbox")).revision).toBe(1);
  await f.cli("pull-requests", "configure", "remote-inbox", "example/project");
  const read = await f.client.pullRequests({ action: "read", name: "remote-inbox" });
  if (read.type !== "snapshot") throw new Error("Expected snapshot");
  const head = "a".repeat(40),
    base = "b".repeat(40),
    now = "2026-09-30T12:00:00.000Z";
  await f.desktop.store.pullRequests.commitInventory(read.snapshot.tabId, {
    repository: { owner: "example", name: "project" },
    viewer: "viewer",
    completedAt: now,
    prs: [
      {
        nodeId: "PR_remote",
        number: 1,
        title: "Remote PR",
        author: "alice",
        labels: [],
        headOid: head,
        headRefName: "feature",
        baseOid: base,
        draft: true,
        additions: 0,
        deletions: 0,
        changedFiles: 0,
        url: "https://github.com/example/project/pull/1",
        merge: { status: "unknown", headOid: head, baseOid: base, observedAt: now },
        checks: { status: "unknown", headOid: null, observedAt: now },
        hasUnresolvedConversations: null,
        createdAt: now,
        updatedAt: now,
        requestedReviewers: [],
      },
    ],
  });
  const text = "n".repeat(19_000);
  const written = await f.client.pullRequests({
    action: "note",
    name: "remote-inbox",
    tabId: read.snapshot.tabId,
    nodeId: "PR_remote",
    requestId: randomUUID(),
    expectedVersion: 0,
    text,
  });
  if (written.type !== "snapshot") throw new Error("Expected snapshot");
  expect(written.snapshot.prs[0].local.note).toBe(text);
  f.desktop.store.pullRequests.setHandlers({
    sync: (tabId) => f.desktop.store.pullRequests.snapshotByTab(tabId),
    detail: async (_tabId, nodeId) => {
      expect(nodeId).toBe("PR_remote");
      return {
        headOid: head,
        body: "Paired PR body",
        diff: "漢".repeat(400_000),
        reviews: [],
        files: [],
        fetchedAt: now,
      };
    },
  });
  const batch = await f.client.pullRequests({
    action: "details",
    name: "remote-inbox",
    tabId: read.snapshot.tabId,
    requestId: randomUUID(),
    nodeIds: ["PR_remote", "PR_missing"],
  });
  expect(batch).toMatchObject({
    type: "details",
    tabId: read.snapshot.tabId,
    results: [
      {
        nodeId: "PR_remote",
        captured: { headOid: head, baseOid: base },
        detail: { body: "Paired PR body", diff: "漢".repeat(400_000) },
      },
      { nodeId: "PR_missing", error: "Open pull request not found." },
    ],
  });
  const oversized = await fetch(`${f.hub.url}/v1/pull-requests`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.local.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text: "x".repeat(256 * 1024) }),
  });
  expect(oversized.status).toBe(413);
  const browser = await fetch(`${f.hub.url}/v1/pull-requests`, {
    method: "POST",
    headers: { Authorization: `Bearer ${f.local.token}`, Origin: "https://example.com" },
    body: "{}",
  });
  expect(browser.status).toBe(403);
  await f.remotes.setEnabled(f.remotes.snapshot()[0].id, false);
  await expect(
    f.client.pullRequests({
      action: "sync",
      name: "remote-inbox",
      tabId: read.snapshot.tabId,
      requestId: randomUUID(),
    }),
  ).rejects.toMatchObject({ status: 503 });
  expect((await f.client.hubQueue()).items).toHaveLength(0);
});
