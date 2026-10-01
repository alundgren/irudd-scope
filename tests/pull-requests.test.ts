import { afterEach, expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { artifactRequest } from "@irudd-scope/protocol/remote";
import type {
  PullRequestFacts,
  PullRequestsSnapshot,
  PullRequestsReply,
} from "@irudd-scope/protocol/pull-requests";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { ArtifactStore } from "../apps/desktop/src/library/store.ts";

const token = "synthetic-pull-requests-test-token";
const name = "test-inbox";
const repository = { owner: "example", name: "project" };
const now = "2026-09-30T12:00:00.000Z";
const head = "a".repeat(40),
  base = "b".repeat(40);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function facts(number = 1): PullRequestFacts {
  return {
    nodeId: `PR_${number}`,
    number,
    title: `Change ${number}`,
    author: "alice",
    labels: ["bug"],
    headOid: head,
    headRefName: "feature",
    baseOid: base,
    draft: number === 2,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    url: `https://github.com/example/project/pull/${number}`,
    merge: { status: "unknown", headOid: head, baseOid: base, observedAt: now },
    checks: { status: "unknown", headOid: null, observedAt: now },
    hasUnresolvedConversations: null,
    createdAt: now,
    updatedAt: now,
    requestedReviewers: ["viewer"],
  };
}
function snapshot(reply: PullRequestsReply): PullRequestsSnapshot {
  if (reply.type !== "snapshot") throw new Error("Expected snapshot");
  return reply.snapshot;
}
async function fixture(publish = true) {
  const directory = await mkdtemp(join(tmpdir(), "scope-pull-requests-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const server = await startArtifactServer({ directory, token, port: 0 });
  cleanup.push(server.close);
  const client = new ScopeClient(server.url, token);
  const html = join(directory, "inbox.html");
  await writeFile(html, "<h1>Inbox</h1>");
  if (publish)
    await client.publish(
      "inbox",
      {
        name,
        title: "Inbox",
        kind: "pull-requests",
        mediaType: "text/html",
        fileName: "inbox.html",
        expectedRevision: 0,
      },
      Buffer.from("<h1>Inbox</h1>"),
    );
  const cli = (...args: string[]) =>
    promisify(execFile)(process.execPath, [resolve("packages/cli/dist/main.mjs"), ...args], {
      env: {
        ...process.env,
        SCOPE_ENDPOINT: server.url,
        SCOPE_TOKEN: token,
        SCOPE_TOKEN_FILE: undefined,
      },
    });
  const read = async () => snapshot(await client.pullRequests({ action: "read", name }));
  const configure = async () =>
    client.pullRequests({
      action: "configure",
      name,
      tabId: (await read()).tabId,
      requestId: randomUUID(),
      repository,
    });
  return { directory, server, client, cli, html, read, configure };
}

test("first verified alias inventory updates the binding atomically and rejects an old queried pin", async () => {
  const f = await fixture();
  await f.configure();
  const initial = await f.read();
  const canonical = { owner: "canonical-owner", name: "canonical-project" };
  const row = { ...facts(), url: "https://github.com/canonical-owner/canonical-project/pull/1" };
  const inventory = {
    queriedRepository: repository,
    repository: canonical,
    viewer: "viewer",
    prs: [row],
    completedAt: now,
  };
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    f.server.store.pullRequests.commitInventory(initial.tabId, inventory, aborted.signal),
  ).rejects.toThrow();
  expect(await f.read()).toEqual(initial);
  const synced = await f.server.store.pullRequests.commitInventory(initial.tabId, inventory);
  expect(synced).toMatchObject({
    tabId: initial.tabId,
    repository: canonical,
    sync: { lastSuccessAt: now },
    prs: [{ nodeId: "PR_1" }],
  });
  await expect(
    f.server.store.pullRequests.commitInventory(initial.tabId, inventory),
  ).rejects.toMatchObject({ status: 409 });
  expect(await f.read()).toEqual(synced);
});

test("a successful empty inventory prevents later canonical rebinding", async () => {
  const f = await fixture();
  await f.configure();
  const initial = await f.read();
  await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: [],
    completedAt: now,
  });
  const before = await f.read();
  await expect(
    f.server.store.pullRequests.commitInventory(initial.tabId, {
      queriedRepository: repository,
      repository: { owner: "other", name: "project" },
      viewer: "viewer",
      prs: [],
      completedAt: "2026-10-01T12:00:00Z",
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await f.read()).toEqual(before);
});

test("cached rows prevent rebinding even when a success timestamp is missing", async () => {
  const f = await fixture();
  await f.configure();
  const initial = await f.read();
  await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: [facts()],
    completedAt: now,
  });
  await f.server.store.pullRequests.setSyncStatus(initial.tabId, {
    state: "error",
    updatedAt: now,
    lastSuccessAt: null,
    error: "Earlier sync incomplete",
  });
  const before = await f.read();
  await expect(
    f.server.store.pullRequests.commitInventory(initial.tabId, {
      queriedRepository: repository,
      repository: { owner: "other", name: "project" },
      viewer: "viewer",
      prs: [],
      completedAt: "2026-10-01T12:00:00Z",
    }),
  ).rejects.toMatchObject({ status: 409 });
  expect(await f.read()).toEqual(before);
});

