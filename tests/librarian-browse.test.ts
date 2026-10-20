import { afterEach, expect, test } from "vite-plus/test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { DesktopStore } from "../apps/desktop/src/desktop-store.ts";
import { memoryCredentials } from "../apps/desktop/src/credentials.ts";
import { dreaming, librarianFixture, library, note, raw } from "./librarian-fixture.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
test("Librarian filters the whole library, keeps results beside the reader and follows references back", async () => {
  const f = await librarianFixture(cleanup);
  await library(f.root);
  await f.page.setViewportSize({ width: 1280, height: 820 });
  await f.open();
  const page = f.page;
  const results = page.getByRole("list", { name: "Memory results" });
  await results.getByRole("button", { name: "notes", exact: true }).waitFor();

  await page.getByLabel("Stage", { exact: true }).selectOption("silver");
  await page.getByText("1–1 of 1 matching memories", { exact: true }).waitFor();
  await results.getByRole("button", { name: "Deploy steps", exact: true }).waitFor();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await results.getByRole("button", { name: "notes", exact: true }).waitFor();

  await page.getByLabel("Tag", { exact: true }).selectOption("ci");
  await page.getByText("1–2 of 2 matching memories", { exact: true }).waitFor();
  await page.getByRole("textbox", { name: "Search memory", exact: true }).fill("Deploys can");
  await page.getByRole("button", { name: "Search memory", exact: true }).click();
  await page.getByText("1–1 of 1 matching memories", { exact: true }).waitFor();
  await page.getByLabel("Kind", { exact: true }).selectOption("semantic");
  await results.getByRole("button", { name: "Retry rule", exact: true }).waitFor();
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByRole("textbox", { name: "Search memory", exact: true }).fill("");
  await page.getByRole("button", { name: "Search memory", exact: true }).click();
  await page.getByLabel("Applies to", { exact: true }).selectOption("global");
  await results.getByRole("button", { name: "Deploy steps", exact: true }).click();

  const reader = page.getByRole("region", { name: "Memory", exact: true });
  await reader.getByRole("heading", { name: "Deploy steps" }).waitFor();
  // The result list stays beside the reader at laptop width.
  expect(
    await results
      .getByRole("button", { name: "Deploy steps", exact: true })
      .getAttribute("aria-current"),
  ).toBe("true");
  const details = reader.getByLabel("Memory details");
  for (const label of ["Silver", "Procedure", "Applies: Everywhere"])
    await details.getByText(label, { exact: true }).waitFor();
  await reader.getByText("Broken reference: gone.md does not exist", { exact: false }).waitFor();
  await reader
    .getByRole("list", { name: "References" })
    .getByRole("button", { name: "Retry rule", exact: true })
    .click();
  await reader.getByRole("heading", { name: "Retry rule" }).waitFor();
  await details.getByText("Applies: Repository atlas", { exact: true }).waitFor();
  await reader
    .getByRole("list", { name: "Backlinks" })
    .getByRole("button", { name: "Deploy steps", exact: true })
    .waitFor();
  await reader.getByRole("button", { name: "Back to previous memory", exact: true }).click();
  await reader.getByRole("heading", { name: "Deploy steps" }).waitFor();

  await reader.getByRole("button", { name: "#deploy", exact: true }).click();
  await page.getByText("1–1 of 1 matching memories", { exact: true }).waitFor();
  const seen = (await f.client.librarian({ action: "read" })).state;
  expect(seen.view).toBe("browse");
  expect(seen.browse?.filters).toEqual({ applicability: "global", tag: "deploy" });
  expect(seen.focusPath).toBe("deploy.md");

  await f.restart();
  await f.page.setViewportSize({ width: 1280, height: 820 });
  await f.open();
  expect(await f.page.getByLabel("Tag", { exact: true }).inputValue()).toBe("deploy");
  await f.page
    .getByRole("list", { name: "Memory results" })
    .getByRole("button", { name: "Deploy steps", exact: true })
    .waitFor();
});

