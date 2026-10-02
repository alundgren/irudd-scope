import { afterEach, expect, test } from "vite-plus/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { GitHubProcess } from "../apps/desktop/src/plugins/pull-requests/gh-process.ts";
import { GitHubPullRequests } from "../apps/desktop/src/plugins/pull-requests/gh.ts";
import { PullRequestSync } from "../apps/desktop/src/plugins/pull-requests/sync.ts";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";

const repository = { owner: "example", name: "project" };
const head = "a".repeat(40),
  base = "b".repeat(40),
  at = "2026-10-01T12:00:00Z";
const complete = { hasNextPage: false, endCursor: null as string | null };
const header = { id: "PRS_1", number: 12, size: 2, baseRefName: "main" };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
function opinion(state: string, author = "reviewer") {
  return { id: "REVIEW_" + author, state, author: { login: author } };
}
function sourcePr(
  number: number,
  options: {
    draft?: boolean;
    stack?: typeof header;
    position?: number;
    opinions?: ReturnType<typeof opinion>[];
    decision?: string | null;
  } = {},
) {
  const opinions = options.opinions ?? [];
  return {
    state: "OPEN",
    reviewThreads: {
      nodes: [],
      pageInfo: { hasNextPage: true, endCursor: "threads" as string | null },
    },
    id: "PR_" + number,
    repository: { id: "R_PROJECT" },
    number,
    title: "Change " + number,
    author: { login: "author" },
    labels: { nodes: [], pageInfo: complete },
    reviewRequests: { nodes: [], pageInfo: complete },
    headRefOid: head,
    headRefName: "feature-" + number,
    baseRefOid: base,
    isDraft: options.draft ?? false,
    stack: options.stack ?? null,
    stackEntry: options.stack ? { position: options.position ?? number } : null,
    reviewDecision: options.decision ?? null,
    latestOpinionatedReviews: { totalCount: opinions.length, nodes: opinions, pageInfo: complete },
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    url: `https://github.com/example/project/pull/${number}`,
    mergeable: "MERGEABLE",
    updatedAt: at,
    createdAt: at,
    commits: { nodes: [{ commit: { oid: head, statusCheckRollup: null } }] },
  };
}
function inventory(nodes: ReturnType<typeof sourcePr>[], pageInfo = complete) {
  return {
    data: {
      viewer: { login: "viewer" },
      rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2099-10-03T00:00:00Z" },
      repository: {
        id: "R_PROJECT",
        owner: { login: repository.owner },
        name: repository.name,
        nameWithOwner: "example/project",
        pullRequests: { nodes, pageInfo },
      },
    },
  };
}
function entry(pr: ReturnType<typeof sourcePr>, state = "OPEN", position = pr.number) {
  return {
    position,
    pullRequest: {
      id: pr.id,
      number: pr.number,
      repository: pr.repository,
      state,
      isDraft: pr.isDraft,
      headRefOid: pr.headRefOid,
    },
  };
}
function stack(
  entries: (ReturnType<typeof entry> | null)[],
  pageInfo = complete,
  count = header.size,
) {
  return {
    data: {
      viewer: { login: "viewer" },
      rateLimit: { cost: 1, limit: 5000, remaining: 4999, resetAt: "2099-10-03T00:00:00Z" },
      node: { ...header, entries: { nodes: entries, totalCount: count, pageInfo } },
    },
  };
}
async function fakeGh(
  rows: ReturnType<typeof sourcePr>[],
  stackPages: ReturnType<typeof stack>[] = [],
) {
  const directory = await mkdtemp(join(tmpdir(), "scope-stack-api-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const payload = {
    inventory: [inventory(rows)],
    stack: stackPages,
    opinions: {} as Record<string, unknown>,
    threadHead: head,
    memberReviews: {} as Record<string, ReturnType<typeof sourcePr> | null>,
  };
  const path = join(directory, "gh.mjs"),
    data = join(directory, "responses.json"),
    log = join(directory, "calls.jsonl");
  await writeFile(
    path,
    `#!${process.execPath}
import {readFileSync,appendFileSync} from 'node:fs';
const args=process.argv.slice(2), data=JSON.parse(readFileSync(${JSON.stringify(data)},'utf8'));
appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\\n');
const query=args.find(a=>a.startsWith('query='))||'', number=args.find(a=>a.startsWith('number='))?.slice(7), later=args.some(a=>a.startsWith('cursor='));
const common={viewer:{login:'viewer'},rateLimit:{cost:1,limit:5000,remaining:4999,resetAt:'2099-10-03T00:00:00Z'}};
const emit=value=>{ if(value?.data) value.data={...common,...value.data}; console.log(JSON.stringify(value)); };
const repo=data.inventory[0].data.repository, rows=data.inventory.flatMap(page=>page.data.repository.pullRequests.nodes), ids=args.filter(a=>a.startsWith('ids[]=')).map(a=>a.slice(6));
if(args.includes('user')) console.log(JSON.stringify({login:'viewer'}));
else if(query.includes('ScopeOpenPullRequests') || query.includes('ScopeInitialOpenPullRequests')) {
 const value=data.inventory[later?1:0];
 if(query.includes('ScopeInitialOpenPullRequests')) for(const row of value.data.repository.pullRequests.nodes) for(const key of ['stack','stackEntry','reviewDecision','latestOpinionatedReviews','reviewThreads','commits','mergeable']) delete row[key];
 emit(value);
}
else if(query.includes('ScopeEnrichPullRequests')) emit({data:{nodes:ids.map(id=>({...rows.find(row=>row.id===id),repository:repo}))}});
else if(query.includes('ScopeCurrentPullRequest')) emit({data:{repository:{...repo,pullRequest:rows.find(row=>row.number===Number(number))}}});
else if(query.includes('ScopeStackMemberReviews')) emit({data:{nodes:ids.map(id=>Object.hasOwn(data.memberReviews||{},id)?data.memberReviews[id]:rows.find(row=>row.id===id))}});
else if(query.includes('ScopePullRequestStack')) emit(data.stack[later?1:0]);
else if(query.includes('ScopePullRequestOpinions')) emit(data.opinions[number]);
else emit({data:{repository:{pullRequest:{id:'PR_'+number,state:'OPEN',headRefOid:data.threadHead,baseRefOid:'${base}',reviewThreads:{nodes:[],pageInfo:${JSON.stringify(complete)}}}}}});

`,
    { mode: 0o700 },
  );
  const update = () => writeFile(data, JSON.stringify(payload));
  await update();
  const reader = new GitHubPullRequests(new GitHubProcess(path, 5000));
  return {
    directory,
    payload,
    update,
    reader,
    read: () => reader.inventory(repository, new AbortController().signal),
    calls: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]),
  };
}

