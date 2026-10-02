import { afterEach, expect, test } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { decode } from "@irudd-scope/protocol";
import { PullRequestsSnapshot, PullRequestsSync } from "@irudd-scope/protocol/pull-requests";
import type { PullRequestFacts } from "@irudd-scope/protocol/pull-requests";
import { ArtifactStore } from "../apps/desktop/src/library/store.ts";
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
      type: "file",
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
    startedAt: stamp,
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
  await expect
    .poll(
      async () => {
        const row = await f.store.snapshotByTab(tabId);
        return row.prs.length;
      },
      { timeout: 10_000 },
    )
    .toBe(0);
  release();
  await expect
    .poll(async () => (await f.store.snapshotByTab(tabId)).sync.state, { timeout: 10_000 })
    .toBe("idle");
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

test("newer reopened inventory survives an older closed observation", async () => {
  const remote = reader(),
    f = await fixture(remote.github),
    tabId = await f.tab("reopen");
  await f.service.sync(tabId);
  const previous = facts(),
    reopened = facts(1, "2026-10-02T00:00:20.000Z"),
    closedAt = "2026-10-02T00:00:15.000Z";
  await f.store.commitCurrent(tabId, repository, previous, null, undefined, closedAt);
  await f.store.commitInventory(tabId, {
    repository,
    viewer: "viewer",
    prs: [reopened],
    completedAt: "2026-10-02T00:00:30.000Z",
    startedAt: reopened.merge.observedAt,
    closed: new Map([["PR_1", closedAt]]),
  });
  await f.store.commitCurrent(tabId, repository, previous, null, undefined, closedAt);
  await f.store.commitInventory(tabId, {
    repository,
    viewer: "viewer",
    prs: [facts(1, "2026-10-02T00:00:10.000Z")],
    completedAt: "2026-10-02T00:00:40.000Z",
    startedAt: "2026-10-02T00:00:10.000Z",
    closed: new Map([["PR_1", closedAt]]),
  });
  expect((await f.store.snapshotByTab(tabId)).prs[0].merge.observedAt).toBe(
    reopened.merge.observedAt,
  );
});

test("complete inventory does not prune targeted open facts observed after its first root", async () => {
  const remote = reader(),
    f = await fixture(remote.github),
    tabId = await f.tab("absence");
  await f.service.sync(tabId);
  const newer = facts(1, "2026-10-02T00:00:30.000Z");
  await f.store.commitCurrent(tabId, repository, facts(), newer);
  await f.store.commitInventory(tabId, {
    repository,
    viewer: "viewer",
    prs: [],
    startedAt: "2026-10-02T00:00:20.000Z",
    completedAt: "2026-10-02T00:00:40.000Z",
  });
  expect((await f.store.snapshotByTab(tabId)).prs).toHaveLength(1);
  await f.store.commitInventory(tabId, {
    repository,
    viewer: "viewer",
    prs: [],
    startedAt: "2026-10-02T00:00:50.000Z",
    completedAt: "2026-10-02T00:00:55.000Z",
  });
  expect((await f.store.snapshotByTab(tabId)).prs).toHaveLength(0);
});

test("explicit sync retries authentication recovery while automatic cadence stays slow", async () => {
  const remote = reader();
  let calls = 0;
  const inventory = remote.github.inventory.bind(remote.github);
  remote.github.inventory = async (...args) => {
    if (++calls === 1) throw new GitHubReadError("Sign in with gh auth login", "auth");
    return inventory(...args);
  };
  const f = await fixture(remote.github, { now: () => Date.parse(stamp) }),
    tabId = await f.tab("auth-recovery");
  expect((await f.service.sync(tabId)).sync.nextAttemptAt).toBe("2026-10-02T00:15:00.000Z");
  expect((await f.service.sync(tabId)).sync.state).toBe("idle");
  expect(calls).toBe(2);
});

