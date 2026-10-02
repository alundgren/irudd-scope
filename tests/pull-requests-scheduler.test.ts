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
  cleanups.push(async () => {
    service.cancelPending();
    await server.close();
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
      type: "file",
      title: name,
      groupId: randomUUID(),
      state: { version: 1, data: { artifactId: snapshot.artifact.id } },
    });
    return snapshot.tabId;
  }
  return { server, service, tab, store: server.store.pullRequests };
}
function reader() {
  let calls = 0;
  const github = new GitHubPullRequests();
  github.inventory = async () => {
    calls++;
    return {
      repository,
      queriedRepository: repository,
      viewer: "viewer",
      account: "VIEWER",
      cost: 1,
      prs: [facts()],
    };
  };
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

test("complete inventory preserves newer targeted facts with unchanged updatedAt", async () => {
  const remote = reader(),
    f = await fixture(remote.github),
    tabId = await f.tab("ordered");
  await f.service.sync(tabId);
  const previous = facts(),
    newer = {
      ...facts(1, "2026-10-02T00:01:00.000Z"),
      checks: {
        ...facts().checks,
        status: "passing" as const,
        observedAt: "2026-10-02T00:01:00.000Z",
      },
    };
  await f.store.commitCurrent(tabId, repository, previous, newer);
  await f.service.sync(tabId);
  expect((await f.store.snapshotByTab(tabId)).prs[0].checks.status).toBe("passing");
  await f.store.commitCurrent(tabId, repository, previous, null);
  expect((await f.store.snapshotByTab(tabId)).prs).toHaveLength(1);
  await f.store.commitCurrent(tabId, repository, newer, null);
  await f.store.commitCurrent(tabId, repository, newer, newer);
  expect((await f.store.snapshotByTab(tabId)).prs).toHaveLength(0);
});

test("startup loads unmounted configured tabs and trash stops the final repository", async () => {
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
  await f.server.store.trashTab(tabId);
  await f.service.reconcile();
  expect(tasks.size).toBe(0);
});

test("large inventories lengthen active cadence using actual costs", async () => {
  const remote = reader();
  remote.github.inventory = async () => ({
    repository,
    queriedRepository: repository,
    viewer: "viewer",
    account: "VIEWER",
    cost: 20,
    prs: Array.from({ length: 125 }, (_, index) => facts(index + 1)),
  });
  const f = await fixture(remote.github, { now: () => Date.parse(stamp) }),
    tabId = await f.tab("large");
  await f.service.interest({ tabId, active: true, detail: null });
  const snapshot = await f.service.sync(tabId);
  expect(snapshot.prs).toHaveLength(125);
  expect(snapshot.sync.intervalMs).toBe(144_000);
  expect(snapshot.sync.reason).toBe("Account query budget");
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

test("closed targeted read cannot be resurrected by an older completing inventory", async () => {
  const remote = reader();
  let nextTask: (() => void) | undefined;
  const f = await fixture(remote.github, {
    now: () => Date.parse(stamp),
    setTimeout: (callback) => {
      nextTask = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {
      nextTask = undefined;
    },
  });
  const tabId = await f.tab("closed");
  await f.service.sync(tabId);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inventory = remote.github.inventory.bind(remote.github);
  remote.github.inventory = async (...args) => {
    await held;
    return inventory(...args);
  };
  remote.github.current = async () => null;
  await f.service.interest({
    tabId,
    active: true,
    detail: { nodeId: "PR_1", headOid: facts().headOid, baseOid: facts().baseOid },
  });
  await f.service.start();
  nextTask!();
  await expect.poll(async () => (await f.store.snapshotByTab(tabId)).prs.length).toBe(0);
  release();
  await expect.poll(async () => (await f.store.snapshotByTab(tabId)).sync.state).toBe("idle");
  expect((await f.store.snapshotByTab(tabId)).prs).toHaveLength(0);
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

test("immutable detail is shared across tabs until commits change", async () => {
  const remote = reader();
  let calls = 0;
  remote.github.detail = async (_repository, pr) => {
    calls++;
    return {
      headOid: pr.headOid,
      body: "description",
      diff: "diff",
      reviews: [],
      files: [],
      fetchedAt: stamp,
    };
  };
  const f = await fixture(remote.github),
    first = await f.tab("detail-first"),
    second = await f.tab("detail-second");
  await f.service.sync(first);
  await Promise.all([f.service.detail(first, "PR_1"), f.service.detail(second, "PR_1")]);
  expect(calls).toBe(1);
  const previous = facts(),
    changed = {
      ...facts(1, "2026-10-02T00:01:00.000Z"),
      baseOid: "c".repeat(40),
      merge: { ...facts().merge, baseOid: "c".repeat(40), observedAt: "2026-10-02T00:01:00.000Z" },
    };
  await f.store.commitCurrent(first, repository, previous, changed);
  await f.service.detail(first, "PR_1");
  expect(calls).toBe(2);
});
