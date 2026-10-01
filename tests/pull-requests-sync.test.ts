import { afterEach, describe, expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubProcess } from "../apps/desktop/src/plugins/pull-requests/gh-process.ts";
import { GitHubPullRequests } from "../apps/desktop/src/plugins/pull-requests/gh.ts";
import { PullRequestSync } from "../apps/desktop/src/plugins/pull-requests/sync.ts";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { randomUUID } from "node:crypto";
import { PullRequestsReply } from "@irudd-scope/protocol/pull-requests";
import { decode } from "@irudd-scope/protocol";
import { ArtifactStore } from "../apps/desktop/src/library/store.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fakeGh(handler: string, options: { timeoutMs?: number; maxBytes?: number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "scope-gh-test-"));
  directories.push(directory);
  const path = join(directory, "gh.mjs");
  const log = join(directory, "calls.jsonl");
  await writeFile(
    path,
    `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';\nconst args = process.argv.slice(2);\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');\n${handler}\n`,
    { mode: 0o755 },
  );
  return {
    process: new GitHubProcess(path, options.timeoutMs ?? 2000, options.maxBytes),
    release: () => writeFile(`${path}.release`, "ready"),
    calls: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
  };
}

const repository = { owner: "example", name: "project" };
const head = "a".repeat(40);
const base = "b".repeat(40);
const oldHead = "c".repeat(40);
const complete: { hasNextPage: boolean; endCursor: string | null } = {
  hasNextPage: false,
  endCursor: null,
};
function pr(
  number: number,
  options: { draft?: boolean; mergeable?: string; checkHead?: string; checkState?: string } = {},
) {
  return {
    id: `PR_${number}`,
    number,
    title: `Pull request ${number}`,
    author: { login: "author" },
    labels: { nodes: [{ name: "bug" }], pageInfo: complete },
    headRefOid: head,
    headRefName: "feature",
    baseRefOid: base,
    reviewRequests: {
      nodes: [
        {
          requestedReviewer: { login: "reviewer" } as
            | { login: string }
            | { slug: string; organization: { login: string } },
        },
      ],
      pageInfo: complete,
    },
    isDraft: options.draft ?? false,
    additions: 0,
    deletions: 0,
    changedFiles: 1,
    url: `https://github.com/example/project/pull/${number}`,
    mergeable: options.mergeable ?? "UNKNOWN",
    updatedAt: "2026-10-01T12:00:00Z",
    createdAt: "2026-09-30T12:00:00Z",
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
            statusCheckRollup: {
              state: options.checkState ?? "SUCCESS",
              commit: { oid: options.checkHead ?? head },
            },
          },
        },
      ],
    },
  };
}
function inventory(nodes: ReturnType<typeof pr>[], pageInfo = complete) {
  return {
    data: { viewer: { login: "viewer" }, repository: { pullRequests: { nodes, pageInfo } } },
  };
}
function threads(number: number, resolved: boolean[], pageInfo = complete) {
  return {
    data: {
      repository: {
        pullRequest: {
          id: `PR_${number}`,
          state: "OPEN",
          headRefOid: head,
          baseRefOid: base,
          reviewThreads: { nodes: resolved.map((isResolved) => ({ isResolved })), pageInfo },
        },
      },
    },
  };
}
const signal = () => new AbortController().signal;