test("first load publishes complete base rows before enrichment and a joining tab shares it", async () => {
  const remote = reader();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  remote.github.enrichInventory = async () => {
    await held;
    return {
      repository,
      queriedRepository: repository,
      viewer: "viewer",
      account: "VIEWER",
      cost: 1,
      startedAt: stamp,
      closed: new Map<string, string>(),
      prs: [facts()],
    };
  };
  const f = await fixture(remote.github, { now: () => Date.parse(stamp) }),
    first = await f.tab("base-first");
  const pending = f.service.sync(first);
  await expect
    .poll(async () => (await f.store.snapshotByTab(first)).prs.length, { timeout: 10_000 })
    .toBe(1);
  const base = await f.store.snapshotByTab(first);
  expect(base.sync.state).toBe("syncing");
  expect(base.sync.lastSuccessAt).toBeNull();
  expect(base.sync.reason).toBe("Loading remaining GitHub facts");
  const second = await f.tab("base-second");
  await f.service.reconcile();
  expect((await f.store.snapshotByTab(second)).sync.lastSuccessAt).toBeNull();
  expect((await f.store.snapshotByTab(second)).prs).toHaveLength(1);
  const joined = f.service.sync(second);
  release();
  await Promise.all([pending, joined]);
  expect(remote.calls()).toBe(1);
  expect((await f.store.snapshotByTab(second)).sync.lastSuccessAt).toBe(stamp);
});

test("failed initial enrichment retains base rows and retries without claiming full freshness", async () => {
  const remote = reader();
  let attempts = 0;
  remote.github.enrichInventory = async () => {
    if (++attempts === 1) throw new GitHubReadError("GitHub could not be reached", "network");
    return {
      repository,
      queriedRepository: repository,
      viewer: "viewer",
      account: "VIEWER",
      cost: 1,
      startedAt: stamp,
      closed: new Map<string, string>(),
      prs: [facts()],
    };
  };
  const f = await fixture(remote.github),
    tabId = await f.tab("base-retry");
  const failed = await f.service.sync(tabId);
  expect(failed.sync.state).toBe("error");
  expect(failed.sync.lastSuccessAt).toBeNull();
  expect(failed.prs).toHaveLength(1);
  expect((await f.service.sync(tabId)).sync.lastSuccessAt).toBeTruthy();
});

for (const restart of [false, true]) {
  test(`failed enrichment retries preserve known targeted facts${restart ? " after restart" : ""}`, async () => {
    const remote = reader();
    let metadataReads = 0;
    const initial = remote.github.initialInventory.bind(remote.github);
    remote.github.initialInventory = async (...args) => {
      metadataReads++;
      const base = await initial(...args);
      return {
        ...base,
        prs: base.prs.map((pr) => ({
          ...pr,
          merge: { ...pr.merge, status: "unknown" as const },
          checks: { ...pr.checks, status: "unknown" as const },
          hasUnresolvedConversations: null,
        })),
      };
    };
    remote.github.enrichInventory = async () => {
      throw new GitHubReadError("GitHub could not be reached", "network");
    };
    const f = await fixture(remote.github),
      tabId = await f.tab("known-retry");
    const failed = await f.service.sync(tabId);
    expect(failed.viewer).toBe("viewer");
    expect(failed.sync.lastSuccessAt).toBeNull();
    const observed = facts(1, "2026-10-02T00:00:01.000Z");
    const known = {
      ...observed,
      checks: { ...observed.checks, status: "passing" as const },
      hasUnresolvedConversations: true,
    };
    await f.store.commitCurrent(tabId, repository, failed.prs[0]!, known);
    let store = f.store,
      service = f.service;
    if (restart) {
      await f.close();
      const reopened = await ArtifactStore.open(f.directory);
      store = reopened.pullRequests;
      service = new PullRequestSync(store, remote.github);
      cleanups.push(async () => {
        service.cancelPending();
        await reopened.close();
      });
    }
    let completeReads = 0;
    remote.github.inventory = async () => {
      completeReads++;
      throw new GitHubReadError("GitHub is still unavailable", "network");
    };
    const retried = await service.sync(tabId);
    expect(metadataReads).toBe(1);
    expect(completeReads).toBe(1);
    expect(retried.sync.state).toBe("error");
    expect(retried.sync.lastSuccessAt).toBeNull();
    expect(retried.prs[0]!.checks.status).toBe("passing");
    expect(retried.prs[0]!.merge.status).toBe("clear");
    expect(retried.prs[0]!.hasUnresolvedConversations).toBe(true);
    expect(retried.prs[0]!.merge.observedAt).toBe(known.merge.observedAt);
  });
}

