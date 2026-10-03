import { expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  const diff = `diff --git a/example.ts b/example.ts
--- a/example.ts
+++ b/example.ts
@@ -10,3 +10,4 @@ export function example()
 unchanged
-old value
+new value
+<script>literal code</script>
 last line
diff --git a/old name.ts b/new name.ts
similarity index 100%
rename from old name.ts
rename to new name.ts
diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"
--- "a/caf\\303\\251.ts"
+++ "b/caf\\303\\251.ts"
@@ -1 +1 @@
-old café
+new café
diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
`;
  await writeFile(
    join(ghDirectory, "gh"),
    `#!${process.execPath}
import { readFileSync } from 'node:fs';
const args = process.argv.slice(2);
const state = JSON.parse(readFileSync(${JSON.stringify(stateFile)}, 'utf8'));
if (state.fail) { console.error('Synthetic offline GitHub'); process.exit(1); }
const complete = { hasNextPage: false, endCursor: null };
const row = { state:'OPEN',reviewThreads:{nodes:[],pageInfo:complete}, id:'PR_JOURNEY_1', repository:{id:'R_JOURNEY'}, number:1, title:'Review persistent state', author:{login:'colleague'}, labels:{nodes:[{name:'enhancement'}],pageInfo:complete}, headRefOid:state.head, headRefName:'feature', stack:null, stackEntry:null, reviewDecision:null, latestOpinionatedReviews:{totalCount:0,nodes:[],pageInfo:complete}, baseRefOid:'${base}', reviewRequests:{nodes:[{requestedReviewer:{__typename:'User',login:'viewer'}}],pageInfo:complete}, isDraft:false, additions:14, deletions:3, changedFiles:4, url:'https://github.com/synthetic/project/pull/1', mergeable:'MERGEABLE', createdAt:'2026-09-30T12:00:00Z',updatedAt:'2026-10-01T12:00:00Z', commits:{nodes:[{commit:{oid:state.head,statusCheckRollup:{state:'SUCCESS',commit:{oid:state.head}}}}]} };
const common = {viewer:{login:'viewer'},rateLimit:{cost:1,limit:5000,remaining:4999,resetAt:'2099-10-02T00:00:00Z'}};
const repository = {id:'R_JOURNEY',owner:{login:'synthetic'},name:'project',nameWithOwner:'synthetic/project'};
if(args.some(a => a.includes('ScopeOpenPullRequests') || a.includes('ScopeInitialOpenPullRequests'))) console.log(JSON.stringify({data:{...common,repository:{...repository,pullRequests:{nodes:[row],pageInfo:complete}}}}));
else if(args.some(a => a.includes('ScopeEnrichPullRequests'))) console.log(JSON.stringify({data:{...common,nodes:[{...row,repository}]}}));
else if(args.some(a => a.includes('ScopeCurrentPullRequest'))) console.log(JSON.stringify({data:{...common,repository:{...repository,pullRequest:row}}}));
else if(args.some(a => a.includes('ScopePullRequestReviewBody'))) console.log(JSON.stringify({data:{...common,repository:{...repository,pullRequest:{id:row.id,state:'OPEN',headRefOid:state.head,baseRefOid:'${base}',body:'Inspect this synthetic change'}}}}));
else if(args[0]==='pr' && args[1]==='diff') console.log(${JSON.stringify(diff)});
else if(args.some(a=>a.includes('/files?'))) console.log(JSON.stringify(['example.ts','new name.ts','café.ts','image.png'].map(filename=>({sha:'synthetic-file',filename,additions:14,deletions:3,changes:17,status:filename==='new name.ts'?'renamed':'modified',blob_url:'https://github.com/synthetic/project/blob/example.ts'}))));
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
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 780),
    );
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Create PR inbox", exact: true }).click();
    await page.getByLabel("Repository", { exact: true }).fill("synthetic/project");
    await page.getByLabel("Title", { exact: true }).fill("Persistent PR inbox");
    await page.getByLabel("Name, optional", { exact: true }).fill("journey-inbox");
    await page.getByRole("button", { name: "Create PR inbox", exact: true }).click();
    let frame = page.frameLocator(".pull-requests-document");
    await frame
      .getByRole("button", { name: "View changed files for #1", exact: true })
      .locator("svg path")
      .click();
    const viewer = page.getByRole("dialog", { name: "Changes in #1" });
    await viewer.getByText("new value", { exact: true }).waitFor();
    expect(await viewer.getByRole("row").filter({ hasText: "old value" }).textContent()).toBe(
      "11−old value",
    );
    expect(await viewer.getByText("<script>literal code</script>", { exact: true }).count()).toBe(
      1,
    );
    await viewer.getByRole("button", { name: "Split", exact: true }).click();
    expect(await viewer.getByRole("row").filter({ hasText: "old value" }).textContent()).toBe(
      "11−old value11+new value",
    );
    await viewer.getByRole("button", { name: /new name.ts/ }).click();
    await viewer.getByText("Renamed from old name.ts", { exact: true }).waitFor();
    await viewer.getByRole("button", { name: /café.ts/ }).click();
    await viewer.getByText("new café", { exact: true }).waitFor();
    await viewer.getByRole("button", { name: /image.png/ }).click();
    await viewer
      .getByText("Binary files a/image.png and b/image.png differ", { exact: true })
      .first()
      .waitFor();
    await viewer.getByRole("button", { name: /example.ts/ }).click();
    const window = page.locator(".pr-diff-window");
    const original = (await window.boundingBox())!;
    await viewer.getByRole("button", { name: "Move diff window" }).focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowDown");
    expect((await window.boundingBox())!.x).toBeCloseTo(original.x - 10, 1);
    const grip = (await viewer.getByRole("button", { name: "Move diff window" }).boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2 + 15, grip.y + grip.height / 2 + 10, {
      steps: 5,
    });
    await page.mouse.up();
    expect((await window.boundingBox())!.x).toBeCloseTo(original.x + 5, 1);
    const handle = (await viewer
      .getByRole("button", { name: "Resize diff window" })
      .boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 160, handle.y - 120, { steps: 5 });
    await page.mouse.up();
    const resized = (await window.boundingBox())!;
    expect(resized.width).toBeLessThan(original.width - 100);
    expect(resized.height).toBeLessThan(original.height - 80);
    await viewer.getByRole("button", { name: "Maximize diff window" }).click();
    expect((await window.boundingBox())!.width).toBe(1100);
    await viewer.getByRole("button", { name: "Restore diff window" }).click();
    expect((await window.boundingBox())!.width).toBeCloseTo(resized.width, 1);
    if (process.env.SCOPE_TEST_SCREENSHOTS) {
      await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, "pr-diff-light.png"),
      });
    }
    await viewer.getByRole("button", { name: "Close diff window" }).click();
    await frame
      .getByRole("button", { name: "View changed files for #1", exact: true })
      .press("Enter");
    await viewer.getByText("new value", { exact: true }).waitFor();
    await page.keyboard.press("Escape");
    await viewer.waitFor({ state: "hidden" });
    await frame.getByRole("button", { name: "Review persistent state", exact: true }).click();
    await frame.getByText("Inspect this synthetic change", { exact: true }).waitFor();
    await frame.getByLabel("Your notes").fill("Keep this note across updates");
    await frame.getByRole("button", { name: "Save note", exact: true }).click();
    await frame.getByText("Saved", { exact: true }).waitFor();
    await frame.getByRole("button", { name: "Diff", exact: true }).click();
    await viewer.getByText("new value", { exact: true }).waitFor();
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
    await viewer.getByRole("button", { name: "Load latest comparison" }).waitFor();
    expect(await viewer.locator(".pr-diff-commits").textContent()).toBe(
      `${base.slice(0, 7)} → ${head.slice(0, 7)}`,
    );
    await writeFile(stateFile, JSON.stringify({ head: newerHead, fail: true }));
    await viewer.getByRole("button", { name: "Load latest comparison" }).click();
    await viewer.getByRole("alert").waitFor();
    await writeFile(stateFile, JSON.stringify({ head: newerHead, fail: false }));
    await viewer.getByRole("button", { name: "Retry loading diff" }).click();
    await viewer.getByText("new value", { exact: true }).waitFor();
    expect(await viewer.locator(".pr-diff-commits").textContent()).toBe(
      `${base.slice(0, 7)} → ${newerHead.slice(0, 7)}`,
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(500, 520),
    );
    await page.keyboard.press("ControlOrMeta+,");
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.getByRole("dialog", { name: "Settings", exact: true }).waitFor({ state: "hidden" });
    const narrow = (await window.boundingBox())!;
    expect(narrow.x + narrow.width).toBeLessThanOrEqual(
      await page.evaluate(() => globalThis.innerWidth + 1),
    );
    await viewer.getByRole("button", { name: "Split", exact: true }).click();
    if (process.env.SCOPE_TEST_SCREENSHOTS)
      await page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, "pr-diff-narrow-dark.png"),
      });
    await viewer.getByRole("button", { name: "Close diff window" }).click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1100, 780),
    );
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
    const html = `<!doctype html><div id="restored">Loading</div><input aria-label="Authored draft"><button id="files" aria-label="Authored file action"><svg width="24" height="24"><path d="M4 4h16v16H4z"/></svg></button><button id="invalid">Invalid comparison</button><div id="result"></div><script>
const api=window.scope.pullRequests;let current;
api.watch((prs)=>{current=prs[0];document.getElementById('restored').textContent=current?.local.note||'Empty';});
document.getElementById('files').onclick=()=>api.openDiff(current.nodeId).then(()=>document.getElementById('result').textContent='Opened').catch(error=>document.getElementById('result').textContent=error.message);
document.getElementById('invalid').onclick=()=>api.openDiff(current.nodeId,{headOid:'invalid',baseOid:'invalid'}).catch(()=>document.getElementById('result').textContent='Invalid comparison rejected');
</script>`;
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
    frame = page.frameLocator(".pull-requests-document");
    await frame.getByLabel("Authored draft").fill("Keep the authored page mounted");
    await frame.getByRole("button", { name: "Authored file action" }).locator("svg path").click();
    await frame.getByText("Opened", { exact: true }).waitFor();
    await viewer.getByText("new value", { exact: true }).waitFor();
    expect(await viewer.locator(".pr-diff-commits").textContent()).toBe(
      `${base.slice(0, 7)} → ${newerHead.slice(0, 7)}`,
    );
    await viewer.getByRole("button", { name: "Close diff window" }).click();
    expect(await frame.getByLabel("Authored draft").inputValue()).toBe(
      "Keep the authored page mounted",
    );
    await frame.getByRole("button", { name: "Invalid comparison" }).click();
    await frame.getByText("Invalid comparison rejected", { exact: true }).waitFor();
    expect(await viewer.count()).toBe(0);
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
