import { afterEach, expect, test } from "vite-plus/test";
import { join } from "node:path";
import { MemorySync } from "@irudd-scope/memory-sync";
import { HubState } from "../apps/hub/src/state.ts";
import { startPairedHub } from "../apps/hub/src/paired-server.ts";
import { librarianFixture } from "./librarian-fixture.ts";

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
  await f.page.evaluate(() => window.scope.retryMemory().catch(() => undefined));
  await remote.getByRole("heading", { name: /not connected/ }).waitFor();
  // Whatever Scope still holds from this session is marked as an earlier observation.
  expect(await remote.textContent()).toMatch(
    /Current state unknown|last observed this session and may have changed/,
  );

  await f.page.getByRole("button", { name: "Memory settings", exact: true }).click();
  await f.page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
  expect((await f.client.librarian({ action: "read" })).state.view).toBe("machines");
});
