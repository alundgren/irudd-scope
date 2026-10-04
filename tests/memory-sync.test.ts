import { afterEach, expect, test } from "vite-plus/test";
import { access, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemorySync } from "@irudd-scope/memory-sync";
import { decode } from "@irudd-scope/protocol";
import { MemoryMachineStatus } from "@irudd-scope/protocol/memory";
import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
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

test("an unknown unfinished rebase keeps newer edits and reports recovery guidance", async () => {
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
  await writeFile(join(clone, "index.md"), "Agent edit after the interrupted rebase.\n");
  await server.sync();
  expect(server.status().phase).toBe("error");
  expect(server.status().message).toContain("Preserve any newer edits");
  expect(await readFile(join(clone, "index.md"), "utf8")).toBe(
    "Agent edit after the interrupted rebase.\n",
  );
  await f.git(clone, "rebase", "--abort");
  await server.sync();
  expect(server.status().phase).toBe("synced");
  expect(server.status().conflicts).toHaveLength(1);
  expect(await f.git(clone, "status", "--porcelain")).toBe("");
});

test("OKF runtime files stay local and an active writer is left alone", async () => {
  const f = await setup();
  const laptop = await f.machine("laptop");
  const server = await f.machine("server");
  const runtime = join(f.clone("laptop"), ".irudd-okf");
  await mkdir(join(runtime, "recovery"), { recursive: true });
  await writeFile(join(runtime, "recovery", "old.md"), "Recovery bytes.\n");
  await writeFile(join(f.clone("laptop"), ".okf-example.tmp"), "Temporary bytes.\n");
  const lock = join(runtime, "write.lock");
  await writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  await writeFile(join(f.clone("laptop"), "lesson.md"), "New lesson.\n");
  const head = await f.head();
  await laptop.sync();
  expect(laptop.status().message).toContain("irudd-okf is writing memory");
  expect(await f.head()).toBe(head);
  expect(await readFile(lock, "utf8")).toContain(String(process.pid));
  await rm(lock);
  await laptop.sync();
  await server.sync();
  expect(await readFile(join(f.clone("server"), "lesson.md"), "utf8")).toBe("New lesson.\n");
  expect(await f.git(f.clone("laptop"), "ls-files")).toBe("index.md\nlesson.md\n");
  expect(
    await access(join(f.clone("server"), ".irudd-okf", "write.lock")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  expect(
    await access(join(f.clone("server"), ".irudd-okf", "recovery", "old.md")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

test("files written while Git fetches survive the pull and reach the other machine", async () => {
  const f = await setup();
  const laptop = await f.machine("laptop");
  await writeFile(join(f.clone("laptop"), "incoming.md"), "Incoming lesson.\n");
  await laptop.sync();
  const gate = f.gate("fetch", "git:fetch");
  const server = new MemorySync({
    root: f.root("server"),
    machine: "server",
    env: f.env("server", { extra: gate.env }),
  });
  cleanup.push(async () => {
    await gate.release();
    await server.close();
  });
  server.configure({ enabled: true, repository: MEMORY_REPOSITORY });
  try {
    await expect.poll(gate.entered, { timeout: 10_000 }).toBe(true);
    await writeFile(join(f.clone("server"), "concurrent.md"), "Concurrent lesson.\n");
  } finally {
    await gate.release();
  }
  await server.sync();
  await laptop.sync();
  expect(server.status().phase).toBe("synced");
  expect(await readFile(join(f.clone("server"), "incoming.md"), "utf8")).toBe("Incoming lesson.\n");
  expect(await readFile(join(f.clone("laptop"), "concurrent.md"), "utf8")).toBe(
    "Concurrent lesson.\n",
  );
  expect(await f.pulls()).toEqual([]);
});

test("a tracked edit made immediately before returning from a conflict is preserved", async () => {
  const f = await setup();
  const laptop = await f.machine("laptop");
  const gate = f.gate("reset", "git:reset");
  const server = await f.machine("server", { extra: gate.env });
  cleanup.push(gate.release);
  await writeFile(join(f.clone("laptop"), "index.md"), "Laptop line.\n");
  await laptop.sync();
  await writeFile(join(f.clone("server"), "index.md"), "Server line.\n");
  const task = server.sync();
  try {
    await expect.poll(gate.entered, { timeout: 10_000 }).toBe(true);
    await writeFile(join(f.clone("server"), "index.md"), "New agent edit.\n");
  } finally {
    await gate.release();
  }
  await task;
  expect(server.status().phase).toBe("error");
  expect(server.status().message).toContain("Local edits are kept");
  expect(await readFile(join(f.clone("server"), "index.md"), "utf8")).toBe("New agent edit.\n");
  const [pull] = await f.pulls();
  expect(
    await f.git(f.directory, "--git-dir", f.bare, "show", `${pull.headRefName}:index.md`),
  ).toBe("Server line.\n");
});

test("turning memory off lets an active Git commit finish and does not push it", async () => {
  const f = await setup();
  const gate = f.gate("commit", "git:commit");
  const laptop = await f.machine("laptop", { extra: gate.env });
  cleanup.push(gate.release);
  await writeFile(join(f.clone("laptop"), "lesson.md"), "Keep this edit.\n");
  const before = await f.head();
  const task = laptop.sync();
  try {
    await expect.poll(gate.entered, { timeout: 10_000 }).toBe(true);
    laptop.configure({ enabled: false, repository: MEMORY_REPOSITORY });
  } finally {
    await gate.release();
  }
  await task;
  expect(laptop.status().phase).toBe("off");
  expect(await f.head()).toBe(before);
  expect(await f.git(f.clone("laptop"), "show", "HEAD:lesson.md")).toBe("Keep this edit.\n");
  expect(await f.git(f.clone("laptop"), "status", "--porcelain")).toBe("");
  expect(
    await access(join(f.clone("laptop"), ".git", "index.lock")).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
});

test("turning memory off during a rebase completes cleanup before another writer can edit", async () => {
  const f = await setup();
  const laptop = await f.machine("laptop");
  const gate = f.gate("rebase", "git:rebase --quiet");
  const server = await f.machine("server", { extra: gate.env });
  cleanup.push(gate.release);
  await writeFile(join(f.clone("laptop"), "index.md"), "Laptop line.\n");
  await laptop.sync();
  await writeFile(join(f.clone("server"), "index.md"), "Server line.\n");
  const task = server.sync();
  try {
    await expect.poll(gate.entered, { timeout: 10_000 }).toBe(true);
    server.configure({ enabled: false, repository: MEMORY_REPOSITORY });
  } finally {
    await gate.release();
  }
  await task;
  expect(server.status().phase).toBe("off");
  expect(await readFile(join(f.clone("server"), "index.md"), "utf8")).toBe("Server line.\n");
  expect(await f.git(f.clone("server"), "status", "--porcelain")).toBe("");
  await writeFile(join(f.clone("server"), "index.md"), "Later edit.\n");
  server.configure({ enabled: true, repository: MEMORY_REPOSITORY });
  await server.sync();
  const [pull] = await f.pulls();
  expect(
    await f.git(f.directory, "--git-dir", f.bare, "show", `${pull.headRefName}:index.md`),
  ).toBe("Later edit.\n");
});

test("an old lock owned by a running sync cannot be reclaimed by another Scope process", async () => {
  const f = await setup();
  const gate = f.gate("locked", "git:fetch");
  const first = new MemorySync({
    root: f.root("shared"),
    machine: "first",
    env: f.env("first", { extra: gate.env }),
  });
  const second = new MemorySync({
    root: f.root("shared"),
    machine: "second",
    env: f.env("second"),
  });
  cleanup.push(async () => {
    await gate.release();
    await first.close();
    await second.close();
  });
  first.configure({ enabled: true, repository: MEMORY_REPOSITORY });
  try {
    await expect.poll(gate.entered, { timeout: 10_000 }).toBe(true);
    const past = new Date(Date.now() - 60 * 60_000);
    await utimes(join(f.root("shared"), ".personal-memory.scope-sync.lock"), past, past);
    second.configure({ enabled: true, repository: MEMORY_REPOSITORY });
    await second.sync();
    expect(second.status().message).toContain("Another Scope process");
  } finally {
    await gate.release();
  }
  await first.sync();
  expect(first.status().phase).toBe("synced");
});

test("old closed conflict pull requests stay closed after many newer pull requests", async () => {
  const f = await setup();
  const laptop = await f.machine("laptop");
  const server = await f.machine("server");
  await writeFile(join(f.clone("laptop"), "index.md"), "Laptop line.\n");
  await laptop.sync();
  await writeFile(join(f.clone("server"), "index.md"), "Server line.\n");
  await server.sync();
  const [conflict] = await f.pulls();
  const history = [
    { ...conflict, state: "CLOSED" },
    ...Array.from({ length: 220 }, (_, id) => ({
      url: `https://github.com/${MEMORY_REPOSITORY}/pull/${id + 2}`,
      title: "Other PR",
      headRefName: `other-${id}`,
      state: "CLOSED",
    })),
  ];
  await writeFile(
    join(f.directory, "gh-state", "prs.jsonl"),
    history.map((pull) => JSON.stringify(pull)).join("\n") + "\n",
  );
  await laptop.sync();
  expect(laptop.status().conflicts).toEqual([]);
  expect(await f.pulls()).toHaveLength(history.length);
});

test("upgrades run while waiting for a repository and stop when memory is turned off", async () => {
  const f = await setup();
  const gate = f.gate("upgrade", "okf:upgrade --check");
  const sync = new MemorySync({
    root: f.root("waiting"),
    machine: "waiting",
    env: f.env("waiting", { extra: { ...gate.env, FAKE_OKF_UPGRADE: "available" } }),
  });
  cleanup.push(async () => {
    await gate.release();
    await sync.close();
  });
  sync.configure({ enabled: true, repository: null });
  try {
    await expect.poll(gate.entered, { timeout: 10_000 }).toBe(true);
    sync.configure({ enabled: false, repository: null });
    await sync.close();
    expect((await gate.commands()).split("\n")).not.toContain("okf:upgrade");
    expect(sync.status().phase).toBe("off");
  } finally {
    await gate.release();
  }
});

test("unreadable upgrade responses and long versions produce valid machine status", async () => {
  const f = await setup();
  const bad = await f.machine("bad", {
    extra: {
      FAKE_OKF_UPGRADE: "available",
      FAKE_OKF_CHECK_RESPONSE: '{"latest":42,"updateAvailable":true}',
    },
  });
  await bad.upgradeOkf();
  expect(bad.status().okf.message).toContain("unreadable upgrade response");
  const long = await f.machine("long", {
    extra: {
      FAKE_OKF_UPGRADE: "available",
      FAKE_OKF_VERSION: `0.1.0-${"x".repeat(100)}`,
      FAKE_OKF_UPGRADE_RESPONSE: JSON.stringify({
        current: `0.2.0-${"x".repeat(100)}`,
        updated: true,
      }),
    },
  });
  await long.upgradeOkf();
  expect(long.status().okf.version).toHaveLength(64);
  expect(() => decode(MemoryMachineStatus, long.status())).not.toThrow();
});

test("a writer lock left by a stopped Scope process is recovered without copying it", async () => {
  const f = await setup();
  const laptop = await f.machine("laptop");
  const stopped = execFile(process.execPath, ["-e", ""]);
  await new Promise<void>((done) => stopped.on("exit", () => done()));
  const lock = join(f.clone("laptop"), ".irudd-okf", "write.lock");
  await writeFile(
    lock,
    JSON.stringify({ pid: stopped.pid, startedAt: new Date().toISOString(), scope: true }),
  );
  await writeFile(join(f.clone("laptop"), "lesson.md"), "After restart.\n");
  await laptop.sync();
  expect(laptop.status().phase).toBe("synced");
  expect(
    await access(lock).then(
      () => true,
      () => false,
    ),
  ).toBe(false);
  expect(await f.git(f.clone("laptop"), "ls-files")).toBe("index.md\nlesson.md\n");
});

test("turning memory off stops an installer child that ignores its CLI's termination", async () => {
  const f = await setup();
  const gate = f.gate("installer", "installer:upgrade");
  const installer = join(f.directory, "installer-child");
  const sync = new MemorySync({
    root: f.root("waiting"),
    machine: "waiting",
    env: f.env("waiting", {
      extra: { ...gate.env, FAKE_OKF_UPGRADE: "available", FAKE_OKF_INSTALLER: installer },
    }),
  });
  cleanup.push(async () => {
    await gate.release();
    await sync.close();
  });
  sync.configure({ enabled: true, repository: null });
  try {
    await expect.poll(gate.entered, { timeout: 10_000 }).toBe(true);
    sync.configure({ enabled: false, repository: null });
    await sync.close();
    await writeFile(`${installer}.continue`, "");
    await delay(100);
    expect(
      await access(`${installer}.completed`).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(sync.status().phase).toBe("off");
  } finally {
    await gate.release();
  }
});

test("an upgrade and a requested sync run in order without overlapping OKF commands", async () => {
  const f = await setup();
  const gate = f.gate("queued", "okf:upgrade --check");
  const sync = new MemorySync({
    root: f.root("queued"),
    machine: "queued",
    env: f.env("queued", { extra: { ...gate.env, FAKE_OKF_UPGRADE: "available" } }),
  });
  cleanup.push(async () => {
    await gate.release();
    await sync.close();
  });
  sync.configure({ enabled: true, repository: MEMORY_REPOSITORY });
  await expect.poll(gate.entered, { timeout: 10_000 }).toBe(true);
  const task = sync.sync();
  await gate.release();
  await task;
  const log = (await gate.commands()).split("\n");
  const checked = log.findIndex((line) => line === "okf:upgrade --check");
  const upgraded = log.findIndex((line) => line === "okf:upgrade");
  const nextSync = log.findIndex(
    (line, index) => index > checked && line.startsWith("gh:repo view"),
  );
  expect(checked).toBeGreaterThan(0);
  expect(upgraded).toBeGreaterThan(checked);
  expect(nextSync).toBeGreaterThan(upgraded);
  expect(sync.status().phase).toBe("synced");
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
