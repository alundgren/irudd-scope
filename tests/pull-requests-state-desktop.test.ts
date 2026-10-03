import { expect, test } from "vite-plus/test";
import { rm, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ScopeClient } from "@irudd-scope/protocol/client";
import type { PullRequestFacts } from "@irudd-scope/protocol/pull-requests";
import { ArtifactStore } from "../apps/desktop/src/library/store.ts";
import { startArtifactServer } from "../apps/desktop/src/library/server.ts";
import { randomUUID } from "node:crypto";
import { desktopFixture } from "./desktop-fixture.ts";

type State = { version: number; value: Record<string, unknown> };
type StateSDK = {
  read: () => Promise<State>;
  set: (value: Record<string, unknown>, version: number) => Promise<State>;
  patch: (value: Record<string, unknown>, version: number) => Promise<State>;
  delete: (keys: string[], version: number) => Promise<State>;
};
type InboxWindow = {
  scope: {
    pullRequests: { state: StateSDK & { forPR: (nodeId: string) => StateSDK } };
    windows: { open: (content: { title: string; html: string }) => Promise<string> };
  };
};
const html = `<!doctype html><h1>State inbox</h1><p id="state"></p><script>
window.updates=[];window.stopState=scope.pullRequests.state.watch(update=>{
  updates.push(update);document.getElementById('state').textContent=JSON.stringify(update);
});
window.draft=null;scope.pullRequests.beforeClose(async()=>{
  if(!window.draft)return;
  const current=await scope.pullRequests.state.read();
  await scope.pullRequests.state.patch(window.draft,current.version);window.draft=null;
});
</script>`;

