import { afterEach, expect, test } from "vite-plus/test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { dreaming, librarianFixture, library, note, raw } from "./librarian-fixture.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("Connections explores one memory's links with an equivalent keyboard list and keeps its place", async () => {
  const f = await librarianFixture(cleanup);
  await library(f.root);
  await f.page.setViewportSize({ width: 1280, height: 820 });
  await f.open();
  const page = f.page;
  const tabs = page.getByRole("tablist", { name: "Librarian views" });
  await tabs.getByRole("tab", { name: "Connections", exact: true }).click();
  await page.getByText("Choose a memory in Browse first.", { exact: false }).waitFor();

  await tabs.getByRole("tab", { name: "Browse", exact: true }).click();
  await page.getByRole("button", { name: "deploy", exact: true }).click();
  await page
    .getByRole("region", { name: "Memory", exact: true })
    .getByRole("heading", { name: "Deploy steps" })
    .waitFor();
  await tabs.getByRole("tab", { name: "Connections", exact: true }).click();
  const connected = page.getByRole("list", { name: "Connected memories" });
  const retry = connected.getByRole("listitem").filter({ hasText: "Retry rule" });
  await retry.getByText("References each other", { exact: true }).waitFor();
  expect(await connected.getByRole("listitem").count()).toBe(1);
  await page
    .getByText("deploy.md points to gone.md, which does not exist", { exact: false })
    .waitFor();

  await page.getByRole("button", { name: "Expand to 2 steps", exact: true }).click();
  await connected.getByRole("button", { name: "Old episode", exact: true }).waitFor();
  await connected
    .getByRole("listitem")
    .filter({ hasText: "Old episode" })
    .getByText("Linked through another memory", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "Shared tags", exact: true }).click();
  await retry
    .getByText("References each other · Shares #ci (not a reference)", { exact: true })
    .waitFor();

  const node = page.getByRole("button", { name: "Focus Retry rule", exact: true });
  await node.focus();
  await page.keyboard.press("Enter");
  await page
    .getByText("Focused on", { exact: false })
    .getByText("Retry rule", { exact: true })
    .waitFor();
  const seen = (await f.client.librarian({ action: "read" })).state;
  expect(seen.view).toBe("connections");
  expect(seen.focusPath).toBe("retry.md");
  expect(seen.connections).toEqual({ depth: 2, sharedTags: true });

  // Arrow keys move between views; Browse then returns to the shared memory.
  await tabs.getByRole("tab", { name: "Connections", exact: true }).focus();
  await page.keyboard.press("ArrowLeft");
  await page
    .getByRole("region", { name: "Memory", exact: true })
    .getByRole("heading", { name: "Retry rule" })
    .waitFor();
  expect(
    await tabs.getByRole("tab", { name: "Browse", exact: true }).getAttribute("aria-selected"),
  ).toBe("true");
  await tabs.getByRole("tab", { name: "Connections", exact: true }).click();
  await page.getByRole("button", { name: "Return to 1 step", exact: true }).waitFor();
});

