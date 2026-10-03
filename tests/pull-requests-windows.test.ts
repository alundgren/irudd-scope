import { expect, test } from "vite-plus/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PullRequest } from "@irudd-scope/protocol/pull-requests";
import { desktopFixture } from "./desktop-fixture.ts";

const head = "a".repeat(40),
  base = "b".repeat(40),
  at = "2026-10-01T12:00:00.000Z";
function pr(number: number): PullRequest {
  return {
    nodeId: `PR_${number}`,
    number,
    title: `Project change ${number}`,
    author: "colleague",
    labels: [],
    requestedReviewers: [],
    createdAt: at,
    updatedAt: at,
    headOid: head,
    headRefName: "feature",
    baseOid: base,
    draft: false,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    url: `https://github.com/synthetic/project/pull/${number}`,
    merge: { status: "unknown", headOid: head, baseOid: base, observedAt: at },
    checks: { status: "unknown", headOid: head, observedAt: at },
    hasUnresolvedConversations: false,
    local: {
      note: "",
      noteVersion: 0,
      snooze: null,
      snoozeVersion: 0,
      inspected: null,
      reviewed: null,
      reviewVersion: 0,
    },
    agent: { version: 0, assessment: null, customFields: [] },
  };
}
function childHTML(label: string, both = false) {
  return `<!doctype html><style>body{font:16px system-ui;margin:20px;background:#eef7fa;color:#173442}input,button{font:inherit}pre{white-space:pre-wrap}</style>
<h1>${label}</h1><p id="context"></p><p id="note"></p><p id="theme"></p><p id="message"></p><p id="detail"></p>
<label>Draft <input id="draft" aria-label="Window draft"></label><button id="save">Save in window</button><button id="broadcast">Tell siblings</button><button id="nested">Open nested</button>
<a href="https://github.com/synthetic/project/pull/1">Project link</a><p id="error"></p>
<script>
const api=scope.pullRequests, $=id=>document.getElementById(id);let current;
$('context').textContent=scope.window.context.project+' '+scope.window.context.nodeId;
api.watch((prs,context)=>{current=prs[0];$('note').textContent=current.local.note||'No note';$('theme').textContent=context.theme;});
scope.windows.watch(message=>$('message').textContent=message.senderId+':'+message.value.selection);
api.watchDetail('PR_1','${head}','${base}',update=>$('detail').textContent=update.body);
${both ? `api.watchDetail('PR_2','${head}','${base}',update=>$('detail').textContent=update.body);` : ""}
async function save(){await api.saveNote(current.nodeId,$('draft').value,current.local.noteVersion);$('draft').value='';}
$('save').onclick=()=>save().catch(error=>$('error').textContent=error.message);
$('broadcast').onclick=()=>scope.windows.broadcast({selection:'chosen'});
$('nested').onclick=()=>scope.windows.open({title:'Nested content',html:'<input aria-label="Nested draft">',context:{child:true}});
api.beforeClose(async()=>{window.beforeCloseCalls=(window.beforeCloseCalls||0)+1;if($('draft').value==='blocked')throw new Error('Keep this draft');if($('draft').value)await save();});
addEventListener('keydown',event=>{if(event.key==='Escape'&&$('draft').value==='consume'){event.preventDefault();$('error').textContent='Escape consumed';}});
</script>`;
}
const childA = childHTML("Project A", true),
  childB = childHTML("Project B");
const scriptString = (html: string) => JSON.stringify(html).replaceAll("<", "\\u003c");
const html = `<!doctype html><h1>Project inbox</h1><input aria-label="Main draft"><p id="note"></p><p id="message"></p><p id="result"></p>
<button id="a">Open project A</button><button id="b">Open project B</button><button id="batch">Preload candidate</button><a href="https://github.com/synthetic/project">Main link</a>
<script>
scope.pullRequests.watch(prs=>document.getElementById('note').textContent=prs[0]?.local.note||'No note');
scope.windows.watch(message=>document.getElementById('message').textContent=message.value.selection);
document.getElementById('a').onclick=()=>scope.windows.open({title:'Project A window',html:${scriptString(childA)},context:{project:'A',nodeId:'PR_1'}});
document.getElementById('b').onclick=()=>scope.windows.open({title:'Project B window',html:${scriptString(childB)},context:{project:'B',nodeId:'PR_2'}});
document.getElementById('batch').onclick=()=>scope.pullRequests.loadDetails(['PR_2']).then(results=>document.getElementById('result').textContent=results[0].detail.body);
</script>`;

