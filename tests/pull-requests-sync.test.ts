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
function threads(number: number, resolved: boolean[], pageInfo = complete) {
  return {
    data: {
      viewer: { login: "viewer" },
      rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2026-10-03T00:00:00Z" },
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
  test("resolves an alias from one verified repository identity across every open page", async () => {
    const first = inventory([pr(1)], { hasNextPage: true, endCursor: "two" });
    const second = inventory([pr(2)]);
    const gh = await fakeGh(
      `if(args.some(a=>a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(args.includes('cursor=two')?${JSON.stringify(second)}:${JSON.stringify(first)}));else console.log(JSON.stringify(args.includes('number=1')?${JSON.stringify(threads(1, []))}:${JSON.stringify(threads(2, []))}));`,
    );
    const alias = { owner: "previous-owner", name: "previous-project" };
    const result = await new GitHubPullRequests(gh.process).inventory(alias, signal());
    expect(result).toMatchObject({ queriedRepository: alias, repository, viewer: "viewer" });
    expect(result.prs.map((row) => row.number)).toEqual([1, 2]);
    expect((await gh.calls()).every((args) => args.includes("owner=previous-owner"))).toBe(true);
  });

  test.each(["node identity", "canonical path", "nameWithOwner", "PR repository", "PR URL"])(
    "rejects inconsistent %s rather than returning an inventory",
    async (failure) => {
      const first = inventory([pr(1)], { hasNextPage: true, endCursor: "two" });
      const second = inventory([pr(2)]);
      if (failure === "node identity") second.data.repository.id = "R_OTHER";
      if (failure === "canonical path") {
        second.data.repository.owner.login = "other";
        second.data.repository.nameWithOwner = "other/project";
      }
      if (failure === "nameWithOwner") second.data.repository.nameWithOwner = "other/project";
      if (failure === "PR repository")
        second.data.repository.pullRequests.nodes[0].repository.id = "R_OTHER";
      if (failure === "PR URL")
        second.data.repository.pullRequests.nodes[0].url =
          "https://github.com/other/project/pull/2";
      const gh = await fakeGh(
        `console.log(JSON.stringify(args.includes('cursor=two')?${JSON.stringify(second)}:${JSON.stringify(first)}));`,
      );
      await expect(
        new GitHubPullRequests(gh.process).inventory(repository, signal()),
      ).rejects.toThrow(/repository/);
    },
  );

  test("reads all open pages including drafts and later unresolved threads with head-bound checks", async () => {
    const first = inventory([pr(1, { draft: true, mergeable: "MERGEABLE", checkHead: oldHead })], {
      hasNextPage: true,
      endCursor: "inventory-two",
    });
    first.data.repository.pullRequests.nodes[0].reviewThreads = {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "threads-two" },
    };
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
    expect(calls).toHaveLength(3);
    expect(
      calls.every(
        (args) => args.slice(0, 5).join(" ") === "api graphql --include --hostname github.com",
      ),
    ).toBe(true);
    expect(calls[0].find((arg) => arg.startsWith("query="))).toContain("states: OPEN");
    expect(calls[0]).toContain("owner=example");
    expect(calls[0]).toContain("name=project");
  });

  test("unavailable thread data stays unknown while complete current inventory survives", async () => {
    const row = pr(1, { mergeable: "MERGEABLE" });
    row.reviewThreads = { nodes: [], pageInfo: { hasNextPage: true, endCursor: "fail" } };
    const gh = await fakeGh(
      `if(args.some(a => a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([row]))})); else { console.error('permission denied GH_TOKEN=secret'); process.exit(1); }`,
    );
    const result = await new GitHubPullRequests(gh.process).inventory(repository, signal());
    expect(result.prs[0].hasUnresolvedConversations).toBeNull();
    expect(result.prs[0].checks.status).toBe("passing");
  });

  test("observed unresolved threads remain true if a later thread page fails", async () => {
    const row = pr(1, { mergeable: "MERGEABLE" });
    row.reviewThreads = {
      nodes: [{ isResolved: false }],
      pageInfo: { hasNextPage: true, endCursor: "fail" },
    };
    const gh = await fakeGh(
      `if(args.some(a => a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([row]))})); else if(args.includes('cursor=fail')) process.exit(1); else console.log(JSON.stringify(${JSON.stringify(threads(1, [false], { hasNextPage: true, endCursor: "fail" }))}));`,
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
else if(args.some(a => a.includes('ScopePullRequestLabels'))) console.log(JSON.stringify({data:{viewer:{login:'viewer'},rateLimit:{cost:1,limit:5000,remaining:4999,resetAt:'2026-10-03T00:00:00Z'},repository:{nameWithOwner:'example/project',pullRequest:{id:'PR_1',labels:{nodes:[{name:'later-label'}],pageInfo:${JSON.stringify(complete)}}}}}}));
else if(args.some(a => a.includes('ScopePullRequestReviewers'))) console.log(JSON.stringify({data:{viewer:{login:'viewer'},rateLimit:{cost:1,limit:5000,remaining:4999,resetAt:'2026-10-03T00:00:00Z'},repository:{nameWithOwner:'example/project',pullRequest:{id:'PR_1',reviewRequests:{nodes:[{requestedReviewer:{login:'later-reviewer'}},{requestedReviewer:{slug:'maintainers',organization:{login:'another-org'}}}],pageInfo:${JSON.stringify(complete)}}}}}}));
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
    expect(calls).toHaveLength(3);
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
    const row = pr(1, { mergeable: "MERGEABLE" });
    row.reviewThreads = { nodes: [], pageInfo: { hasNextPage: true, endCursor: "fail" } };
    const gh = await fakeGh(
      `if(args.some(a => a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([row]))})); else console.log(JSON.stringify(${JSON.stringify(moved)}));`,
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
    ["null JSON", "console.log('null')"],
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
    const view = {
      id: "PR_1",
      state: "OPEN",
      headRefOid: head,
      baseRefOid: base,
      body: "Review this change",
    };
    const gh = await fakeGh(`
if(process.env.GH_HOST !== 'github.example.com') throw new Error('Expected non-default host');
if(args[0] === 'pr' && !args.includes('github.com/example/project')) throw new Error('Wrong host');
if(args.some(a => a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))}));
else if(args.some(a=>a.includes('ScopePullRequestReviewBody'))) console.log(JSON.stringify({data:{viewer:{login:"viewer"},rateLimit:{cost:1,limit:5000,remaining:4999,resetAt:"2026-10-03T00:00:00Z"},repository:{nameWithOwner:'example/project',pullRequest:${JSON.stringify(view)}}}}));
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
      expect(
        calls.filter((args) => args.some((a) => a.includes("ScopePullRequestReviewBody"))),
      ).toHaveLength(2);
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

  test.each(["head", "base"])(
    "refuses detail when the %s changes during diff collection",
    async (commit) => {
      const view = {
        id: "PR_1",
        state: "OPEN",
        headRefOid: head,
        baseRefOid: base,
        body: "Original",
      };
      const gh = await fakeGh(`
import { existsSync, writeFileSync } from 'node:fs';
const marker = process.argv[1] + '.viewed';
if(args.some(a => a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))}));
else if(args.some(a=>a.includes('ScopePullRequestReviewBody'))) { const moved = existsSync(marker); writeFileSync(marker, 'yes'); console.log(JSON.stringify({data:{viewer:{login:'viewer'},rateLimit:{cost:1,limit:5000,remaining:4999,resetAt:'2026-10-03T00:00:00Z'},repository:{nameWithOwner:'example/project',pullRequest:{...${JSON.stringify(view)},headRefOid:moved && '${commit}'==='head'?'${oldHead}':'${head}',baseRefOid:moved && '${commit}'==='base'?'${oldHead}':'${base}'}}}})); }
else if(args[1] === 'diff') console.log('diff --git a/test b/test');
else if(args.some(a => a.includes('/files?'))) console.log(JSON.stringify([{filename:'test',additions:0,deletions:0,status:'modified'}]));
else if(args.some(a => a.includes('/reviews?'))) console.log('[]');
else console.log(JSON.stringify(${JSON.stringify(threads(1, []))}));`);
      const service = new GitHubPullRequests(gh.process);
      const current = (await service.inventory(repository, signal())).prs[0];
      await expect(service.detail(repository, current, signal())).rejects.toThrow(
        "changed while loading",
      );
    },
  );
});

describe("batched and targeted GitHub reads", () => {
  test.each([1051, 2526])(
    "reads every one of %i PRs in bounded pages without first-thread subprocesses",
    async (count) => {
      const gh = await fakeGh(`
const query = args.find(a=>a.startsWith('query='));
if(!query.includes('pullRequests(states: OPEN, first: 25') || !query.includes('reviewThreads(first: 100)') || !query.includes('rateLimit { cost limit remaining resetAt }')) throw new Error('Missing bounded query');
const offset = Number(args.find(a=>a.startsWith('cursor='))?.slice(7) ?? 0);
const rows = Array.from({length:Math.min(25,${count}-offset)},(_,i)=>({...${JSON.stringify(pr(1))},id:'PR_'+(offset+i+1),number:offset+i+1,url:'https://github.com/example/project/pull/'+(offset+i+1)}));
console.log(JSON.stringify({...${JSON.stringify(inventory([]))},data:{...${JSON.stringify(inventory([]).data)},repository:{...${JSON.stringify(inventory([]).data.repository)},pullRequests:{nodes:rows,pageInfo:{hasNextPage:offset+25<${count},endCursor:String(offset+25)}}}}}));`);
      const result = await new GitHubPullRequests(gh.process).inventory(repository, signal());
      expect(result.prs).toHaveLength(count);
      expect(result.prs.at(-1)?.number).toBe(count);
      expect(result.prs.every((row) => row.hasUnresolvedConversations === false)).toBe(true);
      expect(result.cost).toBe(Math.ceil(count / 25));
      expect(await gh.calls()).toHaveLength(Math.ceil(count / 25));
    },
  );

  test("current reads see reopened conversations without updatedAt changing and only remove explicitly closed PRs", async () => {
    const row = pr(1);
    const initial = inventory([row]);
    const target = {
      data: {
        ...initial.data,
        repository: {
          ...initial.data.repository,
          pullRequest: {
            ...row,
            reviewThreads: { nodes: [{ isResolved: false }], pageInfo: complete },
          },
        },
      },
    };
    const gh = await fakeGh(`
if(args.some(a=>a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(initial)}));
else console.log(JSON.stringify(${JSON.stringify(target)}));`);
    const service = new GitHubPullRequests(gh.process);
    const first = (await service.inventory(repository, signal())).prs[0];
    const current = await service.current(repository, first, signal());
    expect(current?.updatedAt).toBe(first.updatedAt);
    expect(current?.hasUnresolvedConversations).toBe(true);
    expect(current!.merge.observedAt > first.merge.observedAt).toBe(true);
    expect(current?.checks.observedAt).toBe(current?.merge.observedAt);
    const closed = await fakeGh(
      `console.log(JSON.stringify(${JSON.stringify({ ...target, data: { ...target.data, repository: { ...target.data.repository, pullRequest: { ...target.data.repository.pullRequest, state: "CLOSED" } } } })}));`,
    );
    expect(
      await new GitHubPullRequests(closed.process).current(repository, first, signal()),
    ).toBeNull();
    const missing = await fakeGh(
      `console.log(JSON.stringify(${JSON.stringify({ ...target, data: { ...target.data, repository: { ...target.data.repository, pullRequest: null } } })}));`,
    );
    await expect(
      new GitHubPullRequests(missing.process).current(repository, first, signal()),
    ).rejects.toThrow("did not return");
  });

  test("queued inspected facts run between inventory pages and retain their later root timestamp", async () => {
    const row = pr(1);
    const first = inventory([row], { hasNextPage: true, endCursor: "page-two" });
    const target = {
      data: { ...first.data, repository: { ...first.data.repository, pullRequest: row } },
    };
    const gh = await fakeGh(`
import {existsSync} from 'node:fs';
if(args.some(a=>a.includes('ScopeCurrentPullRequest'))) console.log(JSON.stringify(${JSON.stringify(target)}));
else if(args.includes('cursor=page-two')) console.log(JSON.stringify(${JSON.stringify(inventory([pr(2)]))}));
else { const wait=setInterval(()=>{if(existsSync(process.argv[1]+'.release')){clearInterval(wait);console.log(JSON.stringify(${JSON.stringify(first)}));}},10); }`);
    const service = new GitHubPullRequests(gh.process);
    const cachedGh = await fakeGh(
      `console.log(JSON.stringify(${JSON.stringify(inventory([row]))}));`,
    );
    const cached = (await new GitHubPullRequests(cachedGh.process).inventory(repository, signal()))
      .prs[0];
    const pending = service.inventory(repository, signal());
    await waitForCalls(gh, 1);
    const inspected = service.current(repository, cached, signal());
    await gh.release();
    const [inventoryResult, current] = await Promise.all([pending, inspected]);
    expect(
      (await gh.calls()).map(
        (args) => args.find((a) => a.startsWith("query="))?.match(/query (\w+)/)?.[1],
      ),
    ).toEqual(["ScopeOpenPullRequests", "ScopeCurrentPullRequest", "ScopeOpenPullRequests"]);
    expect(current!.merge.observedAt > inventoryResult.prs[0].merge.observedAt).toBe(true);
  });

  test("an account change on thread overflow rejects inventory and reports its new account", async () => {
    const row = pr(1);
    row.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "overflow" };
    const overflow = threads(1, []);
    overflow.data.viewer.login = "different";
    const gh = await fakeGh(
      `console.log(JSON.stringify(args.some(a=>a.includes('ScopeOpenPullRequests'))?${JSON.stringify(inventory([row]))}:${JSON.stringify(overflow)}));`,
    );
    const observations: string[] = [];
    const service = new GitHubPullRequests(gh.process, (observation) =>
      observations.push(observation.account),
    );
    await expect(service.inventory(repository, signal())).rejects.toMatchObject({
      kind: "account",
      account: "different",
    });
    expect(observations).toEqual(["viewer", "different"]);
  });

  test("GraphQL success with throttling errors reaches the scheduler even during thread overflow", async () => {
    const row = pr(1);
    row.reviewThreads.pageInfo = { hasNextPage: true, endCursor: "overflow" };
    const failure = {
      data: {
        viewer: { login: "viewer" },
        rateLimit: { cost: 1, limit: 5000, remaining: 0, resetAt: "2099-10-02T00:00:00Z" },
      },
      errors: [{ type: "RATE_LIMITED", message: "rate limit secret GH_TOKEN=credential" }],
    };
    const gh = await fakeGh(
      `console.log(JSON.stringify(args.some(a=>a.includes('ScopeOpenPullRequests'))?${JSON.stringify(inventory([row]))}:${JSON.stringify(failure)}));`,
    );
    await expect(
      new GitHubPullRequests(gh.process).inventory(repository, signal()),
    ).rejects.toMatchObject({ kind: "throttle", retryAt: Date.parse("2099-10-02T00:00:00Z") });
  });

  test("nonzero GraphQL responses identify the account and exhausted quota before rejecting", async () => {
    const failure = {
      data: {
        viewer: { login: "new-viewer" },
        rateLimit: { cost: 1, limit: 5000, remaining: 0, resetAt: "2099-10-02T00:00:00Z" },
      },
      errors: [{ type: "RATE_LIMITED", message: "rate limit GH_TOKEN=secret" }],
    };
    const gh = await fakeGh(
      `console.log(JSON.stringify(${JSON.stringify(failure)})); console.error('gh: rate limit exceeded'); process.exit(1);`,
    );
    const observations: { account: string; remaining: number }[] = [];
    const service = new GitHubPullRequests(gh.process, (observation) =>
      observations.push(observation),
    );
    await expect(service.inventory(repository, signal())).rejects.toMatchObject({
      kind: "throttle",
      retryAt: Date.parse("2099-10-02T00:00:00Z"),
    });
    expect(observations).toEqual([
      expect.objectContaining({ account: "new-viewer", remaining: 0 }),
    ]);
    try {
      await gh.process.run([], signal());
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain("secret");
    }
  });

  test("reviews refresh after current commits move preserves each submitted commit without files or diff", async () => {
    const view = {
      id: "PR_1",
      state: "OPEN",
      headRefOid: oldHead,
      baseRefOid: oldHead,
      body: "Current body",
    };
    const gh = await fakeGh(`
if(args.some(a=>a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))}));
else if(args.some(a=>a.includes('ScopePullRequestReviewBody'))) console.log(JSON.stringify({data:{viewer:{login:'viewer'},rateLimit:{cost:1,limit:5000,remaining:4999,resetAt:'2099-10-02T00:00:00Z'},repository:{nameWithOwner:'example/project',pullRequest:${JSON.stringify(view)}}}}));
else if(args.some(a=>a.includes('/reviews?'))) console.log(JSON.stringify([{id:7,user:{login:'reviewer'},state:'APPROVED',body:'old commit approval',submitted_at:'2026-10-01T12:00:00Z',commit_id:'${head}'}]));
else throw new Error('Unexpected file or diff read');`);
    const service = new GitHubPullRequests(gh.process);
    const first = (await service.inventory(repository, signal())).prs[0];
    const result = await service.reviews(repository, first, signal());
    expect(result.body).toBe("Current body");
    expect(result.reviews[0].headOid).toBe(head);
    expect(
      (await gh.calls()).some(
        (args) => args.includes("diff") || args.some((a) => a.includes("/files?")),
      ),
    ).toBe(false);
  });
});

describe("GitHub process failures", () => {
  test("does not return CLI stderr containing credentials", async () => {
    const gh = await fakeGh("console.error('HTTP 401 GH_TOKEN=super-secret'); process.exit(1)");
    await expect(gh.process.run([], signal())).rejects.toThrow("Sign in with gh auth login");
  });

  test.each([
    ["HTTP/2 429\nRetry-After: 120\nGH_TOKEN=secret", "throttle"],
    ["HTTP/2 403\nx-ratelimit-remaining: 0\nx-ratelimit-reset: 4090000000", "throttle"],
    ["HTTP/2 403\npermission denied GH_TOKEN=secret", "permission"],
    ["HTTP/2 429\nRetry-After: invalid GH_TOKEN=secret", "throttle"],
    ["dial tcp: network timeout GH_TOKEN=secret", "network"],
  ])("classifies bounded diagnostics for %s", async (failure, kind) => {
    const gh = await fakeGh(`console.error(${JSON.stringify(failure)}); process.exit(1);`);
    try {
      await gh.process.run([], signal());
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toMatchObject({ kind });
      expect(JSON.stringify(error)).not.toContain("secret");
      if (kind === "throttle")
        expect((error as { retryAt: number }).retryAt).toBeGreaterThan(Date.now());
    }
  });

  test.each([
    [401, "auth"],
    [403, "permission"],
    [404, "permission"],
    [500, "network"],
  ])("ordinary rate headers preserve HTTP %i classification", async (status, kind) => {
    const gh = await fakeGh(
      `console.error('HTTP/2 ${status}\\nX-RateLimit-Limit: 5000\\nX-RateLimit-Remaining: 4999\\nX-RateLimit-Reset: 4090000000\\nordinary error'); process.exit(1);`,
    );
    await expect(gh.process.run([], signal())).rejects.toMatchObject({ kind });
  });

  test("secondary throttling honors Retry-After without waiting for a later primary reset", async () => {
    const gh = await fakeGh(
      `console.error('HTTP/2 403\\nRetry-After: 2\\nX-RateLimit-Remaining: 4999\\nX-RateLimit-Reset: 4090000000\\nsecondary rate limit'); process.exit(1);`,
    );
    const started = Date.now();
    try {
      await gh.process.run([], signal());
      throw new Error("Expected failure");
    } catch (error) {
      expect(error).toMatchObject({ kind: "throttle" });
      const retryAt = (error as { retryAt: number }).retryAt;
      expect(retryAt).toBeGreaterThanOrEqual(started + 2000);
      expect(retryAt).toBeLessThan(Date.now() + 3000);
    }
  });

  test("runs one subprocess at a time and gives queued inspected reads priority", async () => {
    const gh = await fakeGh(`