test("Stages counts the whole library and shows a memory's recorded promotion separately from review", async () => {
  const f = await librarianFixture(cleanup);
  await library(f.root);
  await f.open();
  const run = await dreaming(f);
  const promoted = note(
    "Retry rule",
    { kind: "semantic", stage: "silver", applicability: { type: "repository", id: "atlas" } },
    ["ci"],
    "Deploys can need one retry. Back to [Deploy steps](deploy.md).",
  );
  await run.propose("retry.md", promoted);
  await f.page.getByRole("button", { name: "Accept proposal", exact: true }).click();
  await f.page
    .getByText("No decisions waiting. Continue with your existing agent.", { exact: true })
    .waitFor();
  await f.page.getByRole("button", { name: "Browse memories", exact: true }).click();
  const tabs = f.page.getByRole("tablist", { name: "Librarian views" });
  await tabs.getByRole("tab", { name: "Stages", exact: true }).click();
  // recovery, validation and the old episode are bronze; deploy and the promoted rule are silver.
  await f.page
    .getByRole("region", { name: "Bronze", exact: true })
    .getByRole("heading", { name: "Bronze 3" })
    .waitFor();
  const silver = f.page.getByRole("region", { name: "Silver", exact: true });
  await silver.getByRole("heading", { name: "Silver 2" }).waitFor();
  await f.page
    .getByRole("region", { name: "Gold", exact: true })
    .getByRole("heading", { name: "Gold 0" })
    .waitFor();
  await silver.getByRole("button", { name: "Retry rule", exact: true }).click();
  const history = f.page.getByRole("region", { name: "Stage history", exact: true });
  await history.getByText("Stage Bronze → Silver", { exact: true }).waitFor();
  expect(await history.textContent()).toContain("Accepted by You in Scope");
  expect(await readFile(join(f.root, "retry.md"), "utf8")).toBe(promoted);

  await silver.getByRole("button", { name: "Deploy steps", exact: true }).click();
  await history.getByText("No recorded stage change.", { exact: true }).waitFor();
  const seen = (await f.client.librarian({ action: "read" })).state;
  expect(seen.view).toBe("stages");
  expect((seen.displayed as { counts: object }).counts).toEqual({
    bronze: 3,
    silver: 2,
    gold: 0,
    none: 0,
  });

  await f.restart();
  await f.open();
  expect(
    await f.page
      .getByRole("tablist", { name: "Librarian views" })
      .getByRole("tab", { name: "Stages", exact: true })
      .getAttribute("aria-selected"),
  ).toBe("true");
  await f.page.getByRole("region", { name: "Silver", exact: true }).waitFor();
});