test("an empty committed base uses an atomic retry after restart", async () => {
  const remote = reader();
  let metadataReads = 0;
  const initial = remote.github.initialInventory.bind(remote.github);
  remote.github.initialInventory = async (...args) => {
    metadataReads++;
    return { ...(await initial(...args)), prs: [] };
  };
  remote.github.enrichInventory = async () => {
    throw new GitHubReadError("GitHub could not be reached", "network");
  };
  const f = await fixture(remote.github),
    tabId = await f.tab("empty-retry");
  const failed = await f.service.sync(tabId);
  expect(failed.prs).toEqual([]);
  expect(failed.viewer).toBe("viewer");
  expect(failed.sync.lastSuccessAt).toBeNull();
  await f.close();
  const reopened = await ArtifactStore.open(f.directory);
  const service = new PullRequestSync(reopened.pullRequests, remote.github);
  cleanups.push(async () => {
    service.cancelPending();
    await reopened.close();
  });
  const retry = await service.sync(tabId);
  expect(metadataReads).toBe(1);
  expect(retry.prs.map((pr) => pr.nodeId)).toEqual(["PR_1"]);
  expect(retry.sync.lastSuccessAt).toBeTruthy();
});

test("manual refresh probes a changed account while the previous account reserve is active", async () => {
  const remote = reader();
  let observe!: Parameters<GitHubPullRequests["setReadHooks"]>[0];
  let before!: NonNullable<Parameters<GitHubPullRequests["setReadHooks"]>[1]>;
  remote.github.setReadHooks = (callback, beforeRead) => {
    observe = callback;
    before = beforeRead!;
  };
  let account = "old-account";
  let queries = 0;
  remote.github.account = async () => account;
  remote.github.inventory = async (_repository, signal) => {
    await before(signal);
    queries++;
    observe({
      account,
      cost: 1,
      limit: 5000,
      remaining: account === "old-account" ? 20 : 4000,
      resetAt: "2026-10-02T01:00:00.000Z",
    });
    return {
      repository,
      queriedRepository: repository,
      viewer: account,
      account,
      cost: 1,
      startedAt: stamp,
      closed: new Map<string, string>(),
      prs: [facts()],
    };
  };
  const f = await fixture(remote.github, { now: () => Date.parse(stamp) }),
    tabId = await f.tab("probe");
  await f.service.sync(tabId);
  account = "new-account";
  expect((await f.service.sync(tabId)).viewer).toBe("new-account");
  expect(queries).toBe(2);
});

test("HTTP snapshots remain readable by the original strict schema", async () => {
  const remote = reader(),
    f = await fixture(remote.github),
    tabId = await f.tab("legacy");
  await f.service.sync(tabId);
  expect((await f.store.snapshotByTab(tabId)).sync.intervalMs).toBeTypeOf("number");
  const response = await fetch(`${f.server.url}/v1/pull-requests`, {
    method: "POST",
    headers: {
      Authorization: "Bearer synthetic-scheduler-token-123456789",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "read", name: "legacy" }),
  });
  expect(response.ok).toBe(true);
  const oldSnapshot = PullRequestsSnapshot.mapFields((fields) => ({
    ...fields,
    sync: PullRequestsSync.mapFields((sync) => ({
      state: sync.state,
      updatedAt: sync.updatedAt,
      lastSuccessAt: sync.lastSuccessAt,
      error: sync.error,
    })),
  }));
  const reply = (await response.json()) as { type: string; snapshot: unknown };
  expect(Object.keys(reply)).toEqual(["type", "snapshot"]);
  expect(reply.type).toBe("snapshot");
  const snapshot = decode(oldSnapshot, reply.snapshot);
  expect(snapshot.prs).toHaveLength(1);
});

test("cancelled shutdown pauses requests and resume schedules a new refresh", async () => {
  const remote = reader();
  let task: (() => void) | undefined;
  const f = await fixture(remote.github, {
    now: () => Date.parse(stamp),
    setTimeout: (callback) => {
      task = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {
      task = undefined;
    },
  });
  const tabId = await f.tab("resume");
  await f.service.start();
  task!();
  await expect
    .poll(async () => (await f.store.snapshotByTab(tabId)).sync.lastSuccessAt, { timeout: 10_000 })
    .toBe(stamp);
  f.service.cancelPending();
  expect(task).toBeUndefined();
  await f.service.resume();
  expect(task).toBeTypeOf("function");
  task!();
  await expect.poll(remote.calls, { timeout: 10_000 }).toBe(2);
});

test("configuration arriving during a reconciliation scan is observed before it finishes", async () => {
  const remote = reader();
  let task: (() => void) | undefined;
  const f = await fixture(remote.github, {
    setTimeout: (callback) => {
      task = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {
      task = undefined;
    },
  });
  const original = f.store.configuredTabs.bind(f.store);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
      release = resolve;
    }),
    started = new Promise<void>((resolve) => {
      entered = resolve;
    });
  let scans = 0;
  f.store.configuredTabs = async () => {
    const rows = await original();
    if (++scans === 1) {
      entered();
      await held;
    }
    return rows;
  };
  const scan = f.service.start();
  await started;
  const tabId = await f.tab("arriving");
  const changed = f.service.reconcile();
  release();
  await Promise.all([scan, changed]);
  expect(scans).toBe(2);
  expect(task).toBeTypeOf("function");
  task!();
  await expect
    .poll(async () => (await f.store.snapshotByTab(tabId)).sync.lastSuccessAt, { timeout: 10_000 })
    .toBeTruthy();
});

