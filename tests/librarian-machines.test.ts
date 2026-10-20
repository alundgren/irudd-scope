import { afterEach, expect, test } from "vite-plus/test";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemorySync } from "@irudd-scope/memory-sync";
import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";
import { desktopFixture } from "./desktop-fixture.ts";
import { librarianFixture } from "./librarian-fixture.ts";
import { MEMORY_REPOSITORY, memoryFixture } from "./memory-fixture.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("Machines shows each machine's observed memory state read-only and states what Scope cannot know", async () => {
  const f = await librarianFixture(cleanup);
  await f.open();
  await f.page.getByRole("button", { name: "recovery", exact: true }).waitFor();
  const state = await HubState.open(join(f.memory.directory, "machines-hub"));
  cleanup.push(() => state.close());
  const connectionFile = join(f.memory.directory, "machines-remote.json");
  await state.configure({ endpoint: "http://127.0.0.1:1", port: 1, connectionFile });
  const remoteSync = new MemorySync({
    root: f.memory.root("studio"),
    machine: "studio",
    env: f.memory.env("studio"),
    intervalMs: 60 * 60_000,
  });
  cleanup.push(() => remoteSync.close());
  const hub = await startPairedHub(state, 0, undefined, remoteSync);
  let open = true;
  cleanup.push(() => (open ? hub.close() : undefined));
  await state.configure({ endpoint: hub.url, port: Number(new URL(hub.url).port), connectionFile });
  await f.page.evaluate((url) => window.scope.pairRemote(url), state.pairUrl());
  await expect
    .poll(() => f.page.evaluate(async () => (await window.scope.remotes())[0]?.connection))
    .toBe("connected");

  await f.page
    .getByRole("tablist", { name: "Librarian views" })
    .getByRole("tab", { name: "Machines", exact: true })
    .click();
  const machines = f.page.getByRole("list", { name: "Memory by machine" });
  const local = machines.getByRole("listitem").filter({ hasText: "(this device)" });
  await local.getByText("Local only (Git sync is off)", { exact: false }).waitFor();
  const remote = machines.getByRole("listitem").filter({ hasNotText: "(this device)" });
  // This desktop has no Git sync, so the paired machine reports memory as off, not broken.
  await remote.getByText("Sync is off", { exact: false }).waitFor();
  expect(await remote.textContent()).not.toContain("needs attention");
  expect(await remote.textContent()).not.toContain("not installed");
  await f.page.getByText("Git sync is off on this desktop.", { exact: true }).waitFor();
  for (const limit of [
    "Browsing another machine's memories",
    "Which machine recorded each change",
    "Whether two machines hold the same content",
    "Live sync progress and last contact time",
    "Observations of an unreachable machine after Scope restarts",
  ])
    await f.page.getByText(limit, { exact: true }).waitFor();
  // Read-only: no sync or connection controls appear here.
  const view = f.page.getByRole("region", { name: "Machines", exact: true });
  expect(await view.getByRole("switch").count()).toBe(0);
  expect(await view.getByRole("button", { name: "Sync now", exact: true }).count()).toBe(0);

  open = false;
  await hub.close();
  // The ended connection keeps this session's last status, marked as possibly out of date.
  await remote
    .getByRole("heading", { name: /details may be out of date/ })
    .waitFor({ timeout: 30_000 });
  await remote
    .getByText("last observed this session and may have changed", { exact: false })
    .waitFor();

  await f.page.getByRole("button", { name: "Memory settings", exact: true }).click();
  await f.page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
  expect((await f.client.librarian({ action: "read" })).state.view).toBe("machines");
});

test("Machines flags conflicts but not routine tooling messages on a synced machine", async () => {
  const f = await memoryFixture(cleanup);
  const fixture = await desktopFixture({
    hideInitialPrompts: true,
    env: { ...f.env("mac", { extra: { FAKE_OKF_UPGRADE: "1" } }), SCOPE_MEMORY_DIR: f.root("mac") },
  });
  cleanup.push(() => rm(fixture.directory, { recursive: true, force: true }));
  const application = await fixture.launch();
  cleanup.push(() => application.close());
  const page = await application.firstWindow();
  page.setDefaultTimeout(10_000);
  await page.getByRole("heading", { name: "Things your agents leave for you" }).waitFor();
  await page.evaluate(() => window.scope.setMemoryEnabled(true));
  const client = await fixture.connect();
  await client.connectMemory(MEMORY_REPOSITORY);
  await page.evaluate(() => window.scope.setMemorySyncEnabled(true));
  await expect
    .poll(
      () => page.evaluate(async () => (await window.scope.memory()).machines[0]?.status?.phase),
      { timeout: 30_000 },
    )
    .toBe("synced");
  await expect
    .poll(
      () =>
        page.evaluate(async () => (await window.scope.memory()).machines[0]?.status?.okf.message),
      { timeout: 30_000 },
    )
    .toMatch(/irudd-okf/);
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("button", { name: "Librarian", exact: true }).click();
  await page
    .getByRole("tablist", { name: "Librarian views" })
    .getByRole("tab", { name: "Machines", exact: true })
    .click();
  const local = page
    .getByRole("list", { name: "Memory by machine" })
    .getByRole("listitem")
    .filter({ hasText: "(this device)" });
  await local.getByText("Last sync succeeded", { exact: false }).waitFor();
  expect(await local.textContent()).not.toContain("needs attention");

  const laptop = new MemorySync({
    root: f.root("laptop"),
    machine: "laptop",
    env: f.env("laptop"),
    intervalMs: 60 * 60_000,
  });
  cleanup.push(() => laptop.close());
  laptop.configure({ enabled: true, repository: MEMORY_REPOSITORY });
  await laptop.sync();
  await writeFile(join(f.clone("laptop"), "index.md"), "Laptop line.\n");
  await laptop.sync();
  await writeFile(join(f.clone("mac"), "index.md"), "Mac line.\n");
  await page.evaluate(() => window.scope.retryMemory());
  await local.getByRole("heading", { name: /needs attention/ }).waitFor({ timeout: 30_000 });
  await local
    .getByRole("list", { name: /conflicts/ })
    .getByRole("button")
    .first()
    .waitFor();
}, 90_000);