test("native membership includes hidden drafts and separates active approvals from GitHub's decision", async () => {
  const first = sourcePr(1, {
    stack: header,
    opinions: [opinion("APPROVED"), opinion("CHANGES_REQUESTED", "other")],
    decision: "CHANGES_REQUESTED",
  });
  const second = sourcePr(2, { stack: header, draft: true, opinions: [opinion("APPROVED")] });
  const standalone = sourcePr(3);
  // Ordinary branch dependencies do not establish native stack membership.
  standalone.headRefName = first.headRefName;
  const f = await fakeGh([first, second, standalone], [stack([entry(first), entry(second)])]);
  const result = await f.read();
  expect(result.prs[0].review).toMatchObject({
    decision: "changes-requested",
    hasApproval: true,
    headOid: head,
  });
  expect(result.prs[0].stack).toMatchObject({
    nodeId: header.id,
    number: 12,
    position: 1,
    readyForReview: false,
    approved: true,
  });
  expect(result.prs[0].stack?.members.map((member) => member.nodeId)).toEqual(["PR_1", "PR_2"]);
  expect(result.prs[1].stack?.position).toBe(2);
  expect(result.prs[2].stack).toBeNull();
  expect(result.prs[2].review?.hasApproval).toBe(false);
  expect(
    (await f.calls()).filter((args) => args.some((a) => a.includes("ScopePullRequestStack"))),
  ).toHaveLength(1);
});