describe("fixed GitHub reads", () => {
  test("reads all open pages including drafts and later unresolved threads with head-bound checks", async () => {
    const first = inventory([pr(1, { draft: true, mergeable: "MERGEABLE", checkHead: oldHead })], {
      hasNextPage: true,
      endCursor: "inventory-two",
    });
    const second = inventory([pr(2, { mergeable: "CONFLICTING", checkState: "FAILURE" })]);
    const gh = await fakeGh(`
if (args.some(a => a.includes('ScopeOpenPullRequests'))) {
  console.log(JSON.stringify(args.includes('cursor=inventory-two') ? ${JSON.stringify(second)} : ${JSON.stringify(first)}));
} else if (args.includes('number=1')) {
  console.log(JSON.stringify(args.includes('cursor=threads-two') ? ${JSON.stringify(threads(1, [false]))} : ${JSON.stringify(threads(1, [true], { hasNextPage: true, endCursor: "threads-two" }))}));
} else console.log(JSON.stringify(${JSON.stringify(threads(2, [true]))}));`);
    const result = await new GitHubPullRequests(gh.process).inventory(repository, signal());
    expect(result.viewer).toBe("viewer");
    expect(result.prs.map((row) => row.number)).toEqual([1, 2]);
    expect(result.prs[0]).toMatchObject({
      draft: true,
      additions: 0,
      merge: { status: "clear" },
      checks: { status: "unknown", headOid: oldHead },
      hasUnresolvedConversations: true,
    });
    expect(result.prs[1]).toMatchObject({
      merge: { status: "conflicting" },
      checks: { status: "failing" },
      hasUnresolvedConversations: false,
    });
    const calls = await gh.calls();
    expect(calls).toHaveLength(5);
    expect(
      calls.every((args) => args.slice(0, 4).join(" ") === "api graphql --hostname github.com"),
    ).toBe(true);
    expect(calls[0].find((arg) => arg.startsWith("query="))).toContain("states: OPEN");
    expect(calls[0]).toContain("owner=example");
    expect(calls[0]).toContain("name=project");
  });

  test("unavailable thread data stays unknown while complete current inventory survives", async () => {
    const gh = await fakeGh(
      `if(args.some(a => a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))})); else { console.error('permission denied GH_TOKEN=secret'); process.exit(1); }`,
    );
    const result = await new GitHubPullRequests(gh.process).inventory(repository, signal());
    expect(result.prs[0].hasUnresolvedConversations).toBeNull();
    expect(result.prs[0].checks.status).toBe("passing");
  });

  test("observed unresolved threads remain true if a later thread page fails", async () => {
    const gh = await fakeGh(
      `if(args.some(a => a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))})); else if(args.includes('cursor=fail')) process.exit(1); else console.log(JSON.stringify(${JSON.stringify(threads(1, [false], { hasNextPage: true, endCursor: "fail" }))}));`,
    );
    expect(
      (await new GitHubPullRequests(gh.process).inventory(repository, signal())).prs[0]
        .hasUnresolvedConversations,
    ).toBe(true);
  });

  test("retains teams and users across complete label and reviewer pages", async () => {
    const row = pr(1);
    row.labels.pageInfo = { hasNextPage: true, endCursor: "labels-two" };
    row.reviewRequests.pageInfo = { hasNextPage: true, endCursor: "reviewers-two" };
    row.reviewRequests.nodes.push({
      requestedReviewer: { slug: "security", organization: { login: "example" } },
    });
    const gh = await fakeGh(`
if(args.some(a => a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([row]))}));
else if(args.some(a => a.includes('ScopePullRequestLabels'))) console.log(JSON.stringify({data:{repository:{pullRequest:{id:'PR_1',labels:{nodes:[{name:'later-label'}],pageInfo:${JSON.stringify(complete)}}}}}}));
else if(args.some(a => a.includes('ScopePullRequestReviewers'))) console.log(JSON.stringify({data:{repository:{pullRequest:{id:'PR_1',reviewRequests:{nodes:[{requestedReviewer:{login:'later-reviewer'}},{requestedReviewer:{slug:'maintainers',organization:{login:'another-org'}}}],pageInfo:${JSON.stringify(complete)}}}}}}));
else console.log(JSON.stringify(${JSON.stringify(threads(1, []))}));`);
    const result = await new GitHubPullRequests(gh.process).inventory(repository, signal());
    expect(result.prs[0].labels).toEqual(["bug", "later-label"]);
    expect(result.prs[0].requestedReviewers).toEqual([
      "reviewer",
      "example/security",
      "later-reviewer",
      "another-org/maintainers",
    ]);
    const calls = await gh.calls();
    expect(calls).toHaveLength(4);
    for (const args of calls.filter((args) =>
      args.some(
        (arg) => arg.includes("ScopeOpenPullRequests") || arg.includes("ScopePullRequestReviewers"),
      ),
    ))
      expect(args.find((arg) => arg.startsWith("query="))).toContain(
        "... on Team { slug organization { login } }",
      );
  });

  test("head movement while reading threads makes CI and merge status unknown", async () => {
    const moved = threads(1, [false]);
    moved.data.repository.pullRequest.headRefOid = oldHead;
    const gh = await fakeGh(
      `if(args.some(a => a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([pr(1, { mergeable: "MERGEABLE" })]))})); else console.log(JSON.stringify(${JSON.stringify(moved)}));`,
    );
    const result = await new GitHubPullRequests(gh.process).inventory(repository, signal());
    expect(result.prs[0]).toMatchObject({
      merge: { status: "unknown" },
      checks: { status: "unknown" },
      hasUnresolvedConversations: true,
    });
  });

  test.each([
    ["invalid JSON", "console.log('{')"],
    [
      "GraphQL errors with HTTP success",
      "console.log(JSON.stringify({data:{},errors:[{message:'secret'}]}))",
    ],
    [
      "failed page",
      `if(args.includes('cursor=two')) process.exit(1); else console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)], { hasNextPage: true, endCursor: "two" }))}));`,
    ],
    [
      "repeated cursor",
      `console.log(JSON.stringify(${JSON.stringify(inventory([], { hasNextPage: true, endCursor: "again" }))}));`,
    ],
  ])("rejects %s rather than returning a partial list", async (_label, handler) => {
    const gh = await fakeGh(handler);
    await expect(
      new GitHubPullRequests(gh.process).inventory(repository, signal()),
    ).rejects.toThrow();
  });

  test("rejects repository values before invoking the executable", async () => {
    const gh = await fakeGh("throw new Error('should not run')");
    await expect(
      new GitHubPullRequests(gh.process).inventory(
        { owner: "--query=mutation", name: "project" },
        signal(),
      ),
    ).rejects.toThrow("invalid data");
    await expect(gh.calls()).rejects.toThrow();
  });

  test("reads ordinary REST detail responses with extra fields through GitHub.com despite GH_HOST", async () => {
    const view = { id: "PR_1", state: "OPEN", headRefOid: head, body: "Review this change" };
    const gh = await fakeGh(`
if(process.env.GH_HOST !== 'github.example.com') throw new Error('Expected non-default host');
if(args[0] === 'pr' && !args.includes('github.com/example/project')) throw new Error('Wrong host');
if(args.some(a => a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))}));
else if(args[0] === 'pr' && args[1] === 'view') console.log(JSON.stringify(${JSON.stringify(view)}));
else if(args[0] === 'pr' && args[1] === 'diff') console.log('diff --git a/test b/test');
else if(args.some(a => a.includes('/files?'))) console.log(JSON.stringify([{sha:'${head}',filename:'test.ts',additions:0,deletions:0,changes:0,status:'modified',blob_url:'https://github.com/example/project/blob/${head}/test.ts',raw_url:'https://github.com/example/project/raw/${head}/test.ts',contents_url:'https://api.github.com/repos/example/project/contents/test.ts',patch:'@@ -1 +1 @@'}]));
else if(args.some(a => a.includes('/reviews?'))) console.log(JSON.stringify([{id:2,node_id:'REVIEW_2',user:{login:'reviewer',id:7,node_id:'USER_7',avatar_url:'https://avatars.githubusercontent.com/u/7',type:'User',site_admin:false},state:'APPROVED',body:'Looks good',submitted_at:'2026-10-01T12:00:00Z',commit_id:'${head}',html_url:'https://github.com/example/project/pull/1#pullrequestreview-2',pull_request_url:'https://api.github.com/repos/example/project/pulls/1',author_association:'MEMBER',_links:{html:{href:'https://github.com/example/project/pull/1#pullrequestreview-2'}}}]));
else console.log(JSON.stringify(${JSON.stringify(threads(1, []))}));`);
    const previousHost = process.env.GH_HOST;
    process.env.GH_HOST = "github.example.com";
    try {
      const service = new GitHubPullRequests(gh.process);
      const current = (await service.inventory(repository, signal())).prs[0];
      const detail = await service.detail(repository, current, signal());
      expect(detail).toMatchObject({
        headOid: head,
        body: "Review this change",
        files: [{ path: "test.ts" }],
        reviews: [{ author: "reviewer", headOid: head }],
      });
      expect(detail.diff).toContain("diff --git");
      const calls = await gh.calls();
      expect(calls.filter((args) => args[1] === "view")).toHaveLength(2);
      expect(calls.find((args) => args[1] === "diff")).toEqual([
        "pr",
        "diff",
        "1",
        "--repo",
        "github.com/example/project",
        "--color",
        "never",
      ]);
    } finally {
      if (previousHost === undefined) delete process.env.GH_HOST;
      else process.env.GH_HOST = previousHost;
    }
  });

  test("refuses detail when the head changes during diff collection", async () => {
    const view = { id: "PR_1", state: "OPEN", headRefOid: head, body: "Original" };
    const gh = await fakeGh(`
import { existsSync, writeFileSync } from 'node:fs';
const marker = process.argv[1] + '.viewed';
if(args.some(a => a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))}));
else if(args[1] === 'view') { const moved = existsSync(marker); writeFileSync(marker, 'yes'); console.log(JSON.stringify({...${JSON.stringify(view)},headRefOid:moved?'${oldHead}':'${head}'})); }
else if(args[1] === 'diff') console.log('diff --git a/test b/test');
else if(args.some(a => a.includes('/files?'))) console.log(JSON.stringify([{filename:'test',additions:0,deletions:0,status:'modified'}]));
else if(args.some(a => a.includes('/reviews?'))) console.log('[]');
else console.log(JSON.stringify(${JSON.stringify(threads(1, []))}));`);
    const service = new GitHubPullRequests(gh.process);
    const current = (await service.inventory(repository, signal())).prs[0];
    await expect(service.detail(repository, current, signal())).rejects.toThrow(
      "changed while loading",
    );
  });
});