test("complete inventories preserve independent local writes and current agent values, then prune all removed PR data", async () => {
  const f = await fixture();
  await f.configure();
  const initial = await f.read();
  expect((await f.server.store.tabs())[0].permanent).toBe(1);
  await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: [facts(), facts(2)],
    completedAt: now,
  });
  const events: number[] = [];
  const watch = new AbortController();
  const watching = f.client
    .watch((event) => {
      if (event.type === "pull-requests") events.push(event.generation);
    }, watch.signal)
    .catch(() => {});
  cleanup.push(async () => {
    watch.abort();
    await watching;
  });
  const note = {
    action: "note" as const,
    name,
    tabId: initial.tabId,
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    text: "Keep this note",
  };
  const noted = snapshot(await f.client.pullRequests(note));
  expect(snapshot(await f.client.pullRequests(note)).generation).toBe(noted.generation);
  await expect(f.client.pullRequests({ ...note, text: "Different payload" })).rejects.toMatchObject(
    { status: 409 },
  );
  await expect(f.client.pullRequests({ ...note, requestId: randomUUID() })).rejects.toMatchObject({
    status: 409,
  });
  await f.client.pullRequests({
    action: "snooze",
    name,
    tabId: initial.tabId,
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    snooze: { until: "2026-10-05T12:00:00.000Z", headOid: head, wakeOnNewCommit: true },
  });
  await f.client.pullRequests({
    action: "review",
    name,
    tabId: initial.tabId,
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    baseline: "inspected",
    headOid: head,
  });
  await f.client.pullRequests({
    action: "assessment",
    name,
    tabId: initial.tabId,
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    assessment: {
      text: "Ready",
      author: "agent",
      headOid: head,
      evidenceIds: ["check:1"],
      discussionUpdatedAt: null,
      createdAt: now,
    },
    customFields: [{ key: "risk", type: "number", value: 2 }],
  });
  let finish!: () => void;
  const hold = new Promise<void>((resolve) => {
    finish = resolve;
  });
  f.server.store.pullRequests.setHandlers({
    sync: async (tabId) => {
      await hold;
      return f.server.store.pullRequests.commitInventory(tabId, {
        repository,
        viewer: "viewer",
        prs: [{ ...facts(), title: "Updated title" }, facts(2)],
        completedAt: now,
      });
    },
    detail: async () => ({
      headOid: head,
      body: "Description",
      diff: "+line",
      reviews: [],
      files: [],
      fetchedAt: now,
    }),
  });
  const syncing = f.client.pullRequests({
    action: "sync",
    name,
    tabId: initial.tabId,
    requestId: randomUUID(),
  });
  await f.client.pullRequests({
    ...note,
    requestId: randomUUID(),
    expectedVersion: 1,
    text: "Edited during sync",
  });
  finish();
  const synced = snapshot(await syncing);
  expect(synced.prs[0].draft).toBe(true);
  expect(synced.prs[1]).toMatchObject({
    title: "Updated title",
    local: {
      note: "Edited during sync",
      noteVersion: 2,
      snoozeVersion: 1,
      inspected: { headOid: head },
      reviewed: null,
    },
    agent: { version: 1, assessment: { text: "Ready" } },
  });
  await expect(
    f.client.pullRequests({
      action: "detail",
      name,
      tabId: initial.tabId,
      nodeId: "PR_1",
      requestId: randomUUID(),
    }),
  ).resolves.toMatchObject({ type: "detail", detail: { diff: "+line" } });
  expect(synced.prs[1]).not.toHaveProperty("detail");
  await expect.poll(() => events).toContain(synced.generation);
  await expect(
    f.server.store.pullRequests.commitInventory(initial.tabId, {
      repository,
      viewer: "viewer",
      prs: [facts(), facts()],
      completedAt: now,
    }),
  ).rejects.toThrow();
  expect((await f.read()).prs).toHaveLength(2);
  await f.server.store.pullRequests.setSyncStatus(initial.tabId, {
    state: "error",
    updatedAt: now,
    lastSuccessAt: now,
    error: "Refresh failed",
  });
  expect((await f.read()).prs[1].local.note).toBe("Edited during sync");
  await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: [facts(2)],
    completedAt: now,
  });
  expect((await f.read()).prs.map((pr) => pr.nodeId)).toEqual(["PR_2"]);
  const db = new DatabaseSync(join(f.directory, "scope.db"), { readOnly: true });
  try {
    expect(
      db
        .prepare("SELECT count(*) AS count FROM pull_requests_receipts WHERE node_id = 'PR_1'")
        .get()?.count,
    ).toBe(0);
  } finally {
    db.close();
  }
  await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: [],
    completedAt: now,
  });
  expect((await f.read()).prs).toEqual([]);
  await expect(
    f.client.pullRequests({
      action: "configure",
      name,
      tabId: initial.tabId,
      requestId: randomUUID(),
      repository: { owner: "other", name: "repo" },
    }),
  ).rejects.toMatchObject({ status: 409 });
  await expect(
    f.client.pullRequests({
      action: "configure",
      name,
      tabId: initial.tabId,
      requestId: randomUUID(),
      repository: { owner: "EXAMPLE", name: "PROJECT" },
    }),
  ).resolves.toMatchObject({ type: "snapshot" });
});