test("paginates inventory, current review opinions and native members before reporting readiness", async () => {
  const first = sourcePr(1, { stack: header, opinions: [opinion("CHANGES_REQUESTED")] });
  const second = sourcePr(2, { stack: header, opinions: [opinion("APPROVED")] });
  first.latestOpinionatedReviews.totalCount = 2;
  first.latestOpinionatedReviews.pageInfo = { hasNextPage: true, endCursor: "review-tail" };
  const f = await fakeGh(
    [first],
    [stack([entry(second)], { hasNextPage: true, endCursor: "stack-tail" }), stack([entry(first)])],
  );
  f.payload.inventory = [
    inventory([first], { hasNextPage: true, endCursor: "inventory-tail" }),
    inventory([second]),
  ];
  f.payload.opinions["1"] = {
    data: {
      repository: {
        pullRequest: {
          id: first.id,
          state: "OPEN",
          headRefOid: head,
          updatedAt: at,
          reviewDecision: null,
          latestOpinionatedReviews: {
            totalCount: 2,
            nodes: [opinion("APPROVED", "later-reviewer")],
            pageInfo: complete,
          },
        },
      },
    },
  };
  await f.update();
  const result = await f.read();
  expect(result.prs.map((pr) => pr.review?.hasApproval)).toEqual([true, true]);
  expect(result.prs[0].stack).toMatchObject({ readyForReview: true, approved: true });
  expect(result.prs[0].stack?.members.map((member) => member.position)).toEqual([1, 2]);
});

test.each(["CHANGES_REQUESTED", "DISMISSED", "COMMENTED", "PENDING"])(
  "a current %s opinion does not count as an active approval",
  async (state) => {
    const f = await fakeGh([sourcePr(1, { opinions: [opinion(state)] })]);
    expect((await f.read()).prs[0].review?.hasApproval).toBe(false);
  },
);

test("closed and merged members do not block the remaining open members", async () => {
  const larger = { ...header, size: 3 };
  const first = sourcePr(1, { draft: true });
  const second = sourcePr(2, { draft: true });
  const third = sourcePr(3, { stack: larger, opinions: [opinion("APPROVED")] });
  const page = stack([entry(first, "MERGED"), entry(second, "CLOSED"), entry(third)], complete, 3);
  page.data.node.size = 3;
  const f = await fakeGh([third], [page]);
  expect((await f.read()).prs[0].stack).toMatchObject({
    size: 3,
    position: 3,
    readyForReview: true,
    approved: true,
  });
});

test.each([
  "missing member",
  "null member",
  "duplicate position",
  "duplicate member",
  "wrong repository",
  "changed head",
  "changed draft",
  "changed state",
  "changed total",
  "changed size",
  "missing inventory member",
])("rejects %s rather than asserting complete stack readiness", async (failure) => {
  const first = sourcePr(1, { stack: header }),
    second = sourcePr(2, { stack: header });
  const page = stack([entry(first), entry(second)]);
  const members = page.data.node.entries.nodes;
  if (failure === "missing member") members.pop();
  if (failure === "null member") members[1] = null;
  if (failure === "duplicate position") members[1]!.position = 1;
  if (failure === "duplicate member") members[1]!.pullRequest.id = first.id;
  if (failure === "wrong repository") members[1]!.pullRequest.repository = { id: "R_OTHER" };
  if (failure === "changed head") members[1]!.pullRequest.headRefOid = base;
  if (failure === "changed draft") members[1]!.pullRequest.isDraft = true;
  if (failure === "changed state") members[1]!.pullRequest.state = "CLOSED";
  if (failure === "changed total") page.data.node.entries.totalCount = 1;
  if (failure === "changed size") page.data.node.size = 1;
  const f = await fakeGh(failure === "missing inventory member" ? [first] : [first, second], [
    page,
  ]);
  await expect(f.read()).rejects.toThrow(/stack membership/);
});

