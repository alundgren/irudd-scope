import { afterEach, expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dreaming, hash, librarianFixture, library, note } from "./librarian-fixture.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("Activity shows who proposed and decided each recorded change, opens pending work in Dreaming and inspects cited evidence", async () => {
  const f = await librarianFixture(cleanup);
  await library(f.root);
  await f.page.setViewportSize({ width: 1280, height: 860 });
  await f.open();
  const page = f.page;
  const run = await dreaming(f);
  const promoted = note(
    "Retry rule",
    { kind: "semantic", stage: "silver", applicability: { type: "repository", id: "atlas" } },
    ["ci"],
    "Deploys can need one retry. Back to [Deploy steps](deploy.md).",
  );
  await run.propose("retry.md", promoted);
  await page.getByRole("button", { name: "Accept proposal", exact: true }).click();
  await page.getByText("No decisions waiting.", { exact: false }).waitFor();
  await run.refresh();
  await run.propose(
    "deploy.md",
    note(
      "Deploy steps",
      { kind: "procedural", stage: "gold", applicability: { type: "global" } },
      ["deploy"],
      "Always deploy twice.",
    ),
  );
  await page.getByRole("button", { name: "Reject proposal", exact: true }).click();
  await page.getByText("No decisions waiting.", { exact: false }).waitFor();

  // A change synced from another machine has no dreaming run on this desktop.
  const history = join(f.root, "fixture-changes.json");
  const changes = JSON.parse(await readFile(history, "utf8"));
  changes.unshift({
    ...changes[0],
    id: randomUUID(),
    path: "notes/old.md",
    action: "create",
    before: null,
    actor: { type: "agent", id: "laptop-session" },
    reason: "Recorded an episode on the laptop.",
    createdAt: "2026-10-01T08:00:00.000Z",
    sources: [],
    reviews: [],
    review: undefined,
    status: "accepted",
    display: { title: "Old episode", beforeBody: null, afterBody: "An episode." },
  });
  await writeFile(history, JSON.stringify(changes));

  await page.getByRole("button", { name: "Browse memories", exact: true }).click();
  const tabs = page.getByRole("tablist", { name: "Librarian views" });
  await run.refresh();
  await run.propose(
    "steps.md",
    note(
      "Rollback steps",
      { kind: "procedural", stage: "bronze", applicability: { type: "global" } },
      [],
      "Roll back after one failed retry.",
    ),
    "human",
    undefined,
    [{ path: "retry.md", hash: hash(promoted) }],
  );
  await tabs.getByRole("tab", { name: "Activity", exact: true }).click();
  const list = page.getByRole("list", { name: "Recorded changes" });
  await list
    .getByRole("listitem")
    .first()
    .getByText("Created Rollback steps", { exact: true })
    .waitFor();
  expect(await list.getByRole("listitem").count()).toBe(4);
  await page.getByText("1–4 of 4 recorded changes, newest first", { exact: true }).waitFor();

  await list.getByRole("button", { name: "Updated Retry rule", exact: true }).click();
  const detail = page.getByRole("region", { name: "Change", exact: true });
  await detail.getByText("Agent existing-session", { exact: true }).waitFor();
  await detail.getByText("Accepted by You in Scope", { exact: false }).waitFor();
  await detail.getByText("Evidence for retry.md", { exact: true }).waitFor();
  await detail.getByText("Presented for a human decision", { exact: true }).waitFor();

  await list.getByRole("button", { name: "Created Old episode", exact: true }).click();
  await detail.getByText("No dreaming run on this desktop", { exact: true }).waitFor();
  await detail.getByText("Agent laptop-session", { exact: true }).waitFor();

  await page.getByLabel("Outcome", { exact: true }).selectOption("rejected");
  await list.getByRole("button", { name: "Updated Deploy steps", exact: true }).waitFor();
  await expect.poll(() => list.getByRole("listitem").count()).toBe(1);
  await page.getByLabel("Outcome", { exact: true }).selectOption("");

  await list.getByRole("button", { name: "Created Rollback steps", exact: true }).click();
  await detail
    .getByText("Pending proposal. Accepted memory is unchanged.", { exact: true })
    .waitFor();
  await detail.getByRole("button", { name: "retry.md", exact: true }).click();
  const evidence = page.getByRole("region", { name: "Recorded evidence revision", exact: true });
  await evidence.getByText("Deploys can need one retry.", { exact: false }).waitFor();
  await evidence.getByRole("button", { name: "Open current accepted memory", exact: true }).click();
  const reader = page.getByRole("region", { name: "Memory", exact: true });
  await reader.getByRole("heading", { name: "Retry rule" }).waitFor();
  await reader.getByRole("button", { name: "Back to change", exact: true }).click();
  await detail.getByRole("heading", { name: "Rollback steps" }).waitFor();

  await detail.getByRole("button", { name: "Open in Dreaming", exact: true }).click();
  const proposal = page.getByRole("region", { name: "Displayed proposal", exact: true });
  await proposal.getByRole("heading", { name: "Rollback steps" }).waitFor();
  await page.getByRole("button", { name: "Accept proposal", exact: true }).click();
  await page.getByText("No decisions waiting.", { exact: false }).waitFor();

  await page.getByRole("button", { name: "Browse memories", exact: true }).click();
  await tabs.getByRole("tab", { name: "Browse", exact: true }).waitFor();
  await page.getByRole("button", { name: "steps", exact: true }).click();
  await tabs.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Selected memory only", exact: true }).click();
  await list.getByRole("button", { name: "Created Rollback steps", exact: true }).waitFor();
  await expect.poll(() => list.getByRole("listitem").count()).toBe(1);
  const seen = (await f.client.librarian({ action: "read" })).state;
  expect(seen.activity).toMatchObject({ onlySelected: true, offset: 0 });
  expect(seen.focusPath).toBe("steps.md");
});