test("explicit enrichment closure removes a later base row and preserves only newer reopened facts", async () => {
  const remote = reader(),
    f = await fixture(remote.github),
    tabId = await f.tab("enrichment-close");
  const baseAt = "2026-10-02T00:00:10.000Z",
    closedAt = "2026-10-02T00:00:30.000Z";
  await f.store.commitInventory(tabId, {
    repository,
    viewer: "viewer",
    prs: [facts(1, baseAt), facts(2, baseAt), facts(3, baseAt)],
    startedAt: stamp,
    completedAt: baseAt,
  });
  await f.store.commitCurrent(
    tabId,
    repository,
    facts(2, baseAt),
    facts(2, "2026-10-02T00:00:25.000Z"),
  );
  await f.store.commitCurrent(
    tabId,
    repository,
    facts(3, baseAt),
    facts(3, "2026-10-02T00:00:35.000Z"),
  );
  await f.store.commitInventory(tabId, {
    repository,
    viewer: "viewer",
    prs: [],
    startedAt: stamp,
    completedAt: "2026-10-02T00:00:40.000Z",
    closed: new Map([1, 2, 3].map((number) => [`PR_${number}`, closedAt])),
  });
  expect((await f.store.snapshotByTab(tabId)).prs.map((pr) => pr.nodeId)).toEqual(["PR_3"]);
});

