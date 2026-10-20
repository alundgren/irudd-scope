import { afterEach, expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeLocalConnection } from "@irudd-scope/protocol";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";
import { dreaming, hash, librarianFixture, raw } from "./librarian-fixture.ts";
import {
  LibrarianRoutineWork,
  type LibrarianReply,
  type LibrarianView,
} from "@irudd-scope/protocol/librarian";

const cleanup: (() => Promise<unknown> | void)[] = [];
const fixture = () => librarianFixture(cleanup);
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
test("Librarian browses a local folder without Git, searches a small result set and reads one memory", async () => {
  const f = await fixture();
  await f.open();
  await f.page.getByRole("button", { name: "recovery", exact: true }).waitFor();
  expect(await f.page.getByRole("button", { name: "Graph", exact: true }).count()).toBe(0);
  await f.page.getByRole("textbox", { name: "Search memory", exact: true }).fill("synthetic");
  await f.page.getByRole("button", { name: "Search memory", exact: true }).click();
  await f.page.getByRole("button", { name: "Validation", exact: true }).click();
  await f.page.locator(".memory-wiki").getByRole("heading", { name: "Validation" }).waitFor();
  const projected = await f.client.librarian({ action: "read" });
  expect(projected.state.selectedPath).toBe("validation.md");
  expect((projected.state.displayed as { raw: string }).raw).toContain("Use synthetic fixtures");
  expect(await f.page.getByRole("button", { name: "Edit Markdown", exact: true }).count()).toBe(0);
  expect(await readFile(join(f.root, ".git"), "utf8").catch(() => null)).toBeNull();
  for (const appearance of ["light", "dark"] as const) {
    await f.page.evaluate((appearance) => window.scope.saveSettings({ appearance }), appearance);
    await f.page.setViewportSize(
      appearance === "light" ? { width: 1280, height: 820 } : { width: 620, height: 560 },
    );
    expect(await f.page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
      false,
    );
    if (process.env.SCOPE_TEST_SCREENSHOTS) {
      await mkdir(process.env.SCOPE_TEST_SCREENSHOTS, { recursive: true });
      await f.page.screenshot({
        path: join(process.env.SCOPE_TEST_SCREENSHOTS, `librarian-memory-${appearance}.png`),
      });
    }
  }
});

test("dreaming shows one exact human decision, records automatic work, rejects stale evidence and resumes explicitly", async () => {
  const f = await fixture();
  await f.open();
  await f.page.getByRole("button", { name: "recovery", exact: true }).waitFor();
  const run = await dreaming(f, ["format"]);
  await run.propose("recovery.md", raw("Recovery", "Keep interrupted work."));
  await run.propose(
    "validation.md",
    raw("Validation", "Check synthetic fixtures."),
    "human",
    undefined,
    [{ path: "recovery.md", hash: hash(raw("Recovery", "Keep interrupted work.")) }],
  );
  const automated = await run.propose(
    "routine.md",
    raw("Routine", "Normalize formatting."),
    "automatic",
    "format",
  );
  expect(automated.state.pendingCount).toBe(2);
  expect(automated.state.completedCount).toBe(1);
  expect(automated.state.run!.proposals).toHaveLength(1);
  await f.page.getByRole("button", { name: "Accept proposal", exact: true }).waitFor();
  expect(await f.page.locator(".librarian-proposal").count()).toBe(1);
  expect(await f.page.getByRole("textbox", { name: "Search memory", exact: true }).count()).toBe(0);
  expect(await f.page.getByRole("heading", { name: "Validation", exact: true }).count()).toBe(0);
  if (process.env.SCOPE_TEST_SCREENSHOTS)
    await f.page.screenshot({
      path: join(process.env.SCOPE_TEST_SCREENSHOTS, "librarian-decision.png"),
    });
  await f.page.getByRole("button", { name: "Accept proposal", exact: true }).click();
  await f.page.getByRole("heading", { name: "Validation", exact: true }).waitFor();
  await writeFile(join(f.root, "recovery.md"), "# Changed source\n");
  await f.page.getByRole("button", { name: "Accept proposal", exact: true }).click();
  await f.page.getByRole("alert").filter({ hasText: "source revision changed" }).waitFor();
  expect((await f.client.librarian({ action: "read" })).state.pendingCount).toBe(1);
  const oldRevision = (await run.refresh()).state.uiRevision;
  await f.restart();
  await f.page.getByRole("heading", { name: "Validation", exact: true }).waitFor();
  const interrupted = await f.client.librarian({ action: "read" });
  expect(interrupted.state.run!.status).toBe("interrupted");
  await expect(
    f.client.librarian({
      action: "select",
      requestId: randomUUID(),
      expectedUiRevision: interrupted.state.uiRevision,
      runId: run.runId,
      capability: run.capability,
      sessionId: "existing-session",
      view: "browse",
    }),
  ).rejects.toThrow(/resume/);
  expect(interrupted.state.uiRevision).toBeGreaterThan(oldRevision);
  const resumed = await f.client.librarian({
    action: "resume",
    requestId: randomUUID(),
    expectedUiRevision: interrupted.state.uiRevision,
    runId: run.runId,
    sessionId: "resumed-session",
    userRequest: "Resume my interrupted dreaming run.",
  });
  expect(resumed.capability).toBeTruthy();
  expect(resumed.capability).not.toBe(run.capability);
  await writeFile(join(f.root, "recovery.md"), raw("Recovery", "Keep interrupted work."));
  await f.page.getByRole("button", { name: "Reject proposal", exact: true }).click();
  await f.page.getByRole("button", { name: "Inspect completed changes", exact: true }).waitFor();
  const resolved = await f.client.librarian({ action: "read" });
  const finished = await f.client.librarian({
    action: "finish",
    requestId: randomUUID(),
    expectedUiRevision: resolved.state.uiRevision,
    runId: run.runId,
    capability: resumed.capability!,
    sessionId: "resumed-session",
    userRequest: "Finish dreaming.",
  });
  expect(finished.state.run!.status).toBe("completed");
  await f.page.getByText("3 completed changes.", { exact: true }).waitFor();
  expect(await f.page.locator(".librarian-proposal").count()).toBe(0);
  if (process.env.SCOPE_TEST_SCREENSHOTS)
    await f.page.screenshot({
      path: join(process.env.SCOPE_TEST_SCREENSHOTS, "librarian-overview.png"),
    });
  await f.page.getByRole("button", { name: "Routine", exact: true }).click();
  await f.page.getByRole("heading", { name: "Routine", exact: true }).waitFor();
  expect((await f.client.librarian({ action: "read" })).state.displayed).toMatchObject({
    change: { review: { actor: { type: "agent" } } },
  });
});