test("Activity pages one memory's history, recovers from a missing change and reports evidence it cannot find", async () => {
  const f = await librarianFixture(cleanup);
  await library(f.root);
  // 25 large synced changes to one memory: pages need smaller irudd-okf reads to fit the cap.
  const big = "y".repeat(110_000);
  await writeFile(
    join(f.root, "fixture-changes.json"),
    JSON.stringify(
      Array.from({ length: 25 }, (_, index) => ({
        version: 1,
        id: `old-${index}`,
        bundle: "personal",
        path: "notes/old.md",
        action: "update",
        before: { raw: big, hash: "a".repeat(64) },
        after: { raw: big, hash: "b".repeat(64) },
        revisionHash: "c".repeat(64),
        status: "accepted",
        actor: { type: "agent", id: "laptop-session" },
        reason: `Synced change ${index}.`,
        createdAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString(),
        sources: [],
        reviews: [],
        display: { title: "Old episode", beforeBody: "Before.", afterBody: "After." },
      })),
    ),
  );
  await f.page.setViewportSize({ width: 1280, height: 860 });
  await f.open();
  const page = f.page;
  const tabs = page.getByRole("tablist", { name: "Librarian views" });
  await page.getByRole("button", { name: "notes", exact: true }).click();
  await page.getByRole("button", { name: "old", exact: true }).click();
  await tabs.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByText("1–20 of 25 recorded changes, newest first", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Selected memory only", exact: true }).click();
  await page
    .getByText("1–20 recorded changes to this memory, newest first", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Older", exact: true }).click();
  await page
    .getByText("21–25 recorded changes to this memory, newest first", { exact: true })
    .waitFor();
  expect(await page.getByRole("button", { name: "Older", exact: true }).count()).toBe(0);

  // A change id from another library no longer locks the view.
  await page.evaluate(async () => {
    const state = await window.scope.librarianRead();
    await window.scope.librarianHuman({
      action: "navigate",
      requestId: crypto.randomUUID(),
      expectedUiRevision: state.uiRevision,
      view: "activity",
      activity: { offset: 0, onlySelected: false, changeId: "missing-change" },
    });
  });
  await page.getByText("That change is not in this library.", { exact: true }).waitFor();
  expect((await f.client.librarian({ action: "read" })).state.activity?.changeId).toBeUndefined();

  // Cited bytes: the earlier recorded revision, and bytes nothing recorded.
  const original = await readFile(join(f.root, "retry.md"), "utf8");
  const run = await dreaming(f);
  await run.propose(
    "retry.md",
    note(
      "Retry rule",
      { kind: "semantic", stage: "silver", applicability: { type: "global" } },
      ["ci"],
      "Deploys can need one retry, with the same request ID.",
    ),
  );
  await page.getByRole("button", { name: "Accept proposal", exact: true }).click();
  await page.getByText("No decisions waiting.", { exact: false }).waitFor();
  await run.refresh();
  await run.propose(
    "steps.md",
    note(
      "Rollback steps",
      { kind: "procedural", stage: "bronze", applicability: { type: "global" } },
      [],
      "Roll back.",
    ),
    "human",
    undefined,
    [
      { path: "retry.md", hash: hash(original) },
      { path: "deploy.md", hash: "d".repeat(64) },
    ],
  );
  await page.getByRole("heading", { name: "Rollback steps" }).waitFor();
  const changes = (await f.client.librarian({ action: "read" })).state.selectedChangeId!;
  await page.evaluate(async (changeId) => {
    const state = await window.scope.librarianRead();
    await window.scope.librarianHuman({
      action: "navigate",
      requestId: crypto.randomUUID(),
      expectedUiRevision: state.uiRevision,
      view: "activity",
      activity: { offset: 0, onlySelected: false, changeId },
    });
  }, changes);
  const detail = page.getByRole("region", { name: "Change", exact: true });
  await detail.getByRole("button", { name: "retry.md", exact: true }).click();
  const evidence = page.getByRole("region", { name: "Recorded evidence revision", exact: true });
  await evidence.getByText("Deploys can need one retry. Back to", { exact: false }).waitFor();
  expect(await evidence.getByText("These bytes match the current accepted memory.").count()).toBe(
    0,
  );
  await evidence.getByRole("button", { name: "Back to change", exact: true }).click();
  await detail.getByRole("button", { name: "deploy.md", exact: true }).click();
  await evidence.getByText("No recorded change contains these bytes.", { exact: true }).waitFor();
});