describe("GitHub process failures", () => {
  test("does not return CLI stderr containing credentials", async () => {
    const gh = await fakeGh("console.error('HTTP 401 GH_TOKEN=super-secret'); process.exit(1)");
    await expect(gh.process.run([], signal())).rejects.toThrow("Sign in with gh auth login");
  });

  test("reports a missing executable", async () => {
    await expect(
      new GitHubProcess("/does-not-exist/scope-fake-gh").run([], signal()),
    ).rejects.toThrow("Install GitHub CLI");
  });

  test("rejects excess output rather than truncating successful JSON", async () => {
    const gh = await fakeGh("console.log('x'.repeat(10000))", { maxBytes: 128 });
    await expect(gh.process.run([], signal())).rejects.toThrow("too much data");
  });

  test("terminates a timed out child", async () => {
    const gh = await fakeGh("setInterval(() => {}, 1000)", { timeoutMs: 100 });
    await expect(gh.process.run([], signal())).rejects.toThrow("did not respond in time");
  });

  test("terminates a cancelled child", async () => {
    const gh = await fakeGh("setInterval(() => {}, 1000)");
    const controller = new AbortController();
    const running = gh.process.run([], controller.signal);
    controller.abort();
    await expect(running).rejects.toThrow("cancelled");
  });
});