test("store restore notification restarts an unmounted repository", async () => {
  const remote = reader();
  let task: (() => void) | undefined;
  const f = await fixture(remote.github, {
    setTimeout: (callback) => {
      task = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {
      task = undefined;
    },
  });
  const tabId = await f.tab("restored");
  const unsubscribe = f.server.store.subscribe(() => {
    void f.service.reconcile().catch(() => {});
  });
  cleanups.push(async () => {
    unsubscribe();
  });
  await f.service.start();
  await f.server.store.trashTab(tabId);
  await expect.poll(() => task, { timeout: 10_000 }).toBeUndefined();
  await f.server.store.restoreTab(tabId);
  await expect.poll(() => typeof task, { timeout: 10_000 }).toBe("function");
});

test("opening, advancing and closing a pane leave a fresh active inventory on its cadence", async () => {
  const remote = reader();
  let task: (() => void) | undefined,
    delay = -1,
    currentCalls = 0;
  remote.github.inventory = async () => ({
    repository,
    queriedRepository: repository,
    viewer: "viewer",
    account: "VIEWER",
    cost: 1,
    startedAt: stamp,
    prs: [facts(1), facts(2)],
  });
  remote.github.current = async (_repository, pr) => {
    currentCalls++;
    return { ...facts(pr.number, "2026-10-02T00:00:01.000Z") };
  };
  remote.github.reviews = async () => ({
    body: "current discussion",
    reviews: [],
    fetchedAt: stamp,
  });
  let inventoryCalls = 0;
  const inventory = remote.github.inventory.bind(remote.github);
  remote.github.inventory = async (...args) => {
    inventoryCalls++;
    return inventory(...args);
  };
  const f = await fixture(remote.github, {
      now: () => Date.parse(stamp),
      setTimeout: (callback, wait) => {
        task = callback;
        delay = wait;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {
        task = undefined;
      },
    }),
    tabId = await f.tab("pane-cadence");
  await f.service.interest({ tabId, active: true, detail: null });
  await f.service.sync(tabId);
  await f.service.start();
  expect(delay).toBe(30_000);
  await f.service.interest({
    tabId,
    active: true,
    detail: { nodeId: "PR_1", headOid: facts().headOid, baseOid: facts().baseOid },
  });
  expect(delay).toBe(0);
  task!();
  await expect.poll(() => currentCalls, { timeout: 10_000 }).toBe(1);
  await expect.poll(() => delay, { timeout: 10_000 }).toBeGreaterThan(0);
  await f.service.interest({
    tabId,
    active: true,
    detail: { nodeId: "PR_2", headOid: facts().headOid, baseOid: facts().baseOid },
  });
  task!();
  await expect.poll(() => currentCalls, { timeout: 10_000 }).toBe(2);
  await f.service.interest({ tabId, active: true, detail: null });
  expect(delay).toBeGreaterThan(0);
  expect(inventoryCalls).toBe(1);
  await f.service.interest({ tabId, active: true, detail: null, refresh: true });
  expect(delay).toBe(0);
  task!();
  await expect.poll(() => inventoryCalls, { timeout: 10_000 }).toBe(2);
});

test("live discussions keep captured pane commits while current repository facts advance", async () => {
  const remote = reader();
  let task: (() => void) | undefined,
    detailCalls = 0;
  const updates: { headOid: string; body?: string }[] = [];
  const newHead = "c".repeat(40);
  remote.github.detail = async () => {
    detailCalls++;
    return {
      headOid: facts().headOid,
      body: "old body",
      diff: "captured diff",
      reviews: [],
      files: [],
      fetchedAt: stamp,
    };
  };
  remote.github.current = async () => ({
    ...facts(1, "2026-10-02T00:00:10.000Z"),
    headOid: newHead,
    merge: { ...facts().merge, headOid: newHead, observedAt: "2026-10-02T00:00:10.000Z" },
    checks: { ...facts().checks, headOid: newHead, observedAt: "2026-10-02T00:00:10.000Z" },
  });
  remote.github.reviews = async (_repository, captured) => {
    expect(captured.headOid).toBe(facts().headOid);
    return { body: "new discussion", reviews: [], fetchedAt: stamp };
  };
  const f = await fixture(remote.github, {
      now: () => Date.parse(stamp),
      onDetail: (update) => {
        updates.push(update);
      },
      setTimeout: (callback) => {
        task = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout: () => {
        task = undefined;
      },
    }),
    tabId = await f.tab("pinned");
  await f.service.interest({ tabId, active: true, detail: null });
  await f.service.sync(tabId);
  expect((await f.service.detail(tabId, "PR_1")).diff).toBe("captured diff");
  await f.service.start();
  await f.service.interest({
    tabId,
    active: true,
    detail: { nodeId: "PR_1", headOid: facts().headOid, baseOid: facts().baseOid },
  });
  task!();
  await expect.poll(() => updates.length, { timeout: 10_000 }).toBe(1);
  expect(updates[0]).toMatchObject({ headOid: facts().headOid, body: "new discussion" });
  expect((await f.store.snapshotByTab(tabId)).prs[0].headOid).toBe(newHead);
  expect(detailCalls).toBe(1);
});

test("captured detail rejects changed base before cache or remote read even when head is unchanged", async () => {
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
    tabId = await f.tab("captured-base");
  await f.service.sync(tabId);
  const old = facts(),
    changed = {
      ...facts(1, "2026-10-02T00:00:10.000Z"),
      baseOid: "c".repeat(40),
      merge: { ...facts().merge, baseOid: "c".repeat(40), observedAt: "2026-10-02T00:00:10.000Z" },
    };
  await f.store.commitCurrent(tabId, repository, old, changed);
  await expect(
    f.service.detail(tabId, "PR_1", { headOid: old.headOid, baseOid: old.baseOid }),
  ).rejects.toThrow("comparison changed");
  expect(calls).toBe(0);
  f.store.setHandlers({
    sync: (id) => f.service.sync(id),
    detail: (id, nodeId, captured) => f.service.detail(id, nodeId, captured),
  });
  await expect(
    f.store.command({
      name: "captured-base",
      tabId,
      action: "detail",
      nodeId: "PR_1",
      requestId: randomUUID(),
      captured: { headOid: old.headOid, baseOid: old.baseOid },
    }),
  ).rejects.toThrow("comparison changed");
  expect(calls).toBe(0);
  await f.store.command({
    name: "captured-base",
    tabId,
    action: "detail",
    nodeId: "PR_1",
    requestId: randomUUID(),
  });
  expect(calls).toBe(1);
});