test("large neighbourhoods and stages stay bounded, narrow windows list first, and removed memories fall back", async () => {
  const f = await librarianFixture(cleanup);
  const links = Array.from({ length: 45 }, (_, index) => {
    const name = `leaf-${String(index).padStart(2, "0")}`;
    return { name, line: `[Leaf ${index}](${name}.md)` };
  });
  for (const { name } of links)
    await writeFile(join(f.root, `${name}.md`), raw(name, "A leaf memory."));
  await writeFile(join(f.root, "hub.md"), raw("Hub", links.map((link) => link.line).join(" ")));
  await f.page.setViewportSize({ width: 1280, height: 820 });
  await f.open();
  await f.page.getByRole("button", { name: "hub", exact: true }).click();
  const tabs = f.page.getByRole("tablist", { name: "Librarian views" });
  await tabs.getByRole("tab", { name: "Connections", exact: true }).click();
  await f.page
    .getByText("More connections exist than this limit shows.", { exact: false })
    .waitFor();
  await f.page.getByText("The graph draws 7; the list shows all.", { exact: false }).waitFor();
  expect(await f.page.getByRole("button", { name: /^Focus / }).count()).toBe(7);
  expect(
    await f.page.getByRole("list", { name: "Connected memories" }).getByRole("listitem").count(),
  ).toBe(39);

  await f.page.setViewportSize({ width: 620, height: 700 });
  await expect.poll(() => f.page.locator(".librarian-graph svg").isVisible()).toBe(false);
  await f.page.getByRole("button", { name: "Show graph", exact: true }).click();
  await expect.poll(() => f.page.locator(".librarian-graph svg").isVisible()).toBe(true);
  await f.page.setViewportSize({ width: 1280, height: 820 });

  // Arriving with a memory from Browse does not scan history until asked.
  await tabs.getByRole("tab", { name: "Stages", exact: true }).click();
  const bronze = f.page.getByRole("region", { name: "Bronze", exact: true });
  await bronze.getByRole("heading", { name: "Bronze 48" }).waitFor();
  await f.page.getByRole("button", { name: "Show recorded stage changes", exact: true }).click();
  await f.page.getByText("No recorded stage change.", { exact: true }).waitFor();
  await bronze.getByRole("button", { name: "Show all 48", exact: true }).click();
  const page = f.page.getByRole("region", { name: "Bronze", exact: true });
  await expect.poll(() => page.getByRole("listitem").count()).toBe(20);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Previous", exact: true }).waitFor();
  await expect
    .poll(() => f.client.librarian({ action: "read" }).then((r) => r.state.stages?.offset))
    .toBe(20);
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect.poll(() => page.getByRole("listitem").count()).toBe(8);
  await page.getByRole("button", { name: "All stages", exact: true }).click();
  await f.page.getByRole("region", { name: "Silver", exact: true }).waitFor();

  // Both rings filled: drawn nodes stay apart and inside the drawing.
  for (let leaf = 0; leaf < 5; leaf++) {
    const fars = [0, 1].map((far) => `far-${leaf}-${far}`);
    for (const far of fars) await writeFile(join(f.root, `${far}.md`), raw(far, "Far away."));
    await writeFile(
      join(f.root, `near-${leaf}.md`),
      raw(`near-${leaf}`, fars.map((far) => `[${far}](${far}.md)`).join(" ")),
    );
  }
  await writeFile(
    join(f.root, "center.md"),
    raw("Center", [0, 1, 2, 3, 4].map((leaf) => `[near ${leaf}](near-${leaf}.md)`).join(" ")),
  );
  await tabs.getByRole("tab", { name: "Browse", exact: true }).click();
  await f.page.getByRole("textbox", { name: "Search memory", exact: true }).fill("Center");
  await f.page.getByRole("button", { name: "Search memory", exact: true }).click();
  await f.page.getByRole("button", { name: "Center", exact: true }).click();
  await tabs.getByRole("tab", { name: "Connections", exact: true }).click();
  await f.page.getByText("Focused on", { exact: false }).getByText("Center").waitFor();
  await f.page.getByRole("button", { name: "Expand to 2 steps", exact: true }).click();
  await f.page.getByRole("button", { name: "Return to 1 step", exact: true }).waitFor();
  await f.page.getByText("The graph draws 14; the list shows all.", { exact: false }).waitFor();
  const boxes = await f.page.locator(".librarian-graph g.memory-graph-node").evaluateAll((nodes) =>
    nodes.map((node) => {
      const [x, y] = /translate\(([-\d.]+),([-\d.]+)\)/
        .exec(node.getAttribute("transform")!)!
        .slice(1)
        .map(Number);
      return { x: x!, y: y! };
    }),
  );
  expect(boxes).toHaveLength(14);
  for (const [index, box] of boxes.entries()) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + 160).toBeLessThanOrEqual(840);
    expect(box.y + 44).toBeLessThanOrEqual(420);
    for (const other of boxes.slice(index + 1))
      expect(Math.abs(box.x - other.x) >= 160 || Math.abs(box.y - other.y) >= 44).toBe(true);
  }

  await tabs.getByRole("tab", { name: "Stages", exact: true }).click();
  await f.page.getByRole("region", { name: "Bronze", exact: true }).waitFor();
  await rm(join(f.root, "center.md"));
  await tabs.getByRole("tab", { name: "Connections", exact: true }).click();
  await f.page.getByText("Choose a memory in Browse first.", { exact: false }).waitFor();
  await f.page.getByText("That memory is no longer in the library.", { exact: false }).waitFor();
  await tabs.getByRole("tab", { name: "Browse", exact: true }).click();
  await f.page.getByRole("textbox", { name: "Search memory", exact: true }).fill("leaf-00");
  await f.page.getByRole("button", { name: "Search memory", exact: true }).click();
  await f.page.getByRole("button", { name: "leaf-00", exact: true }).click();
  await f.page
    .getByRole("region", { name: "Memory", exact: true })
    .getByRole("heading", { name: "leaf-00" })
    .waitFor();
  await tabs.getByRole("tab", { name: "Stages", exact: true }).click();
  await f.page.getByRole("region", { name: "Bronze", exact: true }).waitFor();
  await rm(join(f.root, "leaf-00.md"));
  await tabs.getByRole("tab", { name: "Browse", exact: true }).click();
  await f.page.getByText("Choose a memory to read it here.", { exact: true }).waitFor();
  await f.page.getByRole("list", { name: "Memory results" }).waitFor();
  expect(await f.page.getByRole("alert").count()).toBe(0);
  const seen = (await f.client.librarian({ action: "read" })).state;
  expect(seen.view).toBe("browse");
  expect(seen.focusPath).toBeUndefined();
});