test("the reader lists recorded changes, Retry repeats the failed read, and agents browse without the person's filters", async () => {
  const f = await librarianFixture(cleanup);
  await f.page.setViewportSize({ width: 620, height: 640 });
  await f.open();
  const run = await dreaming(f);
  const first = note(
    "Deploy steps",
    { kind: "procedural", stage: "bronze", applicability: { type: "global" } },
    ["deploy"],
    "Run the deploy.",
  );
  await run.propose("deploy.md", first);
  await f.page.getByRole("button", { name: "Accept proposal", exact: true }).click();
  await f.page
    .getByText("No decisions waiting. Continue with your existing agent.", { exact: true })
    .waitFor();
  await run.refresh();
  await run.propose(
    "deploy.md",
    note(
      "Deploy steps",
      { kind: "procedural", stage: "silver", applicability: { type: "global" } },
      ["deploy"],
      "Run the deploy.",
    ),
  );
  await f.page.getByRole("button", { name: "Accept proposal", exact: true }).click();
  await f.page
    .getByText("No decisions waiting. Continue with your existing agent.", { exact: true })
    .waitFor();
  await f.page.getByRole("button", { name: "Browse memories", exact: true }).click();
  await f.page.getByLabel("Tag", { exact: true }).selectOption("deploy");
  await f.page.getByRole("button", { name: "Deploy steps", exact: true }).click();
  const reader = f.page.getByRole("region", { name: "Memory", exact: true });
  await reader.getByRole("button", { name: "Recorded changes", exact: true }).click();
  await reader.getByText("Stage Bronze → Silver", { exact: true }).waitFor();
  const items = reader.getByRole("list", { name: "Recorded changes" }).getByRole("listitem");
  expect(await items.count()).toBe(2);
  expect(await items.first().textContent()).toContain("Accepted by You in Scope");
  expect(await items.first().textContent()).toContain("Proposed by Agent existing-session");

  // Opening a memory that disappeared fails; Retry repeats that read rather than the list.
  await reader.getByRole("button", { name: "Back to results", exact: true }).click();
  await f.page.getByLabel("Tag", { exact: true }).selectOption("");
  await f.page.getByRole("button", { name: "recovery", exact: true }).waitFor();
  await rm(join(f.root, "recovery.md"));
  await f.page.getByRole("button", { name: "recovery", exact: true }).click();
  const alert = f.page.getByRole("alert");
  await alert.waitFor();
  await writeFile(join(f.root, "recovery.md"), "# Recovery\n\nBack again.\n");
  await alert.getByRole("button", { name: "Retry", exact: true }).click();
  await reader.getByText("Back again.", { exact: true }).waitFor();

  await f.page.getByRole("button", { name: "Back to results", exact: true }).click();
  await f.page.getByLabel("Stage", { exact: true }).selectOption("silver");
  await f.page.getByText("1–1 of 1 matching memories", { exact: true }).waitFor();
  const state = (await f.client.librarian({ action: "read" })).state;
  const selected = await f.client.librarian({
    action: "select",
    requestId: randomUUID(),
    expectedUiRevision: state.uiRevision,
    runId: run.runId,
    capability: run.capability,
    sessionId: "existing-session",
    view: "browse",
  });
  expect(selected.state.browse?.filters).toEqual({});
  await f.page.getByRole("button", { name: "recovery", exact: true }).waitFor();
});

test("filters are disabled with a note when the library list fails, and folder browsing still works", async () => {
  const f = await librarianFixture(cleanup, { env: { FAKE_OKF_LIST_FAILS: "1" } });
  await f.open();
  await f.page.getByRole("button", { name: "recovery", exact: true }).waitFor();
  await f.page
    .getByText("Filters are unavailable because the library list could not be read.", {
      exact: true,
    })
    .waitFor();
  expect(await f.page.getByLabel("Stage", { exact: true }).isDisabled()).toBe(true);
});

test("the reader's scroll position is saved in the tab and restored after restart", async () => {
  const f = await librarianFixture(cleanup);
  const body = Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");
  await writeFile(
    join(f.root, "long.md"),
    note(
      "Long note",
      { kind: "semantic", stage: "gold", applicability: { type: "global" } },
      [],
      body,
    ),
  );
  await writeFile(
    join(f.root, "other.md"),
    note(
      "Other note",
      { kind: "semantic", stage: "gold", applicability: { type: "global" } },
      [],
      body.replaceAll("Paragraph", "Other paragraph"),
    ),
  );
  await f.page.setViewportSize({ width: 620, height: 560 });
  await f.open();
  const tabState = () =>
    f.page.evaluate(
      async () =>
        (await window.scope.workspace())!.tabs.find((tab) => tab.type === "memory")!.state,
    );
  expect((await tabState()).version).toBe(2);
  await f.page.getByRole("button", { name: "long", exact: true }).click();
  await f.page.getByText("Paragraph 80.", { exact: true }).waitFor();
  let view = f.page.locator(".librarian-view");
  await view.evaluate((element) => {
    element.scrollTop = 600;
    element.dispatchEvent(new Event("scroll"));
  });
  await expect
    .poll(async () => (await tabState()) as { version: number; data: { positions?: object } })
    .toMatchObject({ version: 3, data: { positions: { memory: 600 } } });
  await f.restart();
  await f.page.setViewportSize({ width: 620, height: 560 });
  await f.open();
  await f.page.getByText("Paragraph 80.", { exact: true }).waitFor();
  view = f.page.locator(".librarian-view");
  await expect
    .poll(() => f.page.locator(".librarian-view").evaluate((element) => element.scrollTop))
    .toBe(600);
  await f.page.getByRole("button", { name: "Back to results", exact: true }).click();
  await f.page.getByRole("button", { name: "other", exact: true }).click();
  await f.page.getByText("Other paragraph 80.", { exact: true }).waitFor();
  expect(await view.evaluate((element) => element.scrollTop)).toBe(0);
});

