import { expect, test } from "vite-plus/test";
import { mkdir, rm, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ElectronApplication } from "@playwright/test";
import type { Artifact } from "@irudd-scope/protocol";
import type { PullRequest, PullRequestsSnapshot } from "@irudd-scope/protocol/pull-requests";
import { desktopFixture } from "./desktop-fixture.ts";

type Mutable<T> = { -readonly [K in keyof T]: T[K] extends object ? Mutable<T[K]> : T[K] };
const head = "a".repeat(40),
  newerHead = "b".repeat(40),
  base = "c".repeat(40);
const at = "2026-09-30T12:00:00.000Z";
async function offlineFixture() {
  const ghDirectory = await mkdtemp(join(tmpdir(), "scope-pr-gh-"));
  await writeFile(join(ghDirectory, "gh"), '#!/bin/sh\necho "Synthetic offline gh" >&2\nexit 1\n', {
    mode: 0o700,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = ghDirectory + ":" + previousPath;
  try {
    return { ...(await desktopFixture()), ghDirectory };
  } finally {
    process.env.PATH = previousPath;
  }
}

function pr(number: number): PullRequest {
  return {
    nodeId: `PR_${number}`,
    number,
    title: `Keep the current review stable ${number}`,
    author: "colleague",
    labels: ["enhancement"],
    requestedReviewers: ["viewer"],
    createdAt: at,
    updatedAt: at,
    headOid: head,
    headRefName: "feature",
    baseOid: base,
    draft: false,
    additions: 14,
    deletions: 3,
    changedFiles: 2,
    url: `https://github.com/synthetic/project/pull/${number}`,
    merge: { status: "unknown", headOid: head, baseOid: base, observedAt: at },
    checks: { status: "failing", headOid: newerHead, observedAt: at },
    hasUnresolvedConversations: true,
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
async function installCommands(application: ElectronApplication, snapshot: PullRequestsSnapshot) {
  await application.evaluate(({ ipcMain, BrowserWindow }, initial) => {
    type State = {
      snapshot: Mutable<typeof initial>;
      failNote: boolean;
      failSync: boolean;
      reads: number;
      held: { snapshot: Mutable<typeof initial>; resolve: (value: unknown) => void } | null;
      holdRead: boolean;
    };
    const state: State = {
      snapshot: initial as Mutable<typeof initial>,
      failNote: false,
      failSync: false,
      reads: 0,
      held: null,
      holdRead: false,
    };
    Object.assign(globalThis, { prInboxTest: state });
    const notify = () =>
      BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-changed", {
        type: "pull-requests",
        name: initial.artifact.name,
        id: state.snapshot.artifact.id,
        generation: state.snapshot.generation,
      });
    ipcMain.removeHandler("scope:pull-requests-command");
    ipcMain.handle("scope:pull-requests-command", (_event, command) => {
      if (command.action === "read") {
        state.reads++;
        if (state.holdRead) {
          state.holdRead = false;
          return new Promise((resolve) => {
            state.held = { snapshot: structuredClone(state.snapshot), resolve };
          });
        }
        return { type: "snapshot", snapshot: state.snapshot };
      }
      if (command.action === "sync") {
        state.snapshot.sync = {
          ...state.snapshot.sync,
          state: state.failSync ? "error" : "idle",
          error: state.failSync ? "Synthetic offline failure" : null,
        };
        state.snapshot.generation++;
        notify();
        if (state.failSync) throw new Error("Synthetic offline failure");
      } else {
        const row = state.snapshot.prs.find((p) => p.nodeId === command.nodeId)!;
        if (command.action === "detail")
          return {
            type: "detail",
            tabId: state.snapshot.tabId,
            nodeId: row.nodeId,
            detail: {
              headOid: row.headOid,
              body: "A synthetic pull request description.",
              diff: "diff --git a/example.ts b/example.ts\n+const value = 1;",
              reviews: [
                {
                  id: "review-1",
                  author: "reviewer",
                  state: "COMMENTED",
                  body: "Check this path.",
                  submittedAt: initial.sync.updatedAt,
                  headOid: row.headOid,
                },
              ],
              files: [{ path: "example.ts", additions: 1, deletions: 0, status: "modified" }],
              fetchedAt: initial.sync.updatedAt,
            },
          };
        if (command.action === "note") {
          if (state.failNote) throw new Error("Synthetic note save failure");
          row.local.note = command.text;
          row.local.noteVersion++;
        }
        if (command.action === "snooze") {
          row.local.snooze = command.snooze;
          row.local.snoozeVersion++;
        }
        if (command.action === "review") {
          row.local[command.baseline as "inspected" | "reviewed"] = {
            headOid: command.headOid,
            at: "2026-10-01T12:00:00.000Z",
          };
          row.local.reviewVersion++;
        }
        state.snapshot.generation++;
        notify();
      }
      return { type: "snapshot", snapshot: state.snapshot };
    });
  }, snapshot);
}
async function sendChange(
  application: ElectronApplication,
  change: "new-head" | "reconnect" | "release" | "note-error" | "note-ok" | "sync-error",
) {
  await application.evaluate(({ BrowserWindow }, action) => {
    const state = (
      globalThis as unknown as {
        prInboxTest: {
          snapshot: Mutable<PullRequestsSnapshot>;
          failNote: boolean;
          failSync: boolean;
          held: {
            snapshot: Mutable<PullRequestsSnapshot>;
            resolve: (value: unknown) => void;
          } | null;
        };
      }
    ).prInboxTest;
    if (action === "note-error") {
      state.failNote = true;
      return;
    }
    if (action === "note-ok") {
      state.failNote = false;
      return;
    }
    if (action === "sync-error") {
      state.failSync = true;
      return;
    }
    if (action === "release") {
      state.held?.resolve({ type: "snapshot", snapshot: state.held.snapshot });
      state.held = null;
      return;
    }
    if (action === "new-head") {
      state.snapshot.prs[0].headOid = "b".repeat(40);
      state.snapshot.prs[0].title = "New head while inspecting";
      state.snapshot.generation++;
    }
    BrowserWindow.getAllWindows()[0]!.webContents.send(
      action === "reconnect" ? "scope:pull-requests-reconnected" : "scope:pull-requests-changed",
      {
        type: "pull-requests",
        name: state.snapshot.artifact.name,
        id: state.snapshot.artifact.id,
        generation: state.snapshot.generation,
      },
    );
  }, change);
}
async function publish(
  app: ElectronApplication,
  html: string,
  name: string,
): Promise<{ artifact: Artifact; tabId: string }> {
  const page = await app.firstWindow();
  const artifact = await page.evaluate(
    async ({ html, name }) =>
      window.scope.createPullRequests({
        name,
        title: "Synthetic PR inbox",
        html,
        repository: { owner: "synthetic", name: "project" },
      }),
    { html, name },
  );
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.scope.workspace()))?.tabs.some(
        (t) => t.type === "pull-requests",
      ),
    )
    .toBe(true);
  const workspace = await page.evaluate(() => window.scope.workspace());
  return {
    artifact,
    tabId: workspace!.tabs.find((t) => t.state.data.artifactId === artifact.id)!.id,
  };
}
async function createStarterInbox(app: ElectronApplication) {
  const page = await app.firstWindow();
  page.setDefaultTimeout(5_000);
  await page.getByRole("button", { name: "Search and controls" }).click();
  await page.getByRole("button", { name: "Create PR inbox", exact: true }).click();
  await page.getByLabel("Repository", { exact: true }).fill("synthetic/project");
  await page.getByLabel("Title", { exact: true }).fill("Synthetic PR inbox");
  await page.getByLabel("Name, optional", { exact: true }).fill("default-inbox");
  await page.getByRole("button", { name: "Create PR inbox", exact: true }).click();
  await page.locator(".pull-requests-document").waitFor();
  const workspace = await page.evaluate(() => window.scope.workspace());
  const tab = workspace!.tabs.find((t) => t.type === "pull-requests")!;
  expect(
    (await page.evaluate(() => window.scope.retainedTabs())).find((t) => t.tab.id === tab.id)
      ?.permanent,
  ).toBe(true);
  const library = await page.evaluate(() => window.scope.artifactLibrary());
  return {
    artifact: library.artifacts.find((a) => a.id === tab.state.data.artifactId)!,
    tabId: tab.id,
  };
}
function snapshot(artifact: Artifact, tabId: string): PullRequestsSnapshot {
  return {
    artifact,
    tabId,
    generation: 100,
    repository: { owner: "synthetic", name: "project" },
    viewer: "viewer",
    sync: { state: "idle", updatedAt: at, lastSuccessAt: at, error: null },
    prs: [pr(1), pr(2)],
  };
}