async function inboxFixture(gh: GitHubProcess) {
  const directory = await mkdtemp(join(tmpdir(), "scope-pr-sync-"));
  directories.push(directory);
  const token = "synthetic-pull-request-sync-token";
  const server = await startArtifactServer({ directory, token, port: 0 });
  const client = new ScopeClient(server.url, token);
  const service = new PullRequestSync(server.store.pullRequests, new GitHubPullRequests(gh));
  server.store.pullRequests.setHandlers({
    sync: (tabId) => service.sync(tabId),
    detail: (tabId, nodeId) => service.detail(tabId, nodeId),
  });
  async function publish() {
    await client.publish(
      randomUUID(),
      {
        name: "test-inbox",
        title: "Test inbox",
        kind: "pull-requests",
        mediaType: "text/html",
        fileName: "inbox.html",
        expectedRevision: 0,
      },
      Buffer.from("<h1>Inbox</h1>"),
    );
    await server.store.pullRequests.command({
      action: "configure",
      tabId: (await server.store.pullRequests.snapshot("test-inbox")).tabId,
      name: "test-inbox",
      requestId: randomUUID(),
      repository,
    });
    return server.store.pullRequests.snapshot("test-inbox");
  }
  const snapshot = await publish();
  await server.store.openTab({
    id: snapshot.tabId,
    type: "file",
    title: snapshot.artifact.title,
    groupId: randomUUID(),
    state: { version: 1, data: { artifactId: snapshot.artifact.id } },
  });
  return {
    directory,
    server,
    service,
    snapshot,
    publish,
    command: async (value: unknown) => {
      const response = await fetch(`${server.url}/v1/pull-requests`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(value),
      });
      expect(response.ok).toBe(true);
      return decode(PullRequestsReply, await response.json());
    },
    close: async () => {
      service.cancelPending();
      await server.close();
    },
  };
}