test("the CLI client accepts Librarian replies from newer desktops with unknown views and fields", async () => {
  const token = "synthetic-token";
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        state: { version: 1, uiRevision: 4, view: "future-view", futureField: { kept: true } },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address() as { port: number };
  const reply = await new ScopeClient(`http://127.0.0.1:${address.port}`, token).librarian({
    action: "read",
  });
  expect(reply.state.view).toBe("future-view");
  expect((reply.state as unknown as { futureField: object }).futureField).toEqual({ kept: true });
});

test("a Librarian document saved before this version reopens its memory with results and filters", async () => {
  const f = await librarianFixture(cleanup);
  await library(f.root);
  await f.page.setViewportSize({ width: 1280, height: 820 });
  await f.open();
  const run = await dreaming(f);
  await run.refresh();
  await f.client.librarian({
    action: "finish",
    requestId: randomUUID(),
    expectedUiRevision: run.reply.state.uiRevision,
    runId: run.runId,
    capability: run.capability,
    sessionId: "existing-session",
    userRequest: "Finish dreaming.",
  });
  await f.page.getByRole("button", { name: "Back", exact: true }).click();
  await f.page.getByRole("button", { name: "deploy", exact: true }).click();
  const reader = f.page.getByRole("region", { name: "Memory", exact: true });
  await reader.getByRole("heading", { name: "Deploy steps" }).waitFor();
  await f.restart(async () => {
    const store = new DesktopStore(f.desktop.settingsDirectory, memoryCredentials());
    await store.load();
    try {
      // Keep only the fields the previous version stored: no groups, result page or facets.
      const {
        browse: _browse,
        results: _results,
        facets: _facets,
        focusPath: _focus,
        ...previous
      } = await store.librarian();
      expect(previous.view).toBe("memory");
      await store.saveLibrarian(previous);
    } finally {
      await store.close();
    }
  });
  await f.page.setViewportSize({ width: 1280, height: 820 });
  await f.open();
  await f.page
    .getByRole("region", { name: "Memory", exact: true })
    .getByRole("heading", { name: "Deploy steps" })
    .waitFor();
  await f.page
    .getByRole("list", { name: "Memory results" })
    .getByRole("button", { name: "deploy", exact: true })
    .waitFor();
  await expect.poll(() => f.page.getByLabel("Stage", { exact: true }).isEnabled()).toBe(true);
  const tab = await f.page.evaluate(
    async () => (await window.scope.workspace())!.tabs.find((tab) => tab.type === "memory")!.state,
  );
  expect(tab.version).toBe(2);
  expect((await f.client.librarian({ action: "read" })).state.run?.status).toBe("completed");
});

test("filters with a search over 300 hits say how much was searched, and Back to results keeps the page", async () => {
  const f = await librarianFixture(cleanup);
  for (let index = 0; index < 310; index++)
    await writeFile(
      join(f.root, `needle-${String(index).padStart(3, "0")}.md`),
      raw(`Needle ${String(index).padStart(3, "0")}`, "A needle in the library."),
    );
  await f.page.setViewportSize({ width: 620, height: 700 });
  await f.open();
  await f.page.getByLabel("Stage", { exact: true }).selectOption("bronze");
  await f.page.getByRole("textbox", { name: "Search memory", exact: true }).fill("needle");
  await f.page.getByRole("button", { name: "Search memory", exact: true }).click();
  await f.page
    .getByText("1–30 of 300 matches in the first 300 of 310 search results", { exact: true })
    .waitFor();
  await f.page.getByRole("button", { name: "Next", exact: true }).click();
  await f.page
    .getByText("31–60 of 300 matches in the first 300 of 310 search results", { exact: true })
    .waitFor();
  const first = f.page
    .getByRole("list", { name: "Memory results" })
    .getByRole("listitem")
    .first()
    .getByRole("button");
  const title = (await first.textContent())!;
  await first.click();
  await f.page
    .getByRole("region", { name: "Memory", exact: true })
    .getByRole("heading", { name: title })
    .waitFor();
  await f.page.getByRole("button", { name: "Back to results", exact: true }).click();
  await f.page
    .getByText("31–60 of 300 matches in the first 300 of 310 search results", { exact: true })
    .waitFor();
  expect(
    await f.page.getByRole("textbox", { name: "Search memory", exact: true }).inputValue(),
  ).toBe("needle");
});