test("dreaming handles routine work by default, queues refused automatic reviews and honours a narrowed list on resume", async () => {
  const f = await fixture();
  await f.open();
  await f.page.getByRole("button", { name: "recovery", exact: true }).waitFor();
  const run = await dreaming(f, null);
  expect(run.reply.state.run!.automaticPermissions).toEqual([...LibrarianRoutineWork]);
  const merged = await run.propose(
    "merged.md",
    raw("Merged", "One copy of the lesson."),
    "automatic",
    "merge-duplicates",
  );
  expect(merged.state.pendingCount).toBe(0);
  expect(merged.state.completedCount).toBe(1);
  const refused = await run.propose(
    "rechecked-episode.md",
    raw("Rechecked", "Removal needs a person after all."),
    "automatic",
    "consolidate-episodes",
  );
  expect(refused.state.pendingCount).toBe(1);
  expect(refused.state.completedCount).toBe(1);
  await f.page.getByRole("heading", { name: "Rechecked", exact: true }).waitFor();
  await f.page.getByRole("button", { name: "Accept proposal", exact: true }).waitFor();
  const paused = await f.client.librarian({
    action: "interrupt",
    requestId: randomUUID(),
    expectedUiRevision: refused.state.uiRevision,
    runId: run.runId,
    capability: run.capability,
    sessionId: "existing-session",
    userRequest: "Pause dreaming.",
  });
  const resumed = await f.client.librarian({
    action: "resume",
    requestId: randomUUID(),
    expectedUiRevision: paused.state.uiRevision,
    runId: run.runId,
    sessionId: "resumed-session",
    userRequest: "Resume, but ask me about everything from now on.",
    automaticPermissions: [],
  });
  expect(resumed.state.run!.automaticPermissions).toEqual([]);
  await expect(
    f.client.librarian({
      action: "propose",
      requestId: randomUUID(),
      expectedUiRevision: resumed.state.uiRevision,
      runId: run.runId,
      capability: resumed.capability!,
      sessionId: "resumed-session",
      path: "later.md",
      raw: raw("Later", "Asked about every change."),
      expectedHash: null,
      reason: "Improve later.md",
      sources: [],
      disposition: "automatic",
      permission: "merge-duplicates",
      evidence: "Evidence for later.md",
    }),
  ).rejects.toThrow(/human decision/);
});

