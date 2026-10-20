import { afterEach, expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ScopeClient } from "@irudd-scope/protocol/client";
import type { PullRequestFacts } from "@irudd-scope/protocol/pull-requests";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { PullRequestSync } from "../apps/desktop/src/plugins/pull-requests/sync.ts";
import { GitHubPullRequests } from "../apps/desktop/src/plugins/pull-requests/gh.ts";
import { GitHubReadError } from "../apps/desktop/src/plugins/pull-requests/gh-process.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const repository = { owner: "example", name: "project" };
const stamp = "2026-10-02T00:00:00.000Z";
function facts(number = 1, observedAt = stamp): PullRequestFacts {
  const headOid = "a".repeat(40),
    baseOid = "b".repeat(40);
  return {
    nodeId: `PR_${number}`,
    number,
    title: `Request ${number}`,
    author: "author",
    labels: [],
    headOid,
    headRefName: "feature",
    baseOid,
    draft: false,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    url: `https://github.com/example/project/pull/${number}`,
    merge: { status: "clear", headOid, baseOid, observedAt },
    checks: { status: "pending", headOid, observedAt },
    hasUnresolvedConversations: false,
    createdAt: stamp,
    requestedReviewers: [],
    updatedAt: stamp,
  };
}
async function fixture(
  reader: GitHubPullRequests,
  scheduling: ConstructorParameters<typeof PullRequestSync>[2] = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "scope-scheduler-"));
  const server = await startArtifactServer({
    directory,
    token: "synthetic-scheduler-token-123456789",
    port: 0,
  });
  const client = new ScopeClient(server.url, "synthetic-scheduler-token-123456789");
  const service = new PullRequestSync(server.store.pullRequests, reader, scheduling);
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    service.cancelPending();
    await server.close();
  }
  cleanups.push(async () => {
    await close();
    await rm(directory, { recursive: true, force: true });
  });
  async function tab(name: string) {
    await client.publish(
      randomUUID(),
      {
        name,
        title: name,
        kind: "pull-requests",
        mediaType: "text/html",
        fileName: `${name}.html`,
        expectedRevision: 0,
      },
      Buffer.from("<h1>Inbox</h1>"),
    );
    const snapshot = await server.store.pullRequests.snapshot(name);
    await server.store.pullRequests.command({
      name,
      tabId: snapshot.tabId,
      requestId: randomUUID(),
      action: "configure",
      repository,
    });
    await server.store.openTab({
      id: snapshot.tabId,
      type: "pull-requests",
      title: name,
      groupId: randomUUID(),
      state: { version: 1, data: { artifactId: snapshot.artifact.id } },
    });
    return snapshot.tabId;
  }
  return { server, service, tab, store: server.store.pullRequests, directory, close };
}
function reader() {
  let calls = 0;
  const github = new GitHubPullRequests();
  github.account = async () => "VIEWER";
  github.inventory = async () => {
    calls++;
    return {
      repository,
      queriedRepository: repository,
      viewer: "viewer",
      account: "VIEWER",
      startedAt: stamp,
      cost: 1,
      prs: [facts()],
    };
  };
  let base: Awaited<ReturnType<GitHubPullRequests["inventory"]>>;
  github.initialInventory = async (...args) => {
    base = await github.inventory(...args);
    return base;
  };
  github.enrichInventory = async () => ({ ...base, closed: new Map<string, string>() });
  return { github, calls: () => calls };
}

test("same-repository tabs share inventory while notes remain independent", async () => {
  const remote = reader();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inventory = remote.github.inventory.bind(remote.github);
  remote.github.inventory = async (...args) => {
    await held;
    return inventory(...args);
  };
  const f = await fixture(remote.github);
  const first = await f.tab("first"),
    second = await f.tab("second");
  const one = f.service.sync(first),
    two = f.service.sync(second);
  release();
  await Promise.all([one, two]);
  expect(remote.calls()).toBe(1);
  await f.store.command({
    name: "first",
    tabId: first,
    requestId: randomUUID(),
    action: "note",
    nodeId: "PR_1",
    expectedVersion: 0,
    text: "private note",
  });
  await f.service.sync(second);
  expect((await f.store.snapshotByTab(first)).prs[0].local.note).toBe("private note");
  expect((await f.store.snapshotByTab(second)).prs[0].local.note).toBe("");
});

test("startup loads unmounted configured tabs and deletion stops the final repository", async () => {
  const remote = reader(),
    tasks = new Map<number, () => void>();
  let timer = 0;
  const f = await fixture(remote.github, {
    now: () => Date.parse(stamp),
    setTimeout: (callback) => {
      const id = ++timer;
      tasks.set(id, callback);
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (id) => {
      tasks.delete(id as unknown as number);
    },
  });
  const tabId = await f.tab("unmounted");
  await f.service.start();
  expect(tasks.size).toBe(1);
  const task = tasks.values().next().value!;
  tasks.clear();
  task();
  await expect
    .poll(async () => (await f.store.snapshotByTab(tabId)).sync.lastSuccessAt)
    .toBe(stamp);
  await f.server.store.removeArtifact((await f.store.snapshotByTab(tabId)).artifact.id);
  await f.service.reconcile();
  expect(tasks.size).toBe(0);
});

test("throttle retry blocks manual sync until the server deadline", async () => {
  const remote = reader();
  let now = Date.parse(stamp),
    calls = 0;
  remote.github.inventory = async () => {
    calls++;
    throw new GitHubReadError("Wait for GitHub", "throttle", now + 120_000);
  };
  const f = await fixture(remote.github, { now: () => now }),
    tabId = await f.tab("retry");
  expect((await f.service.sync(tabId)).sync.state).toBe("error");
  await f.service.sync(tabId);
  expect(calls).toBe(1);
  now += 120_000;
  await f.service.sync(tabId);
  expect(calls).toBe(2);
});

test("account change aborts old work and an account reserve prevents extra queries", async () => {
  const remote = reader();
  let observe!: Parameters<GitHubPullRequests["setReadHooks"]>[0];
  let beforeRead!: NonNullable<Parameters<GitHubPullRequests["setReadHooks"]>[1]>;
  remote.github.setReadHooks = (callback, before) => {
    observe = callback;
    beforeRead = before!;
  };
  let account = "first-account",
    low = false;
  remote.github.account = async () => account;
  remote.github.inventory = async (_repository, signal) => {
    await beforeRead(signal);
    observe({
      account,
      cost: 1,
      limit: 5000,
      remaining: low ? 50 : 4000,
      resetAt: "2026-10-02T01:00:00.000Z",
    });
    signal.throwIfAborted();
    return {
      repository,
      queriedRepository: repository,
      viewer: account,
      account,
      startedAt: stamp,
      cost: 1,
      prs: [facts()],
    };
  };
  const f = await fixture(remote.github, { now: () => Date.parse(stamp) }),
    tabId = await f.tab("account");
  expect((await f.service.sync(tabId)).viewer).toBe("first-account");
  account = "second-account";
  await expect(f.service.sync(tabId)).rejects.toThrow();
  expect((await f.service.sync(tabId)).viewer).toBe("second-account");
  low = true;
  await f.service.sync(tabId);
  await expect(
    Promise.resolve().then(() => beforeRead(new AbortController().signal)),
  ).rejects.toThrow("account query budget");
  expect((await f.service.sync(tabId)).sync.nextAttemptAt).toBe("2026-10-02T01:00:00.000Z");
});
