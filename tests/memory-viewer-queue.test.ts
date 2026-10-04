import { afterEach, expect, test } from "vite-plus/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemorySync } from "@irudd-scope/memory-sync";
import { memoryFixture, MEMORY_REPOSITORY } from "./memory-fixture.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

test("queued viewer saves are cancelled when memory is disconnected and cannot use another repository", async () => {
  const f = await memoryFixture(cleanup);
  const gate = f.gate("viewer", "okf:read personal index.md");
  const sync = new MemorySync({
    root: f.root("mac"),
    machine: "mac",
    env: f.env("mac", { extra: gate.env }),
    intervalMs: 60 * 60_000,
  });
  cleanup.push(() => sync.close());
  sync.configure({ enabled: true, repository: MEMORY_REPOSITORY });
  await sync.sync();
  expect(sync.status().bundle).toBe("registered");
  const reading = sync.runOkf(MEMORY_REPOSITORY, ["read", "personal", "index.md"]);
  const outcome = reading.then(
    () => "unexpected success",
    () => "cancelled",
  );
  await expect.poll(gate.entered, { timeout: 10000 }).toBe(true);
  const before = await readFile(join(f.clone("mac"), "index.md"), "utf8");
  const input = join(f.directory, "queued.md");
  await writeFile(input, "# This cancelled save must not run\n");
  const queued = sync.runOkf(MEMORY_REPOSITORY, [
    "write",
    "personal",
    "index.md",
    "--file",
    input,
    "--expected",
    createHash("sha256").update(before).digest("hex"),
    "--authorize-personal",
  ]);
  const queuedOutcome = queued.then(
    () => "unexpected success",
    () => "cancelled",
  );
  sync.configure({ enabled: false, repository: MEMORY_REPOSITORY });
  expect(await outcome).toBe("cancelled");
  expect(await queuedOutcome).toBe("cancelled");
  expect(await readFile(join(f.clone("mac"), "index.md"), "utf8")).toBe(before);
  await expect(sync.runOkf("octo/other-memory", ["read", "personal", "index.md"])).rejects.toThrow(
    "unavailable",
  );
});

test("viewer reads wait for the Git sync transaction to complete", async () => {
  const f = await memoryFixture(cleanup);
  const gate = f.gate("git", "git:commit");
  const sync = new MemorySync({
    root: f.root("mac"),
    machine: "mac",
    env: f.env("mac", { extra: gate.env }),
    intervalMs: 60 * 60_000,
  });
  cleanup.push(() => sync.close());
  sync.configure({ enabled: true, repository: MEMORY_REPOSITORY });
  await sync.sync();
  cleanup.push(gate.release);
  await writeFile(`${f.clone("mac")}/index.md`, "# Queued memory\n");
  const syncing = sync.sync();
  await expect.poll(gate.entered, { timeout: 10000 }).toBe(true);
  let completed = false;
  const reading = sync
    .runOkf(MEMORY_REPOSITORY, ["read", "personal", "index.md"])
    .then((result) => {
      completed = true;
      return result;
    });
  expect(completed).toBe(false);
  expect(await gate.commands()).not.toContain("okf:read");
  await gate.release();
  await syncing;
  const result = await reading;
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).raw).toBe("# Queued memory\n");
});