async function waitForCalls(gh: Awaited<ReturnType<typeof fakeGh>>, count: number) {
  await expect
    .poll(async () => {
      try {
        return (await gh.calls()).length;
      } catch {
        return 0;
      }
    })
    .toBeGreaterThanOrEqual(count);
}

describe("tab-owned GitHub synchronization", () => {
  test("coalesces sync commands through HTTP and preserves newer local edits during refresh", async () => {
    const gh = await fakeGh(
      `if(args.some(a => a.includes('ScopeOpenPullRequests'))) { setTimeout(() => console.log(JSON.stringify(${JSON.stringify(inventory([pr(1, { draft: true })]))})), 150); } else console.log(JSON.stringify(${JSON.stringify(threads(1, []))}));`,
    );
    const f = await inboxFixture(gh.process);
    try {
      await f.service.sync(f.snapshot.tabId);
      const refresh = f.command({
        action: "sync",
        name: "test-inbox",
        tabId: f.snapshot.tabId,
        requestId: randomUUID(),
      });
      const joined = f.command({
        action: "sync",
        name: "test-inbox",
        tabId: f.snapshot.tabId,
        requestId: randomUUID(),
      });
      await waitForCalls(gh, 3);
      await f.server.store.pullRequests.command({
        action: "note",
        name: "test-inbox",
        tabId: f.snapshot.tabId,
        requestId: randomUUID(),
        nodeId: "PR_1",
        expectedVersion: 0,
        text: "Keep this note",
      });
      await f.server.store.pullRequests.command({
        action: "snooze",
        name: "test-inbox",
        tabId: f.snapshot.tabId,
        requestId: randomUUID(),
        nodeId: "PR_1",
        expectedVersion: 0,
        snooze: { until: "2026-10-02T12:00:00Z", wakeOnNewCommit: true, headOid: head },
      });
      const [a, b] = await Promise.all([refresh, joined]);
      expect(a).toEqual(b);
      if (a.type !== "snapshot") throw new Error("Expected snapshot");
      expect(a.snapshot.prs[0]).toMatchObject({
        draft: true,
        local: {
          note: "Keep this note",
          noteVersion: 1,
          snoozeVersion: 1,
          snooze: { until: "2026-10-02T12:00:00Z" },
        },
      });
      expect(await gh.calls()).toHaveLength(4);
    } finally {
      await f.close();
    }
  });

  test("failed complete inventory preserves the cache and an empty complete inventory prunes local state", async () => {
    const gh = await fakeGh(
      `if(args.some(a => a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))})); else console.log(JSON.stringify(${JSON.stringify(threads(1, []))}));`,
    );
    const failed = await fakeGh("console.log(JSON.stringify({errors:[{message:'unavailable'}]}))");
    const empty = await fakeGh(`console.log(JSON.stringify(${JSON.stringify(inventory([]))}));`);
    const f = await inboxFixture(gh.process);
    try {
      await f.service.sync(f.snapshot.tabId);
      await f.server.store.pullRequests.command({
        action: "note",
        name: "test-inbox",
        tabId: f.snapshot.tabId,
        requestId: randomUUID(),
        nodeId: "PR_1",
        expectedVersion: 0,
        text: "Saved note",
      });
      const failure = await new PullRequestSync(
        f.server.store.pullRequests,
        new GitHubPullRequests(failed.process),
      ).sync(f.snapshot.tabId);
      expect(failure.sync.state).toBe("error");
      expect(failure.sync.lastSuccessAt).not.toBeNull();
      expect(failure.prs[0].local.note).toBe("Saved note");
      expect(failure.prs[0].headOid).toBe(head);
      const completeEmpty = await new PullRequestSync(
        f.server.store.pullRequests,
        new GitHubPullRequests(empty.process),
      ).sync(f.snapshot.tabId);
      expect(completeEmpty.prs).toEqual([]);
      expect(completeEmpty.sync).toMatchObject({ state: "idle", error: null });
      await f.service.sync(f.snapshot.tabId);
      expect(
        (await f.server.store.pullRequests.snapshotByTab(f.snapshot.tabId)).prs[0].local.note,
      ).toBe("");
    } finally {
      await f.close();
    }
  });

  test("a delayed refresh cannot revive a deleted tab or write into a reused name", async () => {
    const gh = await fakeGh(
      `if(args.some(a => a.includes('ScopeOpenPullRequests'))) setTimeout(() => console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))})), 150); else console.log(JSON.stringify(${JSON.stringify(threads(1, []))}));`,
    );
    const f = await inboxFixture(gh.process);
    try {
      const refreshing = f.service.sync(f.snapshot.tabId).catch(() => null);
      await waitForCalls(gh, 1);
      await f.server.store.removeArtifact(f.snapshot.artifact.id);
      const replacement = await f.publish();
      expect(replacement.tabId).not.toBe(f.snapshot.tabId);
      expect(await refreshing).toBeNull();
      const current = await f.server.store.pullRequests.snapshot("test-inbox");
      expect(current.prs).toEqual([]);
      expect(current.sync.state).toBe("idle");
    } finally {
      await f.close();
    }
  });

  test("cancellation clears retained sync status while keeping the cache across restart", async () => {
    const gh = await fakeGh(
      `if(args.some(a => a.includes('ScopeOpenPullRequests'))) setTimeout(() => console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))})), 150); else console.log(JSON.stringify(${JSON.stringify(threads(1, []))}));`,
    );
    const f = await inboxFixture(gh.process);
    let closed = false;
    try {
      const seeded = await f.service.sync(f.snapshot.tabId);
      await f.server.store.pullRequests.command({
        action: "note",
        name: "test-inbox",
        tabId: f.snapshot.tabId,
        requestId: randomUUID(),
        nodeId: "PR_1",
        expectedVersion: 0,
        text: "Retained note",
      });
      const refreshing = f.service.sync(f.snapshot.tabId).catch(() => null);
      await waitForCalls(gh, 3);
      await f.server.store.trashTab(f.snapshot.tabId);
      f.service.cancelTabs([f.snapshot.tabId]);
      expect(await refreshing).toBeNull();
      const cancelled = await f.server.store.pullRequests.snapshotByTab(f.snapshot.tabId);
      expect(cancelled.sync).toMatchObject({
        state: "idle",
        lastSuccessAt: seeded.sync.lastSuccessAt,
        error: null,
      });
      expect(cancelled.prs[0].local.note).toBe("Retained note");
      await f.server.store.restoreTab(f.snapshot.tabId);
      await f.close();
      closed = true;
      const reopened = await ArtifactStore.open(f.directory);
      try {
        const saved = await reopened.pullRequests.snapshotByTab(f.snapshot.tabId);
        expect(saved.sync.state).toBe("idle");
        expect(saved.prs[0].local.note).toBe("Retained note");
      } finally {
        await reopened.close();
      }
    } finally {
      if (!closed) await f.close();
    }
  });

  test("startup recovers an interrupted sync for active and trashed owners without losing cache", async () => {
    const gh = await fakeGh(
      `if(args.some(a => a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))})); else console.log(JSON.stringify(${JSON.stringify(threads(1, []))}));`,
    );
    const f = await inboxFixture(gh.process);
    let closed = false;
    try {
      const seeded = await f.service.sync(f.snapshot.tabId);
      await f.server.store.pullRequests.setSyncStatus(f.snapshot.tabId, {
        ...seeded.sync,
        state: "syncing",
        updatedAt: "2026-10-01T12:00:00Z",
      });
      await f.server.store.trashTab(f.snapshot.tabId);
      await f.close();
      closed = true;
      let reopened = await ArtifactStore.open(f.directory);
      try {
        const recovered = await reopened.pullRequests.snapshotByTab(f.snapshot.tabId);
        expect(recovered.sync).toMatchObject({
          state: "error",
          lastSuccessAt: seeded.sync.lastSuccessAt,
          error: "GitHub refresh was interrupted. Try Sync again.",
        });
        expect(recovered.prs).toEqual(seeded.prs);
        await reopened.restoreTab(f.snapshot.tabId);
        await reopened.pullRequests.setSyncStatus(f.snapshot.tabId, {
          ...seeded.sync,
          state: "syncing",
          updatedAt: "2026-10-01T12:00:00Z",
        });
      } finally {
        await reopened.close();
      }
      reopened = await ArtifactStore.open(f.directory);
      try {
        const recovered = await reopened.pullRequests.snapshotByTab(f.snapshot.tabId);
        expect(recovered.sync.state).toBe("error");
        expect(recovered.prs).toEqual(seeded.prs);
      } finally {
        await reopened.close();
      }
    } finally {
      if (!closed) await f.close();
    }
  });

  test("delayed cancellation cleanup cannot clear a newer run's status", async () => {
    const gh = await fakeGh(
      `import { existsSync } from 'node:fs';
if(args.some(a => a.includes('ScopeOpenPullRequests'))) {
  const timer = setInterval(() => { if(existsSync(process.argv[1] + '.release')) { clearInterval(timer); console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))})); } }, 10);
} else console.log(JSON.stringify(${JSON.stringify(threads(1, []))}));`,
    );
    const f = await inboxFixture(gh.process);
    const cancelSync = f.server.store.pullRequests.cancelSync.bind(f.server.store.pullRequests);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    const cleanupEntered = new Promise<void>((done) => {
      entered = done;
    });
    f.server.store.pullRequests.cancelSync = async (tabId, stamp) => {
      entered();
      await waiting;
      return cancelSync(tabId, stamp);
    };
    try {
      const cancelled = f.service.sync(f.snapshot.tabId).catch(() => null);
      await waitForCalls(gh, 1);
      const oldStatus = await f.server.store.pullRequests.snapshotByTab(f.snapshot.tabId);
      f.service.cancelTabs([f.snapshot.tabId]);
      await cleanupEntered;
      const refreshing = f.service.sync(f.snapshot.tabId);
      await waitForCalls(gh, 2);
      const newer = await f.server.store.pullRequests.snapshotByTab(f.snapshot.tabId);
      expect(newer.sync.state).toBe("syncing");
      expect(newer.sync.updatedAt).not.toBe(oldStatus.sync.updatedAt);
      release();
      expect(await cancelled).toBeNull();
      const afterCleanup = await f.server.store.pullRequests.snapshotByTab(f.snapshot.tabId);
      expect(afterCleanup.sync).toEqual(newer.sync);
      expect(afterCleanup.generation).toBe(newer.generation);
      await gh.release();
      expect((await refreshing).sync.state).toBe("idle");
      await cancelSync(f.snapshot.tabId, oldStatus.sync.updatedAt!);
      expect((await f.server.store.pullRequests.snapshotByTab(f.snapshot.tabId)).sync.state).toBe(
        "idle",
      );
      await cancelSync(randomUUID(), oldStatus.sync.updatedAt!);
    } finally {
      release();
      await gh.release();
      f.server.store.pullRequests.cancelSync = cancelSync;
      await f.close();
    }
  });
});