import {existsSync,writeFileSync,unlinkSync} from 'node:fs';
const lock = process.argv[1]+'.active';
if(existsSync(lock)) throw new Error('Concurrent subprocess');
writeFileSync(lock,'active');
setTimeout(()=>{unlinkSync(lock);console.log(args[0]);},100);`);
    const first = gh.process.run(["first"], signal());
    await waitForCalls(gh, 1);
    const inventoryPage = gh.process.run(["inventory"], signal(), 0);
    const inspected = gh.process.run(["current"], signal(), 1);
    expect(await Promise.all([first, inventoryPage, inspected])).toEqual([
      "first\n",
      "inventory\n",
      "current\n",
    ]);
    expect((await gh.calls()).map((args) => args[0])).toEqual(["first", "current", "inventory"]);
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
  test("first HTTP sync canonicalizes an alias and later sync preserves notes, review and agent fields", async () => {
    const alias = { owner: "previous-owner", name: "previous-project" };
    const gh = await fakeGh(
      `if(args.some(a=>a.includes('ScopeOpenPullRequests'))) console.log(JSON.stringify(${JSON.stringify(inventory([pr(1)]))}));else console.log(JSON.stringify(${JSON.stringify(threads(1, []))}));`,
    );
    const f = await inboxFixture(gh.process, alias);
    try {
      const first = await f.command({
        action: "sync",
        name: "test-inbox",
        tabId: f.snapshot.tabId,
        requestId: randomUUID(),
      });
      if (first.type !== "snapshot") throw new Error("Expected snapshot");
      expect(first.snapshot).toMatchObject({
        tabId: f.snapshot.tabId,
        repository,
        sync: { state: "idle" },
        prs: [{ nodeId: "PR_1" }],
      });
      expect(first.snapshot.sync.lastSuccessAt).not.toBeNull();
      for (const change of [
        { action: "note", text: "Keep canonical repository note" },
        { action: "review", baseline: "reviewed", headOid: head },
        {
          action: "snooze",
          snooze: { until: "2099-10-02T12:00:00Z", wakeOnNewCommit: false, headOid: head },
        },
        {
          action: "assessment",
          assessment: null,
          customFields: [{ key: "priority", type: "number", value: 2 }],
        },
      ])
        await f.command({
          ...change,
          name: "test-inbox",
          tabId: f.snapshot.tabId,
          requestId: randomUUID(),
          nodeId: "PR_1",
          expectedVersion: 0,
        });
      const before = await f.server.store.pullRequests.snapshot("test-inbox");
      const refreshed = await f.service.sync(f.snapshot.tabId);
      expect(refreshed.repository).toEqual(repository);
      expect(refreshed.prs[0].local).toEqual(before.prs[0].local);
      expect(refreshed.prs[0].agent).toEqual(before.prs[0].agent);
      const calls = await gh.calls();
      expect(calls[0]).toContain("owner=previous-owner");
      expect(calls[1]).toContain("owner=example");
    } finally {
      await f.close();
    }
  });

  test("a later resolved path change keeps the successful binding and cached local values", async () => {
    const changed = pr(1);
    changed.repository.id = "R_TRANSFERRED";
    changed.url = "https://github.com/other/project/pull/1";
    const gh = await fakeGh(
      `import { existsSync } from 'node:fs';if(args.some(a=>a.includes('ScopeOpenPullRequests')))console.log(JSON.stringify(existsSync(process.argv[1]+'.release')?${JSON.stringify(inventory([changed], complete, { owner: "other", name: "project" }, "R_TRANSFERRED"))}:${JSON.stringify(inventory([pr(1)]))}));else console.log(JSON.stringify(${JSON.stringify(threads(1, []))}));`,
    );
    const f = await inboxFixture(gh.process);
    try {
      await f.service.sync(f.snapshot.tabId);
      await f.command({
        action: "note",
        name: "test-inbox",
        tabId: f.snapshot.tabId,
        requestId: randomUUID(),
        nodeId: "PR_1",
        expectedVersion: 0,
        text: "Keep cached note",
      });
      const before = await f.server.store.pullRequests.snapshot("test-inbox");
      await gh.release();
      const failed = await f.service.sync(f.snapshot.tabId);
      expect(failed.sync).toMatchObject({
        state: "error",
        lastSuccessAt: before.sync.lastSuccessAt,
      });
      expect(failed.repository).toEqual(before.repository);
      expect(failed.prs).toEqual(before.prs);
    } finally {
      await f.close();
    }
  });

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
      await waitForCalls(gh, 2);
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
      expect(await gh.calls()).toHaveLength(2);
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
      await waitForCalls(gh, 2);
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
