import { afterEach, expect, test } from "vite-plus/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemorySync } from "@irudd-scope/memory-sync";
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

test(
  "a machine clones the memory repository, registers the personal bundle, and pushes nothing when unchanged",
  { tags: ["memory-syncs"] },
  async () => {
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
  },
);

test(
  "changes on one machine reach GitHub and then another machine",
  { tags: ["memory-syncs"] },
  async () => {
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
  },
);

test(
  "a conflicting machine moves its edit to a pull request and keeps syncing",
  { tags: ["memory-syncs"] },
  async () => {
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
  },
);

test(
  "an unknown unfinished rebase keeps newer edits and reports recovery guidance",
  { tags: ["memory-syncs"] },
  async () => {
    const f = await setup();
    const laptop = await f.machine("laptop");
    const server = await f.machine("server");
    await writeFile(join(f.clone("laptop"), "index.md"), "Laptop.\n");
    await laptop.sync();
    const clone = f.clone("server");
    await writeFile(join(clone, "index.md"), "Server.\n");
    await f.git(
      clone,
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.test",
      "commit",
      "-qam",
      "x",
    );
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
  },
);

test(
  "files written while Git fetches survive the pull and reach the other machine",
  { tags: ["memory-syncs"] },
  async () => {
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
    expect(await readFile(join(f.clone("server"), "incoming.md"), "utf8")).toBe(
      "Incoming lesson.\n",
    );
    expect(await readFile(join(f.clone("laptop"), "concurrent.md"), "utf8")).toBe(
      "Concurrent lesson.\n",
    );
    expect(await f.pulls()).toEqual([]);
  },
);

test(
  "a tracked edit made immediately before returning from a conflict is preserved",
  { tags: ["memory-syncs"] },
  async () => {
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
  },
);

test.runIf(process.platform === "win32")(
  "Windows sync uses an installed irudd-okf without running its unsupported upgrader",
  { tags: ["memory-syncs"] },
  async () => {
    const f = await setup();
    const log = join(f.directory, "windows-okf-commands");
    const computer = await f.machine("windows", {
      extra: { FAKE_MEMORY_LOG: log, FAKE_OKF_UPGRADE: "available" },
    });
    await computer.upgradeOkf();
    expect(computer.status()).toMatchObject({
      phase: "synced",
      okf: {
        installed: true,
        version: "0.1.0",
        message: expect.stringContaining("unavailable on Windows"),
      },
    });
    expect(await readFile(log, "utf8")).not.toContain("okf:upgrade");
    await writeFile(join(f.clone("windows"), "windows.md"), "Native Windows memory.\n");
    await computer.sync();
    expect(await f.git(f.clone("windows"), "log", "-1", "--format=%s")).toBe(
      "memory: update from windows\n",
    );
  },
);

test.runIf(process.platform === "win32")(
  "Windows keeps an existing personal bundle whose path differs only in casing",
  { tags: ["memory-syncs"] },
  async () => {
    const f = await setup();
    const log = join(f.directory, "case-commands");
    const computer = await f.machine("windows", { extra: { FAKE_MEMORY_LOG: log } });
    const root = f.clone("windows").toUpperCase();
    await f.setOkfConfig("windows", [{ name: "personal", root }]);
    await writeFile(log, "");
    await computer.sync();
    expect(computer.status()).toMatchObject({ phase: "synced", bundle: "registered" });
    expect((await f.okfConfig("windows")).bundles).toEqual([{ name: "personal", root }]);
    expect(await readFile(log, "utf8")).not.toMatch(/okf:bundle (add|remove)/);
  },
);

test(
  "missing GitHub access and empty repositories are reported without changing files",
  { tags: ["memory-syncs"] },
  async () => {
    const f = await setup();
    const denied = await f.machine("denied", { extra: { FAKE_GH_DENY: "1" } });
    expect(denied.status()).toMatchObject({ phase: "error" });
    expect(denied.status().message).toContain(`gh cannot access ${MEMORY_REPOSITORY}`);
    await f.git(f.directory, "--git-dir", f.bare, "update-ref", "-d", "refs/heads/main");
    const empty = await f.machine("empty");
    expect(empty.status().message).toContain("has no commits yet");
  },
);

test(
  "a local bundle reads without Git and schedules no upgrades",
  { tags: ["librarian-finds-memory", "memory-syncs"] },
  async () => {
    const f = await setup();
    const root = join(f.directory, "local-only");
    await mkdir(root);
    await writeFile(join(root, "index.md"), "# Local memory\n");
    const gate = f.gate("local-only", "okf:upgrade --check");
    const sync = new MemorySync({
      root: f.root("unused"),
      machine: "local",
      env: f.env("local", { extra: gate.env }),
      intervalMs: 10,
      upgradeIntervalMs: 10,
    });
    cleanup.push(() => sync.close());
    await sync.checkOkf();
    sync.configure({ enabled: true, repository: null, localRoot: root });
    const read = await sync.runOkf(root, ["read", "personal", "index.md"]);
    expect(read.code).toBe(0);
    await delay(50);
    const commands = (await gate.commands()).split("\n");
    expect(commands.some((command) => /^(git|gh):|^okf:upgrade/.test(command))).toBe(false);
    expect(sync.status().root).toBe(root);
  },
);