test("a moved head cannot retain a claimed current approval", async () => {
  const f = await fakeGh([sourcePr(1, { opinions: [opinion("APPROVED")], decision: "APPROVED" })]);
  f.payload.threadHead = base;
  await f.update();
  expect((await f.read()).prs[0].review).toMatchObject({
    headOid: head,
    hasApproval: null,
    decision: null,
  });
});

test.each([
  "duplicate reviewer",
  "moved head",
  "changed count",
  "missing opinion",
  "repeated cursor",
])("a %s during review pagination cannot produce a saved approval", async (failure) => {
  const first = sourcePr(1, { opinions: [opinion("APPROVED")] });
  first.latestOpinionatedReviews.totalCount = 2;
  first.latestOpinionatedReviews.pageInfo = { hasNextPage: true, endCursor: "tail" };
  const current = {
    id: first.id,
    state: "OPEN",
    headRefOid: head,
    updatedAt: at,
    reviewDecision: null,
    latestOpinionatedReviews: {
      totalCount: 2,
      nodes: [opinion("CHANGES_REQUESTED", "other")],
      pageInfo: complete,
    },
  };
  if (failure === "duplicate reviewer")
    current.latestOpinionatedReviews.nodes[0].author.login = "reviewer";
  if (failure === "moved head") current.headRefOid = base;
  if (failure === "changed count") current.latestOpinionatedReviews.totalCount = 3;
  if (failure === "missing opinion") current.latestOpinionatedReviews.nodes = [];
  if (failure === "repeated cursor")
    current.latestOpinionatedReviews.pageInfo = { hasNextPage: true, endCursor: "tail" };
  const f = await fakeGh([first]);
  f.payload.opinions["1"] = { data: { repository: { pullRequest: current } } };
  await f.update();
  await expect(f.read()).rejects.toThrow(/GitHub/);
});

test("stack approval remains unknown when an open member's approval becomes unknown", async () => {
  const first = sourcePr(1, { stack: header, opinions: [opinion("APPROVED")] });
  const second = sourcePr(2, { stack: header, opinions: [opinion("APPROVED")] });
  const f = await fakeGh([first, second], [stack([entry(first), entry(second)])]);
  f.payload.threadHead = base;
  await f.update();
  const result = await f.read();
  expect(result.prs.map((pr) => pr.review?.hasApproval)).toEqual([null, null]);
  expect(result.prs[0].stack).toMatchObject({ readyForReview: true, approved: null });
});

test("HTTP and CLI snapshots retain model facts and notes after a failed native stack refresh", async () => {
  const first = sourcePr(1, { stack: header, opinions: [opinion("APPROVED")] }),
    second = sourcePr(2, { stack: header });
  const f = await fakeGh([first, second], [stack([entry(first), entry(second)])]);
  const token = "synthetic-stack-api-token",
    name = "stack-inbox";
  const server = await startArtifactServer({
    directory: join(f.directory, "storage"),
    token,
    port: 0,
  });
  cleanup.push(server.close);
  const client = new ScopeClient(server.url, token);
  const sync = new PullRequestSync(server.store.pullRequests, f.reader);
  cleanup.push(async () => sync.cancelPending());
  server.store.pullRequests.setHandlers({
    sync: (tabId) => sync.sync(tabId),
    detail: (tabId, id) => sync.detail(tabId, id),
  });
  await client.publish(
    "stack-test",
    {
      name,
      title: "Stack inbox",
      kind: "pull-requests",
      mediaType: "text/html",
      fileName: "inbox.html",
      expectedRevision: 0,
    },
    Buffer.from("<p>Agent-authored inbox</p>"),
  );
  const tabId = (await server.store.pullRequests.snapshot(name)).tabId;
  await client.pullRequests({
    action: "configure",
    name,
    tabId,
    requestId: randomUUID(),
    repository,
  });
  const read = async () => {
    const reply = await client.pullRequests({ action: "read", name });
    if (reply.type !== "snapshot") throw new Error("Expected snapshot");
    return reply.snapshot;
  };
  await client.pullRequests({ action: "sync", name, tabId, requestId: randomUUID() });
  await client.pullRequests({
    action: "note",
    name,
    tabId,
    nodeId: first.id,
    requestId: randomUUID(),
    expectedVersion: 0,
    text: "Keep my review notes",
  });
  const saved = await read();
  expect(saved.prs.find((pr) => pr.nodeId === first.id)?.stack?.approved).toBe(false);
  const cli = await promisify(execFile)(
    process.execPath,
    [resolve("packages/cli/dist/main.mjs"), "pull-requests", "read", name],
    {
      env: {
        ...process.env,
        SCOPE_ENDPOINT: server.url,
        SCOPE_TOKEN: token,
        SCOPE_TOKEN_FILE: undefined,
      },
    },
  );
  expect(JSON.parse(cli.stdout).snapshot.prs).toEqual(saved.prs);
  f.payload.stack[0].data.node.entries.nodes.pop();
  await f.update();
  await client.pullRequests({ action: "sync", name, tabId, requestId: randomUUID() });
  const retained = await read();
  expect(retained.sync.state).toBe("error");
  expect(retained.prs).toEqual(saved.prs);
});

