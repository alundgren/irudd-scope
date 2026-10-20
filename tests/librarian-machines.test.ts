import { afterEach, expect, test } from "vite-plus/test";
import { join } from "node:path";
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
  const hub = await startPairedHub(state, 0);
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
  await machines.getByRole("heading", { name: /\(this device\)/ }).waitFor();
  await expect.poll(() => machines.getByRole("listitem").count()).toBe(2);
  await f.page.getByText("Git sync is off on this desktop.", { exact: true }).waitFor();
  for (const limit of [
    "Browsing another machine's memories",
    "Which machine recorded each change",
    "Whether two machines hold the same content",
    "Earlier observations of a machine that cannot be reached",
  ])
    await f.page.getByText(limit, { exact: true }).waitFor();
  // Read-only: no sync or connection controls appear here.
  for (const control of ["Sync now", "Copy agent request", "Memory"])
    expect(
      await f.page
        .getByRole("region", { name: "Machines", exact: true })
        .getByRole("switch", { name: control, exact: true })
        .count(),
    ).toBe(0);
  expect(
    await f.page
      .getByRole("region", { name: "Machines", exact: true })
      .getByRole("button", { name: "Sync now", exact: true })
      .count(),
  ).toBe(0);

  open = false;
  await hub.close();
  await f.page.evaluate(() => window.scope.retryMemory().catch(() => undefined));
  await machines
    .getByText("Current state unknown. Scope keeps no earlier observation.", { exact: true })
    .waitFor();

  await f.page.getByRole("button", { name: "Memory settings", exact: true }).click();
  await f.page.getByRole("dialog", { name: "Settings", exact: true }).waitFor();
  const seen = (await f.client.librarian({ action: "read" })).state;
  expect(seen.view).toBe("machines");
});