test("HTML replacement and Trashcan preserve records, permanent deletion cascades and rejects a pinned old sync", async () => {
  const f = await fixture();
  await f.configure();
  const initial = await f.read();
  await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: [facts()],
    completedAt: now,
  });
  const before = await f.read();
  await f.client.publish(
    "inbox",
    {
      name,
      title: "Redesigned",
      kind: "pull-requests",
      mediaType: "text/html",
      fileName: "inbox.html",
      expectedRevision: before.artifact.revision,
    },
    Buffer.from("<script>document.title='changed'</script>"),
  );
  expect((await f.read()).prs).toEqual(before.prs);
  await expect(
    f.client.publish(
      "inbox",
      {
        title: "Wrong kind",
        kind: "html",
        mediaType: "text/html",
        fileName: "inbox.html",
        expectedRevision: (await f.read()).artifact.revision,
      },
      Buffer.from("wrong"),
    ),
  ).rejects.toMatchObject({ status: 409 });
  await f.server.store.openTab({
    id: initial.tabId,
    groupId: randomUUID(),
    type: "file",
    title: "Inbox",
    state: {
      version: 1,
      data: { artifactId: "inbox" },
    },
  });
  await f.server.store.trashTab(initial.tabId, 123);
  expect((await f.read()).prs).toHaveLength(1);
  await expect(
    f.client.pullRequests({
      action: "note",
      name,
      tabId: initial.tabId,
      nodeId: "PR_1",
      requestId: randomUUID(),
      expectedVersion: 0,
      text: "Blocked",
    }),
  ).rejects.toMatchObject({ status: 409 });
  await f.server.store.emptyTrash([{ id: initial.tabId, trashedAt: 123 }]);
  await expect(
    f.server.store.pullRequests.commitInventory(initial.tabId, {
      repository,
      viewer: "viewer",
      prs: [],
      completedAt: now,
    }),
  ).rejects.toThrow();
  const db = new DatabaseSync(join(f.directory, "scope.db"), { readOnly: true });
  try {
    for (const table of ["pull_requests_state", "pull_requests_current", "pull_requests_receipts"])
      expect(db.prepare(`SELECT count(*) AS count FROM ${table}`).get()?.count).toBe(0);
  } finally {
    db.close();
  }
  await f.client.publish(
    "inbox",
    {
      name,
      title: "Replacement inbox",
      kind: "pull-requests",
      mediaType: "text/html",
      fileName: "inbox.html",
      expectedRevision: 0,
    },
    Buffer.from("<h1>New tab</h1>"),
  );
  await f.configure();
  const replacement = await f.read();
  expect(replacement.tabId).not.toBe(initial.tabId);
  await expect(
    f.server.store.pullRequests.commitInventory(initial.tabId, {
      repository,
      viewer: "viewer",
      prs: [facts()],
      completedAt: now,
    }),
  ).rejects.toThrow();
  expect((await f.read()).prs).toEqual([]);
});