test("old memory tabs retain a copyable draft, and reminder preferences persist without agent work", async () => {
  const f = await fixture();
  const tabId = randomUUID();
  await f.page.evaluate(
    async ({ tabId }) => {
      const workspace = await window.scope.workspace();
      await window.scope.openTab({
        id: tabId,
        groupId: workspace!.groups[0].id,
        type: "memory",
        title: "Personal memory",
        state: {
          version: 1,
          data: {
            mode: "graph",
            draft: {
              repository: "octo/personal-memory",
              path: "recovery.md",
              expectedHash: "a".repeat(64),
              raw: "# Retained recovery text\n",
            },
          },
        },
      });
    },
    { tabId },
  );
  await f.restart();
  await f.open();
  await f.page.getByRole("button", { name: "Recovered draft", exact: true }).click();
  await f.page.getByRole("button", { name: "Copy recovered draft", exact: true }).click();
  expect(await f.application.evaluate(({ clipboard }) => clipboard.readText())).toContain(
    "Retained recovery text",
  );
  const saved = await f.page.evaluate(async () =>
    (await window.scope.workspace())!.tabs.find((tab) => tab.type === "memory"),
  );
  expect(saved!.state.version).toBe(2);
  expect(saved!.state.data).toMatchObject({ original: { version: 1 } });
  const state = await f.client.librarian({ action: "read" });
  expect(state.state.reminder.enabled).toBe(true);
  await f.page.evaluate(
    async (revision) =>
      window.scope.librarianHuman({
        action: "reminder",
        requestId: crypto.randomUUID(),
        expectedUiRevision: revision,
        enabled: false,
        dismiss: false,
      }),
    state.state.uiRevision,
  );
  await f.restart();
  expect((await f.client.librarian({ action: "read" })).state.reminder.enabled).toBe(false);
  expect((await f.client.librarian({ action: "read" })).state.run).toBeUndefined();
});

test("older local bundles report migration needed without rewriting their files", async () => {
  const f = await fixture();
  await rm(join(f.root, "memory-bundle.json"));
  const before = await readFile(join(f.root, "recovery.md"), "utf8");
  await expect(
    f.client.librarian({ action: "local", root: f.root, initialize: false }),
  ).rejects.toThrow(/Migration needed/);
  expect(await readFile(join(f.root, "recovery.md"), "utf8")).toBe(before);
});

test("agent presentation keeps human navigation and decisions bind the updated displayed evidence", async () => {
  const f = await fixture();
  await f.open();
  await f.page.getByRole("button", { name: "recovery", exact: true }).waitFor();
  const run = await dreaming(f, ["format"]);
  const first = await run.propose("recovery.md", raw("Recovery", "Keep interrupted work."));
  const changeId = first.state.selectedChangeId!;
  await f.page.getByRole("button", { name: "Inspect evidence", exact: true }).click();
  await f.page
    .getByLabel("Proposal evidence")
    .getByText("Evidence for recovery.md", { exact: true })
    .waitFor();
  const seen = await run.refresh();
  const presented = await f.client.librarian({
    action: "present",
    requestId: randomUUID(),
    expectedUiRevision: seen.state.uiRevision,
    sessionId: "existing-session",
    runId: run.runId,
    capability: run.capability,
    changeId,
    disposition: "human",
    evidence: "A more precise observation.",
  });
  await f.page
    .getByLabel("Proposal evidence")
    .getByText("A more precise observation.", { exact: true })
    .waitFor();
  expect(presented.state.displayed).toMatchObject({ evidence: "A more precise observation." });
  expect(presented.state.run!.proposals[0].evidence).toBe("A more precise observation.");
  const displayed = presented.state.run!.proposals[0];
  await expect(
    f.page.evaluate(
      async ({ old, change, runId }) =>
        window.scope.librarianHuman({
          action: "decide",
          requestId: crypto.randomUUID(),
          expectedUiRevision: old,
          runId,
          changeId: change.id,
          expectedRevisionHash: change.revisionHash,
          sources: change.sources,
          decision: "accept",
          reason: "Accept old display",
        }),
      { old: seen.state.uiRevision, change: displayed.change, runId: run.runId },
    ),
  ).rejects.toThrow(/displayed content changed/);
  const after = await f.client.librarian({ action: "read" });
  await f.client.librarian({
    action: "select",
    requestId: randomUUID(),
    expectedUiRevision: after.state.uiRevision,
    sessionId: "existing-session",
    runId: run.runId,
    capability: run.capability,
    view: "browse",
  });
  await f.page.getByRole("button", { name: "recovery", exact: true }).waitFor();
  await run.refresh();
  const queued = await run.propose("validation.md", raw("Validation", "Check synthetic fixtures."));
  expect(queued.state.view).toBe("browse");
  expect(await f.page.getByRole("button", { name: "Accept proposal", exact: true }).count()).toBe(
    0,
  );
  const paused = await f.client.librarian({
    action: "interrupt",
    requestId: randomUUID(),
    expectedUiRevision: queued.state.uiRevision,
    sessionId: "existing-session",
    runId: run.runId,
    capability: run.capability,
    userRequest: "Pause dreaming and retain the queue.",
  });
  expect(paused.state.run!.status).toBe("interrupted");
  expect(paused.state.pendingCount).toBe(2);
  await expect(
    f.client.librarian({
      action: "select",
      requestId: randomUUID(),
      expectedUiRevision: paused.state.uiRevision,
      sessionId: "existing-session",
      runId: run.runId,
      capability: run.capability,
      view: "decision",
    }),
  ).rejects.toThrow(/resume/);
});