test("the inbox SDK runs before authored scripts and recovers updates without replacing the frame", async () => {
  const fixture = await offlineFixture();
  const app = await fixture.launch();
  try {
    const html = `<!doctype html><script>window.firstScriptSDK=!!window.scope.pullRequests;window.boots=1;window.snapshots=[];window.stop=window.scope.pullRequests.watch((prs,context,sync)=>{window.snapshots.push({title:prs[0]?.title,head:prs[0]?.headOid,viewer:context.viewer,frozen:Object.isFrozen(prs)&&Object.isFrozen(prs[0]?.local)});document.getElementById('title')&&(document.getElementById('title').textContent=prs[0]?.title||'Empty')});</script><h1 id="title">Loading</h1><input aria-label="Authored draft">`;
    const { artifact, tabId } = await publish(app, html, "sdk-inbox");
    await installCommands(app, snapshot(artifact, tabId));
    await sendChange(app, "reconnect");
    const page = await app.firstWindow(),
      frame = page.frameLocator(".pull-requests-document");
    await frame.getByRole("heading", { name: "Keep the current review stable 1" }).waitFor();
    const actual = page.frames().find((f) => f.url() === "about:srcdoc")!;
    expect(
      await actual.evaluate(
        () => (window as unknown as { firstScriptSDK: boolean }).firstScriptSDK,
      ),
    ).toBe(true);
    expect(
      await actual.evaluate(
        () => (window as unknown as { snapshots: { frozen: boolean }[] }).snapshots.at(-1)?.frozen,
      ),
    ).toBe(true);
    await frame.getByLabel("Authored draft").fill("Keep my app state");
    await app.evaluate(({ BrowserWindow }) => {
      const state = (globalThis as unknown as { prInboxTest: { holdRead: boolean } }).prInboxTest;
      state.holdRead = true;
      BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-reconnected");
    });
    await expect
      .poll(async () =>
        app.evaluate(
          () => !!(globalThis as unknown as { prInboxTest: { held: unknown } }).prInboxTest.held,
        ),
      )
      .toBe(true);
    await sendChange(app, "new-head");
    await sendChange(app, "release");
    await frame.getByRole("heading", { name: "New head while inspecting" }).waitFor();
    expect(await frame.getByLabel("Authored draft").inputValue()).toBe("Keep my app state");
    expect(await actual.evaluate(() => (window as unknown as { boots: number }).boots)).toBe(1);
    await actual.evaluate(() => (window as unknown as { stop: () => void }).stop());
    const count = await actual.evaluate(
      () => (window as unknown as { snapshots: unknown[] }).snapshots.length,
    );
    await actual.evaluate(() => {
      const frame = window as unknown as {
        receivedAfterUnsubscribe: boolean;
        scope: {
          pullRequests: { watch: (callback: (prs: { title: string }[]) => void) => () => void };
        };
      };
      frame.receivedAfterUnsubscribe = false;
      frame.scope.pullRequests.watch((prs) => {
        if (prs[0]?.title === "After unsubscribe") frame.receivedAfterUnsubscribe = true;
      });
    });
    await app.evaluate(({ BrowserWindow }) => {
      const state = (
        globalThis as unknown as { prInboxTest: { snapshot: Mutable<PullRequestsSnapshot> } }
      ).prInboxTest;
      state.snapshot.prs[0].title = "After unsubscribe";
      state.snapshot.generation++;
      BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-changed", {
        type: "pull-requests",
        name: state.snapshot.artifact.name,
        id: state.snapshot.artifact.id,
        generation: state.snapshot.generation,
      });
    });
    await expect
      .poll(() =>
        actual.evaluate(
          () =>
            (window as unknown as { receivedAfterUnsubscribe: boolean }).receivedAfterUnsubscribe,
        ),
      )
      .toBe(true);
    expect(
      await actual.evaluate(() => (window as unknown as { snapshots: unknown[] }).snapshots.length),
    ).toBe(count);
  } finally {
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(fixture.ghDirectory, { recursive: true, force: true });
  }
});