test("authenticated HTTP rejects malformed commands, browser callers and oversized bodies", async () => {
  const f = await fixture();
  const request = (
    body: unknown,
    headers: Record<string, string> = { Authorization: `Bearer ${token}` },
  ) =>
    fetch(`${f.server.url}/v1/pull-requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  expect((await request({ action: "read", name }, {})).status).toBe(401);
  expect(
    (
      await request(
        { action: "read", name },
        { Authorization: `Bearer ${token}`, Origin: "http://example.com" },
      )
    ).status,
  ).toBe(403);
  expect((await request({ action: "read", name, unexpected: true })).status).toBe(400);
  expect((await request({ data: "x".repeat(256 * 1024) })).status).toBe(413);
  expect(artifactRequest("POST", "/v1/pull-requests")).toBe(true);
  expect(artifactRequest("POST", "/v1/pull-requests?anything=1")).toBe(false);
  expect(artifactRequest("GET", "/v1/pull-requests")).toBe(false);
});

test("built CLI recovers an unconfigured publication and updates HTML without replacing local values", async () => {
  const f = await fixture(false);
  const created = JSON.parse(
    (await f.cli("add", f.html, "--pull-requests", "--name", name)).stdout,
  );
  expect(created).toMatchObject({ kind: "pull-requests", name });
  expect((await f.read()).repository).toBeNull();
  await f.cli("pull-requests", "configure", name, "example/project");
  const initial = await f.read();
  await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: [facts()],
    completedAt: now,
  });
  const request = join(f.directory, "assessment.json");
  await writeFile(
    request,
    JSON.stringify({
      action: "assessment",
      name,
      tabId: initial.tabId,
      nodeId: "PR_1",
      requestId: randomUUID(),
      expectedVersion: 0,
      assessment: {
        text: "Inspect",
        author: "cli-agent",
        headOid: head,
        evidenceIds: [],
        discussionUpdatedAt: null,
        createdAt: now,
      },
      customFields: [{ key: "ready", type: "boolean", value: false }],
    }),
  );
  await f.cli("pull-requests", "apply", request);
  await writeFile(f.html, "<h1>Updated app</h1>");
  await f.cli("update", name, f.html);
  const read = JSON.parse((await f.cli("pull-requests", "read", name)).stdout).snapshot;
  expect(read.tabId).toBe(initial.tabId);
  expect(read.artifact.kind).toBe("pull-requests");
  expect(read.prs[0].agent).toMatchObject({ version: 1, assessment: { author: "cli-agent" } });
  await expect(f.cli("pull-requests", "configure", name, "other/repo")).rejects.toThrow();
});

test("version 6 databases migrate additively and reopen current inbox state", async () => {
  const f = await fixture();
  await f.configure();
  const current = await f.read();
  await f.server.store.pullRequests.commitInventory(current.tabId, {
    repository,
    viewer: "viewer",
    prs: [facts()],
    completedAt: now,
  });
  await f.server.close();
  const db = new DatabaseSync(join(f.directory, "scope.db"));
  try {
    db.exec(
      "DROP TABLE pull_requests_receipts; DROP TABLE pull_requests_current; DROP TABLE pull_requests_state; PRAGMA user_version = 6;",
    );
  } finally {
    db.close();
  }
  const reopened = await ArtifactStore.open(f.directory);
  cleanup.push(() => reopened.close());
  expect((await reopened.pullRequests.snapshot(name)).repository).toBeNull();
  expect((await reopened.list()).items[0].kind).toBe("pull-requests");
  const check = new DatabaseSync(join(f.directory, "scope.db"), { readOnly: true });
  try {
    expect(check.prepare("PRAGMA user_version").get()?.user_version).toBe(7);
  } finally {
    check.close();
  }
});

test("saved write commands reject a recreated named inbox before invoking sync or detail", async () => {
  const f = await fixture();
  await f.configure();
  const old = await f.read();
  await f.server.store.pullRequests.commitInventory(old.tabId, {
    repository,
    viewer: "viewer",
    prs: [facts()],
    completedAt: now,
  });
  const named = { name, tabId: old.tabId, requestId: randomUUID() };
  const field = { ...named, nodeId: "PR_1", expectedVersion: 0 };
  const commands = [
    { ...named, action: "configure" as const, repository },
    { ...named, action: "sync" as const },
    { ...named, action: "detail" as const, nodeId: "PR_1" },
    { ...field, action: "note" as const, text: "Prepared for deleted inbox" },
    { ...field, action: "snooze" as const, snooze: null },
    { ...field, action: "review" as const, baseline: "reviewed" as const, headOid: head },
    { ...field, action: "assessment" as const, assessment: null, customFields: [] },
  ];
  await f.client.delete("inbox");
  await f.client.publish(
    "inbox",
    {
      name,
      title: "Replacement",
      kind: "pull-requests",
      mediaType: "text/html",
      fileName: "inbox.html",
      expectedRevision: 0,
    },
    Buffer.from("new"),
  );
  await f.configure();
  const current = await f.read();
  await f.server.store.pullRequests.commitInventory(current.tabId, {
    repository,
    viewer: "viewer",
    prs: [facts()],
    completedAt: now,
  });
  let called = 0;
  f.server.store.pullRequests.setHandlers({
    sync: async (tabId) => {
      called++;
      return f.server.store.pullRequests.snapshotByTab(tabId);
    },
    detail: async () => {
      called++;
      return { headOid: head, body: "", diff: "", reviews: [], files: [], fetchedAt: now };
    },
  });
  for (const command of commands)
    await expect(f.client.pullRequests(command)).rejects.toMatchObject({ status: 409 });
  expect(called).toBe(0);
  expect((await f.read()).prs[0]).toMatchObject({
    local: { note: "", snooze: null, reviewed: null },
    agent: { version: 0 },
  });
});

test.each(["inventory", "status"] as const)(
  "cancelled queued %s writes preserve data after Trashcan restoration",
  async (kind) => {
    const f = await fixture();
    await f.configure();
    const before = await f.read();
    await f.server.store.pullRequests.commitInventory(before.tabId, {
      repository,
      viewer: "viewer",
      prs: [facts()],
      completedAt: now,
    });
    await f.client.pullRequests({
      action: "note",
      name,
      tabId: before.tabId,
      nodeId: "PR_1",
      requestId: randomUUID(),
      expectedVersion: 0,
      text: "Retain after cancellation",
    });
    await f.server.store.openTab({
      id: before.tabId,
      groupId: randomUUID(),
      type: "file",
      title: "Inbox",
      state: { version: 1, data: { artifactId: "inbox" } },
    });
    const saved = await f.read();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queue = f.server.store as unknown as { pendingMutations: Promise<void> };
    queue.pendingMutations = queue.pendingMutations.then(() => gate);
    const cancel = new AbortController();
    const pending =
      kind === "inventory"
        ? f.server.store.pullRequests.commitInventory(
            before.tabId,
            { repository, viewer: "other", prs: [], completedAt: now },
            cancel.signal,
          )
        : f.server.store.pullRequests.setSyncStatus(
            before.tabId,
            { state: "error", updatedAt: now, lastSuccessAt: now, error: "Cancelled refresh" },
            cancel.signal,
          );
    const rejected = expect(pending).rejects.toThrow();
    try {
      await f.server.store.trashTab(before.tabId, 123);
      cancel.abort();
      await f.server.store.restoreTab(before.tabId);
    } finally {
      release();
    }
    await rejected;
    expect(await f.read()).toEqual(saved);
  },
);

test("request hashes retain retry identity for the current PR lifetime beyond 256 unrelated writes", async () => {
  const f = await fixture();
  await f.configure();
  const initial = await f.read();
  await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: [facts()],
    completedAt: now,
  });
  const note = {
    action: "note" as const,
    name,
    tabId: initial.tabId,
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    text: "Uncertain delivery",
  };
  await f.client.pullRequests(note);
  for (let index = 0; index < 260; index++)
    await f.server.store.pullRequests.command({
      action: "configure",
      name,
      tabId: initial.tabId,
      requestId: randomUUID(),
      repository,
    });
  const current = await f.read();
  const retry = snapshot(await f.client.pullRequests(note));
  expect(retry.generation).toBe(current.generation);
  expect(retry.prs[0].local).toMatchObject({ note: "Uncertain delivery", noteVersion: 1 });
  await expect(
    f.client.pullRequests({ ...note, expectedVersion: 1, text: "Reused UUID" }),
  ).rejects.toMatchObject({ status: 409 });
  const db = new DatabaseSync(join(f.directory, "scope.db"), { readOnly: true });
  try {
    expect(
      db
        .prepare("SELECT payload FROM pull_requests_receipts WHERE request_id = ?")
        .get(note.requestId)?.payload,
    ).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    db.close();
  }
});

test("complete inventories above SQLite's bind parameter limit commit every row and prune only missing PRs", async () => {
  const f = await fixture();
  await f.configure();
  const initial = await f.read();
  await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: [facts(1), facts(99_999)],
    completedAt: now,
  });
  await f.client.pullRequests({
    action: "note",
    name,
    tabId: initial.tabId,
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    text: "Retained current PR",
  });
  const timestamp = "2026-01-01T00:00:00Z";
  const inventory = Array.from({ length: 32_768 }, (_, index) => ({
    ...facts(index + 1),
    title: "a",
    author: null,
    labels: [],
    headRefName: "",
    requestedReviewers: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    merge: { ...facts().merge, observedAt: timestamp },
    checks: { ...facts().checks, observedAt: timestamp },
  }));
  const committed = await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: inventory,
    completedAt: now,
  });
  expect(Buffer.byteLength(JSON.stringify(committed))).toBeLessThan(32 * 1024 * 1024);
  expect(committed.prs).toHaveLength(inventory.length);
  expect(new Set(committed.prs.map((pr) => pr.nodeId))).toEqual(
    new Set(inventory.map((pr) => pr.nodeId)),
  );
  expect(committed.prs.find((pr) => pr.nodeId === "PR_1")?.local.note).toBe("Retained current PR");
  const reduced = await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: inventory.filter((pr) => pr.number !== 42),
    completedAt: now,
  });
  expect(reduced.prs).toHaveLength(32_767);
  expect(reduced.prs.some((pr) => pr.number === 42 || pr.number === 99_999)).toBe(false);
  expect(reduced.prs.find((pr) => pr.nodeId === "PR_1")?.local.note).toBe("Retained current PR");
}, 120_000);

test("review baselines retain the inspected commit when synchronization finds a newer head", async () => {
  const f = await fixture();
  await f.configure();
  const initial = await f.read();
  await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: [facts()],
    completedAt: now,
  });
  await f.client.pullRequests({
    action: "review",
    name,
    tabId: initial.tabId,
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    baseline: "inspected",
    headOid: head,
  });
  const newerHead = "c".repeat(40);
  const updated = {
    ...facts(),
    headOid: newerHead,
    merge: { ...facts().merge, headOid: newerHead },
  };
  await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: [updated],
    completedAt: now,
  });
  const marked = snapshot(
    await f.client.pullRequests({
      action: "review",
      name,
      tabId: initial.tabId,
      nodeId: "PR_1",
      requestId: randomUUID(),
      expectedVersion: 1,
      baseline: "reviewed",
      headOid: head,
    }),
  );
  expect(marked.prs[0]).toMatchObject({
    headOid: newerHead,
    local: { inspected: { headOid: head }, reviewed: { headOid: head }, reviewVersion: 2 },
  });
  expect(marked.prs[0].headOid !== marked.prs[0].local.reviewed?.headOid).toBe(true);
  await expect(
    f.client.pullRequests({
      action: "review",
      name,
      tabId: initial.tabId,
      nodeId: "PR_1",
      requestId: randomUUID(),
      expectedVersion: 1,
      baseline: "reviewed",
      headOid: newerHead,
    }),
  ).rejects.toMatchObject({ status: 409 });
  const current = snapshot(
    await f.client.pullRequests({
      action: "review",
      name,
      tabId: initial.tabId,
      nodeId: "PR_1",
      requestId: randomUUID(),
      expectedVersion: 2,
      baseline: "reviewed",
      headOid: newerHead,
    }),
  );
  expect(current.prs[0].local.reviewed?.headOid).toBe(newerHead);
  expect(current.prs[0].headOid !== current.prs[0].local.reviewed?.headOid).toBe(false);
});

test("complete sync wakes only commit-sensitive snoozes and invalidates stale Undo", async () => {
  const f = await fixture();
  await f.configure();
  const initial = await f.read();
  await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: [facts(1), facts(2), facts(3)],
    completedAt: now,
  });
  const snooze = {
    action: "snooze" as const,
    name,
    tabId: initial.tabId,
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    snooze: { until: "2026-10-05T12:00:00.000Z", headOid: head, wakeOnNewCommit: true },
  };
  await f.client.pullRequests(snooze);
  await f.client.pullRequests({
    ...snooze,
    requestId: randomUUID(),
    nodeId: "PR_2",
    snooze: { ...snooze.snooze, wakeOnNewCommit: false },
  });
  await f.client.pullRequests({ ...snooze, requestId: randomUUID(), nodeId: "PR_3" });
  await f.client.pullRequests({
    action: "note",
    name,
    tabId: initial.tabId,
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    text: "Retain my note",
  });
  await f.client.pullRequests({
    action: "review",
    name,
    tabId: initial.tabId,
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    baseline: "inspected",
    headOid: head,
  });
  await f.client.pullRequests({
    action: "assessment",
    name,
    tabId: initial.tabId,
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    assessment: {
      text: "Captured commit assessment",
      author: "agent",
      headOid: head,
      evidenceIds: [],
      discussionUpdatedAt: null,
      createdAt: now,
    },
    customFields: [],
  });
  const newerHead = "c".repeat(40);
  const changed = (number: number) => ({
    ...facts(number),
    headOid: newerHead,
    merge: { ...facts(number).merge, headOid: newerHead },
  });
  f.server.store.pullRequests.setHandlers({
    sync: (tabId) =>
      f.server.store.pullRequests.commitInventory(tabId, {
        repository,
        viewer: "viewer",
        prs: [
          changed(1),
          changed(2),
          {
            ...facts(3),
            title: "Comments and base changed, same head",
            baseOid: newerHead,
            merge: { ...facts(3).merge, baseOid: newerHead },
            hasUnresolvedConversations: true,
          },
        ],
        completedAt: now,
      }),
    detail: async () => {
      throw new Error("Not needed");
    },
  });
  const sync = { action: "sync" as const, name, tabId: initial.tabId, requestId: randomUUID() };
  const updated = snapshot(await f.client.pullRequests(sync));
  const first = updated.prs.find((pr) => pr.nodeId === "PR_1")!;
  expect(first).toMatchObject({
    headOid: newerHead,
    local: {
      snooze: null,
      snoozeVersion: 2,
      note: "Retain my note",
      noteVersion: 1,
      inspected: { headOid: head },
      reviewed: null,
      reviewVersion: 1,
    },
    agent: { version: 1, assessment: { headOid: head } },
  });
  expect(updated.prs.find((pr) => pr.nodeId === "PR_2")?.local).toMatchObject({
    snooze: { ...snooze.snooze, wakeOnNewCommit: false },
    snoozeVersion: 1,
  });
  expect(updated.prs.find((pr) => pr.nodeId === "PR_3")?.local).toMatchObject({
    snooze: snooze.snooze,
    snoozeVersion: 1,
  });
  await expect(
    f.client.pullRequests({ ...snooze, requestId: randomUUID(), expectedVersion: 1, snooze: null }),
  ).rejects.toMatchObject({ status: 409 });
  expect(
    snapshot(await f.client.pullRequests(snooze)).prs.find((pr) => pr.nodeId === "PR_1")?.local,
  ).toEqual(first.local);
  expect(
    snapshot(await f.client.pullRequests({ ...sync, requestId: randomUUID() })).prs.find(
      (pr) => pr.nodeId === "PR_1",
    )?.local,
  ).toEqual(first.local);
});

test.each([false, true])(
  "sync uses the latest in-flight snooze with wake=%s",
  async (wakeOnNewCommit) => {
    const f = await fixture();
    await f.configure();
    const initial = await f.read();
    await f.server.store.pullRequests.commitInventory(initial.tabId, {
      repository,
      viewer: "viewer",
      prs: [facts()],
      completedAt: now,
    });
    const snooze = {
      action: "snooze" as const,
      name,
      tabId: initial.tabId,
      nodeId: "PR_1",
      requestId: randomUUID(),
      expectedVersion: 0,
      snooze: { until: "2026-10-05T12:00:00.000Z", headOid: head, wakeOnNewCommit: true },
    };
    await f.client.pullRequests(snooze);
    let release!: () => void, entered!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const newerHead = "c".repeat(40);
    f.server.store.pullRequests.setHandlers({
      sync: async (tabId) => {
        entered();
        await hold;
        return f.server.store.pullRequests.commitInventory(tabId, {
          repository,
          viewer: "viewer",
          completedAt: now,
          prs: [
            { ...facts(), headOid: newerHead, merge: { ...facts().merge, headOid: newerHead } },
          ],
        });
      },
      detail: async () => {
        throw new Error("Not needed");
      },
    });
    const syncing = f.client.pullRequests({
      action: "sync",
      name,
      tabId: initial.tabId,
      requestId: randomUUID(),
    });
    const latest = { ...snooze.snooze, until: "2026-10-06T12:00:00.000Z", wakeOnNewCommit };
    try {
      await started;
      await f.client.pullRequests({
        ...snooze,
        requestId: randomUUID(),
        expectedVersion: 1,
        snooze: latest,
      });
      await f.client.pullRequests({
        action: "note",
        name,
        tabId: initial.tabId,
        nodeId: "PR_1",
        requestId: randomUUID(),
        expectedVersion: 0,
        text: "Written during fetch",
      });
    } finally {
      release();
    }
    expect(snapshot(await syncing).prs[0].local).toMatchObject({
      snooze: wakeOnNewCommit ? null : latest,
      snoozeVersion: wakeOnNewCommit ? 3 : 2,
      note: "Written during fetch",
      noteVersion: 1,
    });
  },
);

test("failed, invalid and cancelled inventories preserve commit-sensitive snoozes", async () => {
  const f = await fixture();
  await f.configure();
  const initial = await f.read();
  await f.server.store.pullRequests.commitInventory(initial.tabId, {
    repository,
    viewer: "viewer",
    prs: [facts()],
    completedAt: now,
  });
  await f.client.pullRequests({
    action: "snooze",
    name,
    tabId: initial.tabId,
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    snooze: { until: "2026-10-05T12:00:00.000Z", headOid: head, wakeOnNewCommit: true },
  });
  const saved = await f.read();
  f.server.store.pullRequests.setHandlers({
    sync: async () => {
      throw new Error("Synthetic incomplete inventory");
    },
    detail: async () => {
      throw new Error("Not needed");
    },
  });
  await expect(
    f.client.pullRequests({ action: "sync", name, tabId: initial.tabId, requestId: randomUUID() }),
  ).rejects.toThrow();
  const newerHead = "c".repeat(40);
  const inventory = {
    repository,
    viewer: "viewer",
    completedAt: now,
    prs: [{ ...facts(), headOid: newerHead, merge: { ...facts().merge, headOid: newerHead } }],
  };
  await expect(
    f.server.store.pullRequests.commitInventory(initial.tabId, {
      ...inventory,
      prs: [...inventory.prs, facts()],
    }),
  ).rejects.toThrow();
  const controller = new AbortController();
  controller.abort();
  await expect(
    f.server.store.pullRequests.commitInventory(initial.tabId, inventory, controller.signal),
  ).rejects.toThrow();
  expect(await f.read()).toEqual(saved);
});