test("lightweight initial inventory omits stack and review facts until complete enrichment", async () => {
  const first = sourcePr(1, { stack: header, opinions: [opinion("APPROVED")] });
  const second = sourcePr(2, { stack: header, draft: true });
  const f = await fakeGh([first, second], [stack([entry(first), entry(second)])]);
  const initial = await f.reader.initialInventory(repository, new AbortController().signal);
  for (const pr of initial.prs) {
    expect(Object.hasOwn(pr, "stack")).toBe(false);
    expect(Object.hasOwn(pr, "review")).toBe(false);
  }
  const firstQuery = (await f.calls())[0].find((arg) => arg.startsWith("query="))!;
  expect(firstQuery).not.toContain("latestOpinionatedReviews");
  expect(firstQuery).not.toContain("stackEntry");
  const enriched = await f.reader.enrichInventory(
    repository,
    initial.prs,
    new AbortController().signal,
  );
  expect(enriched.cost).toBe((await f.calls()).length - 1);
  expect(enriched.prs[0].review?.hasApproval).toBe(true);
  expect(enriched.prs[0].stack).toMatchObject({ readyForReview: false, approved: false });
});

test("a focused standalone refresh reads approval without loading the repository or a stack", async () => {
  const first = sourcePr(1, { opinions: [opinion("APPROVED")] });
  const f = await fakeGh([first]);
  const previous = (await f.read()).prs[0];
  const before = (await f.calls()).length;
  const current = await f.reader.current(repository, previous, new AbortController().signal);
  expect(current?.stack).toBeNull();
  expect(current?.review?.hasApproval).toBe(true);
  const calls = (await f.calls()).slice(before);
  expect(calls.some((args) => args.some((arg) => arg.includes("ScopeCurrentPullRequest")))).toBe(
    true,
  );
  expect(
    calls.some((args) =>
      args.some((arg) => /Scope(?:Open|InitialOpen|Enrich|PullRequestStack|StackMember)/.test(arg)),
    ),
  ).toBe(false);
});

test("a focused stack refresh includes hidden drafts and reviews while cached siblings stay older", async () => {
  const first = sourcePr(1, {
    stack: header,
    opinions: [opinion("APPROVED"), opinion("CHANGES_REQUESTED", "other")],
  });
  const second = sourcePr(2, { stack: header, opinions: [opinion("APPROVED")] });
  const f = await fakeGh([first, second], [stack([entry(first), entry(second)])]);
  const cached = (await f.read()).prs;
  const changed = sourcePr(2, {
    stack: header,
    draft: true,
    opinions: [opinion("CHANGES_REQUESTED")],
  });
  f.payload.memberReviews[changed.id] = changed;
  f.payload.stack[0].data.node.entries.nodes = [entry(first), entry(changed)];
  await f.update();
  const before = (await f.calls()).length;
  const current = await f.reader.current(repository, cached[0], new AbortController().signal);
  expect(current?.review?.hasApproval).toBe(true);
  expect(current?.stack).toMatchObject({ readyForReview: false, approved: false });
  expect(current?.stack?.members[1]).toMatchObject({ nodeId: changed.id, draft: true });
  expect(current!.stack!.observedAt > cached[1].stack!.observedAt).toBe(true);
  expect(cached[1].draft).toBe(false);
  expect(cached[1].stack?.approved).toBe(true);
  const calls = (await f.calls()).slice(before);
  const memberQuery = calls.find((args) =>
    args.some((arg) => arg.includes("ScopeStackMemberReviews")),
  )!;
  expect(memberQuery).toContain("ids[]=PR_2");
  expect(memberQuery).not.toContain("ids[]=PR_1");
  expect(
    calls.some((args) =>
      args.some((arg) => /Scope(?:Open|InitialOpen|Enrich)PullRequests/.test(arg)),
    ),
  ).toBe(false);
});