test("the default inbox keeps a captured review queue, note edits, snooze undo, and current commit baselines", async () => {
  const fixture = await offlineFixture();
  const app = await fixture.launch();
  const evidence = "/tmp/scope-pr-inbox-build/ui-evidence";
  try {
    await mkdir(evidence, { recursive: true });
    const { artifact, tabId } = await createStarterInbox(app);
    await installCommands(app, snapshot(artifact, tabId));
    await sendChange(app, "reconnect");
    const page = await app.firstWindow(),
      frame = page.frameLocator(".pull-requests-document");
    await frame
      .getByRole("button", { name: "Keep the current review stable 1", exact: true })
      .waitFor();
    expect(
      await frame.getByText("CI unknown · Merge unknown · Author's turn", { exact: true }).count(),
    ).toBe(2);
    await page.screenshot({ path: join(evidence, "inbox-light.png") });
    await frame
      .getByRole("button", { name: "Keep the current review stable 1", exact: true })
      .click();
    await frame.getByText("A synthetic pull request description.", { exact: true }).waitFor();
    await frame.getByRole("button", { name: "Mark current commit reviewed" }).click();
    await frame.getByText("This commit is marked reviewed.").waitFor();
    await sendChange(app, "note-error");
    await frame.getByLabel("Your notes").fill("Keep this note after a failure");
    await frame.getByRole("button", { name: "Save note", exact: true }).click();
    await frame.getByText(/Your edits are kept here/).waitFor();
    await sendChange(app, "new-head");
    await frame.getByRole("heading", { name: "New head while inspecting" }).waitFor();
    expect(await frame.getByLabel("Your notes").inputValue()).toBe(
      "Keep this note after a failure",
    );
    await frame.getByText("Changed since your review of " + head.slice(0, 12)).waitFor();
    expect(
      await app.evaluate(
        () =>
          (globalThis as unknown as { prInboxTest: { snapshot: PullRequestsSnapshot } }).prInboxTest
            .snapshot.prs[0].local.reviewed?.headOid,
      ),
    ).toBe(head);
    await sendChange(app, "note-ok");
    await frame.getByRole("button", { name: "Save note", exact: true }).click();
    await frame.getByText("Saved", { exact: true }).waitFor();
    await frame.getByRole("button", { name: "Mark current commit reviewed" }).click();
    await frame.getByText("This commit is marked reviewed.").waitFor();
    expect(
      await app.evaluate(
        () =>
          (globalThis as unknown as { prInboxTest: { snapshot: PullRequestsSnapshot } }).prInboxTest
            .snapshot.prs[0].local.reviewed?.headOid,
      ),
    ).toBe(newerHead);
    await frame.getByRole("button", { name: "Snooze pull request", exact: true }).click();
    await frame.getByRole("button", { name: "2 hours", exact: true }).click();
    await frame.getByRole("button", { name: "Next pull request" }).click();
    await frame.getByRole("heading", { name: "Keep the current review stable 2" }).waitFor();
    await frame.getByRole("button", { name: "Previous pull request" }).click();
    await frame.getByRole("heading", { name: "New head while inspecting" }).waitFor();
    await frame.getByRole("button", { name: "Undo", exact: true }).click();
    await frame.getByText("In your inbox", { exact: true }).waitFor();
    await page.screenshot({ path: join(evidence, "review-light.png") });
    await frame.getByRole("button", { name: "Back to inbox" }).click();
    await sendChange(app, "sync-error");
    await frame.getByRole("button", { name: "Sync pull requests" }).click();
    await expect
      .poll(() =>
        frame.getByRole("button", { name: "Sync pull requests" }).getAttribute("data-failed"),
      )
      .toBe("true");
    expect(await page.getByRole("alert").count()).toBe(0);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(560, 620),
    );
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await frame.getByRole("button", { name: "New head while inspecting", exact: true }).click();
    await page.screenshot({ path: join(evidence, "review-narrow-dark.png") });
    const width = await page
      .frames()
      .find((f) => f.url() === "about:srcdoc")!
      .evaluate(() => ({
        width: innerWidth,
        content: document.documentElement.scrollWidth,
        theme: document.documentElement.dataset.theme,
      }));
    expect(width.content).toBe(width.width);
    expect(width.theme).toBe("dark");
    const styles = await page
      .frames()
      .find((f) => f.url() === "about:srcdoc")!
      .evaluate(() => ({
        background: getComputedStyle(document.body).backgroundColor,
        font: getComputedStyle(document.body).fontFamily,
      }));
    expect(styles.background).toBe("rgb(18, 18, 18)");
    expect(styles.font).toContain("system-ui");
    await frame.getByLabel("Your notes").fill("Flush this note before closing");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.webContents.send("scope:before-close"),
    );
    await expect
      .poll(async () =>
        app.evaluate(
          () =>
            (globalThis as unknown as { prInboxTest: { snapshot: PullRequestsSnapshot } })
              .prInboxTest.snapshot.prs[0].local.note,
        ),
      )
      .toBe("Flush this note before closing");
  } finally {
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(fixture.ghDirectory, { recursive: true, force: true });
  }
});