test("a paired remote agent reads the renderer projection and submits proposals without human authority", async () => {
  const f = await fixture();
  await f.open();
  await f.page.getByRole("button", { name: "recovery", exact: true }).waitFor();
  const state = await HubState.open(join(f.memory.directory, "librarian-hub"));
  cleanup.push(() => state.close());
  const connectionFile = join(f.memory.directory, "library-remote.json");
  await state.configure({ endpoint: "http://127.0.0.1:1", port: 1, connectionFile });
  const hub = await startPairedHub(state, 0);
  cleanup.push(hub.close);
  await state.configure({ endpoint: hub.url, port: Number(new URL(hub.url).port), connectionFile });
  await f.page.evaluate((url) => window.scope.pairRemote(url), state.pairUrl());
  await expect
    .poll(() => f.page.evaluate(async () => (await window.scope.remotes())[0]?.connection))
    .toBe("connected");
  const local = decodeLocalConnection(JSON.parse(await readFile(connectionFile, "utf8")));
  const remote = new ScopeClient(local.endpoint, local.token);
  const read = await remote.librarian({ action: "read" });
  expect(read.state).toEqual(await f.page.evaluate(() => window.scope.librarianRead()));
  const started = await remote.librarian({
    action: "start",
    requestId: randomUUID(),
    expectedUiRevision: read.state.uiRevision,
    sessionId: "existing-remote-agent",
    userRequest: "Begin dreaming with my remote coding agent.",
    automaticPermissions: [],
  });
  const connection = {
    runId: started.state.run!.id,
    capability: started.capability!,
    sessionId: "existing-remote-agent",
  };
  const proposed = await remote.librarian({
    action: "propose",
    requestId: randomUUID(),
    expectedUiRevision: started.state.uiRevision,
    ...connection,
    path: "remote.md",
    raw: raw("Remote lesson", "Preserve the same projected text."),
    expectedHash: null,
    reason: "Record this checked outcome.",
    sources: [],
    disposition: "human",
    evidence: "The paired relay returned the displayed proposal.",
  });
  await f.page.getByRole("heading", { name: "Remote lesson", exact: true }).waitFor();
  const displayed = await remote.librarian({ action: "read" });
  expect(displayed.state).toEqual(await f.page.evaluate(() => window.scope.librarianRead()));
  const invalid = await fetch(`${local.endpoint}/v1/librarian`, {
    method: "POST",
    headers: { authorization: `Bearer ${local.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      action: "decide",
      changeId: proposed.state.selectedChangeId,
      decision: "accept",
      actor: { type: "human", id: "forged" },
    }),
  });
  expect(invalid.status).toBe(400);
  await invalid.body?.cancel();
  expect((await remote.librarian({ action: "read" })).state.pendingCount).toBe(1);
  await f.page.getByRole("button", { name: "Accept proposal", exact: true }).click();
  await expect
    .poll(async () => (await remote.librarian({ action: "read" })).state.completedCount)
    .toBe(1);
  const accepted = await remote.librarian({ action: "read" });
  const inspected = await remote.librarian({
    action: "select",
    requestId: randomUUID(),
    expectedUiRevision: accepted.state.uiRevision,
    ...connection,
    view: "overview",
    changeId: proposed.state.selectedChangeId,
  });
  expect(inspected.state.displayed).toMatchObject({
    change: {
      actor: { type: "agent", id: "existing-remote-agent" },
      review: { actor: { type: "human", id: "scope-user" } },
    },
  });
  expect(inspected.state).toEqual(await f.page.evaluate(() => window.scope.librarianRead()));
  expect(state.memoryConfiguration().localRoot).toBeUndefined();
});