test.each(["missing member", "head", "draft", "header"])(
  "focused stack %s drift rejects the read instead of replacing selected facts",
  async (failure) => {
    const first = sourcePr(1, { stack: header, opinions: [opinion("APPROVED")] });
    const second = sourcePr(2, { stack: header, opinions: [opinion("APPROVED")] });
    const f = await fakeGh([first, second], [stack([entry(first), entry(second)])]);
    const cached = (await f.read()).prs[0];
    const changed = { ...second };
    if (failure === "head") changed.headRefOid = base;
    if (failure === "draft") changed.isDraft = true;
    if (failure === "header") changed.stack = { ...header, baseRefName: "different" };
    f.payload.memberReviews[second.id] = failure === "missing member" ? null : changed;
    await f.update();
    await expect(
      f.reader.current(repository, cached, new AbortController().signal),
    ).rejects.toThrow(/stack/);
    expect(cached.review?.hasApproval).toBe(true);
    expect(cached.stack?.approved).toBe(true);
  },
);

test("native stack queries retain GitHub account errors and rate-limit observations", async () => {
  const first = sourcePr(1, { stack: header });
  const second = sourcePr(2, { stack: header });
  const f = await fakeGh([first, second], [stack([entry(first), entry(second)])]);
  const cached = (await f.read()).prs[0];
  const observations: string[] = [];
  f.reader.setReadHooks((observation) => observations.push(observation.account));
  f.payload.stack[0].data.viewer = { login: "another-account" };
  await f.update();
  await expect(
    f.reader.current(repository, cached, new AbortController().signal),
  ).rejects.toMatchObject({ kind: "account" });
  expect(observations).toEqual(["viewer", "viewer", "another-account"]);
  const query = (await f.calls()).at(-1)!.find((arg) => arg.startsWith("query="))!;
  expect(query).toContain("viewer { login }");
  expect(query).toContain("rateLimit { cost limit remaining resetAt }");
});

test.each(["account", "throttle"])(
  "focused opinion pagination retains %s failures",
  async (failure) => {
    const first = sourcePr(1, { stack: header });
    const second = sourcePr(2, { stack: header });
    const f = await fakeGh([first, second], [stack([entry(first), entry(second)])]);
    const cached = (await f.read()).prs[0];
    const member = sourcePr(2, { stack: header, opinions: [opinion("COMMENTED")] });
    member.latestOpinionatedReviews.totalCount = 2;
    member.latestOpinionatedReviews.pageInfo = { hasNextPage: true, endCursor: "opinions" };
    f.payload.memberReviews[second.id] = member;
    f.payload.opinions["2"] = {
      ...(failure === "throttle" ? { errors: [{ message: "API rate limit exceeded" }] } : {}),
      data: {
        viewer: { login: failure === "account" ? "another-account" : "viewer" },
        rateLimit: {
          cost: 1,
          limit: 5000,
          remaining: failure === "throttle" ? 0 : 4999,
          resetAt: "2099-10-03T00:00:00Z",
        },
        repository: {
          pullRequest: {
            ...member,
            latestOpinionatedReviews: {
              totalCount: 2,
              nodes: [opinion("APPROVED", "later")],
              pageInfo: complete,
            },
          },
        },
      },
    };
    await f.update();
    await expect(
      f.reader.current(repository, cached, new AbortController().signal),
    ).rejects.toMatchObject({ kind: failure });
  },
);
