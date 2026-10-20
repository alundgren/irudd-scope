import { afterEach, expect, test } from "vite-plus/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { dreaming, librarianFixture, library, note } from "./librarian-fixture.ts";

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
  await history
    .getByText("No recorded stage change. The memory may have started at this stage.", {
      exact: true,
    })
    .waitFor();
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