test("authored windows share snapshots, context, messages and detail interests and preserve drafts when closing fails", async () => {
  const ghDirectory = await mkdtemp(join(tmpdir(), "scope-windows-gh-"));
  await writeFile(join(ghDirectory, "gh"), '#!/bin/sh\necho "Synthetic offline" >&2\nexit 1\n', {
    mode: 0o700,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${ghDirectory}:${previousPath}`;
  let fixture: Awaited<ReturnType<typeof desktopFixture>>;
  try {
    fixture = await desktopFixture();
  } finally {
    process.env.PATH = previousPath;
  }
  const app = await fixture.launch();
  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(8_000);
    const artifact = await page.evaluate(
      async (html) =>
        window.scope.createPullRequests({
          name: "window-inbox",
          title: "Project windows",
          html,
          repository: { owner: "synthetic", name: "project" },
        }),
      html,
    );
    const client = await fixture.connect();
    const initial = await client.pullRequests({ action: "read", name: "window-inbox" });
    if (initial.type !== "snapshot") throw new Error("Expected inbox snapshot");
    await app.evaluate(
      ({ ipcMain, BrowserWindow, shell }, snapshot) => {
        const state = {
          snapshot,
          interests: [] as { active: boolean; details: { nodeId: string }[] }[],
          batches: [] as string[][],
          urls: [] as string[],
          noteCalls: 0,
          holdNoteReply: false,
          releaseNote: undefined as (() => void) | undefined,
        };
        Object.assign(globalThis, { windowInboxTest: state });
        shell.openExternal = async (url) => {
          state.urls.push(url);
        };
        ipcMain.removeHandler("scope:pull-requests-interest");
        ipcMain.handle("scope:pull-requests-interest", (_event, value) => {
          state.interests.push(value);
        });
        ipcMain.removeHandler("scope:pull-requests-command");
        ipcMain.handle("scope:pull-requests-command", async (_event, command) => {
          if (command.action === "note") {
            state.noteCalls++;
            const row = state.snapshot.prs.find((pr) => pr.nodeId === command.nodeId)!;
            if (row.local.noteVersion !== command.expectedVersion)
              throw new Error("Note version conflict");
            state.snapshot = {
              ...state.snapshot,
              generation: state.snapshot.generation + 1,
              prs: state.snapshot.prs.map((pr) =>
                pr === row
                  ? {
                      ...pr,
                      local: {
                        ...pr.local,
                        note: command.text,
                        noteVersion: pr.local.noteVersion + 1,
                      },
                    }
                  : pr,
              ),
            };
            BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-changed", {
              name: "window-inbox",
              id: snapshot.artifact.id,
            });
            if (state.holdNoteReply) {
              state.holdNoteReply = false;
              await new Promise<void>((resolve) => {
                state.releaseNote = resolve;
              });
              state.releaseNote = undefined;
            }
          }
          if (command.action === "details") {
            state.batches.push(command.nodeIds);
            return {
              type: "details",
              tabId: snapshot.tabId,
              results: command.nodeIds.map((nodeId: string) => ({
                nodeId,
                captured: { headOid: "a".repeat(40), baseOid: "b".repeat(40) },
                detail: {
                  headOid: "a".repeat(40),
                  body: "Candidate ready",
                  diff: "",
                  files: [],
                  reviews: [],
                  fetchedAt: "2026-10-01T12:00:00.000Z",
                },
              })),
            };
          }
          return { type: "snapshot", snapshot: state.snapshot };
        });
        BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-reconnected");
      },
      { ...initial.snapshot, prs: [pr(1), pr(2)] },
    );
    const main = page.frameLocator(".pull-requests-document");
    await main.getByText("No note", { exact: true }).waitFor();
    await main.getByLabel("Main draft").fill("Keep main mounted");
    await main.getByRole("button", { name: "Preload candidate" }).click();
    await main.getByText("Candidate ready", { exact: true }).waitFor();
    expect(
      await app.evaluate(
        () =>
          (globalThis as unknown as { windowInboxTest: { batches: string[][] } }).windowInboxTest
            .batches,
      ),
    ).toEqual([["PR_2"]]);
    await main.getByRole("button", { name: "Open project A" }).click();
    const aChrome = page.getByRole("dialog", { name: "Project A window" });
    const a = aChrome.frameLocator("iframe");
    await a.getByText("A PR_1", { exact: true }).waitFor();
    await page.evaluate(() => {
      const frame = document.querySelector<HTMLIFrameElement>(".pull-requests-document")!;
      frame.contentDocument!.getElementById("b")!.click();
    });
    const bChrome = page.getByRole("dialog", { name: "Project B window" });
    const b = bChrome.frameLocator("iframe");
    await b.getByText("B PR_2", { exact: true }).waitFor();
    await expect
      .poll(() =>
        app.evaluate(() =>
          (
            globalThis as unknown as {
              windowInboxTest: { interests: { details: { nodeId: string }[] }[] };
            }
          ).windowInboxTest.interests
            .at(-1)
            ?.details.map((detail) => detail.nodeId)
            .sort(),
        ),
      )
      .toEqual(["PR_1", "PR_2"]);
    await client.publish(
      "other-window-tab",
      {
        title: "Other tab",
        kind: "html",
        mediaType: "text/html",
        fileName: "other.html",
        expectedRevision: 0,
      },
      Buffer.from("<h1>Other tab content</h1>"),
    );
    await page.getByRole("tab", { name: "Other tab", exact: true }).click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-reconnected"),
    );
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as unknown as { windowInboxTest: { interests: { active: boolean }[] } }
            ).windowInboxTest.interests.at(-1)?.active,
        ),
      )
      .toBe(false);
    await page.getByRole("tab", { name: "Project windows", exact: true }).click();
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-reconnected"),
    );
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as unknown as { windowInboxTest: { interests: { active: boolean }[] } }
            ).windowInboxTest.interests.at(-1)?.active,
        ),
      )
      .toBe(true);
    expect(await a.getByText("A PR_1", { exact: true }).count()).toBe(1);
    await app.evaluate(() => {
      (
        globalThis as unknown as { windowInboxTest: { holdNoteReply: boolean } }
      ).windowInboxTest.holdNoteReply = true;
    });
    await b.getByLabel("Window draft").fill("Saved from B");
    await b.getByRole("button", { name: "Save in window" }).click();
    await a.getByText("Saved from B", { exact: true }).waitFor();
    await main.getByText("Saved from B", { exact: true }).waitFor();
    await b.getByRole("button", { name: "Tell siblings" }).click();
    await main.getByText("chosen", { exact: true }).waitFor();
    await expect.poll(() => a.locator("#message").textContent()).toMatch(/:chosen$/);
    await app.evaluate(
      ({ BrowserWindow }, tabId) =>
        BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-detail-update", {
          tabId,
          nodeId: "PR_2",
          headOid: "a".repeat(40),
          baseOid: "b".repeat(40),
          body: "Second watched PR refreshed",
          reviews: [],
          fetchedAt: "2026-10-01T12:01:00.000Z",
          error: null,
        }),
      initial.snapshot.tabId,
    );
    await a.getByText("Second watched PR refreshed", { exact: true }).waitFor();
    await b.getByRole("button", { name: "Open nested" }).click();
    const nestedChrome = page.getByRole("dialog", { name: "Nested content" });
    const nested = nestedChrome.frameLocator("iframe");
    await nested.getByLabel("Nested draft").fill("Temporary nested draft");
    await nested.getByLabel("Nested draft").press("Escape");
    await nestedChrome.waitFor({ state: "hidden" });
    await expect
      .poll(() =>
        b
          .getByRole("button", { name: "Open nested" })
          .evaluate((element) => document.activeElement === element),
      )
      .toBe(true);
    await b.getByRole("link", { name: "Project link" }).click();
    const beforeCloseCalls = await b.locator("body").evaluate(() => {
      const state = window as unknown as { beforeCloseCalls?: number; closeRequested?: boolean };
      state.closeRequested = false;
      addEventListener("message", (event) => {
        if (event.data?.type === "scope-pull-requests-close") state.closeRequested = true;
      });
      return state.beforeCloseCalls ?? 0;
    });
    await bChrome.getByRole("button", { name: "Close content window" }).click();
    await expect
      .poll(() =>
        b
          .locator("body")
          .evaluate(() => (window as unknown as { closeRequested?: boolean }).closeRequested),
      )
      .toBe(true);
    expect(
      await b
        .locator("body")
        .evaluate(() => (window as unknown as { beforeCloseCalls?: number }).beforeCloseCalls ?? 0),
    ).toBe(beforeCloseCalls);
    await app.evaluate(() => {
      (
        globalThis as unknown as { windowInboxTest: { releaseNote?: () => void } }
      ).windowInboxTest.releaseNote?.();
    });
    await bChrome.waitFor({ state: "hidden" });
    expect(
      await app.evaluate(
        () =>
          (globalThis as unknown as { windowInboxTest: { noteCalls: number } }).windowInboxTest
            .noteCalls,
      ),
    ).toBe(1);
    await a.getByRole("link", { name: "Project link" }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as unknown as { windowInboxTest: { urls: string[] } }).windowInboxTest.urls
              .length,
        ),
      )
      .toBe(2);
    await a.getByLabel("Window draft").fill("consume");
    await a.getByLabel("Window draft").press("Escape");
    await a.getByText("Escape consumed", { exact: true }).waitFor();
    expect(await aChrome.count()).toBe(1);
    await a.getByLabel("Window draft").fill("blocked");
    await aChrome.getByRole("button", { name: "Maximize content window" }).click();
    await aChrome.getByRole("button", { name: "Close content window" }).click();
    await page.getByRole("alert").getByText("Keep this draft", { exact: false }).waitFor();
    expect(await a.getByLabel("Window draft").inputValue()).toBe("blocked");
    const closeAlert = (await page.getByRole("alert").boundingBox())!;
    expect((await aChrome.boundingBox())!.y).toBeGreaterThanOrEqual(
      closeAlert.y + closeAlert.height - 1,
    );
    const current = await client.get(artifact.id);
    await client.publish(
      artifact.id,
      {
        name: "window-inbox",
        title: "Project windows",
        kind: "pull-requests",
        mediaType: "text/html",
        fileName: "inbox.html",
        expectedRevision: current.revision,
      },
      Buffer.from("<h1>Incoming app</h1>"),
    );
    await page.getByRole("alert").getByText("Keep this draft", { exact: false }).waitFor();
    expect(await main.getByLabel("Main draft").inputValue()).toBe("Keep main mounted");
    const replacementAlert = (await page.getByRole("alert").boundingBox())!;
    expect((await aChrome.boundingBox())!.y).toBeGreaterThanOrEqual(
      replacementAlert.y + replacementAlert.height - 1,
    );
    await a.getByLabel("Window draft").fill("Flushed on close");
    await a.getByLabel("Window draft").press("Escape");
    await aChrome.waitFor({ state: "hidden" });
    await main.getByText("Flushed on close", { exact: true }).waitFor();
    expect(await main.getByLabel("Main draft").inputValue()).toBe("Keep main mounted");
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as unknown as { windowInboxTest: { interests: { details: unknown[] }[] } }
            ).windowInboxTest.interests.at(-1)?.details,
        ),
      )
      .toEqual([]);
    await page.getByRole("alert").getByRole("button", { name: "Retry" }).click();
    await page
      .frameLocator(".pull-requests-document")
      .getByText("Incoming app", { exact: true })
      .waitFor();
  } finally {
    await app.evaluate(() => {
      (
        globalThis as unknown as { windowInboxTest?: { releaseNote?: () => void } }
      ).windowInboxTest?.releaseNote?.();
    });
    const page = await app.firstWindow();
    await page.evaluate(() => {
      for (const frame of document.querySelectorAll<HTMLIFrameElement>(".scope-content-document")) {
        const draft = frame.contentDocument?.getElementById("draft") as HTMLInputElement | null;
        if (draft) draft.value = "";
      }
    });
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(ghDirectory, { recursive: true, force: true });
  }
}, 60_000);
