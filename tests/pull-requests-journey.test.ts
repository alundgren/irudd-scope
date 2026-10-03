import { expect, test } from "vite-plus/test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequestsSnapshot } from "@irudd-scope/protocol/pull-requests";
import { desktopFixture } from "./desktop-fixture.ts";

test("a native inbox syncs through gh, preserves local edits across refresh and HTML updates, and restores after restart", async () => {
  const ghDirectory = await mkdtemp(join(tmpdir(), "scope-pr-journey-gh-"));
  const stateFile = join(ghDirectory, "state.json");
  const readsFile = join(ghDirectory, "reads.jsonl");
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
import { readFileSync, appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(readsFile)}, JSON.stringify(args)+'\\n');
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
    const starterHtml = (
      await readFile("apps/desktop/src/plugins/pull-requests/starter.html", "utf8")
    ).replaceAll(
      "/* SCOPE_TOKENS */",
      await readFile("apps/desktop/src/renderer/tokens.css", "utf8"),
    );
    const file = join(fixture.directory, "inbox.html");
    await writeFile(file, starterHtml);
    await fixture.cli(
      "add",
      file,
      "--pull-requests",
      "--name",
      "journey-inbox",
      "--title",
      "Persistent PR inbox",
    );
    await fixture.cli("pull-requests", "configure", "journey-inbox", "synthetic/project");
    let frame = page.frameLocator(".pull-requests-document");
    await frame.getByRole("checkbox", { name: "Preload content for #1", exact: true }).check();
    await frame.getByRole("button", { name: "Preload selected 1", exact: true }).click();
    await frame.getByText("Selected PR content is ready.", { exact: true }).waitFor();
    await frame
      .getByRole("button", { name: "View changed files for #1", exact: true })
      .locator("svg path")
      .click();
    const viewerChrome = page.getByRole("dialog", { name: "Changes in #1" });
    const viewer = page.frameLocator(".scope-content-document");
    await viewer.getByText("new value").waitFor();
    expect(
      (await readFile(readsFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[])
        .filter((args) => args[0] === "pr" && args[1] === "diff"),
    ).toHaveLength(1);
    await viewer.getByText("<script>literal code</script>").waitFor();
    await viewer.getByText("rename from old name.ts").waitFor();
    await viewer.getByText("new café").waitFor();
    await viewer.getByText("Binary files a/image.png and b/image.png differ").waitFor();
    const window = page.locator(".scope-content-window");
    const original = (await window.boundingBox())!;
    await window.focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowDown");
    expect((await window.boundingBox())!.x).toBeCloseTo(original.x - 10, 1);
    const title = (await viewerChrome
      .getByRole("heading", { name: "Changes in #1" })
      .boundingBox())!;
    await page.mouse.move(title.x + title.width / 2, title.y + title.height / 2);
    await page.mouse.down();
    await page.mouse.move(title.x + title.width / 2 + 15, title.y + title.height / 2 + 10, {
      steps: 5,
    });
    await page.mouse.up();
    expect((await window.boundingBox())!.x).toBeCloseTo(original.x + 5, 1);
    const handle = (await viewerChrome
      .getByRole("button", { name: "Resize content window" })
      .boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x - 160, handle.y - 120, { steps: 5 });
    await page.mouse.up();
    const resized = (await window.boundingBox())!;
    expect(resized.width).toBeLessThan(original.width - 100);
    expect(resized.height).toBeLessThan(original.height - 80);
    await viewerChrome.getByRole("button", { name: "Maximize content window" }).click();
    expect((await window.boundingBox())!.width).toBe(1100);
    await viewerChrome.getByRole("button", { name: "Restore content window" }).click();
    expect((await window.boundingBox())!.width).toBeCloseTo(resized.width, 1);
    if (process.env.SCOPE_TEST_SCREENSHOTS) {
      await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
      await page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, "pr-diff-light.png"),
      });
    }
    await viewerChrome.getByRole("button", { name: "Close content window" }).click();
    await frame
      .getByRole("button", { name: "View changed files for #1", exact: true })
      .press("Enter");
    await viewer.getByText("new value").waitFor();
    await page.keyboard.press("Escape");
    await viewerChrome.waitFor({ state: "hidden" });
    await frame.getByRole("button", { name: "Review persistent state", exact: true }).click();
    await frame.getByText("Inspect this synthetic change", { exact: true }).waitFor();
    await frame.getByLabel("Your notes").fill("Keep this note across updates");
    await frame.getByRole("button", { name: "Save note", exact: true }).click();
    await frame.getByText("Saved", { exact: true }).waitFor();
    await frame.getByRole("button", { name: "Diff", exact: true }).click();
    await viewer.getByText("new value").waitFor();
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
    expect(await viewer.locator("#comparison").textContent()).toBe(
      `${base.slice(0, 7)} → ${head.slice(0, 7)}`,
    );
    await writeFile(stateFile, JSON.stringify({ head: newerHead, fail: true }));
    await viewer.getByRole("button", { name: "Load latest comparison" }).click();
    await viewer.getByRole("alert").waitFor();
    await viewer.getByRole("button", { name: "Retry loading diff" }).waitFor();
    await writeFile(stateFile, JSON.stringify({ head: newerHead, fail: false }));
    await viewer.getByRole("button", { name: "Retry loading diff" }).click();
    await viewer.getByText("new value").waitFor();
    expect(await viewer.locator("#comparison").textContent()).toBe(
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
    if (process.env.SCOPE_TEST_SCREENSHOTS)
      await page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, "pr-diff-narrow-dark.png"),
      });
    await viewerChrome.getByRole("button", { name: "Close content window" }).click();
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
    const projectHTML = `<p id="project"></p><script>document.getElementById('project').textContent='Project content for '+scope.window.context.nodeId;</script>`;
    const html = `<!doctype html><div id="restored">Loading</div><input aria-label="Authored draft"><button id="files" aria-label="Authored file action"><svg width="24" height="24"><path d="M4 4h16v16H4z"/></svg></button><button id="invalid">Invalid context</button><div id="result"></div><script>
const api=window.scope.pullRequests;let current;
api.watch((prs)=>{current=prs[0];document.getElementById('restored').textContent=current?.local.note||'Empty';});
document.getElementById('files').onclick=()=>scope.windows.open({title:'Project view',html:${JSON.stringify(projectHTML).replaceAll("<", "\\u003c")},context:{nodeId:current.nodeId}}).then(()=>document.getElementById('result').textContent='Opened').catch(error=>document.getElementById('result').textContent=error.message);
document.getElementById('invalid').onclick=()=>scope.windows.open({title:'Invalid',html:'<p>Invalid</p>',context:{number:NaN}}).catch(()=>document.getElementById('result').textContent='Invalid context rejected');
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
    await page
      .frameLocator(".scope-content-document")
      .getByText("Project content for PR_JOURNEY_1", { exact: true })
      .waitFor();
    await page
      .getByRole("dialog", { name: "Project view" })
      .getByRole("button", { name: "Close content window" })
      .click();
    expect(await frame.getByLabel("Authored draft").inputValue()).toBe(
      "Keep the authored page mounted",
    );
    await frame.getByRole("button", { name: "Invalid context" }).click();
    await frame.getByText("Invalid context rejected", { exact: true }).waitFor();
    expect(await page.locator(".scope-content-window").count()).toBe(0);
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
