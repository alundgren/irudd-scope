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
const complete: { hasNextPage: boolean; endCursor: string | null } = {
  hasNextPage: false,
  endCursor: null,
};
function pr(
  number: number,
  options: { draft?: boolean; mergeable?: string; checkHead?: string; checkState?: string } = {},
) {
  return {
    state: "OPEN",
    reviewThreads: { nodes: [] as { isResolved: boolean }[], pageInfo: complete },
    id: `PR_${number}`,
    repository: { id: "R_PROJECT" },
    number,
    title: `Pull request ${number}`,
    author: { login: "author" },
    labels: { nodes: [{ name: "bug" }], pageInfo: complete },
    headRefOid: head,
    headRefName: "feature",
    baseRefOid: base,
    stack: null,
    stackEntry: null,
    reviewDecision: null,
    latestOpinionatedReviews: { totalCount: 0, nodes: [], pageInfo: complete },
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
function inventory(
  nodes: ReturnType<typeof pr>[],
  pageInfo = complete,
  resolved = repository,
  id = "R_PROJECT",
) {
  return {
    data: {
      viewer: { login: "viewer" },
      rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-10-03T00:00:00Z" },
      repository: {
        id,
        owner: { login: resolved.owner },
        name: resolved.name,
        nameWithOwner: `${resolved.owner}/${resolved.name}`,
        pullRequests: { nodes, pageInfo },
      },
    },
  };
}
function enrichment(nodes: ReturnType<typeof pr>[]) {
  const page = inventory(nodes);
  return {
    data: {
      viewer: page.data.viewer,
      rateLimit: page.data.rateLimit,
      nodes: nodes.map((node) => ({ ...node, repository: page.data.repository })),
    },
  };
}
const signal = () => new AbortController().signal;

describe("GitHub process failures", () => {
  test("does not return CLI stderr containing credentials", async () => {
    const gh = await fakeGh("console.error('HTTP 401 GH_TOKEN=super-secret'); process.exit(1)");
    await expect(gh.process.run([], signal())).rejects.toThrow("Sign in with gh auth login");
  });
});

async function inboxFixture(gh: GitHubProcess, configuredRepository = repository) {
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
      repository: configuredRepository,
    });
    return server.store.pullRequests.snapshot("test-inbox");
  }
  const snapshot = await publish();
  await server.store.openTab({
    id: snapshot.tabId,
    type: "pull-requests",
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

describe("tab-owned GitHub synchronization", () => {
  test("startup recovers an interrupted sync without losing cache", async () => {
    const gh = await fakeGh(
      `if(args.some(a => (a.includes('ScopeOpenPullRequests') || a.includes('ScopeInitialOpenPullRequests')))) console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))})); else if(args.some(a=>a.includes('ScopeEnrichPullRequests'))) console.log(JSON.stringify(${JSON.stringify(enrichment([pr(1)]))}));else throw new Error('Unexpected query');`,
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
});
