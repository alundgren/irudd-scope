import { expect, test } from "vite-plus/test";
import { mkdir, rm, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ElectronApplication } from "@playwright/test";
import type { Artifact } from "@irudd-scope/protocol";
import type {
  PullRequest,
  PullRequestsSnapshot,
  PullRequestsCommand,
} from "@irudd-scope/protocol/pull-requests";
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
    return { ...(await desktopFixture({ hideInitialPrompts: true })), ghDirectory };
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
      holdSync: boolean;
      releaseSync: (() => void) | null;
      holdNextNote: boolean;
      releaseNote: (() => void) | null;
      reads: number;
      held: { snapshot: Mutable<typeof initial>; resolve: (value: unknown) => void } | null;
      holdRead: boolean;
      calls: PullRequestsCommand[];
      interests: {
        tabId: string;
        active: boolean;
        details: { nodeId: string; headOid: string; baseOid: string }[];
      }[];
    };
    const state: State = {
      snapshot: initial as Mutable<typeof initial>,
      failNote: false,
      failSync: false,
      holdSync: false,
      releaseSync: null,
      holdNextNote: false,
      releaseNote: null,
      reads: 0,
      held: null,
      holdRead: false,
      calls: [],
      interests: [],
    };
    Object.assign(globalThis, { prInboxTest: state });
    ipcMain.removeHandler("scope:pull-requests-interest");
    ipcMain.handle("scope:pull-requests-interest", (_event, interest) => {
      state.interests.push(structuredClone(interest));
    });
    const notify = () =>
      BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-changed", {
        type: "pull-requests",
        name: initial.artifact.name,
        id: state.snapshot.artifact.id,
        generation: state.snapshot.generation,
      });
    ipcMain.removeHandler("scope:pull-requests-command");
    ipcMain.handle("scope:pull-requests-command", async (_event, incoming) => {
      const command = structuredClone(incoming);
      state.calls.push(structuredClone(command));
      if (command.action !== "read" && command.tabId !== state.snapshot.tabId)
        throw new Error("Synthetic wrong tab incarnation");
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
        if (state.holdSync) {
          state.holdSync = false;
          return new Promise((resolve) => {
            state.releaseSync = () => {
              state.releaseSync = null;
              resolve({ type: "snapshot", snapshot: state.snapshot });
            };
          });
        }
      } else {
        if (command.action === "note" && state.holdNextNote) {
          state.holdNextNote = false;
          await new Promise<void>((resolve) => {
            state.releaseNote = () => {
              state.releaseNote = null;
              resolve();
            };
          });
        }
        const row = state.snapshot.prs.find((p) => p.nodeId === command.nodeId)!;
        if (command.action === "detail") {
          if (
            command.captured &&
            (command.captured.headOid !== row.headOid || command.captured.baseOid !== row.baseOid)
          )
            throw new Error(
              "This comparison changed. Load the latest comparison to view its details.",
            );
          return {
            type: "detail",
            tabId: state.snapshot.tabId,
            nodeId: row.nodeId,
            detail: {
              headOid: row.headOid,
              body: "A synthetic pull request description.",
              diff:
                "diff --git a/example.ts b/example.ts\n--- a/example.ts\n+++ b/example.ts\n@@ -0,0 +1 @@\n+const commit = " +
                row.headOid +
                ";",
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
        }
        if (command.action === "note") {
          if (command.expectedVersion !== row.local.noteVersion)
            throw new Error("Synthetic note version conflict");
          if (state.failNote) throw new Error("Synthetic note save failure");
          row.local.note = command.text;
          row.local.noteVersion++;
        }
        if (command.action === "snooze") {
          if (command.expectedVersion !== row.local.snoozeVersion)
            throw new Error("Synthetic snooze version conflict");
          row.local.snooze = command.snooze;
          row.local.snoozeVersion++;
        }
        if (command.action === "review") {
          if (command.expectedVersion !== row.local.reviewVersion)
            throw new Error("Synthetic review version conflict");
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

test("live reviews preserve captured code and drafts, and closing the pane stops its subscription", async () => {
  const fixture = await offlineFixture();
  const app = await fixture.launch();
  try {
    const { artifact, tabId } = await createStarterInbox(app, fixture);
    await installCommands(app, {
      ...snapshot(artifact, tabId),
      prs: [pr(1)],
      sync: {
        state: "idle",
        updatedAt: at,
        lastSuccessAt: at,
        error: null,
        intervalMs: 300_000,
        nextAttemptAt: null,
        reason: "Adaptive account budget",
      },
    });
    await sendChange(app, "reconnect");
    const page = await app.firstWindow();
    const frame = page.frameLocator(".pull-requests-document");
    await frame
      .getByRole("button", { name: "Keep the current review stable 1", exact: true })
      .click();
    await frame.getByText("A synthetic pull request description.", { exact: true }).waitFor();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as unknown as {
                prInboxTest: { interests: { details: { nodeId: string }[] }[] };
              }
            ).prInboxTest.interests.at(-1)?.details[0]?.nodeId,
        ),
      )
      .toBe("PR_1");
    await page.getByRole("status").filter({ hasText: "Refresh target 5 minutes" }).waitFor();
    await frame.getByRole("button", { name: "Discussion", exact: true }).click();
    await frame.getByLabel("Your notes").fill("Keep my unfinished note");
    const update = {
      tabId,
      nodeId: "PR_1",
      headOid: head,
      baseOid: base,
      body: "Updated description",
      fetchedAt: "2026-10-02T12:00:00.000Z",
      error: null,
      reviews: [
        {
          id: "review-2",
          author: "reviewer",
          state: "APPROVED",
          body: "Live review arrived",
          submittedAt: at,
          headOid: head,
        },
      ],
    };
    await app.evaluate(({ BrowserWindow }, value) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send(
        "scope:pull-requests-detail-update",
        value,
      );
    }, update);
    await frame.getByText("reviewer · APPROVED\nLive review arrived", { exact: true }).waitFor();
    expect(await frame.getByLabel("Your notes").inputValue()).toBe("Keep my unfinished note");
    await frame.getByRole("button", { name: "Diff", exact: true }).click();
    const diffWindow = page.frameLocator(".scope-content-document");
    await diffWindow.getByText("const commit = " + head + ";").waitFor();
    await sendChange(app, "new-head");
    await frame
      .getByRole("button", { name: "New commit available · Load latest commit" })
      .waitFor();
    expect(await frame.locator("#head").textContent()).toBe(head.slice(0, 12));
    await diffWindow.getByText("const commit = " + head + ";").waitFor();
    await diffWindow.getByRole("button", { name: "Load latest comparison" }).waitFor();
    await app.evaluate(
      ({ BrowserWindow }, value) => {
        BrowserWindow.getAllWindows()[0]!.webContents.send(
          "scope:pull-requests-detail-update",
          value,
        );
      },
      {
        ...update,
        headOid: newerHead,
        body: "Wrong captured commit",
        fetchedAt: "2026-10-02T12:01:00.000Z",
      },
    );
    await page
      .getByRole("dialog", { name: "Changes in #1" })
      .getByRole("button", { name: "Close content window" })
      .click();
    await frame.getByRole("button", { name: "Body", exact: true }).click();
    await expect.poll(() => frame.locator("#content").textContent()).toBe("Updated description");
    await frame.getByRole("button", { name: "Back to inbox" }).click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (
              globalThis as unknown as { prInboxTest: { interests: { details: unknown[] }[] } }
            ).prInboxTest.interests.at(-1)?.details,
        ),
      )
      .toEqual([]);
    await app.evaluate(
      ({ BrowserWindow }, value) => {
        BrowserWindow.getAllWindows()[0]!.webContents.send(
          "scope:pull-requests-detail-update",
          value,
        );
      },
      { ...update, body: "After unsubscribe", fetchedAt: "2026-10-02T12:02:00.000Z" },
    );
    await expect.poll(() => frame.locator("#content").textContent()).toBe("Updated description");
    await mkdir("/tmp/scope-adaptive-live-sync", { recursive: true });
    await page.screenshot({ path: "/tmp/scope-adaptive-live-sync/inbox-light.png" });
    await page.setViewportSize({ width: 680, height: 720 });
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Appearance", exact: true }).click();
    await page.getByLabel("Appearance", { exact: true }).selectOption("dark");
    await page
      .getByRole("dialog", { name: "Settings", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark");
    await expect
      .poll(() => page.getByRole("dialog", { name: "Settings", exact: true }).count())
      .toBe(0);
    await page.screenshot({ path: "/tmp/scope-adaptive-live-sync/inbox-dark-narrow.png" });
    await app.evaluate(({ BrowserWindow }) => {
      const state = (
        globalThis as unknown as {
          prInboxTest: {
            snapshot: {
              sync: { state: string; error: string | null; nextAttemptAt: string | null };
            };
          };
        }
      ).prInboxTest;
      state.snapshot.sync.state = "error";
      state.snapshot.sync.error = "GitHub temporarily unavailable";
      state.snapshot.sync.nextAttemptAt = "2026-10-02T12:05:00.000Z";
      BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-reconnected");
    });
    const failedStatus = page
      .getByRole("status")
      .filter({ hasText: "GitHub temporarily unavailable" });
    await expect.poll(() => failedStatus.textContent()).toContain("Updated ");
    await expect.poll(() => failedStatus.textContent()).toContain("Retrying at ");
  } finally {
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(fixture.ghDirectory, { recursive: true, force: true });
  }
});

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

async function createStarterInbox(
  app: ElectronApplication,
  fixture: Awaited<ReturnType<typeof desktopFixture>>,
) {
  const page = await app.firstWindow();
  page.setDefaultTimeout(5_000);
  const html = (
    await readFile("apps/desktop/src/plugins/pull-requests/starter.html", "utf8")
  ).replaceAll(
    "/* SCOPE_TOKENS */",
    await readFile("apps/desktop/src/renderer/tokens.css", "utf8"),
  );
  const file = join(fixture.directory, "starter-inbox.html");
  await writeFile(file, html);
  await fixture.cli(
    "add",
    file,
    "--pull-requests",
    "--name",
    "default-inbox",
    "--title",
    "Synthetic PR inbox",
  );
  await fixture.cli("pull-requests", "configure", "default-inbox", "synthetic/project");
  await page.locator(".pull-requests-document").waitFor();
  const workspace = await page.evaluate(() => window.scope.workspace());
  const tab = workspace!.tabs.find((t) => t.type === "pull-requests")!;
  expect(
    (await page.evaluate(() => window.scope.retainedTabs())).find((t) => t.tab.id === tab.id)
      ?.permanent,
  ).toBe(true);
  await page.getByRole("img", { name: "Built-in tab: Synthetic PR inbox", exact: true }).waitFor();
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

test("the default inbox keeps a captured review queue, note edits, snooze undo, and current commit baselines", async () => {
  const fixture = await offlineFixture();
  const app = await fixture.launch();
  const evidence = "/tmp/scope-pr-inbox-build/ui-evidence";
  try {
    await mkdir(evidence, { recursive: true });
    const { artifact, tabId } = await createStarterInbox(app, fixture);
    const initial = {
      ...snapshot(artifact, tabId),
      prs: [pr(1), { ...pr(2), hasUnresolvedConversations: null }],
    };
    await installCommands(app, initial);
    await sendChange(app, "reconnect");
    const page = await app.firstWindow(),
      frame = page.frameLocator(".pull-requests-document");
    await frame
      .getByRole("button", { name: "Keep the current review stable 1", exact: true })
      .waitFor();
    expect(
      await frame.getByText("CI unknown · Merge unknown · Author's turn", { exact: true }).count(),
    ).toBe(1);
    expect(
      await frame
        .getByText("CI unknown · Merge unknown · Conversations unknown", { exact: true })
        .count(),
    ).toBe(1);
    await page.screenshot({ path: join(evidence, "inbox-light.png") });
    await frame
      .getByRole("button", { name: "Keep the current review stable 1", exact: true })
      .click();
    await frame.getByText("A synthetic pull request description.", { exact: true }).waitFor();
    await frame.getByRole("button", { name: "Diff", exact: true }).click();
    const diffWindow = page.frameLocator(".scope-content-document");
    await diffWindow.getByText("const commit = " + head + ";").waitFor();
    await page
      .getByRole("dialog", { name: "Changes in #1" })
      .getByRole("button", { name: "Close content window" })
      .click();
    await sendChange(app, "note-error");
    await frame.getByLabel("Your notes").fill("Keep this note after a failure");
    await page.getByRole("button", { name: "Search and controls" }).click();
    await page.getByRole("button", { name: "Fullscreen", exact: true }).click();
    const presentationMode = page.getByRole("combobox", { name: "Fullscreen HTML mode" });
    await presentationMode.selectOption("present");
    await frame.getByLabel("Your notes").hover();
    await expect
      .poll(() =>
        page.locator(".presentation-pointer").evaluate((element) => element.style.opacity),
      )
      .toBe("1");
    expect(await frame.getByLabel("Your notes").inputValue()).toBe(
      "Keep this note after a failure",
    );
    await presentationMode.selectOption("tabs");
    expect(await frame.locator("#head").textContent()).toBe(head.slice(0, 12));
    await frame.getByRole("button", { name: "Save note", exact: true }).click();
    await frame.getByText(/Your edits are kept here/).waitFor();
    await sendChange(app, "new-head");
    await frame
      .getByRole("button", { name: "New commit available · Load latest commit" })
      .waitFor();
    expect(
      await frame
        .getByRole("heading", { name: "Keep the current review stable 1", exact: true })
        .count(),
    ).toBe(1);
    expect(await frame.locator("#head").textContent()).toBe(head.slice(0, 12));
    expect(await frame.locator("#content").textContent()).toBe(
      "A synthetic pull request description.",
    );
    expect(await frame.getByLabel("Your notes").inputValue()).toBe(
      "Keep this note after a failure",
    );
    await frame.getByRole("button", { name: "Mark this commit reviewed" }).click();
    await frame.getByText("This commit is marked reviewed.").waitFor();
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
    await frame.getByRole("button", { name: "New commit available · Load latest commit" }).click();
    await frame.getByRole("heading", { name: "New head while inspecting" }).waitFor();
    await frame.getByText("Changed since your review of " + head.slice(0, 12)).waitFor();
    expect(await frame.locator("#head").textContent()).toBe(newerHead.slice(0, 12));
    await expect
      .poll(() => frame.locator("#content").textContent())
      .toBe("A synthetic pull request description.");
    await frame.getByRole("button", { name: "Mark this commit reviewed" }).click();
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
    await frame.getByRole("button", { name: "Snooze pull request", exact: true }).focus();
    await page.keyboard.press("Tab");
    const undo = frame
      .getByRole("dialog", { name: "Inspect pull request" })
      .getByRole("button", { name: "Undo", exact: true });
    expect(await undo.evaluate((element) => element === document.activeElement)).toBe(true);
    await page.keyboard.press("Enter");
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
    // The intentional note failure can also make background retention's workspace flush fail.
    expect(
      await page
        .getByRole("alert")
        .filter({ hasNotText: "Tab cleanup could not finish. Scope will retry in a minute." })
        .count(),
    ).toBe(0);
    await page.setViewportSize({ width: 560, height: 620 });
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
        width: document.documentElement.clientWidth,
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
    await app.evaluate(({ BrowserWindow }) => {
      const state = (
        globalThis as unknown as { prInboxTest: { snapshot: Mutable<PullRequestsSnapshot> } }
      ).prInboxTest;
      state.snapshot.prs = state.snapshot.prs.filter((p) => p.nodeId !== "PR_1");
      state.snapshot.generation++;
      BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-reconnected");
    });
    await frame.getByRole("heading", { name: "This pull request is no longer open" }).waitFor();
    expect(await frame.locator("#load-latest").isVisible()).toBe(false);
    await frame.getByRole("button", { name: "Next pull request" }).click();
    await frame.getByRole("heading", { name: "Keep the current review stable 2" }).waitFor();
  } finally {
    await app.close();
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(fixture.ghDirectory, { recursive: true, force: true });
  }
});
