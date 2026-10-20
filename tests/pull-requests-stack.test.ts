import { afterEach, expect, test } from "vite-plus/test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubProcess } from "../apps/desktop/src/plugins/pull-requests/gh-process.ts";
import { GitHubPullRequests } from "../apps/desktop/src/plugins/pull-requests/gh.ts";

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

test.each(["CHANGES_REQUESTED", "DISMISSED", "COMMENTED", "PENDING"])(
  "a current %s opinion does not count as an active approval",
  async (state) => {
    const f = await fakeGh([sourcePr(1, { opinions: [opinion(state)] })]);
    expect((await f.read()).prs[0].review?.hasApproval).toBe(false);
  },
);

test.each(["missing member", "duplicate member", "changed head", "missing inventory member"])(
  "rejects %s rather than asserting complete stack readiness",
  async (failure) => {
    const first = sourcePr(1, { stack: header }),
      second = sourcePr(2, { stack: header });
    const page = stack([entry(first), entry(second)]);
    const members = page.data.node.entries.nodes;
    if (failure === "missing member") members.pop();
    if (failure === "duplicate member") members[1]!.pullRequest.id = first.id;
    if (failure === "changed head") members[1]!.pullRequest.headRefOid = base;
    const f = await fakeGh(failure === "missing inventory member" ? [first] : [first, second], [
      page,
    ]);
    await expect(f.read()).rejects.toThrow(/stack membership/);
  },
);

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

test.each(["duplicate reviewer", "moved head", "changed count", "repeated cursor"])(
  "a %s during review pagination cannot produce a saved approval",
  async (failure) => {
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
    if (failure === "repeated cursor")
      current.latestOpinionatedReviews.pageInfo = { hasNextPage: true, endCursor: "tail" };
    const f = await fakeGh([first]);
    f.payload.opinions["1"] = { data: { repository: { pullRequest: current } } };
    await f.update();
    await expect(f.read()).rejects.toThrow(/GitHub/);
  },
);
