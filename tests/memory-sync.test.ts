import { afterEach, expect, test } from "vite-plus/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemorySync } from "@irudd-scope/memory-sync";
import { MEMORY_REPOSITORY, memoryFixture } from "./memory-fixture.ts";

const cleanup: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
  const f = await memoryFixture(cleanup);
  const machine = async (
    name: string,
    options: Parameters<typeof f.env>[1] & { now?: () => Date } = {},
  ) => {
    const sync = new MemorySync({
      root: f.root(name),
      machine: name,
      env: f.env(name, options),
      intervalMs: 60 * 60_000,
      now: options.now,
    });
    cleanup.push(() => sync.close());
    sync.configure({ enabled: true, repository: MEMORY_REPOSITORY });
    await sync.sync();
    return sync;
  };
  return { ...f, machine };
}

test("a machine clones the memory repository, registers the personal bundle, and pushes nothing when unchanged", async () => {
  const f = await setup();
  const before = await f.head();
  const laptop = await f.machine("laptop");
  expect(laptop.status()).toMatchObject({
    phase: "synced",
    bundle: "registered",
    root: f.clone("laptop"),
    repository: MEMORY_REPOSITORY,
    okf: { installed: true, version: "0.1.0" },
    conflicts: [],
  });
  expect(await readFile(join(f.clone("laptop"), "index.md"), "utf8")).toContain("First line.");
  expect((await f.okfConfig("laptop")).bundles).toEqual([
    { name: "personal", root: f.clone("laptop") },
  ]);
  await laptop.sync();
  await laptop.sync();
  expect(await f.head()).toBe(before);
  expect(await f.git(f.clone("laptop"), "log", "--format=%s")).toBe("Initialize memory\n");
});

test("changes on one machine reach GitHub and then another machine", async () => {
  const f = await setup();
  const laptop = await f.machine("laptop");
  const server = await f.machine("server");
  await writeFile(join(f.clone("laptop"), "lesson.md"), "# Lesson\n\nRun the tests first.\n");
  await laptop.sync();
  expect(await f.git(f.clone("laptop"), "log", "-1", "--format=%s")).toBe(
    "memory: update from laptop\n",
  );
  await server.sync();
  expect(await readFile(join(f.clone("server"), "lesson.md"), "utf8")).toContain(
    "Run the tests first.",
  );
  const head = await f.head();
  await server.sync();
  expect(await f.head()).toBe(head);
});

test("a conflicting machine moves its edit to a pull request and keeps syncing", async () => {
  const f = await setup();
  const laptop = await f.machine("laptop");
  const server = await f.machine("server", {
    now: () => new Date("2026-10-04T12:30:15.123Z"),
  });
  await writeFile(join(f.clone("laptop"), "index.md"), "# Personal memory\n\nLaptop line.\n");
  await laptop.sync();
  await writeFile(join(f.clone("server"), "index.md"), "# Personal memory\n\nServer line.\n");
  await server.sync();

  const branch = "memory-conflict/server-20261004T123015Z";
  expect(await f.remoteBranches()).toContain(branch);
  expect(await f.git(f.directory, "--git-dir", f.bare, "show", `${branch}:index.md`)).toContain(
    "Server line.",
  );
  expect(await f.pulls()).toEqual([
    expect.objectContaining({ headRefName: branch, state: "OPEN" }),
  ]);
  expect(server.status()).toMatchObject({
    phase: "synced",
    conflicts: [{ branch, url: `https://github.com/${MEMORY_REPOSITORY}/pull/1` }],
  });
  expect(await readFile(join(f.clone("server"), "index.md"), "utf8")).toContain("Laptop line.");
  expect(await f.git(f.clone("server"), "status", "--porcelain")).toBe("");

  await writeFile(join(f.clone("server"), "later.md"), "Later lesson.\n");
  await server.sync();
  await laptop.sync();
  expect(await readFile(join(f.clone("laptop"), "later.md"), "utf8")).toBe("Later lesson.\n");
});