test("recorded changes stop at the scan limit and read large records in smaller pages", async () => {
  const f = await librarianFixture(cleanup);
  const big = "x".repeat(100_000);
  const changes = Array.from({ length: 1001 }, (_, index) => ({
    version: 1,
    id: `bulk-${index}`,
    bundle: "personal",
    path: "elsewhere.md",
    action: "update",
    before: { raw: index > 970 ? big : "before", hash: "a".repeat(64) },
    after: { raw: index > 970 ? big : "after", hash: "b".repeat(64) },
    revisionHash: "c".repeat(64),
    status: "accepted",
    actor: { type: "agent", id: "bulk-session" },
    reason: "Bulk synthetic change.",
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, index)).toISOString(),
    sources: [],
    reviews: [],
  }));
  await writeFile(join(f.root, "fixture-changes.json"), JSON.stringify(changes));
  await f.open();
  await f.page.getByRole("button", { name: "recovery", exact: true }).click();
  const reader = f.page.getByRole("region", { name: "Memory", exact: true });
  await reader.getByRole("button", { name: "Recorded changes", exact: true }).click();
  await reader
    .getByText("Showing changes found in the latest 1000 recorded changes.", { exact: false })
    .waitFor({ timeout: 60_000 });
  await reader.getByText("No recorded changes for this memory.", { exact: true }).waitFor();
}, 120_000);

test("switching to another library forgets the previous library's selection and filters", async () => {
  const f = await librarianFixture(cleanup);
  await library(f.root);
  await f.page.setViewportSize({ width: 1280, height: 820 });
  await f.open();
  await f.page.getByLabel("Tag", { exact: true }).selectOption("ci");
  await f.page.getByRole("button", { name: "Deploy steps", exact: true }).click();
  await f.page
    .getByRole("region", { name: "Memory", exact: true })
    .getByRole("heading", { name: "Deploy steps" })
    .waitFor();
  // The same folder now holds a different library, as after connecting another repository.
  await writeFile(
    join(f.root, "memory-bundle.json"),
    JSON.stringify({ id: randomUUID(), formatVersion: 2, name: "personal" }),
  );
  await f.page
    .getByRole("tablist", { name: "Librarian views" })
    .getByRole("tab", { name: "Activity", exact: true })
    .click();
  await f.page.getByText("Recorded changes in this desktop's copy", { exact: false }).waitFor();
  const seen = (await f.client.librarian({ action: "read" })).state;
  expect(seen.focusPath).toBeUndefined();
  expect(seen.browse?.filters).toEqual({});
  expect(await f.page.getByRole("button", { name: "Selected memory only" }).isDisabled()).toBe(
    true,
  );
});

test("Browse returns to the list or reader the person left, with results matching the search", async () => {
  const f = await librarianFixture(cleanup);
  await library(f.root);
  await f.page.setViewportSize({ width: 1280, height: 820 });
  await f.open();
  const page = f.page;
  const tabs = page.getByRole("tablist", { name: "Librarian views" });
  const results = page.getByRole("list", { name: "Memory results" });
  await results.getByRole("button", { name: "deploy", exact: true }).click();
  const reader = page.getByRole("region", { name: "Memory", exact: true });
  await reader.getByRole("heading", { name: "Deploy steps" }).waitFor();
  await page.getByRole("textbox", { name: "Search memory", exact: true }).fill("Deploys can");
  await page.getByRole("button", { name: "Search memory", exact: true }).click();
  await results.getByRole("button", { name: "Retry rule", exact: true }).waitFor();
  await tabs.getByRole("tab", { name: "Activity", exact: true }).click();
  await page.getByText("Recorded changes in this desktop's copy", { exact: false }).waitFor();
  // The person left the search results, so Browse returns to them rather than the old reader.
  await tabs.getByRole("tab", { name: "Browse", exact: true }).click();
  await page.getByText("Choose a memory to read it here.", { exact: true }).waitFor();
  expect(await results.getByRole("listitem").count()).toBe(1);
  await results.getByRole("button", { name: "Retry rule", exact: true }).click();
  await reader.getByRole("heading", { name: "Retry rule" }).waitFor();
  await tabs.getByRole("tab", { name: "Stages", exact: true }).click();
  await page.getByRole("region", { name: "Bronze", exact: true }).waitFor();
  await tabs.getByRole("tab", { name: "Browse", exact: true }).click();
  await reader.getByRole("heading", { name: "Retry rule" }).waitFor();
  // The list beside the reader is still the search the box shows.
  expect(await results.getByRole("listitem").count()).toBe(1);
  expect(
    await results
      .getByRole("button", { name: "Retry rule", exact: true })
      .getAttribute("aria-current"),
  ).toBe("true");
});
