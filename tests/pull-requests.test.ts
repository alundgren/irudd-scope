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
  const configure = () =>
    client.pullRequests({ action: "configure", name, requestId: randomUUID(), repository });
  return { directory, server, client, cli, html, read, configure };
}

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
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    snooze: { until: "2026-10-05T12:00:00.000Z", headOid: head, wakeOnNewCommit: true },
  });
  await f.client.pullRequests({
    action: "review",
    name,
    nodeId: "PR_1",
    requestId: randomUUID(),
    expectedVersion: 0,
    baseline: "inspected",
    headOid: head,
  });
  await f.client.pullRequests({
    action: "assessment",
    name,
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
  const syncing = f.client.pullRequests({ action: "sync", name, requestId: randomUUID() });
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
    f.client.pullRequests({ action: "detail", name, nodeId: "PR_1", requestId: randomUUID() }),
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
