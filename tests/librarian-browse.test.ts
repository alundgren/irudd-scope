import { afterEach, expect, test } from "vite-plus/test";
import { createServer } from "node:http";
import { ScopeClient } from "@irudd-scope/protocol/client";
import { librarianFixture, library } from "./librarian-fixture.ts";

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