test("authored inbox JSON edits reach all its frames and survive restart and HTML replacement", async () => {
  const f = await desktopFixture();
  let app = await f.launch();
  try {
    let client = await f.connect();
    await client.publish(
      "state-inbox",
      {
        name: "state-inbox",
        title: "State inbox",
        kind: "pull-requests",
        mediaType: "text/html",
        fileName: "inbox.html",
        expectedRevision: 0,
      },
      Buffer.from(html),
    );
    const page = await app.firstWindow();
    const main = page.frameLocator(".pull-requests-document");
    await main.locator("#state").filter({ hasText: '"version":0' }).waitFor();
    const initial = await main
      .locator("body")
      .evaluate(() => (window as unknown as InboxWindow).scope.pullRequests.state.read());
    expect(initial).toEqual({ version: 0, value: {} });
    await main
      .locator("body")
      .evaluate(
        (_body, html) =>
          (window as unknown as InboxWindow).scope.windows.open({ title: "State child", html }),
        html,
      );
    const child = page.frameLocator('iframe[title="State child"]');
    await child.locator("#state").filter({ hasText: '"version":0' }).waitFor();
    const saved = await main
      .locator("body")
      .evaluate(() =>
        (window as unknown as InboxWindow).scope.pullRequests.state.set(
          { hidden: ["file.ts"], pane: { width: 300 } },
          0,
        ),
      );
    expect(saved.version).toBe(1);
    await child.locator("#state").filter({ hasText: '"operation":"set"' }).waitFor();
    const patched = await child
      .locator("body")
      .evaluate(() =>
        (window as unknown as InboxWindow).scope.pullRequests.state.patch(
          { pane: { width: 450 }, nullable: null },
          1,
        ),
      );
    expect(patched).toEqual({
      version: 2,
      value: { hidden: ["file.ts"], pane: { width: 450 }, nullable: null },
    });
    await main.locator("#state").filter({ hasText: '"operation":"patch"' }).waitFor();
    const failure = await main.locator("body").evaluate(async () => {
      try {
        await (window as unknown as InboxWindow).scope.pullRequests.state.delete(["hidden"], 1);
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(failure).toContain("state changed");
    await child
      .locator("body")
      .evaluate(() =>
        (window as unknown as InboxWindow).scope.pullRequests.state.delete(["hidden"], 2),
      );
    await main.locator("#state").filter({ hasText: '"operation":"delete"' }).waitFor();
    const reply = await client.pullRequests({ action: "read", name: "state-inbox" });
    if (reply.type !== "snapshot") throw new Error("Expected snapshot");
    await client.pullRequests({
      action: "state-patch",
      name: "state-inbox",
      tabId: reply.snapshot.tabId,
      requestId: randomUUID(),
      expectedVersion: 3,
      value: { external: true },
    });
    await main.locator("#state").filter({ hasText: '"version":4' }).waitFor();
    await child.locator("#state").filter({ hasText: '"version":4' }).waitFor();
    await app.evaluate(
      ({ BrowserWindow }, { id, name }) => {
        BrowserWindow.getAllWindows()[0]!.webContents.send("scope:pull-requests-changed", {
          type: "pull-requests",
          id,
          name,
          tabId: "11111111-1111-4111-8111-111111111111",
          generation: 99,
          stateChange: { operation: "set", version: 99, value: { replacementInbox: true } },
        });
      },
      { id: reply.snapshot.artifact.id, name: reply.snapshot.artifact.name },
    );
    const current = await main
      .locator("body")
      .evaluate(() => (window as unknown as InboxWindow).scope.pullRequests.state.read());
    expect(current.version).toBe(4);
    expect(await main.locator("#state").textContent()).toContain('"version":4');
    const updates = await main
      .locator("body")
      .evaluate(() =>
        (window as unknown as { updates: { version: number; operation: string }[] }).updates.map(
          ({ version, operation }) => ({ version, operation }),
        ),
      );
    expect(updates).toEqual([
      { version: 0, operation: "snapshot" },
      { version: 1, operation: "set" },
      { version: 2, operation: "patch" },
      { version: 3, operation: "delete" },
      { version: 4, operation: "patch" },
    ]);
    // Unsubscribed HTML components stop receiving updates while the rest stay live.
    await child
      .locator("body")
      .evaluate(() => (window as unknown as { stopState: () => void }).stopState());
    const last = await main
      .locator("body")
      .evaluate(() =>
        (window as unknown as InboxWindow).scope.pullRequests.state.patch({ sidebar: 280 }, 4),
      );
    expect(last.version).toBe(5);
    await main.locator("#state").filter({ hasText: '"version":5' }).waitFor();
    expect(await child.locator("#state").textContent()).toContain('"version":4');
    await main.locator("body").evaluate(() => {
      (window as unknown as { draft: unknown }).draft = { savedOnReplacement: true };
    });
    const artifact = await client.get("state-inbox");
    await client.publish(
      "state-inbox",
      {
        name: "state-inbox",
        title: "Updated state inbox",
        kind: "pull-requests",
        mediaType: "text/html",
        fileName: "inbox.html",
        expectedRevision: artifact.revision,
      },
      Buffer.from(html.replace("State inbox", "Updated state inbox")),
    );
    await main.getByRole("heading", { name: "Updated state inbox" }).waitFor();
    await main.locator("#state").filter({ hasText: '"version":6' }).waitFor();
    await app.close();
    app = await f.launch();
    client = await f.connect();
    const restarted = await app.firstWindow();
    await restarted
      .frameLocator(".pull-requests-document")
      .locator("#state")
      .filter({ hasText: '"version":6' })
      .waitFor();
    const restored = await client.pullRequests({ action: "read", name: "state-inbox" });
    expect(restored.type === "snapshot" && restored.snapshot.appState).toEqual({
      version: 6,
      value: { ...last.value, savedOnReplacement: true },
    });
  } finally {
    await app.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});

const prHTML = `<!doctype html><h1>PR state inbox</h1><p id="pr-state"></p><script>
window.prCount=0;scope.pullRequests.watch(prs=>window.prCount=prs.length);
window.prUpdates=[];window.stopPr=scope.pullRequests.state.forPR('PR_1').watch(update=>{
  prUpdates.push({version:update.version,operation:update.operation});
  document.getElementById('pr-state').textContent=JSON.stringify({version:update.version,operation:update.operation,size:update.value.large?.length||0,flushed:update.value.flushed});
});
window.prDraft=null;scope.pullRequests.beforeClose(async()=>{
  if(!prDraft)return;const state=scope.pullRequests.state.forPR('PR_1');const current=await state.read();
  await state.patch(prDraft,current.version);prDraft=null;
});
</script>`;

test("PR state watches load large external edits, recover missed edits and reset removed PRs", async () => {
  const ghDirectory = await mkdtemp(join(tmpdir(), "scope-pr-state-gh-"));
  await writeFile(join(ghDirectory, "gh"), '#!/bin/sh\necho "Synthetic offline gh" >&2\nexit 1\n', {
    mode: 0o700,
  });
  const previousPath = process.env.PATH;
  process.env.PATH = `${ghDirectory}:${previousPath}`;
  let f: Awaited<ReturnType<typeof desktopFixture>>;
  try {
    f = await desktopFixture();
  } finally {
    process.env.PATH = previousPath;
  }
  const directory = join(f.settingsDirectory, "artifacts");
  const token = "synthetic-pr-state-seeding-token";
  const seed = await startArtifactServer({ directory, token, port: 0 });
  const client = new ScopeClient(seed.url, token);
  const repository = { owner: "synthetic", name: "project" };
  const now = "2026-09-30T12:00:00.000Z",
    head = "a".repeat(40),
    base = "b".repeat(40);
  const pr: PullRequestFacts = {
    nodeId: "PR_1",
    number: 1,
    title: "Synthetic PR",
    author: "alice",
    labels: [],
    headOid: head,
    headRefName: "feature",
    baseOid: base,
    draft: false,
    additions: 0,
    deletions: 0,
    changedFiles: 0,
    url: "https://github.com/synthetic/project/pull/1",
    merge: { status: "unknown", headOid: head, baseOid: base, observedAt: now },
    checks: { status: "unknown", headOid: null, observedAt: now },
    hasUnresolvedConversations: null,
    createdAt: now,
    updatedAt: now,
    requestedReviewers: [],
  };
  let tabId: string;
  try {
    await client.publish(
      "pr-state-inbox",
      {
        name: "pr-state-inbox",
        title: "PR state inbox",
        kind: "pull-requests",
        mediaType: "text/html",
        fileName: "inbox.html",
        expectedRevision: 0,
      },
      Buffer.from(prHTML),
    );
    const initial = await seed.store.pullRequests.snapshot("pr-state-inbox");
    tabId = initial.tabId;
    await client.pullRequests({
      action: "configure",
      name: "pr-state-inbox",
      tabId,
      requestId: randomUUID(),
      repository,
    });
    await seed.store.pullRequests.commitInventory(tabId, {
      repository,
      viewer: "viewer",
      prs: [pr],
      completedAt: now,
    });
  } finally {
    await seed.close();
  }
  let app = await f.launch();
  let sideStore: ArtifactStore | undefined;
  try {
    const live = await f.connect();
    const page = await app.firstWindow();
    const main = page.frameLocator(".pull-requests-document");
    await main.locator("#pr-state").filter({ hasText: '"version":0' }).waitFor();
    const childId = await main
      .locator("body")
      .evaluate(
        (_body, html) =>
          (window as unknown as InboxWindow).scope.windows.open({ title: "PR state child", html }),
        prHTML,
      );
    const child = page.frameLocator('iframe[title="PR state child"]');
    await child.locator("#pr-state").filter({ hasText: '"version":0' }).waitFor();
    const command = {
      action: "pr-state-set" as const,
      name: "pr-state-inbox",
      tabId,
      nodeId: "PR_1",
      requestId: randomUUID(),
      expectedVersion: 0,
      value: { large: "x".repeat(80_000) },
    };
    await live.pullRequests(command);
    for (const frame of [main, child])
      await frame.locator("#pr-state").filter({ hasText: '"size":80000' }).waitFor();
    const root = await main
      .locator("body")
      .evaluate(() => (window as unknown as InboxWindow).scope.pullRequests.state.read());
    expect(root).toEqual({ version: 0, value: {} });
    const saved = await child
      .locator("body")
      .evaluate(() =>
        (window as unknown as InboxWindow).scope.pullRequests.state
          .forPR("PR_1")
          .patch({ nullable: null }, 1),
      );
    expect(saved.version).toBe(2);
    await main.locator("#pr-state").filter({ hasText: '"version":2' }).waitFor();
    const conflict = await main.locator("body").evaluate(async () => {
      try {
        await (window as unknown as InboxWindow).scope.pullRequests.state.forPR("PR_1").set({}, 1);
      } catch (error) {
        return (error as Error).message;
      }
    });
    expect(conflict).toContain("state changed");
    // A second database connection simulates committed updates whose live notice was missed.
    sideStore = await ArtifactStore.open(directory);
    await sideStore.pullRequests.command({
      ...command,
      action: "pr-state-patch",
      requestId: randomUUID(),
      expectedVersion: 2,
      value: { recovered: true },
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send("scope:pull-requests-reconnected"),
    );
    for (const frame of [main, child])
      await frame.locator("#pr-state").filter({ hasText: '"version":3' }).waitFor();
    const beforeRemoval = await main
      .locator("body")
      .evaluate(() => (window as unknown as { prUpdates: unknown[] }).prUpdates.length);
    await sideStore.pullRequests.commitInventory(tabId, {
      repository,
      viewer: "viewer",
      prs: [],
      completedAt: now,
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send("scope:pull-requests-reconnected"),
    );
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const reply = await window.scope.pullRequestsCommand({
            action: "read",
            name: "pr-state-inbox",
          });
          return reply.type === "snapshot" && reply.snapshot.prs.length;
        }),
      )
      .toBe(0);
    // Wait for the authored frame to receive the empty inventory before readding the same ID.
    await expect
      .poll(() =>
        main.locator("body").evaluate(() => (window as unknown as { prCount: number }).prCount),
      )
      .toBe(0);
    await sideStore.pullRequests.commitInventory(tabId, {
      repository,
      viewer: "viewer",
      prs: [pr],
      completedAt: now,
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.send("scope:pull-requests-reconnected"),
    );
    for (const frame of [main, child])
      await frame.locator("#pr-state").filter({ hasText: '"version":0' }).waitFor();
    expect(
      await main
        .locator("body")
        .evaluate(() => (window as unknown as { prUpdates: unknown[] }).prUpdates.length),
    ).toBeGreaterThan(beforeRemoval);
    await child.locator("body").evaluate(() => {
      (window as unknown as { prDraft: unknown }).prDraft = { flushed: true };
    });
    await main
      .locator("body")
      .evaluate(
        (_body, id) =>
          (
            window as unknown as { scope: { windows: { close: (id: string) => Promise<void> } } }
          ).scope.windows.close(id),
        childId,
      );
    await main.locator("#pr-state").filter({ hasText: '"flushed":true' }).waitFor();
    await sideStore.close();
    sideStore = undefined;
    await app.close();
    app = await f.launch();
    const restarted = await app.firstWindow();
    await restarted
      .frameLocator(".pull-requests-document")
      .locator("#pr-state")
      .filter({ hasText: '"flushed":true' })
      .waitFor();
  } finally {
    await sideStore?.close();
    await app.close();
    await rm(f.directory, { recursive: true, force: true });
    await rm(ghDirectory, { recursive: true, force: true });
  }
});
