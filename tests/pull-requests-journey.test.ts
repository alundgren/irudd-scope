import { expect, test } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequestsSnapshot } from "@irudd-scope/protocol/pull-requests";
import { desktopFixture } from "./desktop-fixture.ts";

test("a native inbox syncs through gh, preserves local edits across refresh and HTML updates, and restores after restart", async () => {
  const ghDirectory = await mkdtemp(join(tmpdir(), "scope-pr-journey-gh-"));
  const stateFile = join(ghDirectory, "state.json");
  const head = "a".repeat(40),
    newerHead = "b".repeat(40),
    base = "c".repeat(40);
  await writeFile(stateFile, JSON.stringify({ head, fail: false }));
  await writeFile(
    join(ghDirectory, "gh"),
    `#!${process.execPath}
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
if (state.fail) { console.error('Synthetic offline GitHub'); process.exit(1); }
const complete = { hasNextPage: false, endCursor: null };
const row = { state:'OPEN',reviewThreads:{nodes:[],pageInfo:complete}, id:'PR_JOURNEY_1', repository:{id:'R_JOURNEY'}, number:1, title:'Review persistent state', author:{login:'colleague'}, labels:{nodes:[{name:'enhancement'}],pageInfo:complete}, headRefOid:state.head, headRefName:'feature', stack:null, stackEntry:null, reviewDecision:null, latestOpinionatedReviews:{totalCount:0,nodes:[],pageInfo:complete}, baseRefOid:'${base}', reviewRequests:{nodes:[{requestedReviewer:{__typename:'User',login:'viewer'}}],pageInfo:complete}, isDraft:false, additions:14, deletions:3, changedFiles:1, url:'https://github.com/synthetic/project/pull/1', mergeable:'MERGEABLE', createdAt:'2026-09-30T12:00:00Z',updatedAt:'2026-10-01T12:00:00Z', commits:{nodes:[{commit:{oid:state.head,statusCheckRollup:{state:'SUCCESS',commit:{oid:state.head}}}}]} };
const common = {viewer:{login:'viewer'},rateLimit:{cost:1,limit:5000,remaining:4999,resetAt:'2099-10-02T00:00:00Z'}};
const repository = {id:'R_JOURNEY',owner:{login:'synthetic'},name:'project',nameWithOwner:'synthetic/project'};
if(args.some(a => a.includes('ScopeOpenPullRequests') || a.includes('ScopeInitialOpenPullRequests'))) console.log(JSON.stringify({data:{...common,repository:{...repository,pullRequests:{nodes:[row],pageInfo:complete}}}}));
else if(args.some(a => a.includes('ScopeEnrichPullRequests'))) console.log(JSON.stringify({data:{...common,nodes:[{...row,repository}]}}));
else if(args.some(a => a.includes('ScopeCurrentPullRequest'))) console.log(JSON.stringify({data:{...common,repository:{...repository,pullRequest:row}}}));
else if(args.some(a => a.includes('ScopePullRequestReviewBody'))) console.log(JSON.stringify({data:{...common,repository:{...repository,pullRequest:{id:row.id,state:'OPEN',headRefOid:state.head,baseRefOid:'${base}',body:'Inspect this synthetic change'}}}}));
else if(args[0]==='pr' && args[1]==='diff') console.log('diff --git a/example.ts b/example.ts\\n+synthetic change');
else if(args.some(a=>a.includes('/files?'))) console.log(JSON.stringify([{sha:'synthetic-file',filename:'example.ts',additions:14,deletions:3,changes:17,status:'modified',blob_url:'https://github.com/synthetic/project/blob/example.ts'}]));
else if(args.some(a=>a.includes('/reviews?'))) console.log(JSON.stringify([{id:1,node_id:'REVIEW_1',user:{id:1,node_id:'USER_1',login:'reviewer'},state:'COMMENTED',body:'Looks straightforward',submitted_at:'2026-10-01T12:00:00Z',commit_id:state.head,html_url:'https://github.com/synthetic/project/pull/1'}]));
else if(args.includes('user')) console.log(JSON.stringify({login:'viewer'}));
else throw new Error('Unexpected GitHub read');
`,
    { mode: 0o700 },
  );
  const previousPath = process.env.PATH;
  process.env.PATH = ghDirectory + ":" + previousPath;
  let fixture: Awaited<ReturnType<typeof desktopFixture>>;
  try {
    fixture = await desktopFixture();
  } finally {
    process.env.PATH = previousPath;
  }
  let app = await fixture.launch();
  try {
    let page = await app.firstWindow();
    page.setDefaultTimeout(8_000);
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Create PR inbox", exact: true }).click();
    await page.getByLabel("Repository", { exact: true }).fill("synthetic/project");
    await page.getByLabel("Title", { exact: true }).fill("Persistent PR inbox");
    await page.getByLabel("Name, optional", { exact: true }).fill("journey-inbox");
    await page.getByRole("button", { name: "Create PR inbox", exact: true }).click();
    let frame = page.frameLocator(".pull-requests-document");
    await frame.getByRole("button", { name: "Review persistent state", exact: true }).click();
    await frame.getByText("Inspect this synthetic change", { exact: true }).waitFor();
    await frame.getByLabel("Your notes").fill("Keep this note across updates");
    await frame.getByRole("button", { name: "Save note", exact: true }).click();
    await frame.getByText("Saved", { exact: true }).waitFor();
    const client = await fixture.connect();
    async function snapshot(): Promise<PullRequestsSnapshot> {
      const reply = await client.pullRequests({ action: "read", name: "journey-inbox" });
      if (reply.type !== "snapshot") throw new Error("Expected current inbox snapshot");
      return reply.snapshot;
    }
    await expect
      .poll(async () => (await snapshot()).prs[0].local.note)
      .toBe("Keep this note across updates");
    await writeFile(stateFile, JSON.stringify({ head: newerHead, fail: false }));
    const before = await snapshot();
    await client.pullRequests({
      action: "sync",
      name: "journey-inbox",
      tabId: before.tabId,
      requestId: crypto.randomUUID(),
    });
    await frame.getByRole("button", { name: /Load latest commit/ }).waitFor();
    expect(await frame.locator("#head").textContent()).toBe(head.slice(0, 12));
    await frame.getByRole("button", { name: "Mark this commit reviewed", exact: true }).click();
    await expect.poll(async () => (await snapshot()).prs[0].local.reviewed?.headOid).toBe(head);
    expect((await snapshot()).prs[0].headOid).toBe(newerHead);
    await frame.getByRole("button", { name: /Load latest commit/ }).click();
    await expect.poll(() => frame.locator("#head").textContent()).toBe(newerHead.slice(0, 12));
    await frame.getByRole("button", { name: "Snooze pull request", exact: true }).click();
    await frame.getByRole("button", { name: "2 hours", exact: true }).click();
    await expect.poll(async () => !!(await snapshot()).prs[0].local.snooze).toBe(true);
    await writeFile(stateFile, JSON.stringify({ head: newerHead, fail: true }));
    const cached = await snapshot();
    await client.pullRequests({
      action: "sync",
      name: "journey-inbox",
      tabId: cached.tabId,
      requestId: crypto.randomUUID(),
    });
    await expect
      .poll(() =>
        frame.getByRole("button", { name: "Sync pull requests" }).getAttribute("data-failed"),
      )
      .toBe("true");
    expect(await page.getByRole("alert").count()).toBe(0);
    expect((await snapshot()).prs[0].local.note).toBe("Keep this note across updates");
    const html = `<!doctype html><div id="restored">Loading</div><script>window.scope.pullRequests.watch((prs)=>{document.getElementById('restored').textContent=prs[0]?.local.note||'Empty';});</script>`;
    const current = await snapshot();
    await client.publish(
      current.artifact.id,
      {
        name: "journey-inbox",
        title: current.artifact.title,
        kind: "pull-requests",
        mediaType: "text/html",
        fileName: "inbox.html",
        expectedRevision: current.artifact.revision,
      },
      Buffer.from(html),
    );
    await page
      .frameLocator(".pull-requests-document")
      .getByText("Keep this note across updates", { exact: true })
      .waitFor();
    await app.close();
    app = await fixture.launch();
    page = await app.firstWindow();
    await page
      .frameLocator(".pull-requests-document")
      .getByText("Keep this note across updates", { exact: true })
      .waitFor();
    const restarted = await fixture.connect();
    const reply = await restarted.pullRequests({ action: "read", name: "journey-inbox" });
    expect(reply.type).toBe("snapshot");
    if (reply.type !== "snapshot") throw new Error("Expected restored snapshot");
    expect(reply.snapshot.tabId).toBe(current.tabId);
    expect(reply.snapshot.prs[0].local.reviewed?.headOid).toBe(head);
    expect(reply.snapshot.prs[0].local.snooze).toEqual(current.prs[0].local.snooze);
    expect(reply.snapshot.prs[0].headOid).toBe(newerHead);
    expect(reply.snapshot.repository).toEqual({ owner: "synthetic", name: "project" });
  } finally {
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(ghDirectory, { recursive: true, force: true });
  }
}, 45_000);