test("a rebase left behind by an interrupted sync is cleared before the next sync", async () => {
  const f = await setup();
  const laptop = await f.machine("laptop");
  const server = await f.machine("server");
  await writeFile(join(f.clone("laptop"), "index.md"), "Laptop.\n");
  await laptop.sync();
  const clone = f.clone("server");
  await writeFile(join(clone, "index.md"), "Server.\n");
  await f.git(clone, "-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "-qam", "x");
  await f.git(clone, "fetch", "--quiet", "origin");
  await f
    .git(clone, "-c", "user.name=T", "-c", "user.email=t@example.test", "rebase", "origin/main")
    .catch(() => {});
  await server.sync();
  expect(server.status().phase).toBe("synced");
  expect(server.status().conflicts).toHaveLength(1);
  expect(await f.git(clone, "status", "--porcelain")).toBe("");
});

test("sync stops with guidance when another branch is checked out in the memory folder", async () => {
  const f = await setup();
  const laptop = await f.machine("laptop");
  await f.git(f.clone("laptop"), "switch", "--quiet", "-c", "experiment");
  await writeFile(join(f.clone("laptop"), "draft.md"), "Draft.\n");
  const head = await f.head();
  await laptop.sync();
  expect(laptop.status()).toMatchObject({ phase: "error" });
  expect(laptop.status().message).toContain("Scope syncs only main");
  expect(await f.head()).toBe(head);
});

test("git sync continues without irudd-okf and a foreign personal bundle stays untouched", async () => {
  const f = await setup();
  const plain = await f.machine("plain", { okf: false });
  expect(plain.status()).toMatchObject({
    phase: "synced",
    bundle: "unavailable",
    okf: { installed: false },
  });
  const elsewhere = join(f.directory, "elsewhere");
  await mkdir(elsewhere);
  await f.setOkfConfig("taken", [{ name: "personal", root: elsewhere }]);
  const taken = await f.machine("taken");
  expect(taken.status()).toMatchObject({ phase: "synced", bundle: "name-taken" });
  expect((await f.okfConfig("taken")).bundles).toEqual([{ name: "personal", root: elsewhere }]);
});

test("a personal bundle left by an earlier Scope repository moves to the connected one", async () => {
  const f = await setup();
  const old = join(f.root("moved"), "old-memory");
  await mkdir(old, { recursive: true });
  await f.setOkfConfig("moved", [{ name: "personal", root: old }]);
  const moved = await f.machine("moved");
  expect(moved.status().bundle).toBe("registered");
  expect((await f.okfConfig("moved")).bundles).toEqual([
    { name: "personal", root: f.clone("moved") },
  ]);
});

test("missing GitHub access and empty repositories are reported without changing files", async () => {
  const f = await setup();
  const denied = await f.machine("denied", { extra: { FAKE_GH_DENY: "1" } });
  expect(denied.status()).toMatchObject({ phase: "error" });
  expect(denied.status().message).toContain(`gh cannot access ${MEMORY_REPOSITORY}`);
  await f.git(f.directory, "--git-dir", f.bare, "update-ref", "-d", "refs/heads/main");
  const empty = await f.machine("empty");
  expect(empty.status().message).toContain("has no commits yet");
});

test("turning sync off stops further commits", async () => {
  const f = await setup();
  const laptop = await f.machine("laptop");
  laptop.configure({ enabled: false, repository: MEMORY_REPOSITORY });
  expect(laptop.status().phase).toBe("off");
  await writeFile(join(f.clone("laptop"), "ignored.md"), "Not synced.\n");
  const head = await f.head();
  await laptop.sync();
  expect(await f.head()).toBe(head);
  expect(await f.git(f.clone("laptop"), "status", "--porcelain")).toBe("?? ignored.md\n");
});

test("daily irudd-okf upgrades run the installed CLI and report old or failing versions", async () => {
  const f = await setup();
  const old = await f.machine("old");
  await old.upgradeOkf();
  expect(old.status().okf.message).toContain("too old for automatic upgrades");
  const current = await f.machine("current", { extra: { FAKE_OKF_UPGRADE: "available" } });
  await current.upgradeOkf();
  expect(current.status().okf).toMatchObject({
    installed: true,
    version: "0.2.0",
    message: "Upgraded irudd-okf to 0.2.0.",
  });
  const failing = await f.machine("failing", { extra: { FAKE_OKF_UPGRADE: "fail" } });
  await failing.upgradeOkf();
  expect(failing.status().okf.message).toContain("0.2.0 is available, but the upgrade failed");
});
